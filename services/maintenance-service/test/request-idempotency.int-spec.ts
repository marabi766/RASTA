import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import { CREATE_REQUEST_ENDPOINT, RequestController } from '../src/maintenance/request.controller';
import { IN_FLIGHT_WAIT_MS, IdempotencyStore } from '../src/maintenance/idempotency';
import type { CreateRequestDto, MaintenanceRequestView } from '../src/maintenance/dto';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * Idempotency-Key on POST /v1/maintenance-requests (#157, docs/06 § 6.8),
 * against real PostgreSQL. The controller is driven directly with the real
 * service and store, so every claim is about what the database holds: how
 * many requests exist, and what each caller was answered.
 */
const LEASE_SECONDS = 120;

describe('maintenance request creation under an Idempotency-Key', () => {
  let prisma: PrismaService;
  let requests: RequestService;
  let store: IdempotencyStore;
  let controller: RequestController;

  const org = tenants();
  const reporter = 'USR-ITEST-REPORTER';

  beforeAll(async () => {
    prisma = newPrisma();
    const repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
    store = new IdempotencyStore(prisma, {
      MAINTENANCE_IDEMPOTENCY_TTL_HOURS: 24,
      MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: LEASE_SECONDS,
    });
    controller = new RequestController(
      requests,
      new RepairOrderService(repository, new UnverifiedWorkshopDirectory()),
      store,
    );
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  async function machine(organizationId = org.a): Promise<string> {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, organizationId);
    return assetId;
  }

  const breakdown = (assetId: string, title = 'نشتی روغن'): CreateRequestDto => ({
    assetId,
    type: 'CORRECTIVE',
    severity: 'HIGH',
    title,
  });

  const create = (
    dto: CreateRequestDto,
    key: string | undefined,
    { organizationId = org.a, userId = reporter } = {},
  ) => asActor({ organizationId, userId }, () => controller.create(dto, key));

  const requestsFor = (assetId: string) =>
    prisma.client.$queryRawUnsafe<{ id: string; organization_id: string }[]>(
      'SELECT id, organization_id FROM maintenance_request WHERE asset_id = $1',
      assetId,
    );

  const keyRow = (organizationId: string, key: string) =>
    prisma.client.$queryRawUnsafe<{ state: string; claim_token: string; request_hash: string }[]>(
      'SELECT state, claim_token, request_hash FROM idempotency_key WHERE organization_id = $1 AND endpoint = $2 AND key = $3',
      organizationId,
      CREATE_REQUEST_ENDPOINT,
      key,
    );

  it('answers a concurrent double submit once: one request, and both callers get the same 201 body', async () => {
    const assetId = await machine();
    const key = id('KEY');

    const [first, second] = await Promise.all([
      create(breakdown(assetId), key),
      create(breakdown(assetId), key),
    ]);

    expect(second).toEqual(first);
    const rows = await requestsFor(assetId);
    expect(rows.map((row) => row.id)).toEqual([(first as { id: string }).id]);
    expect((await keyRow(org.a, key))[0]?.state).toBe('COMPLETED');
  });

  it('replays a retry after completion instead of raising the work again', async () => {
    const assetId = await machine();
    const key = id('KEY');

    const original = await create(breakdown(assetId), key);
    const retry = await create(breakdown(assetId), key);

    expect(retry).toEqual(original);
    expect(await requestsFor(assetId)).toHaveLength(1);
  });

  it('does not raise the work again after the first request was closed, while the key is live', async () => {
    // Without the key this retry would succeed: the duplicate-open control
    // no longer applies once the first request is cancelled.
    const assetId = await machine();
    const key = id('KEY');

    const original = (await create(breakdown(assetId), key)) as { id: string; status: string };
    await asActor({ organizationId: org.a, userId: reporter }, () =>
      requests.cancel(original.id, { reason: 'reported twice by mistake' }),
    );

    const retry = await create(breakdown(assetId), key);

    expect(retry).toEqual(original);
    expect(await requestsFor(assetId)).toHaveLength(1);
  });

  it('refuses the same key with a different body, or from another user, and writes nothing', async () => {
    const assetId = await machine();
    const key = id('KEY');
    await create(breakdown(assetId), key);

    await expect(create(breakdown(assetId, 'another title'), key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    // A DRIVER sees only what they reported: another user's key is never
    // answered with this request.
    await expect(
      create(breakdown(assetId), key, { userId: 'USR-ITEST-SOMEONE-ELSE' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await requestsFor(assetId)).toHaveLength(1);
  });

  it('keeps keys per tenant: the same key in two organizations is two requests', async () => {
    const key = id('KEY');
    const inA = await machine(org.a);
    const inB = await machine(org.b);

    const a = (await create(breakdown(inA), key, { organizationId: org.a })) as { id: string };
    const b = (await create(breakdown(inB), key, { organizationId: org.b })) as { id: string };

    expect(a.id).not.toBe(b.id);
    expect((await requestsFor(inA)).map((row) => row.organization_id)).toEqual([org.a]);
    expect((await requestsFor(inB)).map((row) => row.organization_id)).toEqual([org.b]);
    expect(await keyRow(org.a, key)).toHaveLength(1);
    expect(await keyRow(org.b, key)).toHaveLength(1);
  });

  // ---- Round 1 on #171: the claim check, the create, its outbox rows and the
  // completion commit in ONE transaction. Real creates, real rows.

  const actor = { organizationId: org.a, userId: reporter };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const outboxFor = (assetId: string) =>
    prisma.client.$queryRawUnsafe<{ aggregate_id: string }[]>(
      'SELECT aggregate_id FROM outbox_message WHERE partition_key = $1',
      assetId,
    );

  /** A gate a test opens by hand, and a signal that something reached it. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    return { open, opened, reach, reached };
  }

  it('commits nothing of a create whose claim lapsed and was re-taken: exactly one request', async () => {
    const assetId = await machine();
    const key = id('KEY');
    const dto = breakdown(assetId);
    const a = gate();

    // A claims, then stalls before its transaction — a slow client, a GC pause.
    const first = asActor(actor, () =>
      store.execute<MaintenanceRequestView>(
        CREATE_REQUEST_ENDPOINT,
        key,
        dto,
        201,
        async (fence) => {
          a.reach();
          await a.opened;
          return requests.create(dto, fence);
        },
      ),
    ).then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    );
    await a.reached;

    // A's claim expires; a retry re-takes the key and creates the request.
    await prisma.client.$executeRawUnsafe(
      `UPDATE idempotency_key SET expires_at = now() - interval '1 second' WHERE organization_id = $1 AND key = $2`,
      org.a,
      key,
    );
    const retried = (await create(dto, key)) as { id: string };
    // Closed, so the open-request rule no longer stands between A and a
    // second request: only the claim can stop it now.
    await asActor(actor, () => requests.cancel(retried.id, { reason: 'handled already' }));

    a.open();
    expect(await first).toEqual({ error: expect.objectContaining({ code: 'CONFLICT' }) });
    expect((await requestsFor(assetId)).map((row) => row.id)).toEqual([retried.id]);
    expect(await keyRow(org.a, key)).toEqual([expect.objectContaining({ state: 'COMPLETED' })]);
    expect(await create(dto, key)).toEqual(retried);
  });

  it('does not let a retry re-take a claim that expires under a running create: it waits, then replays', async () => {
    const assetId = await machine();
    const key = id('KEY');
    const dto = breakdown(assetId);
    const a = gate();
    const LIFETIME_MS = 1_500;

    // A's claim is about to expire as A's transaction takes it.
    const first = asActor(actor, () =>
      store.execute<MaintenanceRequestView>(
        CREATE_REQUEST_ENDPOINT,
        key,
        dto,
        201,
        async (fence) => {
          await prisma.client.$executeRawUnsafe(
            `UPDATE idempotency_key SET expires_at = now() + make_interval(secs => $3) WHERE organization_id = $1 AND key = $2`,
            org.a,
            key,
            LIFETIME_MS / 1000,
          );
          return requests.create(dto, {
            hold: async (tx) => {
              await fence.hold(tx);
              a.reach();
              await a.opened;
            },
            complete: fence.complete,
          });
        },
      ),
    );
    await a.reached;
    await sleep(LIFETIME_MS + 200);

    // The claim has expired while A holds it. The retry's removal of the
    // expired row must wait for A's lock...
    const retry = create(dto, key);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const [{ waiting }] = await prisma.client.$queryRawUnsafe<{ waiting: number }[]>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE 'DELETE FROM%idempotency_key%'`,
      );
      if (waiting > 0) break;
      if (Date.now() > deadline) throw new Error('the retry never waited on the held claim');
      await sleep(25);
    }

    // ...and, once A commits with a fresh lifetime, find the response to replay.
    a.open();
    const original = (await first).result as { id: string };
    expect(await retry).toEqual(original);
    expect((await requestsFor(assetId)).map((row) => row.id)).toEqual([original.id]);
  });

  it.each(['__proto__', 'constructor'])(
    'refuses a body that differs only under a %s key, and creates nothing more (#194)',
    async (name) => {
      const assetId = await machine();
      const key = id('KEY');
      const dto = breakdown(assetId);
      // JSON.parse makes `name` an own key, as the request body parser does. The
      // schema refuses such a body today; the store must not rely on that.
      const hashed = (x: number): unknown => ({
        ...dto,
        extra: JSON.parse(`{"${name}":{"x":${x}}}`) as unknown,
      });
      const run = (x: number) =>
        asActor(actor, () =>
          store.execute<MaintenanceRequestView>(
            CREATE_REQUEST_ENDPOINT,
            key,
            hashed(x),
            201,
            (fence) => requests.create(dto, fence),
          ),
        );

      const original = (await run(1)).result;
      await expect(run(2)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect((await requestsFor(assetId)).map((row) => row.id)).toEqual([original.id]);
      // The same body is still recognised as the retry it is.
      expect(await run(1)).toEqual({ result: original, executed: false });
    },
  );

  /** Until a session waits on a row lock with a statement matching `pattern`. */
  async function untilBlocked(pattern: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const [{ waiting }] = await prisma.client.$queryRawUnsafe<{ waiting: number }[]>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
        pattern,
      );
      if (waiting > 0) return;
      if (Date.now() > deadline) throw new Error(`no session ever blocked on ${pattern}`);
      await sleep(25);
    }
  }

  it('bounds the takeover of a lapsed claim: a holder that keeps its lock gets a retryable 409 within the budget, then the retry takes over (#194)', async () => {
    const assetId = await machine();
    const key = id('KEY');
    const dto = breakdown(assetId);
    await asActor(actor, () => store.claim(CREATE_REQUEST_ENDPOINT, key, dto));
    await prisma.client.$executeRawUnsafe(
      `UPDATE idempotency_key SET expires_at = now() - interval '1 second'
       WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
      org.a,
      CREATE_REQUEST_ENDPOINT,
      key,
    );
    const held = gate();

    // A holder that keeps the lapsed claim's row lock past any request's
    // budget. The retry's removal of the lapsed row waits on that lock — for
    // what is left of the budget, never longer.
    const holder = prisma.transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT 1 FROM idempotency_key
           WHERE organization_id = $1 AND endpoint = $2 AND key = $3 FOR UPDATE`,
          org.a,
          CREATE_REQUEST_ENDPOINT,
          key,
        );
        held.reach();
        await held.opened;
      },
      { timeoutMs: 30_000 },
    );
    await held.reached;

    const started = Date.now();
    const refused = create(dto, key).catch((error: unknown) => error);
    await untilBlocked('DELETE FROM%idempotency_key%');
    expect(await refused).toMatchObject({ code: 'CONFLICT', retryAfterSeconds: 1 });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(IN_FLIGHT_WAIT_MS - 1_000);
    expect(waited).toBeLessThan(IN_FLIGHT_WAIT_MS + 2_500);
    expect(await requestsFor(assetId)).toEqual([]);

    // Once the holder lets go, the next retry takes the lapsed claim over.
    held.open();
    await holder;
    const taken = (await create(dto, key)) as { id: string };
    expect((await requestsFor(assetId)).map((row) => row.id)).toEqual([taken.id]);
  }, 30_000);

  it('leaves nothing half-done when the completion fails: no request, no outbox row, the key free', async () => {
    const assetId = await machine();
    const key = id('KEY');
    const dto = breakdown(assetId);

    const failing = jest
      .spyOn(store, 'storeResponse')
      .mockRejectedValueOnce(new Error('response store failed (injected)'));
    try {
      await expect(create(dto, key)).rejects.toThrow('response store failed (injected)');
    } finally {
      failing.mockRestore();
    }
    expect(await requestsFor(assetId)).toEqual([]);
    expect(await outboxFor(assetId)).toEqual([]);
    expect(await keyRow(org.a, key)).toEqual([]);

    // The retry is the first request that commits — once, with its events.
    const created = (await create(dto, key)) as { id: string };
    expect((await requestsFor(assetId)).map((row) => row.id)).toEqual([created.id]);
    const events = await outboxFor(assetId);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((row) => row.aggregate_id))).toEqual(new Set([created.id]));
    expect(await create(dto, key)).toEqual(created);
  });

  it('releases the key when the work fails, so a corrected retry can run', async () => {
    const key = id('KEY');
    const missing = id('AST-ITEST-MISSING');

    await expect(create(breakdown(missing), key)).rejects.toBeDefined();
    expect(await keyRow(org.a, key)).toEqual([]);

    const assetId = await machine();
    const created = (await create(breakdown(assetId), key)) as { id: string };
    expect((await requestsFor(assetId)).map((row) => row.id)).toEqual([created.id]);
  });

  it('keeps the create path as it was when no key is sent', async () => {
    const assetId = await machine();

    await create(breakdown(assetId), undefined);
    await expect(create(breakdown(assetId), undefined)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
    });
    expect(await requestsFor(assetId)).toHaveLength(1);
  });

  it('refuses a key that is present but too short, rather than ignoring it', async () => {
    const assetId = await machine();
    await expect(create(breakdown(assetId), 'short')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await requestsFor(assetId)).toHaveLength(0);
  });
  // ---- Round 3 on #187: the store is shared, so a request creation whose
  // process died after its claim committed is retried after the claim's lease.

  describe('a claim left behind by a process that died', () => {
    const row = async (key: string) =>
      (
        await prisma.client.$queryRawUnsafe<{ claim_token: string; state: string; secs: number }[]>(
          `SELECT claim_token, state, extract(epoch FROM (expires_at - now()))::float AS secs
           FROM idempotency_key WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
          org.a,
          CREATE_REQUEST_ENDPOINT,
          key,
        )
      )[0];
    const lapse = (key: string) =>
      prisma.client.$executeRawUnsafe(
        `UPDATE idempotency_key SET expires_at = now() - interval '1 second'
         WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
        org.a,
        CREATE_REQUEST_ENDPOINT,
        key,
      );

    it('is held for the lease while in flight and for the configured hours once completed', async () => {
      const assetId = await machine();
      const key = id('KEY');
      const dto = breakdown(assetId);

      await asActor(actor, () => store.claim(CREATE_REQUEST_ENDPOINT, key, dto));
      const claimed = await row(key);
      expect(claimed?.state).toBe('IN_PROGRESS');
      expect(claimed?.secs).toBeGreaterThan(LEASE_SECONDS - 30);
      expect(claimed?.secs).toBeLessThanOrEqual(LEASE_SECONDS);

      const done = id('KEY');
      await create(breakdown(await machine()), done);
      const completed = await row(done);
      expect(completed?.state).toBe('COMPLETED');
      expect(completed?.secs).toBeGreaterThan(23 * 3_600);
    });

    it('answers a retry inside the lease with a retryable 409 and creates nothing', async () => {
      const assetId = await machine();
      const key = id('KEY');
      const dto = breakdown(assetId);
      await asActor(actor, () => store.claim(CREATE_REQUEST_ENDPOINT, key, dto));

      await expect(create(dto, key)).rejects.toMatchObject({
        code: 'CONFLICT',
        retryAfterSeconds: 1,
      });
      expect(await requestsFor(assetId)).toEqual([]);
    }, 20_000);

    it('is taken over by a retry once the lease has lapsed, under a new fencing token: one request', async () => {
      const assetId = await machine();
      const key = id('KEY');
      const dto = breakdown(assetId);
      await asActor(actor, () => store.claim(CREATE_REQUEST_ENDPOINT, key, dto));
      const dead = (await row(key))?.claim_token;
      await lapse(key);

      const created = (await create(dto, key)) as { id: string };

      expect((await requestsFor(assetId)).map((r) => r.id)).toEqual([created.id]);
      const after = await row(key);
      expect(after?.state).toBe('COMPLETED');
      expect(after?.claim_token).not.toBe(dead);
      expect(await create(dto, key)).toEqual(created);
      expect(await requestsFor(assetId)).toHaveLength(1);
    });
  });
});

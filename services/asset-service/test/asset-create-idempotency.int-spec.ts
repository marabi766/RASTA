import {
  Module,
  VersioningType,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ulid } from 'ulid';
import { AllExceptionsFilter, RolesGuard, runWithContext } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { AssetController, CREATE_ASSET_ENDPOINT } from '../src/asset/asset.controller';
import { IN_FLIGHT_WAIT_MS, IdempotencyStore } from '../src/asset/idempotency';
import { InsuranceService } from '../src/insurance/insurance.service';
import { ClaimService } from '../src/insurance/claim.service';
import type { AssetView, CreateAssetDto } from '../src/asset/dto';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * Idempotency-Key on POST /v1/assets (#169, docs/06 § 6.8), against real
 * PostgreSQL. The controller is driven with the real service and store — and,
 * for the header and the role check, behind a real HTTP stack — so every claim
 * is about what the database holds: how many assets exist, how many
 * ASSET_CREATED events wait in the outbox, and what each caller was answered.
 *
 * The registrations carry neither tag nor serial number: those have unique
 * indexes of their own, and the defect was precisely that without them a
 * retried registration created a second machine.
 */
const LEASE_SECONDS = 120;

describe('asset registration under an Idempotency-Key', () => {
  let prisma: PrismaService;
  let assets: AssetService;
  let store: IdempotencyStore;
  let controller: AssetController;
  let http: INestApplication;

  const org = tenants();
  const manager = { organizationId: org.a, userId: 'USR-ITEST-MANAGER' };

  beforeAll(async () => {
    prisma = newPrisma();
    assets = new AssetService(new AssetRepository(prisma));
    store = new IdempotencyStore(prisma, {
      ASSET_IDEMPOTENCY_TTL_HOURS: 24,
      ASSET_IDEMPOTENCY_CLAIM_LEASE_SECONDS: LEASE_SECONDS,
    });
    controller = new AssetController(assets, {} as never, {} as never, store);

    // The same controller, service and store behind a real HTTP stack: the
    // platform's role guard and exception filter, and the caller's context set
    // by a middleware as `RequestContextMiddleware` does. The test names the
    // caller's organization, user and roles in headers of its own.
    const withCaller = (
      req: { headers: Record<string, string | undefined> },
      _res: unknown,
      next: () => void,
    ) => {
      runWithContext(
        {
          correlationId: `itest-${ulid()}`,
          requestId: `itest-${ulid()}`,
          organizationId: req.headers['x-test-org'] ?? org.a,
          userId: req.headers['x-test-user'] ?? manager.userId,
          roles: (req.headers['x-test-roles'] ?? 'FLEET_MANAGER').split(','),
          organizationIds: [],
          authType: 'USER',
          startedAt: Date.now(),
        },
        () => next(),
      );
    };
    @Module({
      controllers: [AssetController],
      providers: [
        { provide: AssetService, useValue: assets },
        { provide: InsuranceService, useValue: {} },
        { provide: ClaimService, useValue: {} },
        { provide: IdempotencyStore, useValue: store },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
    class HttpModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(withCaller).forRoutes('*');
      }
    }
    const moduleRef = await Test.createTestingModule({ imports: [HttpModule] }).compile();
    http = moduleRef.createNestApplication();
    http.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    http.useGlobalFilters(
      new AllExceptionsFilter({
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      } as never),
    );
    await http.init();
  });

  afterAll(async () => {
    await http?.close();
    const orgs = [org.a, org.b];
    for (const table of [
      'outbox_message',
      'idempotency_key',
      'asset_timeline_entry',
      'asset_location',
      'asset',
    ]) {
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id = ANY($1::text[])`,
        orgs,
      );
    }
    await prisma.onModuleDestroy();
  });

  /** A registration with neither tag nor serial: only the key can tell a retry apart. */
  const machine = (name = `لودر ${ulid().slice(-6)}`): CreateAssetDto => ({
    name,
    type: 'LOADER',
    specifications: {},
  });

  const create = (
    dto: CreateAssetDto,
    key: string | undefined,
    actor: { organizationId: string; userId: string } = manager,
  ) => asActor(actor, () => controller.create(dto, key));

  const assetsNamed = (name: string) =>
    prisma.client.$queryRawUnsafe<{ id: string; organization_id: string }[]>(
      'SELECT id, organization_id FROM asset WHERE name = $1 ORDER BY id',
      name,
    );

  const createdEvents = (assetIds: string[]) =>
    prisma.client
      .$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM outbox_message
         WHERE event_name = 'ASSET_CREATED' AND aggregate_id = ANY($1::text[])`,
        assetIds,
      )
      .then((rows) => rows[0]?.n ?? 0);

  const keyRow = (organizationId: string, key: string) =>
    prisma.client.$queryRawUnsafe<{ state: string; claim_token: string; secs: number }[]>(
      `SELECT state, claim_token, extract(epoch FROM (expires_at - now()))::float AS secs
       FROM idempotency_key WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
      organizationId,
      CREATE_ASSET_ENDPOINT,
      key,
    );

  const lapse = (key: string, organizationId = org.a) =>
    prisma.client.$executeRawUnsafe(
      `UPDATE idempotency_key SET expires_at = now() - interval '1 second'
       WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
      organizationId,
      CREATE_ASSET_ENDPOINT,
      key,
    );

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** A gate a test opens by hand, and a signal that something reached it. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    return { open, opened, reach, reached };
  }

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

  describe('a retry', () => {
    it('replays the original 201 — the same asset — and registers and publishes nothing more', async () => {
      const dto = machine();
      const key = id('KEY');

      const original = await create(dto, key);
      const retry = await create(dto, key);

      expect(retry).toEqual(original);
      const rows = await assetsNamed(dto.name);
      expect(rows.map((row) => row.id)).toEqual([original.id]);
      expect(await createdEvents([original.id])).toBe(1);
      expect((await keyRow(org.a, key))[0]?.state).toBe('COMPLETED');
    });

    it('is refused with a different body, and registers nothing', async () => {
      const dto = machine();
      const key = id('KEY');
      const original = await create(dto, key);

      await expect(create({ ...dto, model: 'another model' }, key)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([original.id]);
    });

    it.each(['__proto__', 'constructor'])(
      'is refused when only a %s key in the free JSON differs, and registers nothing',
      async (name) => {
        // JSON.parse makes `name` an own key, as the request body parser does.
        const withValue = (x: number): CreateAssetDto => ({
          ...dto,
          specifications: { engine: JSON.parse(`{"${name}":{"x":${x}}}`) as unknown },
        });
        const dto = machine();
        const key = id('KEY');
        const original = await create(withValue(1), key);

        await expect(create(withValue(2), key)).rejects.toMatchObject({
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
        expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([original.id]);
        // The same body is still recognised as the retry it is.
        expect(await create(withValue(1), key)).toEqual(original);
      },
    );

    it('is refused from another user of the same organization, who learns nothing of the first', async () => {
      const dto = machine();
      const key = id('KEY');
      const original = await create(dto, key);

      const refusal = await create(dto, key, {
        organizationId: org.a,
        userId: 'USR-ITEST-SOMEONE-ELSE',
      }).catch((error: unknown) => error);

      expect(refusal).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      // No asset id, no name: nothing of the stored response in the refusal.
      expect(JSON.stringify(refusal)).not.toContain(original.id);
      expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([original.id]);
    });

    it('releases the key when the registration fails, so a corrected retry can run', async () => {
      const serial = `SN-ITEST-${ulid()}`;
      const holder = await create({ ...machine(), serialNumber: serial }, id('KEY'));
      const dto = { ...machine(), serialNumber: serial };
      const key = id('KEY');

      await expect(create(dto, key)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      expect(await keyRow(org.a, key)).toEqual([]);

      const corrected = await create({ ...dto, serialNumber: undefined }, key);
      expect(corrected.id).not.toBe(holder.id);
    });
  });

  describe('tenant isolation', () => {
    it('keeps keys per organization: tenant B cannot replay tenant A’s key, it registers its own', async () => {
      const dto = machine();
      const key = id('KEY');

      const inA = await create(dto, key, { organizationId: org.a, userId: manager.userId });
      const inB = await create(dto, key, { organizationId: org.b, userId: manager.userId });

      expect(inB.id).not.toBe(inA.id);
      expect(inB.organizationId).toBe(org.b);
      expect((await assetsNamed(dto.name)).map((row) => row.organization_id).sort()).toEqual(
        [org.a, org.b].sort(),
      );
      expect(await keyRow(org.a, key)).toHaveLength(1);
      expect(await keyRow(org.b, key)).toHaveLength(1);
      // And B's own retry replays B's asset, never A's.
      expect(await create(dto, key, { organizationId: org.b, userId: manager.userId })).toEqual(
        inB,
      );
    });
  });

  describe('a concurrent double submit', () => {
    it('blocks the duplicate on the first request’s claim, then answers it the same 201: one asset, one event', async () => {
      const dto = machine();
      const key = id('KEY');
      const a = gate();

      // A has claimed and holds its transaction's first statement — the
      // claim's row lock — open.
      const first = asActor(manager, () =>
        store.execute<AssetView>(CREATE_ASSET_ENDPOINT, key, dto, 201, (fence) =>
          assets.create(dto, {
            hold: async (tx) => {
              await fence.hold(tx);
              a.reach();
              await a.opened;
            },
            complete: fence.complete,
          }),
        ),
      );
      await a.reached;

      // B, the same registration, arrives now and waits on A's lock.
      const duplicate = create(dto, key);
      await untilBlocked('%idempotency_key%FOR SHARE%');
      expect(await assetsNamed(dto.name)).toEqual([]);

      a.open();
      const original = (await first).result;
      expect(await duplicate).toEqual(original);
      expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([original.id]);
      expect(await createdEvents([original.id])).toBe(1);
    });

    it('gives up waiting on a holder still inside its transaction after the bound: retryable 409, nothing registered', async () => {
      const dto = machine();
      const key = id('KEY');
      await asActor(manager, () => store.claim(CREATE_ASSET_ENDPOINT, key, dto));
      const held = gate();

      // A holder inside its transaction, holding the claim row's lock longer
      // than a duplicate waits (a registration's own transaction cannot: its
      // 5 s timeout ends it first, so this stands in for one).
      const holder = prisma.transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT 1 FROM idempotency_key
             WHERE organization_id = $1 AND endpoint = $2 AND key = $3 FOR UPDATE`,
            org.a,
            CREATE_ASSET_ENDPOINT,
            key,
          );
          held.reach();
          await held.opened;
        },
        { timeoutMs: 20_000 },
      );
      await held.reached;

      // B waits on that lock until its lock_timeout ends the wait.
      const started = Date.now();
      await expect(create(dto, key)).rejects.toMatchObject({
        code: 'CONFLICT',
        retryAfterSeconds: 1,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(await assetsNamed(dto.name)).toEqual([]);

      held.open();
      await holder;
      expect((await keyRow(org.a, key))[0]?.state).toBe('IN_PROGRESS');
    }, 20_000);

    it('bounds the takeover of a lapsed claim too: a holder that keeps its lock gets a retryable 409, not a hang', async () => {
      const dto = machine();
      const key = id('KEY');
      await asActor(manager, () => store.claim(CREATE_ASSET_ENDPOINT, key, dto));
      await lapse(key);
      const held = gate();

      // A holder that keeps the lapsed claim's row lock past any request's
      // budget. The retry sees the lapsed row and tries to remove it; that
      // removal waits on the lock — for the remaining budget, never longer.
      const holder = prisma.transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT 1 FROM idempotency_key
             WHERE organization_id = $1 AND endpoint = $2 AND key = $3 FOR UPDATE`,
            org.a,
            CREATE_ASSET_ENDPOINT,
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
      expect(waited).toBeGreaterThanOrEqual(4_000);
      expect(waited).toBeLessThan(IN_FLIGHT_WAIT_MS + 2_500);
      expect(await assetsNamed(dto.name)).toEqual([]);

      // Once the holder lets go, the next retry takes the lapsed claim over.
      held.open();
      await holder;
      const taken = await create(dto, key);
      expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([taken.id]);
    }, 30_000);

    it('lets two Promise.all submits register exactly one asset', async () => {
      const dto = machine();
      const key = id('KEY');

      const [x, y] = await Promise.all([create(dto, key), create(dto, key)]);

      expect(y).toEqual(x);
      expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([x.id]);
      expect(await createdEvents([x.id])).toBe(1);
    });

    it('cannot re-take a claim that lapses under a running registration: its removal waits on the lock, then replays', async () => {
      const dto = machine();
      const key = id('KEY');
      const a = gate();
      const LIFETIME_MS = 1_500;

      // A's lease is about to lapse as A's transaction takes the claim.
      const first = asActor(manager, () =>
        store.execute<AssetView>(CREATE_ASSET_ENDPOINT, key, dto, 201, async (fence) => {
          await prisma.client.$executeRawUnsafe(
            `UPDATE idempotency_key SET expires_at = now() + make_interval(secs => $3)
             WHERE organization_id = $1 AND key = $2`,
            org.a,
            key,
            LIFETIME_MS / 1000,
          );
          return assets.create(dto, {
            hold: async (tx) => {
              await fence.hold(tx);
              a.reach();
              await a.opened;
            },
            complete: fence.complete,
          });
        }),
      );
      await a.reached;
      await sleep(LIFETIME_MS + 200);

      // The lease has lapsed while A holds the row. The retry's removal of the
      // lapsed row must wait for A's lock...
      const retry = create(dto, key);
      await untilBlocked('DELETE FROM%idempotency_key%');

      // ...and, once A commits with a fresh lifetime, find the response to replay.
      a.open();
      const original = (await first).result;
      expect(await retry).toEqual(original);
      expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([original.id]);
      expect(await createdEvents([original.id])).toBe(1);
    });
  });

  describe('a claim left behind by a process that died', () => {
    it('is held for the lease while in flight and for the configured hours once completed', async () => {
      const dto = machine();
      const key = id('KEY');
      await asActor(manager, () => store.claim(CREATE_ASSET_ENDPOINT, key, dto));
      const [claimed] = await keyRow(org.a, key);
      expect(claimed?.state).toBe('IN_PROGRESS');
      expect(claimed?.secs).toBeGreaterThan(LEASE_SECONDS - 30);
      expect(claimed?.secs).toBeLessThanOrEqual(LEASE_SECONDS);

      const done = id('KEY');
      await create(machine(), done);
      const [completed] = await keyRow(org.a, done);
      expect(completed?.state).toBe('COMPLETED');
      expect(completed?.secs).toBeGreaterThan(23 * 3_600);
    });

    it('answers a retry inside the lease with a retryable 409 and registers nothing', async () => {
      const dto = machine();
      const key = id('KEY');
      await asActor(manager, () => store.claim(CREATE_ASSET_ENDPOINT, key, dto));

      await expect(create(dto, key)).rejects.toMatchObject({
        code: 'CONFLICT',
        retryAfterSeconds: 1,
      });
      expect(await assetsNamed(dto.name)).toEqual([]);
    }, 20_000);

    it('is taken over once the lease lapsed, under a new token; the dead holder’s late completion is refused', async () => {
      const dto = machine();
      const key = id('KEY');
      const holder = gate();

      // The holder claims and stalls before its transaction — alive, but slow
      // past its lease, which is all a crashed-and-resumed process looks like.
      const late = asActor(manager, () =>
        store.execute<AssetView>(CREATE_ASSET_ENDPOINT, key, dto, 201, async (fence) => {
          holder.reach();
          await holder.opened;
          return assets.create(dto, fence);
        }),
      ).then(
        (outcome) => ({ outcome }),
        (error: unknown) => ({ error }),
      );
      await holder.reached;
      const [{ claim_token: holderToken }] = await keyRow(org.a, key);

      // Its lease lapses and a retry takes over and registers the asset.
      await lapse(key);
      const retried = await create(dto, key);
      const [after] = await keyRow(org.a, key);
      expect(after?.state).toBe('COMPLETED');
      expect(after?.claim_token).not.toBe(holderToken);

      // The holder wakes: its lock on the claim and its response are both
      // matched on a token it no longer has.
      holder.open();
      expect(await late).toEqual({ error: expect.objectContaining({ code: 'CONFLICT' }) });

      expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([retried.id]);
      expect(await createdEvents([retried.id])).toBe(1);
      expect(await create(dto, key)).toEqual(retried);
    });

    it('refuses a completion by a stale token even when the lock was never taken', async () => {
      const dto = machine();
      const key = id('KEY');
      await asActor(manager, () => store.claim(CREATE_ASSET_ENDPOINT, key, dto));

      await expect(
        asActor(manager, () =>
          prisma.transaction((tx) =>
            store.storeResponse(tx, CREATE_ASSET_ENDPOINT, key, 'stale-token', 201, { id: 'x' }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await keyRow(org.a, key))[0]?.state).toBe('IN_PROGRESS');
    });

    it('leaves nothing half-done when storing the response fails: no asset, no event, the key free', async () => {
      const dto = machine();
      const key = id('KEY');

      const failing = jest
        .spyOn(store, 'storeResponse')
        .mockRejectedValueOnce(new Error('response store failed (injected)'));
      try {
        await expect(create(dto, key)).rejects.toThrow('response store failed (injected)');
      } finally {
        failing.mockRestore();
      }
      expect(await assetsNamed(dto.name)).toEqual([]);
      expect(await keyRow(org.a, key)).toEqual([]);

      const created = await create(dto, key);
      expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([created.id]);
      expect(await createdEvents([created.id])).toBe(1);
    });
  });

  describe('over HTTP', () => {
    const post = (
      body: object,
      key?: string,
      caller: { org?: string; user?: string; roles?: string } = {},
    ) => {
      let call = request(http.getHttpServer()).post('/v1/assets');
      if (key !== undefined) call = call.set('Idempotency-Key', key);
      if (caller.org) call = call.set('x-test-org', caller.org);
      if (caller.user) call = call.set('x-test-user', caller.user);
      if (caller.roles) call = call.set('x-test-roles', caller.roles);
      return call.send(body);
    };

    it('refuses a registration without a key, or with a malformed one, as 400 and registers nothing', async () => {
      const dto = machine();

      const missing = await post(dto);
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('VALIDATION_FAILED');
      expect(missing.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'Idempotency-Key', code: 'required' }),
        ]),
      );
      for (const bad of ['   ', 'short', 'x'.repeat(256)]) {
        const refused = await post(dto, bad);
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await assetsNamed(dto.name)).toEqual([]);
    });

    it('registers once however often the same request is posted, and answers 201 with the same asset', async () => {
      const dto = machine();
      const key = id('KEY');

      const first = await post(dto, key);
      const second = await post(dto, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect((await assetsNamed(dto.name)).map((row) => row.id)).toEqual([first.body.id]);
    });

    it('refuses a body that differs only in a nested __proto__ key: 409 IDEMPOTENCY_KEY_REUSED, one asset', async () => {
      const name = `لودر ${ulid().slice(-6)}`;
      const raw = (x: number) =>
        `{"name":"${name}","type":"LOADER","specifications":{"engine":{"__proto__":{"x":${x}}}}}`;
      const key = id('KEY');
      const send = (x: number) =>
        request(http.getHttpServer())
          .post('/v1/assets')
          .set('Idempotency-Key', key)
          .set('content-type', 'application/json')
          .send(raw(x));

      const first = await send(1);
      expect(first.status).toBe(201);
      const second = await send(2);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await assetsNamed(name)).map((row) => row.id)).toEqual([first.body.id]);
    });

    it('answers another user’s reuse of a key 409 with no trace of the stored response', async () => {
      const dto = machine();
      const key = id('KEY');
      const first = await post(dto, key);

      const reused = await post(dto, key, { user: 'USR-ITEST-SOMEONE-ELSE' });
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(JSON.stringify(reused.body)).not.toContain(first.body.id);
      expect(JSON.stringify(reused.body)).not.toContain(dto.name);
    });

    it('checks the role before any replay: a caller who may not register gets 403, never the stored asset', async () => {
      const dto = machine();
      const key = id('KEY');
      const first = await post(dto, key, { user: 'USR-ITEST-DEMOTED' });
      expect(first.status).toBe(201);

      // The same user, the same key and body — but no longer a registering role.
      const demoted = await post(dto, key, { user: 'USR-ITEST-DEMOTED', roles: 'DRIVER' });
      expect(demoted.status).toBe(403);
      expect(JSON.stringify(demoted.body)).not.toContain(first.body.id);
    });

    it('answers a duplicate still in flight with 409 CONFLICT and Retry-After', async () => {
      const dto = machine();
      const key = id('KEY');
      await asActor(manager, () => store.claim(CREATE_ASSET_ENDPOINT, key, dto));

      const busy = await post(dto, key);
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('CONFLICT');
      expect(busy.headers['retry-after']).toBe('1');
      expect(await assetsNamed(dto.name)).toEqual([]);
    }, 20_000);
  });
});

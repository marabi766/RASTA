import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { PrismaClient as Owner } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseClock } from '../src/shared/clock';
import { IdempotencyStore, idempotentRequest } from '../src/shared/idempotency';
import { actor, client, key, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import {
  cleanup,
  newOrderLineId,
  newOrderReference,
  newOrganizationId,
  newProductId,
  newReturnRequestId,
  ownerDatabaseUrl,
  runtimeClient,
} from './helpers';

/**
 * The replay fence (FU-171, PM decision D-133; #844's pattern with PR-844 r1 F1 closed): every keyed
 * command reads `Idempotency-Replay-Deadline` through the one store, and a request past it — or asking
 * for more than the retention can keep — is refused before anything is executed. A warehouse is the
 * probe: unlike a stock movement or a shipment it has no `command_key_hash` backstop, so the record's
 * expiry is all that stands between a delayed retry and a second write.
 */
describe('Idempotency-Replay-Deadline', () => {
  let api: ApiHarness;
  const raw = runtimeClient();
  const owner = new Owner({ datasources: { db: { url: ownerDatabaseUrl() } } });
  const organizations: string[] = [];
  const DEADLINE = 'idempotency-replay-deadline';
  /** B with the default skew: 2 · 30 s + 7 s. */
  const BUDGET_MS = 67_000;
  /** The default retention (INVENTORY_IDEMPOTENCY_TTL_HOURS = 24). */
  const TTL_MS = 24 * 3_600_000;
  const ENDPOINT = 'POST /v1/warehouses';
  const BODY = { name: 'Central warehouse' };

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const warehousesOf = (organizationId: string) =>
    raw.warehouse.count({ where: { organizationId } });
  const keysOf = (organizationId: string) =>
    raw.idempotencyKey.findMany({ where: { organizationId } });
  const waitUntilPast = async (instantMs: number) => {
    while (Date.now() <= instantMs) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, instantMs - Date.now() + 5)));
    }
  };
  /** The retention elapses: the stored response is reclaimable, as a purge or a takeover finds it. */
  const expireKeysOf = (organizationId: string) =>
    owner.idempotencyKey.updateMany({
      where: { organizationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
  /** A store on the real database, whose database clock the test sets. */
  const storeReading = (clock: (db: Parameters<typeof databaseClock>[0]) => Promise<Date>) =>
    new IdempotencyStore(
      api.app.get(PrismaService),
      {
        INVENTORY_IDEMPOTENCY_TTL_HOURS: 24,
        INVENTORY_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120,
        INVENTORY_CLOCK_SKEW_SECONDS: 30,
      },
      () => undefined,
      clock,
    );
  const contextOf = (organizationId: string) =>
    createSystemContext({ correlationId: key(), organizationId, userId: 'USR-REPLAY-00000001' });
  const headers = (k: string, deadlineMs: number) => ({
    'idempotency-key': k,
    [DEADLINE]: String(deadlineMs),
  });

  beforeAll(async () => {
    api = await startApi();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await owner.$disconnect();
    await api.close();
  });

  it('delayed-retry probe: a retry past the retention is refused, never a second warehouse', async () => {
    const a = org();
    const as = client(api, orgAdmin(a));
    const k = key();
    const deadline = String(Date.now() + 1_500);

    const first = await as.post('/v1/warehouses', BODY, k).set(DEADLINE, deadline);
    expect(first.status).toBe(201);
    const [stored] = await keysOf(a);
    // Kept at least B past the deadline, whatever the retention.
    expect(stored!.expiresAt.getTime()).toBeGreaterThanOrEqual(Number(deadline) + BUDGET_MS);

    await expireKeysOf(a);
    await waitUntilPast(Number(deadline));

    // The same request, same key, same deadline — delayed before admission.
    const retry = await as.post('/v1/warehouses', BODY, k).set(DEADLINE, deadline);
    expect({
      status: retry.status,
      code: retry.body.code,
      warehouses: await warehousesOf(a),
    }).toEqual({ status: 409, code: 'REPLAY_WINDOW_CLOSED', warehouses: 1 });
    // Nothing was written by the refused attempt: the old row is untouched.
    expect((await keysOf(a)).map((row) => row.claimToken)).toEqual([stored!.claimToken]);

    // The record gone altogether is no way in either.
    expect(await api.app.get(IdempotencyStore).purgeExpired()).toBeGreaterThanOrEqual(1);
    const afterPurge = await as.post('/v1/warehouses', BODY, k).set(DEADLINE, deadline);
    expect(afterPurge.status).toBe(409);
    expect(await warehousesOf(a)).toBe(1);
    expect(await keysOf(a)).toEqual([]);
  });

  it('D-133: no header, no fence — an expired key is still reusable, for now', async () => {
    const a = org();
    const as = client(api, orgAdmin(a));
    const k = key();
    expect((await as.post('/v1/warehouses', BODY, k)).status).toBe(201);
    await expireKeysOf(a);
    expect((await as.post('/v1/warehouses', BODY, k)).status).toBe(201);
    expect(await warehousesOf(a)).toBe(2);
  });

  it('admits on the database clock inside the insert’s transaction: past it rolls the claim back; equality is admitted', async () => {
    const a = org();
    const deadline = Date.now() + 60_000;
    const work = jest.fn();

    // This replica's clock passes the check; the database clock read after the insert does not (a
    // request suspended between the two). The reading is the real statement on the real
    // transaction, offset: it must run on the connection that holds the insert.
    const late = await runWithContext(contextOf(a), () =>
      storeReading(async (db) => {
        const inserted = await db.idempotencyKey.count({ where: { organizationId: a } });
        expect(inserted).toBe(1);
        return new Date(deadline + 1);
      }).execute(ENDPOINT, idempotentRequest(headers(key(), deadline)), BODY, 201, work, jest.fn()),
    ).catch((error: unknown) => error);
    expect(late).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(work).not.toHaveBeenCalled();
    expect(await keysOf(a)).toEqual([]);

    const onTime = await runWithContext(contextOf(a), () =>
      storeReading(async () => new Date(deadline)).claim(ENDPOINT, key(), BODY, deadline),
    );
    expect(onTime.kind).toBe('PROCEED');
    expect(await keysOf(a)).toHaveLength(1);
  });

  it('replay wait, on a real row: a stored response the database clock has passed is refused, the row untouched', async () => {
    const a = org();
    const k = key();
    const deadline = Date.now() + 60_000;
    const first = await client(api, orgAdmin(a))
      .post('/v1/warehouses', BODY, k)
      .set(DEADLINE, String(deadline));
    expect(first.status).toBe(201);
    const before = await keysOf(a);

    const visible = jest.fn();
    const work = jest.fn();
    const context = contextOf(a);
    // This caller's hash is its own: give the row the store's reading of it, so only the clock decides.
    const store = storeReading(async () => new Date(deadline + 1));
    await owner.idempotencyKey.updateMany({
      where: { organizationId: a },
      data: { requestHash: runWithContext(context, () => store.hash(BODY)) },
    });
    const late = await runWithContext(context, () =>
      store.execute(ENDPOINT, idempotentRequest(headers(k, deadline)), BODY, 201, work, visible),
    ).catch((error: unknown) => error);
    expect(late).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(visible).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect((await keysOf(a)).map((row) => row.claimToken)).toEqual(
      before.map((row) => row.claimToken),
    );
    expect(await warehousesOf(a)).toBe(1);
  });

  it('a duplicate waiting on the holder past its deadline is refused, not answered', async () => {
    const a = org();
    const k = key();
    const store = storeReading(databaseClock);
    const prisma = api.app.get(PrismaService);
    const holderHolds = (() => {
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { gate, open };
    })();
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const context = contextOf(a);
    const holder = runWithContext(context, () =>
      store.execute(
        ENDPOINT,
        idempotentRequest({ 'idempotency-key': k }),
        BODY,
        201,
        (fence) =>
          prisma.transaction(
            async (tx) => {
              await fence.hold(tx);
              locked();
              await holderHolds.gate;
              return fence.complete(tx, { id: 'WHS_first' });
            },
            { timeoutMs: 30_000, maxWaitMs: 10_000 },
          ),
        jest.fn(),
      ),
    );
    await lockTaken;

    const deadline = Date.now() + 300;
    const duplicate = runWithContext(context, () =>
      store.execute(
        ENDPOINT,
        idempotentRequest(headers(k, deadline)),
        BODY,
        201,
        jest.fn(),
        jest.fn(),
      ),
    ).catch((error: unknown) => error);
    await waitUntilPast(deadline + 100);
    holderHolds.open();

    expect(await duplicate).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(await holder).toEqual({ result: { id: 'WHS_first' }, executed: true });
  });

  it('refuses a deadline later than the retention less B with 400 beyond_retention, nothing written; accepts one inside it', async () => {
    const a = org();
    const as = client(api, orgAdmin(a));

    const tooLate = await as
      .post('/v1/warehouses', BODY, key())
      .set(DEADLINE, String(Date.now() + TTL_MS - BUDGET_MS + 60_000));
    expect(tooLate.status).toBe(400);
    expect(tooLate.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'Idempotency-Replay-Deadline', code: 'beyond_retention' }],
    });
    expect(await keysOf(a)).toEqual([]);
    expect(await warehousesOf(a)).toBe(0);

    const inside = Date.now() + TTL_MS - BUDGET_MS - 60_000;
    const accepted = await as.post('/v1/warehouses', BODY, key()).set(DEADLINE, String(inside));
    expect(accepted.status).toBe(201);
    const [row] = await keysOf(a);
    expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(inside + BUDGET_MS);
  });

  it('refuses a malformed deadline with 400 invalid before any claim', async () => {
    const a = org();
    const response = await client(api, orgAdmin(a))
      .post('/v1/warehouses', BODY, key())
      .set(DEADLINE, '01700000000000');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: [{ path: 'Idempotency-Replay-Deadline', code: 'invalid' }],
    });
    expect(await keysOf(a)).toEqual([]);
  });

  it('a stored response is not replayed past its deadline; before it, it is', async () => {
    const a = org();
    const as = client(api, orgAdmin(a));
    const k = key();
    const deadline = String(Date.now() + 1_500);
    const first = await as.post('/v1/warehouses', BODY, k).set(DEADLINE, deadline);
    expect(first.status).toBe(201);
    const again = await as.post('/v1/warehouses', BODY, k).set(DEADLINE, deadline);
    expect({ status: again.status, id: again.body.id }).toEqual({
      status: 201,
      id: first.body.id,
    });
    await waitUntilPast(Number(deadline));
    const replay = await as.post('/v1/warehouses', BODY, k).set(DEADLINE, deadline);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(await warehousesOf(a)).toBe(1);
  });

  it('the inventory policy decides first: a caller it refuses gets its 403, not the deadline’s answer', async () => {
    const a = org();
    const refused = await client(api, actor(a, ['DRIVER']))
      .post('/v1/warehouses', BODY, key())
      .set(DEADLINE, String(Date.now() - 1));
    expect(refused.status).toBe(403);
    expect(await keysOf(a)).toEqual([]);
  });

  it('keeps organizations apart: another organization’s closed deadline touches nothing here', async () => {
    const a = org();
    const b = org();
    const k = key();
    const first = await client(api, orgAdmin(a))
      .post('/v1/warehouses', BODY, k)
      .set(DEADLINE, String(Date.now() + 60_000));
    expect(first.status).toBe(201);
    const closed = await client(api, orgAdmin(b))
      .post('/v1/warehouses', BODY, k)
      .set(DEADLINE, String(Date.now() - 1));
    expect(closed.status).toBe(409);
    expect(await keysOf(b)).toEqual([]);
    expect(await keysOf(a)).toHaveLength(1);
    expect(await warehousesOf(b)).toBe(0);
  });

  it('is enforced by every keyed command the API publishes, before its work', async () => {
    const a = org();
    const as = client(api, orgAdmin(a));
    const past = String(Date.now() - 1);
    const warehouseId = 'WHS_00000000000000000000000000';
    const stockItemId = 'SKI_00000000000000000000000000';
    const missing = '00000000000000000000000000';
    const orderLineId = newOrderLineId();
    const version = { expectedVersion: 1 };
    const commands: Record<string, [string, object]> = {
      'POST /v1/warehouses': ['/v1/warehouses', BODY],
      'POST /v1/stock/receipts': [
        '/v1/stock/receipts',
        { warehouseId, productId: newProductId(), quantity: 1 },
      ],
      'POST /v1/stock/adjustments': ['/v1/stock/adjustments', { stockItemId, quantityDelta: 1 }],
      'POST /v1/stock/reservations': [
        '/v1/stock/reservations',
        { lines: [{ stockItemId, quantity: 1 }] },
      ],
      'POST /v1/stock/reservations/{id}/release': [
        `/v1/stock/reservations/RSV_${missing}/release`,
        version,
      ],
      'POST /v1/stock/reservations/{id}/issue': [
        `/v1/stock/reservations/RSV_${missing}/issue`,
        version,
      ],
      'POST /v1/shipments': [
        '/v1/shipments',
        {
          originWarehouseId: warehouseId,
          consigneeOrganizationId: newOrganizationId(),
          legs: [{ carrierName: 'Carrier' }],
        },
      ],
      'POST /v1/shipments/{id}/dispatch': [`/v1/shipments/SHP_${missing}/dispatch`, version],
      'POST /v1/shipments/{id}/deliver': [`/v1/shipments/SHP_${missing}/deliver`, version],
      'POST /v1/return-shipments': [
        '/v1/return-shipments',
        {
          returnRequestId: newReturnRequestId(),
          orderId: newOrderReference(),
          buyerOrganizationId: newOrganizationId(),
          destinationWarehouseId: warehouseId,
          lines: [{ orderLineId, productId: newProductId(), quantity: 1 }],
        },
      ],
      'POST /v1/return-shipments/{id}/receive': [
        `/v1/return-shipments/RSH_${missing}/receive`,
        { ...version, lines: [{ orderLineId, receivedQuantity: 1 }] },
      ],
      'POST /v1/return-shipments/{id}/inspection': [
        `/v1/return-shipments/RSH_${missing}/inspection`,
        version,
      ],
      'POST /v1/return-shipments/{id}/resolution': [
        `/v1/return-shipments/RSH_${missing}/resolution`,
        { ...version, dispositions: [{ orderLineId, disposition: 'SCRAP', quantity: 1 }] },
      ],
    };

    // The list is the published one: a new keyed command cannot stay out of this test.
    const document = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'docs', 'api', 'inventory-service.openapi.json'),
        'utf8',
      ),
    ) as {
      paths: Record<string, Record<string, { parameters?: { name?: string }[] }>>;
    };
    const keyed = Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([, operation]) =>
          (operation.parameters ?? []).some((parameter) => parameter.name === 'Idempotency-Key'),
        )
        .map(([method]) => `${method.toUpperCase()} ${path.replace(/^\/api/, '')}`),
    );
    expect(Object.keys(commands).sort()).toEqual(keyed.sort());

    for (const [command, [path, body]] of Object.entries(commands)) {
      const response = await as.post(path, body).set(DEADLINE, past);
      expect({ command, status: response.status, code: response.body.code }).toEqual({
        command,
        status: 409,
        code: 'REPLAY_WINDOW_CLOSED',
      });
    }
    expect(await keysOf(a)).toEqual([]);
  });
});

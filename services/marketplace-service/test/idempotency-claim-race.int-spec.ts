import request from 'supertest';
import type { Server } from 'node:http';
import { createSystemContext, runUnscoped, runWithContext } from '@rasta/nest-common';
import { IdempotencyStore } from '../src/shared/idempotency';
import type { PrismaService } from '../src/prisma/prisma.service';
import { apiKey, apiTenant, buyer, startApi, supplier, type ApiHarness } from './api-helpers';
import { cleanup } from './helpers';

/**
 * The claim race of review #141, against the real database and the real
 * `POST /v1/orders`, with the one interleaving that matters forced every run:
 *
 *   A claims key K  →  B's insert of K loses to A's row
 *                   →  A's attempt fails and releases K
 *                   →  B reads K, and finds nothing there
 *
 * B reserved nothing. It used to proceed anyway, so its completion matched no
 * row, K stayed free, and the next request with K — C — claimed it and placed
 * a second order (an order's `idempotencyKey` was not unique then). The rule
 * this pins: `PROCEED` only from an insert this request made itself.
 *
 * And a key record lost under a committed order: the response is now stored in
 * the order's own transaction, so a failed store leaves no order behind
 * (`idempotency-response-in-transaction.int-spec.ts`); should a completed
 * record still be lost — expired and purged — `uq_order_org_idempotency_key`
 * refuses a second order as a 409.
 */
describe('an Idempotency-Key whose claim vanishes under a request (real database)', () => {
  let harness: ApiHarness;
  let http: Server;
  let store: IdempotencyStore;

  const buyerOrg = apiTenant('RACE-BUY');
  const supplierOrg = apiTenant('RACE-SUP');
  const ENDPOINT = 'POST /v1/orders';

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    store = harness.app.get(IdempotencyStore);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [buyerOrg, supplierOrg]);
    await harness.close();
  });

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(
      createSystemContext({ correlationId: 'race-actor-a', organizationId: buyerOrg }),
      fn,
    );

  /**
   * Runs `between` once, at the store's next read of an idempotency row —
   * after that request's insert has lost, before it sees what it lost to.
   * Everything else reaches the real client unchanged.
   */
  function betweenLostInsertAndRead(between: () => Promise<void>): () => void {
    const holder = store as unknown as { prisma: PrismaService };
    const real = holder.prisma;
    const delegate = real.client.idempotencyKey;
    let fired = false;
    const idempotencyKey = new Proxy(delegate, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property === 'findUnique' && !fired) {
          const findUnique = value as (args: unknown) => Promise<unknown>;
          return async (args: unknown) => {
            fired = true;
            await between();
            return findUnique.call(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const client = new Proxy(real.client, {
      get: (target, property) =>
        property === 'idempotencyKey' ? idempotencyKey : Reflect.get(target, property),
    });
    holder.prisma = { client } as unknown as PrismaService;
    return () => {
      holder.prisma = real;
    };
  }

  async function publishOffer(): Promise<string> {
    const asSupplier = `Bearer ${supplier(supplierOrg)}`;
    const product = await request(http)
      .post('/v1/products')
      .set('idempotency-key', apiKey('catalogue'))
      .set('authorization', asSupplier)
      .send({
        sku: `RACE-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);
    const offer = await request(http)
      .post('/v1/offers')
      .set('idempotency-key', apiKey('catalogue'))
      .set('authorization', asSupplier)
      .send({
        productId: product.body.id,
        unitPriceMinor: '250000',
        currency: 'IRR',
        availableQuantity: 20,
        leadTimeDays: 3,
        minimumQuantity: 1,
        publish: true,
      })
      .expect(201);
    return offer.body.id as string;
  }

  const ordersUnder = (key: string): Promise<number> =>
    runUnscoped('the suite counts the orders one key produced, in its own tenant', () =>
      harness.prisma.client.order.count({
        where: { organizationId: buyerOrg, idempotencyKey: key },
      }),
    );

  it('B retries the insert and owns K; C then replays B — one order, never two', async () => {
    const offerId = await publishOffer();
    const key = apiKey('race-vanish');
    const body = { lines: [{ offerId, quantity: 1 }] };
    const place = () =>
      request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', key)
        .send(body);

    // A holds K, as a first attempt still running would.
    const a = await asTenant(() => store.claim(ENDPOINT, key, body));
    if (a.kind !== 'PROCEED') throw new Error('A should own K');

    // B's insert loses to A's row; A then fails and releases, before B reads.
    const restore = betweenLostInsertAndRead(() =>
      asTenant(() => store.release(ENDPOINT, key, a.token)),
    );
    let b: request.Response;
    try {
      b = await place();
    } finally {
      restore();
    }
    expect(b.status).toBe(201);

    // B completed a claim it inserted itself: K is now B's stored response.
    const row = await runUnscoped('the suite reads the key it raced', () =>
      harness.prisma.client.idempotencyKey.findUnique({
        where: {
          organizationId_endpoint_key: { organizationId: buyerOrg, endpoint: ENDPOINT, key },
        },
      }),
    );
    expect(row?.state).toBe('COMPLETED');

    // C, the next request with K, replays B rather than placing a second order.
    const c = await place();
    expect(c.status).toBe(201);
    expect(c.body.id).toBe(b.body.id);
    expect(await ordersUnder(key)).toBe(1);
  });

  it('A’s claim expires and is purged, B re-claims: A’s late completion is refused and changes nothing', async () => {
    const key = apiKey('race-token');
    const body = { probe: 'token' };
    const rowOf = () =>
      runUnscoped('the suite reads the key whose claim changed hands', () =>
        harness.prisma.client.idempotencyKey.findUnique({
          where: {
            organizationId_endpoint_key: { organizationId: buyerOrg, endpoint: ENDPOINT, key },
          },
        }),
      );
    const completeInTransaction = (token: string, response: unknown) =>
      asTenant(() =>
        harness.prisma.transaction((tx) => store.complete(tx, ENDPOINT, key, token, 201, response)),
      );

    const a = await asTenant(() => store.claim(ENDPOINT, key, body));
    if (a.kind !== 'PROCEED') throw new Error('A should own K');

    // A's claim expires and the purge removes it.
    await runUnscoped('the suite expires the claim, as the clock would', () =>
      harness.prisma.client.idempotencyKey.updateMany({
        where: { organizationId: buyerOrg, endpoint: ENDPOINT, key },
        // `ck_idempotency_expiry`: a row expires after it was created.
        data: { createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await rowOf()).toBeNull();

    // B claims the same key afresh, under a token of its own.
    const b = await asTenant(() => store.claim(ENDPOINT, key, body));
    if (b.kind !== 'PROCEED') throw new Error('B should own K');
    expect(b.token).not.toBe(a.token);

    // A, late, cannot complete B's row: its completion throws, so A's own work
    // would roll back with it — never two commits under one key. Its release
    // frees nothing either.
    await expect(completeInTransaction(a.token, { id: 'from-A' })).rejects.toMatchObject({
      code: 'CONFLICT',
      retryAfterSeconds: 1,
    });
    expect(await rowOf()).toMatchObject({ state: 'IN_PROGRESS', responseStatus: null });
    await asTenant(() => store.release(ENDPOINT, key, a.token));
    expect(await rowOf()).toMatchObject({ state: 'IN_PROGRESS', claimToken: b.token });

    // B completes normally, and A's later release still cannot take it back.
    await completeInTransaction(b.token, { id: 'from-B' });
    await asTenant(() => store.release(ENDPOINT, key, a.token));
    expect(await rowOf()).toMatchObject({
      state: 'COMPLETED',
      responseStatus: 201,
      responseBody: { id: 'from-B' },
    });
  });

  it('defence in depth: a key record lost after its order committed cannot place a second order', async () => {
    const offerId = await publishOffer();
    const key = apiKey('race-lost');
    const body = { lines: [{ offerId, quantity: 1 }] };
    const place = () =>
      request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', key)
        .send(body);

    expect((await place()).status).toBe(201);

    // The completed record is gone (expired and purged, say). The retry claims
    // the key and runs the work again — and the unique index refuses the
    // second order as a conflict, not a 500, and frees the claim.
    await runUnscoped('the suite removes the record, as the expiry purge would', () =>
      harness.prisma.client.idempotencyKey.deleteMany({
        where: { organizationId: buyerOrg, endpoint: ENDPOINT, key },
      }),
    );
    const afterPurge = await place();
    expect(afterPurge.status).toBe(409);
    expect(afterPurge.body).toMatchObject({
      code: 'CONFLICT',
      message: 'An order has already been placed with this Idempotency-Key',
    });
    expect(afterPurge.headers['retry-after']).toBeUndefined();
    expect(await ordersUnder(key)).toBe(1);
    const record = await runUnscoped('the suite reads the key the refusal freed', () =>
      harness.prisma.client.idempotencyKey.findUnique({
        where: {
          organizationId_endpoint_key: { organizationId: buyerOrg, endpoint: ENDPOINT, key },
        },
      }),
    );
    expect(record).toBeNull();
  });
});

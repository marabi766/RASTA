import request from 'supertest';
import type { Server } from 'node:http';
import { IdempotencyStore } from '../src/shared/idempotency';
import { apiKey, apiTenant, buyer, startApi, supplier, type ApiHarness } from './api-helpers';
import { cleanup } from './helpers';

/**
 * docs/06 § 6.8 over real HTTP: a request whose Idempotency-Key is still in
 * flight is answered `409 CONFLICT` with `Retry-After: 1`.
 *
 * The documented promise was never kept — the wait sat in the error's
 * server-side context, and the exception filter sends no header from there.
 * Two requests with one key, the first held **after** its claim committed and
 * **before** its work ran, so the second meets the in-flight row every time:
 * no timing, no seeded row, the real claim of a real first request.
 */
describe('an Idempotency-Key in flight: 409 with Retry-After (real HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;
  let store: IdempotencyStore;

  const buyerOrg = apiTenant('INFLIGHT-BUY');
  const otherBuyerOrg = apiTenant('INFLIGHT-OTH');
  const supplierOrg = apiTenant('INFLIGHT-SUP');

  beforeAll(async () => {
    harness = await startApi();
    // Listening before the first request, so two requests in flight at once
    // share one server rather than each asking supertest to start it.
    await harness.app.listen(0, '127.0.0.1');
    http = harness.app.getHttpServer() as Server;
    store = harness.app.get(IdempotencyStore);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [buyerOrg, otherBuyerOrg, supplierOrg]);
    await harness.close();
  });

  /**
   * Lets the first claim through, then holds that request until released —
   * its key committed `IN_PROGRESS`, its work not yet begun. Later claims pass
   * straight through.
   */
  function holdFirstClaim(): { claimed: Promise<void>; release: () => void; restore: () => void } {
    let signalClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => (signalClaimed = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const original = store.claim.bind(store);
    let held = false;
    const spy = jest.spyOn(store, 'claim').mockImplementation(async (endpoint, key, body) => {
      const outcome = await original(endpoint, key, body);
      if (!held && outcome.kind === 'PROCEED') {
        held = true;
        signalClaimed();
        await released;
      }
      return outcome;
    });
    return { claimed, release, restore: () => spy.mockRestore() };
  }

  async function publishOffer(): Promise<string> {
    const asSupplier = `Bearer ${supplier(supplierOrg)}`;
    const product = await request(http)
      .post('/v1/products')
      .set('authorization', asSupplier)
      .send({
        sku: `INFLIGHT-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);

    const offer = await request(http)
      .post('/v1/offers')
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

  const placeOrder = (organizationId: string, key: string, offerId: string, quantity = 1) =>
    request(http)
      .post('/v1/orders')
      .set('authorization', `Bearer ${buyer(organizationId)}`)
      .set('idempotency-key', key)
      .send({ lines: [{ offerId, quantity }] });

  it('the second of two concurrent requests is told to wait, and the first completes once', async () => {
    const offerId = await publishOffer();
    const key = apiKey('inflight-place');
    const gate = holdFirstClaim();
    const first = placeOrder(buyerOrg, key, offerId).then((response) => response);

    try {
      await gate.claimed;

      const second = await placeOrder(buyerOrg, key, offerId);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        code: 'CONFLICT',
        message: 'This request is already being processed; retry shortly',
      });
      expect(second.headers['retry-after']).toBe('1');
      // The wait is a header, and nothing of the error's context rides along.
      expect(JSON.stringify(second.body)).not.toMatch(/retryAfter|endpoint/);

      // The in-flight row is this tenant's: another organization using the
      // same key is neither told to wait nor given anything of this one.
      const foreign = await placeOrder(otherBuyerOrg, key, offerId);
      expect(foreign.status).toBe(201);
      expect(foreign.headers['retry-after']).toBeUndefined();

      gate.release();
      const done = await first;
      expect(done.status).toBe(201);
      expect(done.headers['retry-after']).toBeUndefined();
      expect(foreign.body.id).not.toBe(done.body.id);

      // The retry the header asked for: the stored response, not a second order.
      const retried = await placeOrder(buyerOrg, key, offerId);
      expect(retried.status).toBe(201);
      expect(retried.body).toEqual(done.body);
      expect(retried.headers['retry-after']).toBeUndefined();
    } finally {
      // Whatever failed above, the held request finishes inside this test:
      // left running, it would outlive the application and hold Jest open.
      gate.release();
      await first.catch(() => undefined);
      gate.restore();
    }
  });

  it('a key reused with another body is refused without Retry-After: waiting will not help', async () => {
    const offerId = await publishOffer();
    const key = apiKey('inflight-reused');
    await placeOrder(buyerOrg, key, offerId).expect(201);

    const reused = await placeOrder(buyerOrg, key, offerId, 2);

    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(reused.headers['retry-after']).toBeUndefined();
  });

  it.each(['__proto__', 'constructor'])(
    'a body carrying a %s key is refused at the boundary, 400, and claims nothing (#194)',
    async (name) => {
      const offerId = await publishOffer();
      const key = apiKey(`proto-${name}`);
      const refused = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', key)
        .set('content-type', 'application/json')
        .send(`{"lines":[{"offerId":"${offerId}","quantity":1}],"${name}":{"x":1}}`);

      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      // Nothing was claimed: the key is still free for a valid request.
      await placeOrder(buyerOrg, key, offerId).expect(201);
    },
  );
});

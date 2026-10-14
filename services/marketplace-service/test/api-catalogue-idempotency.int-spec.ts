import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { apiKey, apiTenant, startApi, supplier, type ApiHarness } from './api-helpers';
import { cleanup } from './helpers';

/**
 * `Idempotency-Key` on every unsafe catalogue route (docs/06 § 6.8 lists
 * publishing an offer — ثبت پیشنهاد), against the real database.
 *
 * The defect: `POST /v1/products`, `POST /v1/offers` and `PATCH /v1/offers/{id}`
 * had no key at all, so a double submit — a double click, a client retry after
 * a timeout — published two offers. Now each route requires the key, a retry
 * with the same key and body replays the first response, a different body is
 * `409 IDEMPOTENCY_KEY_REUSED`, and two requests racing on one key commit once.
 */
describe('catalogue writes are idempotent (real database)', () => {
  let harness: ApiHarness;
  let http: Server;

  const supplierOrg = apiTenant('CAT-IDEM');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [supplierOrg]);
    await harness.close();
  });

  const asSupplier = () => `Bearer ${supplier(supplierOrg)}`;

  const productBody = () => ({
    sku: `IDEM-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
    name: 'قطعه یدکی آزمایشی',
    category: 'PARTS',
    kind: 'GOOD',
    unit: 'عدد',
  });

  const offerBody = (productId: string, overrides: Record<string, unknown> = {}) => ({
    productId,
    unitPriceMinor: '250000',
    currency: 'IRR',
    availableQuantity: 20,
    leadTimeDays: 3,
    minimumQuantity: 1,
    publish: true,
    ...overrides,
  });

  const postProduct = (body: unknown, key?: string) => {
    const call = request(http).post('/v1/products').set('authorization', asSupplier());
    return (key ? call.set('idempotency-key', key) : call).send(body as object);
  };

  const postOffer = (body: unknown, key?: string) => {
    const call = request(http).post('/v1/offers').set('authorization', asSupplier());
    return (key ? call.set('idempotency-key', key) : call).send(body as object);
  };

  const patchOffer = (id: string, body: unknown, key?: string) => {
    const call = request(http).patch(`/v1/offers/${id}`).set('authorization', asSupplier());
    return (key ? call.set('idempotency-key', key) : call).send(body as object);
  };

  async function newProduct(): Promise<string> {
    const response = await postProduct(productBody(), apiKey('idem-product')).expect(201);
    return response.body.id as string;
  }

  const count = {
    productsWithSku: (sku: string) =>
      runUnscoped('the suite counts products by SKU', () =>
        harness.prisma.client.product.count({ where: { organizationId: supplierOrg, sku } }),
      ),
    offersOn: (productId: string) =>
      runUnscoped('the suite counts offers on a product', () =>
        harness.prisma.client.offer.count({ where: { productId } }),
      ),
    eventsFor: (aggregateId: string) =>
      runUnscoped('the suite counts the events one aggregate wrote', () =>
        harness.prisma.client.outboxMessage.count({ where: { aggregateId } }),
      ),
    priceVersions: (offerId: string) =>
      runUnscoped('the suite counts the price history of an offer', () =>
        harness.prisma.client.offerPriceHistory.count({ where: { offerId } }),
      ),
  };

  describe('POST /v1/products', () => {
    it('refuses a request with no Idempotency-Key with 400, and creates nothing', async () => {
      const body = productBody();
      const response = await postProduct(body).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(await count.productsWithSku(body.sku)).toBe(0);
    });

    it('replays the same key and body: one product, one event', async () => {
      const body = productBody();
      const key = apiKey('idem-product-replay');

      const first = await postProduct(body, key).expect(201);
      const replay = await postProduct(body, key).expect(201);

      expect(replay.body).toEqual(first.body);
      expect(await count.productsWithSku(body.sku)).toBe(1);
      expect(await count.eventsFor(first.body.id as string)).toBe(1);
    });

    it('refuses the same key with a different body with 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = apiKey('idem-product-reused');
      await postProduct(productBody(), key).expect(201);

      const other = productBody();
      const response = await postProduct(other, key).expect(409);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(response.headers['retry-after']).toBeUndefined();
      expect(await count.productsWithSku(other.sku)).toBe(0);
    });
  });

  describe('POST /v1/offers', () => {
    it('refuses a request with no Idempotency-Key with 400, and publishes nothing', async () => {
      const productId = await newProduct();
      const response = await postOffer(offerBody(productId)).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(await count.offersOn(productId)).toBe(0);
    });

    it('replays the same key and body: one offer, one event', async () => {
      const productId = await newProduct();
      const key = apiKey('idem-offer-replay');

      const first = await postOffer(offerBody(productId), key).expect(201);
      const replay = await postOffer(offerBody(productId), key).expect(201);

      expect(replay.body).toEqual(first.body);
      expect(await count.offersOn(productId)).toBe(1);
      expect(await count.eventsFor(first.body.id as string)).toBe(1);
    });

    it('refuses the same key with a different body with 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const productId = await newProduct();
      const key = apiKey('idem-offer-reused');
      await postOffer(offerBody(productId), key).expect(201);

      const response = await postOffer(offerBody(productId, { unitPriceMinor: '1' }), key).expect(
        409,
      );

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await count.offersOn(productId)).toBe(1);
    });

    it('a concurrent double submit publishes one offer', async () => {
      // The double click. Every request carries the same key and body and
      // leaves together; whichever claims the key first publishes, and each
      // other one either finds it in flight (409 CONFLICT, Retry-After: 1) or,
      // if it arrives after the commit, replays it. Never a second offer.
      const productId = await newProduct();
      const key = apiKey('idem-offer-race');
      const body = offerBody(productId);

      const answers = await Promise.all(
        Array.from({ length: 4 }, () => postOffer(body, key).then((response) => response)),
      );

      expect(await count.offersOn(productId)).toBe(1);
      const created = answers.filter((answer) => answer.status === 201);
      const inFlight = answers.filter((answer) => answer.status === 409);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(created.length + inFlight.length).toBe(answers.length);
      expect(new Set(created.map((answer) => answer.body.id as string)).size).toBe(1);
      for (const answer of inFlight) {
        expect(answer.body.code).toBe('CONFLICT');
        expect(answer.headers['retry-after']).toBe('1');
      }

      // The loser's retry, once the winner has committed, is the same offer.
      const retry = await postOffer(body, key).expect(201);
      expect(retry.body.id).toBe(created[0]?.body.id);
      expect(await count.offersOn(productId)).toBe(1);
      expect(await count.eventsFor(retry.body.id as string)).toBe(1);
    });
  });

  describe('PATCH /v1/offers/{id}', () => {
    async function newOffer(): Promise<string> {
      const productId = await newProduct();
      const response = await postOffer(offerBody(productId), apiKey('idem-patch-offer')).expect(
        201,
      );
      return response.body.id as string;
    }

    it('refuses a request with no Idempotency-Key with 400, and changes nothing', async () => {
      const offerId = await newOffer();
      const response = await patchOffer(offerId, { unitPriceMinor: '300000' }).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(await count.priceVersions(offerId)).toBe(1);
    });

    it('replays the same key and body: one repricing, one version', async () => {
      const offerId = await newOffer();
      const key = apiKey('idem-patch-replay');

      const first = await patchOffer(offerId, { unitPriceMinor: '300000' }, key).expect(200);
      const replay = await patchOffer(offerId, { unitPriceMinor: '300000' }, key).expect(200);

      expect(first.body.version).toBe(2);
      expect(replay.body).toEqual(first.body);
      expect(await count.priceVersions(offerId)).toBe(2);
    });

    it('refuses the same key on another offer with 409 IDEMPOTENCY_KEY_REUSED, rather than replaying', async () => {
      const mine = await newOffer();
      const other = await newOffer();
      const key = apiKey('idem-patch-target');
      await patchOffer(mine, { availableQuantity: 5 }, key).expect(200);

      const response = await patchOffer(other, { availableQuantity: 5 }, key).expect(409);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const untouched = await runUnscoped('the suite reads the other offer', () =>
        harness.prisma.client.offer.findUnique({ where: { id: other } }),
      );
      expect(untouched?.availableQuantity).toBe(20);
    });
  });
});

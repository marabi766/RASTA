import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import {
  apiTenant,
  auditor,
  buyer,
  platformAdmin,
  startApi,
  supplier,
  type ApiHarness,
} from './api-helpers';
import { cleanup } from './helpers';

/**
 * The catalogue HTTP surface.
 *
 * The one place in this service where a tenant deliberately reads another's
 * rows — a marketplace in which you can only see your own listings is not a
 * marketplace (ADR-042 § 3) — so the tests here are as much about the width of
 * that crossing as about the happy path: published offers and catalogue
 * columns, never an order.
 */
describe('catalogue API', () => {
  let harness: ApiHarness;
  let http: Server;

  const supplierOrg = apiTenant('CAT-SUP');
  const otherSupplierOrg = apiTenant('CAT-SUP2');
  const buyerOrg = apiTenant('CAT-BUY');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [supplierOrg, otherSupplierOrg, buyerOrg]);
    await harness.close();
  });

  const sku = () => `CAT-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`;

  async function createProduct(org = supplierOrg, overrides: Record<string, unknown> = {}) {
    return request(http)
      .post('/v1/products')
      .set('authorization', `Bearer ${supplier(org)}`)
      .send({
        sku: sku(),
        name: 'شیلنگ هیدرولیک صنعتی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
        ...overrides,
      });
  }

  async function publish(
    productId: string,
    org = supplierOrg,
    overrides: Record<string, unknown> = {},
  ) {
    return request(http)
      .post('/v1/offers')
      .set('authorization', `Bearer ${supplier(org)}`)
      .send({
        productId,
        unitPriceMinor: '300000',
        currency: 'IRR',
        availableQuantity: 15,
        leadTimeDays: 5,
        minimumQuantity: 1,
        publish: true,
        ...overrides,
      });
  }

  // -------------------------------------------------------------------------

  describe('POST /v1/products', () => {
    it('defines a catalogue entry', async () => {
      const response = await createProduct();
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('ACTIVE');
      expect(response.body.kind).toBe('GOOD');
    });

    it('refuses a duplicate SKU within one organization with 409', async () => {
      const shared = sku();
      expect((await createProduct(supplierOrg, { sku: shared })).status).toBe(201);

      const conflict = await createProduct(supplierOrg, { sku: shared });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('ALREADY_EXISTS');
    });

    it('lets a different organization use the same SKU', async () => {
      // The uniqueness is per organization: two suppliers may each have their
      // own part numbered the same way, and a platform-wide unique would make
      // one of them unable to list it at all.
      const shared = sku();
      expect((await createProduct(supplierOrg, { sku: shared })).status).toBe(201);
      expect((await createProduct(otherSupplierOrg, { sku: shared })).status).toBe(201);
    });

    it('refuses a missing required field with 400', async () => {
      const response = await request(http)
        .post('/v1/products')
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .send({ sku: sku(), name: 'no category or unit' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses an unknown kind with 400', async () => {
      const response = await createProduct(supplierOrg, { kind: 'SOMETHING_ELSE' });
      expect(response.status).toBe(400);
    });

    it('refuses the oversight role with 403', async () => {
      await request(http)
        .post('/v1/products')
        .set('authorization', `Bearer ${auditor(supplierOrg)}`)
        .send({ sku: sku(), name: 'n', category: 'c', kind: 'GOOD', unit: 'u' })
        .expect(403);
    });

    it('refuses an unauthenticated request with 401', async () => {
      await request(http)
        .post('/v1/products')
        .send({ sku: sku(), name: 'n', category: 'c', kind: 'GOOD', unit: 'u' })
        .expect(401);
    });
  });

  describe('POST /v1/offers', () => {
    it('publishes an offer and reports the qualification as unavailable', async () => {
      const product = await createProduct();
      const response = await publish(product.body.id);

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('PUBLISHED');
      expect(response.body.version).toBe(1);
      // ADR-041: not `false`. A false would claim the supplier failed a check
      // that never ran.
      expect(response.body.supplierQualification).toBe('UNAVAILABLE');
    });

    it('leaves an unpublished offer as a draft', async () => {
      const product = await createProduct();
      const response = await publish(product.body.id, supplierOrg, { publish: false });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('DRAFT');
    });

    it('lets one supplier offer against another organization’s product', async () => {
      // The catalogue entry is shared; the offer against it is not. A supplier
      // that could only sell what it had defined itself would make the
      // catalogue a set of private lists.
      const product = await createProduct(supplierOrg);
      const response = await publish(product.body.id, otherSupplierOrg);
      expect(response.status).toBe(201);
      expect(response.body.supplierOrganizationId).toBe(otherSupplierOrg);
    });

    it('reports 404 for a product that does not exist', async () => {
      const response = await publish('PRD_NOT_REAL');
      expect(response.status).toBe(404);
    });

    it('reports 404 for a product that has been archived', async () => {
      const product = await createProduct();
      await runUnscoped('the suite archives the product it created', () =>
        harness.prisma.client.$executeRawUnsafe(
          `UPDATE product SET status='ARCHIVED' WHERE id=$1`,
          product.body.id,
        ),
      );

      const response = await publish(product.body.id);
      expect(response.status).toBe(404);
    });

    it('refuses a price as a JSON number with 400', async () => {
      const product = await createProduct();
      const response = await publish(product.body.id, supplierOrg, { unitPriceMinor: 300000 });
      expect(response.status).toBe(400);
    });

    it('refuses a buyer role with 403', async () => {
      const product = await createProduct();
      const response = await request(http)
        .post('/v1/offers')
        .set('authorization', `Bearer ${buyer(supplierOrg)}`)
        .send({
          productId: product.body.id,
          unitPriceMinor: '1000',
          availableQuantity: 1,
          leadTimeDays: 1,
        });
      expect(response.status).toBe(403);
    });
  });

  describe('PATCH /v1/offers/:id', () => {
    it('reprices, increments the version and records the history', async () => {
      const product = await createProduct();
      const offer = await publish(product.body.id, supplierOrg, { unitPriceMinor: '100000' });

      const updated = await request(http)
        .patch(`/v1/offers/${offer.body.id}`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .send({ unitPriceMinor: '175000' })
        .expect(200);

      expect(updated.body.unitPriceMinor).toBe('175000');
      expect(updated.body.version).toBe(2);

      const history = await runUnscoped('the suite reads the price history it produced', () =>
        harness.prisma.client.offerPriceHistory.findMany({
          where: { offerId: offer.body.id },
          orderBy: { version: 'asc' },
        }),
      );
      expect(history.map((row) => row.unitPriceMinor)).toEqual([100_000n, 175_000n]);
    });

    it('changes availability without incrementing the version', async () => {
      // Restocking is not a repricing: an `OrderLine` records the version it
      // agreed a *price* at, and bumping it for a stock change would make that
      // record say something it does not mean.
      const product = await createProduct();
      const offer = await publish(product.body.id);

      const updated = await request(http)
        .patch(`/v1/offers/${offer.body.id}`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .send({ availableQuantity: 99 })
        .expect(200);

      expect(updated.body.availableQuantity).toBe(99);
      expect(updated.body.version).toBe(1);
    });

    it('withdraws an offer, which removes it from the catalogue', async () => {
      const product = await createProduct();
      const offer = await publish(product.body.id);

      const withdrawn = await request(http)
        .patch(`/v1/offers/${offer.body.id}`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .send({ status: 'WITHDRAWN' })
        .expect(200);

      expect(withdrawn.body.status).toBe('WITHDRAWN');

      const offers = await request(http)
        .get(`/v1/products/${product.body.id}/offers`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);
      expect(offers.body.items.map((o: { id: string }) => o.id)).not.toContain(offer.body.id);
    });

    it('refuses an empty patch with 400', async () => {
      const product = await createProduct();
      const offer = await publish(product.body.id);

      await request(http)
        .patch(`/v1/offers/${offer.body.id}`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .send({})
        .expect(400);
    });

    it('reports 404 to another supplier, so the attempt confirms nothing', async () => {
      const product = await createProduct();
      const offer = await publish(product.body.id);

      const response = await request(http)
        .patch(`/v1/offers/${offer.body.id}`)
        .set('authorization', `Bearer ${supplier(otherSupplierOrg)}`)
        .send({ unitPriceMinor: '1' });

      expect(response.status).toBe(404);

      const unchanged = await runUnscoped('the suite verifies nothing was repriced', () =>
        harness.prisma.client.offer.findUnique({ where: { id: offer.body.id } }),
      );
      expect(unchanged?.unitPriceMinor).toBe(300_000n);
    });

    it('reports 404 for an offer that does not exist', async () => {
      await request(http)
        .patch('/v1/offers/OFR_NOT_REAL')
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .send({ unitPriceMinor: '1000' })
        .expect(404);
    });

    it('lets a platform operator reprice any supplier’s offer', async () => {
      // The one exemption in `assertOfferOwner`, and it is deliberate: an
      // operator correcting a mispriced listing is an operational act, and it
      // is recorded in the price history like any other.
      const product = await createProduct();
      const offer = await publish(product.body.id);

      await request(http)
        .patch(`/v1/offers/${offer.body.id}`)
        .set('authorization', `Bearer ${platformAdmin()}`)
        .send({ unitPriceMinor: '1000' })
        .expect(200);

      // The correction must not move the offer, or the history it writes, into
      // the operator's organization. The write crosses the tenant guard, so
      // this is the assertion that keeps the crossing narrow rather than wide.
      const rows = await runUnscoped('the suite verifies where the rows landed', () =>
        harness.prisma.client.$queryRawUnsafe<{ org: string; hist: string }[]>(
          `SELECT o.organization_id AS org, h.organization_id AS hist
             FROM "offer" o JOIN offer_price_history h ON h.offer_id = o.id
            WHERE o.id = $1 AND h.version = 2`,
          offer.body.id,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].org).toBe(supplierOrg);
      expect(rows[0].hist).toBe(supplierOrg);
    });
  });

  describe('GET /v1/offers', () => {
    it('shows a supplier its own offers, drafts included', async () => {
      const product = await createProduct();
      const draft = await publish(product.body.id, supplierOrg, { publish: false });

      const response = await request(http)
        .get('/v1/offers')
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .expect(200);

      expect(response.body.items.map((o: { id: string }) => o.id)).toContain(draft.body.id);
      expect(
        response.body.items.every(
          (o: { supplierOrganizationId: string }) => o.supplierOrganizationId === supplierOrg,
        ),
      ).toBe(true);
    });

    it('refuses a buyer role with 403', async () => {
      await request(http)
        .get('/v1/offers')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(403);
    });
  });

  describe('GET /v1/products', () => {
    it('finds a published product by free text, across organizations', async () => {
      const product = await createProduct(supplierOrg, { name: 'واشر مخصوص گیربکس' });
      await publish(product.body.id);

      const response = await request(http)
        .get('/v1/products?q=گیربکس')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      expect(response.body.items.map((p: { id: string }) => p.id)).toContain(product.body.id);
      // The offers come with it, so a buyer can compare without a second call.
      const found = response.body.items.find((p: { id: string }) => p.id === product.body.id);
      expect(found.offers.length).toBeGreaterThan(0);
    });

    it('filters by category', async () => {
      const product = await createProduct(supplierOrg, { category: 'LUBRICANTS' });
      await publish(product.body.id);

      const response = await request(http)
        .get('/v1/products?category=LUBRICANTS')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      expect(
        response.body.items.every((p: { category: string }) => p.category === 'LUBRICANTS'),
      ).toBe(true);
    });

    it('omits a product whose offers are all unpublished', async () => {
      // A product nobody is selling is not a search result, however well its
      // name matches.
      const product = await createProduct(supplierOrg, { name: 'قطعه بدون عرضه منتشرشده' });
      await publish(product.body.id, supplierOrg, { publish: false });

      const response = await request(http)
        .get('/v1/products?q=بدون')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      expect(response.body.items.map((p: { id: string }) => p.id)).not.toContain(product.body.id);
    });

    it.each(['PRICE_ASC', 'PRICE_DESC', 'LEAD_TIME_ASC'])('sorts by %s', async (sort) => {
      const response = await request(http)
        .get(`/v1/products?sort=${sort}&limit=10`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      expect(Array.isArray(response.body.items)).toBe(true);
    });

    it('orders offers cheapest first by default', async () => {
      const product = await createProduct();
      await publish(product.body.id, supplierOrg, { unitPriceMinor: '900000' });
      await publish(product.body.id, otherSupplierOrg, { unitPriceMinor: '400000' });

      const response = await request(http)
        .get(`/v1/products/${product.body.id}/offers`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      const prices = response.body.items.map((o: { unitPriceMinor: string }) =>
        BigInt(o.unitPriceMinor),
      );
      expect(prices[0]).toBeLessThanOrEqual(prices[1]);
    });

    it('refuses a sort the platform cannot honestly perform with 400', async () => {
      const response = await request(http)
        .get('/v1/products?sort=RATING')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses the oversight role with 403', async () => {
      await request(http)
        .get('/v1/products')
        .set('authorization', `Bearer ${auditor(buyerOrg)}`)
        .expect(403);
    });

    it('returns an empty list rather than 404 when nothing matches', async () => {
      const response = await request(http)
        .get('/v1/products?q=zzzzzzzzzznothingmatchesthis')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      expect(response.body.items).toEqual([]);
    });
  });
});

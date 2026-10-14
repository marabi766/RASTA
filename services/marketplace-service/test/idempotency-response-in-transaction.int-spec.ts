import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { IdempotencyStore } from '../src/shared/idempotency';
import {
  apiKey,
  apiTenant,
  buyer,
  sagaClientOf,
  startApi,
  supplier,
  type ApiHarness,
} from './api-helpers';
import { cleanup } from './helpers';

/**
 * The idempotent response is stored **inside** the domain transaction
 * (docs/06 § 6.8), against the real database and the real routes.
 *
 * The defect (Codex on #245): the response was stored after the order's
 * transaction committed, so a failure there answered 500 for an order that
 * existed — the buyer was told it failed, and the key stayed in flight until
 * it expired. Now the response is the transaction's last statement: when
 * storing it fails, nothing of the command is left — no order, no event, no
 * reserved availability, no key — and a retry with the same key runs once.
 */
describe('the idempotent response is stored in the domain transaction (real database)', () => {
  let harness: ApiHarness;
  let http: Server;
  let store: IdempotencyStore;

  const buyerOrg = apiTenant('TXN-BUY');
  const supplierOrg = apiTenant('TXN-SUP');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    store = harness.app.get(IdempotencyStore);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [buyerOrg, supplierOrg]);
    await harness.close();
  });

  afterEach(() => jest.restoreAllMocks());

  /** The response store fails once, as a dropped connection would. */
  const failNextResponseStore = () =>
    jest
      .spyOn(store, 'complete')
      .mockRejectedValueOnce(new Error('connection reset while storing the response'));

  const keyRow = (organizationId: string, endpoint: string, key: string) =>
    runUnscoped('the suite reads the key the command left', () =>
      harness.prisma.client.idempotencyKey.findUnique({
        where: { organizationId_endpoint_key: { organizationId, endpoint, key } },
      }),
    );

  const outboxCount = (organizationId: string) =>
    runUnscoped('the suite counts the events a tenant has', () =>
      harness.prisma.client.outboxMessage.count({ where: { organizationId } }),
    );

  async function publishOffer(): Promise<string> {
    const asSupplier = `Bearer ${supplier(supplierOrg)}`;
    const product = await request(http)
      .post('/v1/products')
      .set('authorization', asSupplier)
      .set('idempotency-key', apiKey('txn-product'))
      .send({
        sku: `TXN-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);
    const offer = await request(http)
      .post('/v1/offers')
      .set('authorization', asSupplier)
      .set('idempotency-key', apiKey('txn-offer'))
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

  const available = (offerId: string) =>
    runUnscoped('the suite reads what the offer has left', () =>
      harness.prisma.client.offer.findUnique({ where: { id: offerId } }),
    ).then((offer) => offer?.availableQuantity);

  describe('POST /v1/orders', () => {
    const ENDPOINT = 'POST /v1/orders';

    it('storing the response fails: no order, no event, nothing reserved, the key free — and a retry places one', async () => {
      const offerId = await publishOffer();
      const key = apiKey('txn-place');
      const place = () =>
        request(http)
          .post('/v1/orders')
          .set('authorization', `Bearer ${buyer(buyerOrg)}`)
          .set('idempotency-key', key)
          .send({ lines: [{ offerId, quantity: 2 }] });
      const ordersUnder = () =>
        runUnscoped('the suite counts the orders one key produced', () =>
          harness.prisma.client.order.count({
            where: { organizationId: buyerOrg, idempotencyKey: key },
          }),
        );
      const eventsBefore = await outboxCount(buyerOrg);

      failNextResponseStore();
      const failed = await place();

      expect(failed.status).toBe(500);
      // The order rolled back with its response: nothing of it remains.
      expect(await ordersUnder()).toBe(0);
      expect(await outboxCount(buyerOrg)).toBe(eventsBefore);
      expect(await available(offerId)).toBe(20);
      // And the claim was released, so the same key is free to run again.
      expect(await keyRow(buyerOrg, ENDPOINT, key)).toBeNull();

      const retried = await place();
      expect(retried.status).toBe(201);
      expect(await ordersUnder()).toBe(1);
      expect(await available(offerId)).toBe(18);
      expect(await keyRow(buyerOrg, ENDPOINT, key)).toMatchObject({
        state: 'COMPLETED',
        responseStatus: 201,
        responseBody: retried.body,
      });

      // Success: a replay answers with the stored response and places nothing.
      const replay = await place();
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(retried.body);
      expect(await ordersUnder()).toBe(1);
      expect(await available(offerId)).toBe(18);
    });
  });

  describe('a command on an existing order', () => {
    const ENDPOINT = 'POST /v1/orders/:id/cancel';

    it('storing the response fails: the order does not move and the saga hears nothing — a retry moves it once', async () => {
      const offerId = await publishOffer();
      const placed = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('txn-cancel-place'))
        .send({ lines: [{ offerId, quantity: 1 }] })
        .expect(201);
      const orderId = placed.body.id as string;
      const key = apiKey('txn-cancel');
      const cancel = () =>
        request(http)
          .post(`/v1/orders/${orderId}/cancel`)
          .set('authorization', `Bearer ${buyer(buyerOrg)}`)
          .set('idempotency-key', key)
          .send({ reason: 'Ordered against the wrong asset by mistake.' });
      const orderNow = () =>
        runUnscoped('the suite reads the order and its history', () =>
          harness.prisma.client.order.findUnique({
            where: { id: orderId },
            include: { history: true },
          }),
        );
      const signal = jest.spyOn(sagaClientOf(harness), 'signal');

      failNextResponseStore();
      const failed = await cancel();

      expect(failed.status).toBe(500);
      const unmoved = await orderNow();
      expect(unmoved?.status).toBe('PENDING');
      expect(unmoved?.history.filter((row) => row.toStatus === 'CANCELLING')).toEqual([]);
      expect(signal).not.toHaveBeenCalled();
      expect(await keyRow(buyerOrg, ENDPOINT, key)).toBeNull();

      const retried = await cancel();
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe('CANCELLING');
      expect(signal).toHaveBeenCalledTimes(1);

      const replay = await cancel();
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(retried.body);
      // A replay ran nothing, so it signals nothing.
      expect(signal).toHaveBeenCalledTimes(1);
      const moved = await orderNow();
      expect(moved?.history.filter((row) => row.toStatus === 'CANCELLING')).toHaveLength(1);
    });
  });

  describe('POST /v1/offers', () => {
    const ENDPOINT = 'POST /v1/offers';

    it('storing the response fails: no offer and no event — a retry publishes one', async () => {
      const asSupplier = `Bearer ${supplier(supplierOrg)}`;
      const product = await request(http)
        .post('/v1/products')
        .set('authorization', asSupplier)
        .set('idempotency-key', apiKey('txn-offer-product'))
        .send({
          sku: `TXN-OFR-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
          name: 'قطعه یدکی آزمایشی',
          category: 'PARTS',
          kind: 'GOOD',
          unit: 'عدد',
        })
        .expect(201);
      const key = apiKey('txn-offer-key');
      const publish = () =>
        request(http)
          .post('/v1/offers')
          .set('authorization', asSupplier)
          .set('idempotency-key', key)
          .send({
            productId: product.body.id,
            unitPriceMinor: '250000',
            currency: 'IRR',
            availableQuantity: 20,
            leadTimeDays: 3,
            minimumQuantity: 1,
            publish: true,
          });
      const offersOfProduct = () =>
        runUnscoped('the suite counts the offers on the product', () =>
          harness.prisma.client.offer.count({ where: { productId: product.body.id } }),
        );
      const eventsBefore = await outboxCount(supplierOrg);

      failNextResponseStore();
      expect((await publish()).status).toBe(500);
      expect(await offersOfProduct()).toBe(0);
      expect(await outboxCount(supplierOrg)).toBe(eventsBefore);
      expect(await keyRow(supplierOrg, ENDPOINT, key)).toBeNull();

      const retried = await publish();
      expect(retried.status).toBe(201);
      const replay = await publish();
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(retried.body);
      expect(await offersOfProduct()).toBe(1);
    });
  });
});

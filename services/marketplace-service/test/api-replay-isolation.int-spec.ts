import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { EconomicClient } from '../src/economic/economic.client';
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
 * An idempotent replay never reaches an order it did not run on — the tenant
 * isolation half of docs/06 § 6.8, through the real HTTP surface.
 *
 * The defect: every targeted order command stored its `Idempotency-Key` under
 * the route template and hashed the body alone, then signalled the saga for
 * the URL's id whether or not the command had run. So an attacker who
 * cancelled its own order X with key K could send K and the same body to
 * `/orders/Y/cancel`, where Y is another tenant's order. The store replayed
 * X's stored response and ran nothing against Y — no party check, no
 * transition check — and the controller still sent Y's saga `orderCancelled`.
 * The saga then adopted Y's buyer and ran the economic refund: Y's money moved
 * while Y's order row said nothing had happened.
 *
 * Each case below asserts all three effects the attack had: the response (the
 * documented `409 IDEMPOTENCY_KEY_REUSED`, not X's order), the saga (no
 * signal for Y) and the money (no economic-service call at all). The saga
 * client is the real one with Temporal disabled, so the spy sees exactly the
 * calls the controller makes; the economic client is spied on the booted
 * application, so any path that reached it — in this request or through a
 * signal — would show here.
 */
describe('order API — idempotent replay across orders and tenants', () => {
  let harness: ApiHarness;
  let http: Server;
  let signal: jest.SpyInstance;
  let economicCalls: jest.SpyInstance[];

  const attackerOrg = apiTenant('RPL-ATK');
  const victimOrg = apiTenant('RPL-VIC');
  const supplierOrg = apiTenant('RPL-SUP');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  beforeEach(() => {
    signal = jest.spyOn(sagaClientOf(harness), 'signal');
    const economic = harness.app.get(EconomicClient);
    economicCalls = (
      [
        'createObligation',
        'authoriseSettlement',
        'settle',
        'refund',
        'cancel',
        'dispute',
        'resolveDispute',
      ] as const
    ).map((method) => jest.spyOn(economic, method));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [attackerOrg, victimOrg, supplierOrg]);
    await harness.close();
  });

  async function publishOffer(): Promise<string> {
    const product = await request(http)
      .post('/v1/products')
      .set('authorization', `Bearer ${supplier(supplierOrg)}`)
      .send({
        sku: `RPL-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);

    const offer = await request(http)
      .post('/v1/offers')
      .set('authorization', `Bearer ${supplier(supplierOrg)}`)
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

  /** An order placed by `buyerOrg`, advanced to `status` the way the saga would. */
  async function orderOf(buyerOrg: string, status: 'PENDING' | 'AWAITING_RECEIPT_CONFIRMATION') {
    const offerId = await publishOffer();
    const placed = await request(http)
      .post('/v1/orders')
      .set('authorization', `Bearer ${buyer(buyerOrg)}`)
      .set('idempotency-key', apiKey('rpl-place'))
      .send({ lines: [{ offerId, quantity: 1 }] })
      .expect(201);
    const id = placed.body.id as string;

    if (status === 'AWAITING_RECEIPT_CONFIRMATION') {
      // Funds are held by the saga, which does not run here; the supplier's
      // half goes through the API like any other command.
      await runUnscoped('the suite advances the order the saga would', () =>
        harness.prisma.client.$executeRawUnsafe(
          `UPDATE "order" SET status='FUNDS_HELD', economic_transaction_id=$2 WHERE id=$1`,
          id,
          `TXN_RPLTEST_${id}`,
        ),
      );
      for (const step of ['confirm', 'fulfill']) {
        await request(http)
          .post(`/v1/orders/${id}/${step}`)
          .set('authorization', `Bearer ${supplier(supplierOrg)}`)
          .set('idempotency-key', apiKey(`rpl-${step}`))
          .send({})
          .expect(200);
      }
    }

    // What setting the order up signalled is not what the test is about.
    signal.mockClear();
    return id;
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const row = await runUnscoped('the suite reads the victim order as an observer', () =>
      harness.prisma.client.order.findUnique({ where: { id } }),
    );
    return row?.status;
  }

  function signalledOrders(): unknown[] {
    return signal.mock.calls.map(([orderId]) => orderId);
  }

  function economicCallCount(): number {
    return economicCalls.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  }

  const CASES = [
    {
      name: 'cancel',
      status: 'PENDING',
      path: 'cancel',
      body: { reason: 'ordered against the wrong asset' },
      signal: 'orderCancelled',
      after: 'CANCELLING',
    },
    {
      name: 'confirm-receipt',
      status: 'AWAITING_RECEIPT_CONFIRMATION',
      path: 'confirm-receipt',
      body: {},
      signal: 'receiptConfirmed',
      after: 'RECEIPT_CONFIRMED',
    },
    {
      name: 'dispute',
      status: 'AWAITING_RECEIPT_CONFIRMATION',
      path: 'disputes',
      body: { reason: 'the delivered part does not match the published offer' },
      signal: 'orderDisputed',
      after: 'DISPUTED',
    },
  ] as const;

  describe.each(CASES)('$name', ({ status, path, body, signal: signalName, after }) => {
    it('refuses a key replayed onto another tenant’s order: 409, no signal, no money', async () => {
      const own = await orderOf(attackerOrg, status);
      const victim = await orderOf(victimOrg, status);
      const key = apiKey(`rpl-${path.replace('/', '-')}`);

      await request(http)
        .post(`/v1/orders/${own}/${path}`)
        .set('authorization', `Bearer ${buyer(attackerOrg)}`)
        .set('idempotency-key', key)
        .send(body)
        .expect(200);
      signal.mockClear();

      const attack = await request(http)
        .post(`/v1/orders/${victim}/${path}`)
        .set('authorization', `Bearer ${buyer(attackerOrg)}`)
        .set('idempotency-key', key)
        .send(body)
        .expect(409);

      expect(attack.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      // Not the attacker's stored order either: nothing was replayed.
      expect(attack.body.id).toBeUndefined();
      expect(signalledOrders()).not.toContain(victim);
      expect(signal).not.toHaveBeenCalled();
      expect(economicCallCount()).toBe(0);
      expect(await statusOf(victim)).toBe(status);
    });

    it('replays the same order idempotently, signalling only the request that ran', async () => {
      const own = await orderOf(attackerOrg, status);
      const key = apiKey(`rpl-same-${path.replace('/', '-')}`);

      const first = await request(http)
        .post(`/v1/orders/${own}/${path}`)
        .set('authorization', `Bearer ${buyer(attackerOrg)}`)
        .set('idempotency-key', key)
        .send(body)
        .expect(200);

      const replay = await request(http)
        .post(`/v1/orders/${own}/${path}`)
        .set('authorization', `Bearer ${buyer(attackerOrg)}`)
        .set('idempotency-key', key)
        .send(body)
        .expect(200);

      expect(first.body.status).toBe(after);
      expect(replay.body).toEqual(first.body);
      expect(signal).toHaveBeenCalledTimes(1);
      expect(signal.mock.calls[0]?.slice(0, 2)).toEqual([own, signalName]);
      expect(economicCallCount()).toBe(0);
    });
  });
});

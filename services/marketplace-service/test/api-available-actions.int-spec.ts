import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import {
  apiKey,
  apiTenant,
  buyer,
  platformAdmin,
  startApi,
  supplier,
  type ApiHarness,
} from './api-helpers';
import { cleanup } from './helpers';

/**
 * `OrderView.availableActions`, against a real database and the real state
 * machine, along the order's real lifecycle.
 *
 * The unit spec (`order-actions.spec.ts`) proves the table says what it
 * should. This proves the table is **true**: at each step, the commands the
 * field advertises to a viewer are commands the service then accepts from that
 * viewer, and the one it withholds in the case that matters — confirm receipt
 * on a disputed order — is one the service then refuses. A field that
 * advertised a command the service refused would be a client told to press a
 * button that fails; one that withheld a command the service allowed would
 * strand an order with nobody able to move it.
 *
 * Funds are held by the saga, which this harness does not run, so the suite
 * advances `PENDING → FUNDS_HELD` directly — the same way `api-order.int-spec`
 * does.
 */
describe('available actions, along a real order lifecycle', () => {
  let harness: ApiHarness;
  let http: Server;

  const buyerOrg = apiTenant('AVA-BUY');
  const supplierOrg = apiTenant('AVA-SUP');
  const strangerOrg = apiTenant('AVA-OTH');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [buyerOrg, supplierOrg, strangerOrg]);
    await harness.close();
  });

  const asBuyer = () => `Bearer ${buyer(buyerOrg)}`;
  const asSupplier = () => `Bearer ${supplier(supplierOrg)}`;
  /** A platform operator acting for an organization that is neither party. */
  const asOperator = () => `Bearer ${platformAdmin()}`;

  async function publishOffer(): Promise<string> {
    const product = await request(http)
      .post('/v1/products')
      .set('authorization', asSupplier())
      .send({
        sku: `AVA-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);

    const offer = await request(http)
      .post('/v1/offers')
      .set('authorization', asSupplier())
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

  async function placeOrder(): Promise<string> {
    const offerId = await publishOffer();
    const order = await request(http)
      .post('/v1/orders')
      .set('authorization', asBuyer())
      .set('idempotency-key', apiKey('ava-place'))
      .send({ lines: [{ offerId, quantity: 1 }] })
      .expect(201);
    return order.body.id as string;
  }

  /** What the saga would do when economic-service confirms the hold. */
  async function holdFunds(orderId: string): Promise<void> {
    await runUnscoped('the suite advances the order the saga would', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE "order" SET status='FUNDS_HELD', economic_transaction_id=$2 WHERE id=$1`,
        orderId,
        `TXN_AVA_${orderId}`,
      ),
    );
  }

  async function actionsFor(orderId: string, who: string): Promise<string[]> {
    const response = await request(http)
      .get(`/v1/orders/${orderId}`)
      .set('authorization', who)
      .expect(200);
    return response.body.availableActions as string[];
  }

  function post(orderId: string, path: string, who: string, body: object = {}) {
    return request(http)
      .post(`/v1/orders/${orderId}/${path}`)
      .set('authorization', who)
      .set('idempotency-key', apiKey(`ava-${path.replace('/', '-')}`))
      .send(body);
  }

  // -------------------------------------------------------------------------

  it('advertises, at each step, exactly what then succeeds: confirm → fulfil → receipt', async () => {
    const id = await placeOrder();

    // PENDING — funds not yet held. The buyer may withdraw; the supplier has
    // nothing to accept yet.
    expect(await actionsFor(id, asBuyer())).toEqual(['CANCEL']);
    expect(await actionsFor(id, asSupplier())).toEqual([]);

    // FUNDS_HELD — the buyer's money is committed before the supplier says yes.
    await holdFunds(id);
    expect(await actionsFor(id, asSupplier())).toEqual(['CONFIRM']);
    expect(await actionsFor(id, asBuyer())).toEqual(['RAISE_DISPUTE', 'CANCEL']);

    // The supplier issues the command it was offered, and it succeeds. The
    // response already answers for the caller who sent it.
    const confirmed = await post(id, 'confirm', asSupplier()).expect(200);
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(confirmed.body.availableActions).toEqual(['FULFILL']);

    const fulfilled = await post(id, 'fulfill', asSupplier(), {
      trackingReference: 'AVA-WB-1',
    }).expect(200);
    expect(fulfilled.body.status).toBe('AWAITING_RECEIPT_CONFIRMATION');
    // Delivered: the supplier's part is done and nothing is left to offer them.
    expect(fulfilled.body.availableActions).toEqual([]);

    // Same order, same moment — the buyer is the one with something to do.
    expect(await actionsFor(id, asBuyer())).toEqual(['CONFIRM_RECEIPT', 'RAISE_DISPUTE', 'CANCEL']);

    const received = await post(id, 'confirm-receipt', asBuyer()).expect(200);
    expect(received.body.status).toBe('RECEIPT_CONFIRMED');
    expect(received.body.availableActions).toEqual(['RAISE_DISPUTE']);
  });

  it('withholds receipt confirmation mid-dispute, and the service refuses it', async () => {
    const id = await placeOrder();
    await holdFunds(id);
    await post(id, 'confirm', asSupplier()).expect(200);
    await post(id, 'fulfill', asSupplier()).expect(200);

    const disputed = await post(id, 'disputes', asBuyer(), {
      reason: 'کالای تحویل‌شده با سفارش مطابقت ندارد و قطعه آسیب دیده است.',
    }).expect(200);
    expect(disputed.body.status).toBe('DISPUTED');

    // The transition table gives DISPUTED two exits — RECEIPT_CONFIRMED and
    // CANCELLING — both for the operator. The buyer is offered neither.
    expect(disputed.body.availableActions).toEqual([]);

    // And the service agrees on both doors: a buyer who presses either anyway
    // is refused, and the order does not move. This is what makes withholding
    // them the truth rather than a UI choice.
    await post(id, 'confirm-receipt', asBuyer()).expect(422);
    await post(id, 'cancel', asBuyer(), { reason: 'راهی برای خروج از اختلاف' }).expect(422);
    const stillDisputed = await request(http)
      .get(`/v1/orders/${id}`)
      .set('authorization', asBuyer());
    expect(stillDisputed.body.status).toBe('DISPUTED');

    // Only an operator may end a dispute, and only an operator is offered it.
    expect(await actionsFor(id, asOperator())).toEqual(['RESOLVE_DISPUTE']);
    expect(await actionsFor(id, asSupplier())).toEqual([]);

    const resolved = await post(id, 'disputes/resolve', asOperator(), {
      outcome: 'SETTLE',
      resolution: 'بررسی شد؛ کالا مطابق سفارش بود و آسیب پس از تحویل رخ داده است.',
      responsibility: 'BUYER',
    }).expect(200);
    expect(resolved.body.status).toBe('RECEIPT_CONFIRMED');

    // Back on the settlement path — and the buyer may dispute again, because
    // RECEIPT_CONFIRMED still has that edge.
    expect(await actionsFor(id, asBuyer())).toEqual(['RAISE_DISPUTE']);
  });

  it('leaves both exits from DISPUTED to the operator alone', async () => {
    // The edge exists in the transition table for `resolveDispute`. Neither
    // party may walk it — not the buyer by confirming receipt, and not either
    // of them by resolving the dispute themselves.
    const id = await placeOrder();
    await holdFunds(id);
    await post(id, 'confirm', asSupplier()).expect(200);
    await post(id, 'fulfill', asSupplier()).expect(200);
    await post(id, 'disputes', asBuyer(), {
      reason: 'قطعهٔ تحویلی با مشخصات سفارش همخوانی ندارد.',
    }).expect(200);

    const resolution = {
      outcome: 'SETTLE',
      resolution: 'طرفین توافق کردند که کالا پذیرفته شود و تسویه انجام گیرد.',
      responsibility: 'UNDETERMINED',
    };

    await post(id, 'confirm-receipt', asBuyer()).expect(422);
    // The second exit: a buyer's cancel on a disputed order would refund the
    // escrow and leave a supplier who delivered unpaid (ADR-038 gives
    // DISPUTED → CANCELLING to `ResolveDispute(REFUND)` alone).
    await post(id, 'cancel', asBuyer(), { reason: 'خروج از اختلاف با لغو' }).expect(422);
    await post(id, 'disputes/resolve', asBuyer(), resolution).expect(403);
    await post(id, 'disputes/resolve', asSupplier(), resolution).expect(403);

    // Still disputed: none of the four attempts moved it.
    const still = await request(http).get(`/v1/orders/${id}`).set('authorization', asBuyer());
    expect(still.body.status).toBe('DISPUTED');
    expect(still.body.receiptConfirmedAt).toBeNull();
  });

  describe('an organization that is neither party', () => {
    const asStranger = () => `Bearer ${buyer(strangerOrg)}`;
    const asStrangerSupplier = () => `Bearer ${supplier(strangerOrg)}`;

    it('cannot read the order, and is told it does not exist', async () => {
      const id = await placeOrder();
      await request(http).get(`/v1/orders/${id}`).set('authorization', asStranger()).expect(404);
    });

    it('gets 404 on every command, never a 403 that confirms the order exists', async () => {
      // Commands used to skip the visibility check `get()` makes, so a
      // stranger reached the party check and was refused with 403 — an
      // existence oracle, and a message naming the order's supplying side.
      const id = await placeOrder();
      await holdFunds(id);

      const attempts: Array<[string, string, object]> = [
        ['confirm', asStrangerSupplier(), {}],
        ['fulfill', asStrangerSupplier(), {}],
        ['confirm-receipt', asStranger(), {}],
        ['cancel', asStranger(), { reason: 'not ours to cancel' }],
        ['disputes', asStranger(), { reason: 'a complaint about an order that is not ours' }],
        ['reviews', asStranger(), { rating: 5 }],
      ];

      for (const [path, who, body] of attempts) {
        const response = await post(id, path, who, body);
        expect({ path, status: response.status }).toEqual({ path, status: 404 });
      }

      // Nothing moved.
      const after = await request(http).get(`/v1/orders/${id}`).set('authorization', asBuyer());
      expect(after.body.status).toBe('FUNDS_HELD');
    });

    it('answers a real order and a made-up id identically', async () => {
      const id = await placeOrder();
      const real = await post(id, 'cancel', asStranger(), { reason: 'probe' });
      const fake = await post('ORD_01JZZZZZZZZZZZZZZZZZZZZZZZ', 'cancel', asStranger(), {
        reason: 'probe',
      });

      expect(real.status).toBe(fake.status);
      expect(real.body.code).toBe(fake.body.code);
    });
  });

  it('never advertises to the supplier what the service would refuse it', async () => {
    // Walk every step a supplier sees and try the buyer's commands: each must
    // be refused, since none was ever advertised.
    const id = await placeOrder();
    await holdFunds(id);

    for (const [path, body] of [
      ['cancel', { reason: 'آزمون' }],
      ['disputes', { reason: 'آزمون دسترسی فروشنده به ثبت اختلاف' }],
    ] as const) {
      expect(await actionsFor(id, asSupplier())).not.toContain(
        path === 'cancel' ? 'CANCEL' : 'RAISE_DISPUTE',
      );
      await post(id, path, asSupplier(), body).expect(403);
    }
  });
});

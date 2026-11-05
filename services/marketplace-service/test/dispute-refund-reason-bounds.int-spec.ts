import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { z } from 'zod';
import { runUnscoped } from '@rasta/nest-common';
import { TRANSACTION_TEXT_BOUNDS, textWithin } from '@rasta/contracts';
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
import { REFUND_RESOLUTION_OUT_OF_BOUNDS } from '../src/order/dto';

/**
 * FU-134, over the real HTTP stack and database: a dispute decision the money
 * path cannot carry out is refused at the decision, before anything changes.
 *
 * A REFUND resolution becomes the order's `cancellationReason`, and the saga
 * sends that as the economic refund's (or cancellation's) `reason`, which
 * economic-service bounds at `TRANSACTION_TEXT_BOUNDS.closingReason.max`. The
 * decision used to accept up to 1000 characters: past 500 the refund was
 * refused inside the saga, which ended with the buyer's funds held and the
 * order `CANCELLING`.
 *
 * "Nothing written" is the order (still `DISPUTED`, no cancellation reason),
 * its dispute (still `OPEN`), the outbox (no `ORDER_DISPUTE_RESOLVED`) and the
 * idempotency table (no row for the key, in any state) — so the operator can
 * shorten the text and send it again, under the same key.
 */
describe('a REFUND decision is bounded by the refund it causes (FU-134, HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  const operatorOrg = apiTenant('RRB-OP');
  const buyerOrg = apiTenant('RRB-B');
  const supplierOrg = apiTenant('RRB-C');
  const asOperator = () => `Bearer ${platformAdmin(operatorOrg)}`;

  const CLOSING = TRANSACTION_TEXT_BOUNDS.closingReason;
  /** economic-service's refund/cancel `reason`, as its DTO declares it (same table). */
  const economicClosingReason = textWithin(z.string().trim(), CLOSING);
  const text = (length: number) => 'ب'.repeat(length);

  const disputeOf = new Map<string, string>();

  async function disputedOrder(): Promise<string> {
    const product = await request(http)
      .post('/v1/products')
      .set('idempotency-key', apiKey('rrb-product'))
      .set('authorization', `Bearer ${supplier(supplierOrg)}`)
      .send({
        sku: `RRB-SKU-${ulid()}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);
    const offer = await request(http)
      .post('/v1/offers')
      .set('idempotency-key', apiKey('rrb-offer'))
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
    const order = await request(http)
      .post('/v1/orders')
      .set('authorization', `Bearer ${buyer(buyerOrg)}`)
      .set('idempotency-key', apiKey('rrb-order'))
      .send({ lines: [{ offerId: offer.body.id, quantity: 1 }] })
      .expect(201);
    const orderId = order.body.id as string;
    await runUnscoped('the suite advances the order the saga would', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE "order" SET status='FUNDS_HELD', economic_transaction_id=$2 WHERE id=$1`,
        orderId,
        `TXN_RRB_${orderId}`,
      ),
    );
    const raised = await request(http)
      .post(`/v1/orders/${orderId}/disputes`)
      .set('authorization', `Bearer ${buyer(buyerOrg)}`)
      .set('idempotency-key', apiKey('rrb-raise'))
      .send({ reason: 'the supplier has not delivered anything at all' })
      .expect(200);
    disputeOf.set(orderId, raised.body.openDisputeId as string);
    return orderId;
  }

  const decide = (orderId: string, key: string, outcome: 'SETTLE' | 'REFUND', resolution: string) =>
    request(http)
      .post(`/v1/orders/${orderId}/disputes/resolve`)
      .set('authorization', asOperator())
      .set('idempotency-key', key)
      .send({ disputeId: disputeOf.get(orderId), outcome, resolution, responsibility: 'SUPPLIER' });

  async function written(orderId: string, key: string) {
    return runUnscoped('the suite reads what the decision wrote', async () => {
      const client = harness.prisma.client;
      const order = await client.order.findUniqueOrThrow({ where: { id: orderId } });
      const disputes = await client.orderDispute.findMany({ where: { orderId } });
      const resolvedEvents = await client.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM outbox_message
          WHERE aggregate_id = $1 AND event_name = 'ORDER_DISPUTE_RESOLVED'`,
        orderId,
      );
      const keys = await client.idempotencyKey.findMany({
        where: { organizationId: operatorOrg, key },
      });
      return {
        status: order.status,
        cancellationReason: order.cancellationReason,
        disputes: disputes.map((dispute) => dispute.status),
        resolvedEvents: Number(resolvedEvents[0]?.n ?? 0),
        keys: keys.length,
      };
    });
  }

  const untouched = {
    status: 'DISPUTED',
    cancellationReason: null,
    disputes: ['OPEN'],
    resolvedEvents: 0,
    keys: 0,
  };

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [operatorOrg, buyerOrg, supplierOrg]);
    await harness.close();
  });

  it(`refuses a REFUND resolution of ${CLOSING.max + 1} characters with 400, writing nothing`, async () => {
    const orderId = await disputedOrder();
    const key = apiKey('rrb-over');

    const refused = await decide(orderId, key, 'REFUND', text(CLOSING.max + 1)).expect(400);

    expect(refused.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(refused.body)).toContain(REFUND_RESOLUTION_OUT_OF_BOUNDS);
    expect(await written(orderId, key)).toEqual(untouched);
  });

  it(`accepts ${CLOSING.max} after the refusal, under the same key, and the reason it stores fits economic's refund body`, async () => {
    const orderId = await disputedOrder();
    const key = apiKey('rrb-retry');
    await decide(orderId, key, 'REFUND', text(CLOSING.max + 1)).expect(400);

    // Surrounding whitespace is trimmed before counting, on both sides.
    const decided = await decide(orderId, key, 'REFUND', `  ${text(CLOSING.max)}\n`).expect(200);

    expect(decided.body.status).toBe('CANCELLING');
    const after = await written(orderId, key);
    expect(after).toEqual({
      status: 'CANCELLING',
      cancellationReason: text(CLOSING.max),
      disputes: ['RESOLVED_REFUND'],
      resolvedEvents: 1,
      keys: 1,
    });
    // What the saga will send as the refund's reason, through economic's bound.
    expect(economicClosingReason.safeParse(after.cancellationReason).success).toBe(true);
  });

  it(`still accepts a SETTLE resolution of ${TRANSACTION_TEXT_BOUNDS.disputeResolution.max} characters, which no refund carries`, async () => {
    const orderId = await disputedOrder();
    const key = apiKey('rrb-settle');

    const decided = await decide(
      orderId,
      key,
      'SETTLE',
      text(TRANSACTION_TEXT_BOUNDS.disputeResolution.max),
    ).expect(200);

    expect(decided.body.status).toBe('FUNDS_HELD');
    expect((await written(orderId, key)).cancellationReason).toBeNull();
  });
});

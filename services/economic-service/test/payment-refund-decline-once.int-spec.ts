import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';
import { ECONOMIC_EVENTS } from '../src/events/events';

/**
 * A declined refund replayed through the HTTP surface is announced once
 * (Codex on #210, ADR-064 § 9).
 *
 * A business refusal releases the request's idempotency key
 * (`IdempotencyStore.run`), so the same request with the same
 * `Idempotency-Key` runs again: a new hold, the provider asked with the same
 * refund key and answering with its cached decline, the hold returned again.
 * Before `payment_refund_decline` that wrote a second `PAYMENT_REFUND_FAILED`
 * for one provider outcome. Now the decline row's primary key stops it — for
 * the same key and for a new one alike, since the provider attempt is the same.
 *
 * What a replay still does, and this suite pins so it is visible: it places a
 * second hold and returns it. Replaying the refusal without running the work
 * again would need the idempotency store to record a terminal error, which it
 * does for no endpoint today; that is routed separately.
 */
describe('a declined refund replayed over HTTP (real database)', () => {
  let harness: ApiHarness;
  let http: Server;
  const org = apiTenant('DECLINE-ONCE');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org]);
    await harness.close();
  });

  const operator = () =>
    bearer({
      sub: `sub-platform-${org}`,
      rastaUserId: 'USR-APITEST-DECLINE-OPERATOR',
      organizationId: org,
      organizationIds: [org],
      roles: ['UNION_ADMIN'],
    });

  const declinesOf = (paymentIntentId: string) =>
    runUnscoped('the suite reads the outbox', async () => {
      const rows = await harness.prisma.client.outboxMessage.findMany({
        where: { organizationId: org, eventName: ECONOMIC_EVENTS.PAYMENT_REFUND_FAILED },
      });
      return rows.filter(
        (row) =>
          (row.payload as { payload: { paymentIntentId?: string } }).payload.paymentIntentId ===
          paymentIntentId,
      );
    });

  const declineRows = (paymentIntentId: string) =>
    runUnscoped('the suite reads the decline record', () =>
      harness.prisma.client.paymentRefundDecline.findMany({ where: { paymentIntentId } }),
    );

  const refundHolds = (paymentIntentId: string) =>
    runUnscoped('the suite reads the refund holds', () =>
      harness.prisma.client.walletHold.findMany({ where: { reference: paymentIntentId } }),
    );

  const refund = (paymentIntentId: string, key: string) =>
    request(http)
      .post(`/v1/payment-intents/${paymentIntentId}/refund`)
      .set('authorization', `Bearer ${operator()}`)
      .set('idempotency-key', key)
      .send({ reason: 'refund the provider declines' });

  it('announces one PAYMENT_REFUND_FAILED however often the same request is replayed', async () => {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    const topUp = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', id('decline-once-topup'))
      .send({ amountMinor: '5000', instrument: 'fail-refund:NOT_PERMITTED' })
      .expect(201);
    const intentId = topUp.body.paymentIntentId as string;
    const key = id('decline-once-refund');

    const first = await refund(intentId, key).expect(422);
    expect(first.body.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(await declinesOf(intentId)).toHaveLength(1);

    // The same request, the same key: refused again, announced no further.
    const replay = await refund(intentId, key).expect(422);
    expect(replay.body.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(await declinesOf(intentId)).toHaveLength(1);

    // A new key reaches the same provider attempt, and its decline is the same one.
    await refund(intentId, id('decline-once-refund-new')).expect(422);
    expect(await declinesOf(intentId)).toHaveLength(1);

    expect(await declineRows(intentId)).toEqual([
      expect.objectContaining({
        organizationId: org,
        paymentIntentId: intentId,
        announcedBy: 'USR-APITEST-DECLINE-OPERATOR',
      }),
    ]);
    // Each run held the amount and returned it: nothing is left held, and the
    // wallet has every rial back.
    const holds = await refundHolds(intentId);
    expect(holds).toHaveLength(3);
    expect(holds.every((hold) => hold.status !== 'ACTIVE')).toBe(true);
    const after = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    expect(BigInt(after.body.availableBalanceMinor)).toBe(
      BigInt(wallet.body.availableBalanceMinor) + 5000n,
    );
    expect(BigInt(after.body.pendingBalanceMinor)).toBe(BigInt(wallet.body.pendingBalanceMinor));
  });
});

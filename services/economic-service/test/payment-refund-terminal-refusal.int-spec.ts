import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';
import { ECONOMIC_EVENTS } from '../src/events/events';

/**
 * A provider-declined refund is a terminal refusal the idempotency store
 * records and replays (follow-up to #210, docs/06 § 6.8).
 *
 * `IdempotencyStore.run` releases the key on every error, so a declined refund
 * replayed with the same `Idempotency-Key` used to run again: a new hold, the
 * provider asked with its fixed refund key and answering with its cached
 * decline, the hold returned. #210 made the announcement once per provider
 * attempt; this suite pins the rest — the replay answers the recorded refusal
 * and does no work at all.
 *
 * Everything whose refusal can become success stays released: the second suite
 * shows an insufficient-balance refusal retried with the same key after a
 * top-up.
 */
describe('a declined refund replayed over HTTP (real database)', () => {
  let harness: ApiHarness;
  let http: Server;
  const org = apiTenant('DECLINE-ONCE');
  const payee = apiTenant('DECLINE-ONCE-PAYEE');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org, payee]);
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

  const idempotencyRow = (key: string) =>
    runUnscoped('the suite reads the idempotency record', () =>
      harness.prisma.client.idempotencyKey.findFirst({
        where: { organizationId: org, endpoint: 'POST /v1/payment-intents/:id/refund', key },
      }),
    );

  const refund = (paymentIntentId: string, key: string, reason = 'refund the provider declines') =>
    request(http)
      .post(`/v1/payment-intents/${paymentIntentId}/refund`)
      .set('authorization', `Bearer ${operator()}`)
      .set('idempotency-key', key)
      .send({ reason });

  const wallet = () =>
    request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

  const topUp = async (amountMinor: string, instrument?: string) => {
    const w = await wallet();
    return request(http)
      .post(`/v1/wallets/${w.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', id('decline-once-topup'))
      .send({ amountMinor, ...(instrument ? { instrument } : {}) })
      .expect(201);
  };

  it('replays the recorded refusal: no new hold, no new event, no new provider attempt', async () => {
    const before = await wallet();
    const intentId = (await topUp('5000', 'fail-refund:NOT_PERMITTED')).body
      .paymentIntentId as string;
    const key = id('decline-once-refund');

    const first = await refund(intentId, key).expect(422);
    expect(first.body.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(first.body.message).toBe('The payment provider refused the refund');
    expect(await declinesOf(intentId)).toHaveLength(1);
    expect(await refundHolds(intentId)).toHaveLength(1);

    // Recorded as the key's completed outcome — the status and a closed name,
    // nothing the refusal carried (S-09).
    expect(await idempotencyRow(key)).toMatchObject({
      state: 'COMPLETED',
      responseStatus: 422,
      responseBody: { refusal: 'REFUND_DECLINED' },
    });

    // The same request, the same key: the recorded refusal, and nothing run.
    const replay = await refund(intentId, key).expect(422);
    expect(replay.body.code).toBe(first.body.code);
    expect(replay.body.message).toBe(first.body.message);
    expect(await declinesOf(intentId)).toHaveLength(1);
    expect(await refundHolds(intentId)).toHaveLength(1);

    // The same key with another body is still refused as a reused key.
    const reused = await refund(intentId, key, 'a different reason').expect(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // A NEW key is a new request: it reaches the same provider attempt, whose
    // decline is the same one — announced once, its hold placed and returned.
    await refund(intentId, id('decline-once-refund-new')).expect(422);
    expect(await declinesOf(intentId)).toHaveLength(1);

    expect(await declineRows(intentId)).toEqual([
      expect.objectContaining({
        organizationId: org,
        paymentIntentId: intentId,
        announcedBy: 'USR-APITEST-DECLINE-OPERATOR',
      }),
    ]);
    const holds = await refundHolds(intentId);
    expect(holds).toHaveLength(2);
    expect(holds.every((hold) => hold.status !== 'ACTIVE')).toBe(true);
    const after = await wallet();
    expect(BigInt(after.body.availableBalanceMinor)).toBe(
      BigInt(before.body.availableBalanceMinor) + 5000n,
    );
    expect(BigInt(after.body.pendingBalanceMinor)).toBe(BigInt(before.body.pendingBalanceMinor));
  });

  it('does not record a refusal that can change: insufficient balance is retried after a top-up', async () => {
    const w = await wallet();
    const available = BigInt(w.body.availableBalanceMinor);
    const key = id('terminal-insufficient');
    const create = () =>
      request(http)
        .post('/v1/transactions')
        .set('authorization', `Bearer ${admin(org)}`)
        .set('idempotency-key', key)
        .send({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: payee,
          grossAmountMinor: (available + 1000n).toString(),
          currency: 'IRR',
          holdFunds: true,
        });

    const refused = await create().expect(422);
    expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');

    await topUp('5000');

    // The same key, the same body: the work runs again and now succeeds.
    const retried = await create().expect(201);
    expect(retried.body.status).toBe('HELD');
  });
});

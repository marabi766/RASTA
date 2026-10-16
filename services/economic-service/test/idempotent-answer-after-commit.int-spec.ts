import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped, tryGetContext } from '@rasta/nest-common';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import type { RefundRequest, RefundResult } from '../src/payment/provider';
import { ECONOMIC_EVENTS } from '../src/events/events';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A failure after an idempotent command's effect committed is answered by
 * replaying what was applied — never by freeing the key as if nothing had been
 * (review of #283, finding 2; docs/23 D-054).
 *
 * The failure is injected, deterministically, after the COMMIT of the effect's
 * transaction: the transaction runs and commits for real, and then its call
 * throws — the acknowledgement lost on the wire, or any read or serialisation
 * the command does afterwards. Before the fix the response was read and
 * stored after that commit, inside the work whose failure releases the key:
 * the same-key retry was judged against the state the first attempt had
 * already moved and refused `INVALID_STATE_TRANSITION`, so a caller such as
 * the order saga never learnt that its authorisation or settlement happened.
 *
 * For every path: (a) the effect is committed once, (b) the same key returns
 * the stored success — what the committed rows say — and keeps returning it,
 * (c) a different key is judged normally against the applied state.
 */
describe('a failure after the commit of an idempotent economic command (HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('ANSWER-PAYER');
  const payee = apiTenant('ANSWER-PAYEE');

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asPlatform = () => `Bearer ${admin(payer, ['UNION_ADMIN'])}`;
  // One person: a reconciliation key is bound to who sent it.
  const resolver = admin(payer, ['SYSTEM_ADMIN']);
  const asResolver = () => `Bearer ${resolver}`;
  const asRefunder = () =>
    `Bearer ${bearer({
      sub: `sub-refunder-${payer}`,
      rastaUserId: 'USR-APITEST-ANSWER-REFUNDER',
      organizationId: payer,
      organizationIds: [payer],
      roles: ['UNION_ADMIN'],
    })}`;

  /** A provider whose refund takes effect and whose answer is then lost. */
  class LosingRefundProvider extends MockPaymentProvider {
    loseNextRefund = false;
    refundCalls = 0;

    override async refund(refund: RefundRequest): Promise<RefundResult> {
      this.refundCalls += 1;
      const answer = await super.refund(refund);
      if (this.loseNextRefund) {
        this.loseNextRefund = false;
        throw new Error('provider response lost');
      }
      return answer;
    }
  }
  const provider = new LosingRefundProvider();

  beforeAll(async () => {
    harness = await startApi({ paymentProvider: provider });
    http = harness.app.getHttpServer() as Server;
    await topUp('200000000');
    await request(http).get('/v1/wallets/me').set('authorization', asPayee()).expect(200);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  /**
   * Makes the `calls`-th transactions `organizationId`'s requests open from
   * now on commit and then throw. Counted per tenant, so nothing a background
   * timer runs is touched; the claim's own short transactions are not
   * `PrismaService.transaction` and are not counted either.
   */
  function failAfterCommit(organizationId: string, ...calls: number[]): () => number {
    const original = harness.prisma.transaction.bind(harness.prisma);
    let seen = 0;
    let fired = 0;
    jest.spyOn(harness.prisma, 'transaction').mockImplementation((async (
      fn: Parameters<typeof original>[0],
    ) => {
      const result = await original(fn);
      if (tryGetContext()?.organizationId !== organizationId) return result;
      seen += 1;
      if (!calls.includes(seen)) return result;
      fired += 1;
      throw new Error('injected: the connection was lost after COMMIT');
    }) as typeof original);
    return () => fired;
  }

  const stored = (organizationId: string, endpoint: string, key: string) =>
    runUnscoped('the suite reads the idempotency record', () =>
      harness.prisma.client.idempotencyKey.findFirst({ where: { organizationId, endpoint, key } }),
    );

  const statusChanges = (transactionId: string, action: string) =>
    runUnscoped('the suite reads the outbox', async () => {
      const rows = await harness.prisma.client.outboxMessage.findMany({
        where: {
          aggregateId: transactionId,
          eventName: ECONOMIC_EVENTS.TRANSACTION_STATUS_CHANGED,
        },
      });
      return rows.filter(
        (row) => (row.payload as { payload: { action?: string } }).payload.action === action,
      ).length;
    });

  const journals = (transactionId: string, journalType: 'SETTLEMENT' | 'FUNDS_REFUNDED') =>
    runUnscoped('the suite counts journals', () =>
      harness.prisma.client.journal.count({ where: { transactionId, journalType } }),
    );

  async function wallet(token = asPayer()) {
    return (await request(http).get('/v1/wallets/me').set('authorization', token).expect(200))
      .body as { id: string; availableBalanceMinor: string; pendingBalanceMinor: string };
  }

  async function topUp(amountMinor: string, instrument?: string, key = id('answer-topup')) {
    const w = await wallet();
    return request(http)
      .post(`/v1/wallets/${w.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', key)
      .send({ amountMinor, ...(instrument ? { instrument } : {}) });
  }

  async function transaction(state: 'created' | 'held' | 'authorised' | 'disputed') {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('answer-txn'))
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '7000',
        currency: 'IRR',
        holdFunds: state !== 'created',
      })
      .expect(201);
    const transactionId = created.body.id as string;
    if (state === 'authorised' || state === 'disputed') {
      await lifecycle(transactionId, 'authorise-settlement', asPayer(), undefined, id('a')).expect(
        200,
      );
    }
    if (state === 'disputed') {
      await lifecycle(
        transactionId,
        'dispute',
        asPayer(),
        { reason: 'The goods arrived damaged' },
        id('d'),
      ).expect(200);
    }
    return transactionId;
  }

  function lifecycle(
    transactionId: string,
    verb: string,
    token: string,
    body: Record<string, unknown> | undefined,
    key: string,
  ): request.Test {
    const call = request(http)
      .post(`/v1/transactions/${transactionId}/${verb}`)
      .set('authorization', token)
      .set('idempotency-key', key);
    return body ? call.send(body) : call;
  }

  const detail = async (transactionId: string) =>
    (
      await request(http)
        .get(`/v1/transactions/${transactionId}`)
        .set('authorization', asPayer())
        .expect(200)
    ).body as { status: string };

  // ---------------------------------------------------------------------------
  // The lifecycle: authorise, dispute, resolve, cancel, and the hold's refund
  // ---------------------------------------------------------------------------

  it.each([
    {
      verb: 'authorise-settlement',
      from: 'held' as const,
      action: 'AUTHORISE_SETTLEMENT',
      to: 'PENDING_SETTLEMENT',
      token: asPayer,
      tenant: payer,
      body: undefined,
    },
    {
      verb: 'dispute',
      from: 'authorised' as const,
      action: 'DISPUTE',
      to: 'DISPUTED',
      token: asPayer,
      tenant: payer,
      body: { reason: 'The delivery is not what was ordered' },
    },
    {
      verb: 'resolve-dispute',
      from: 'disputed' as const,
      action: 'RESOLVE_DISPUTE',
      to: 'PENDING_SETTLEMENT',
      token: asPlatform,
      tenant: payer,
      body: { resolution: 'The supplier showed the delivery note' },
    },
    {
      verb: 'cancel',
      from: 'created' as const,
      action: 'CANCEL',
      to: 'CANCELLED',
      token: asPayer,
      tenant: payer,
      body: { reason: 'Ordered by mistake' },
    },
    {
      verb: 'refund',
      from: 'held' as const,
      action: 'REFUND',
      to: 'REFUNDED',
      token: asPayee,
      tenant: payee,
      body: { reason: 'The order was cancelled before dispatch' },
    },
  ])(
    '$verb: the effect once, the same key replays its success, another key is judged against it',
    async ({ verb, from, action, to, token, tenant, body }) => {
      const transactionId = await transaction(from);
      const before = await wallet();
      const key = id(`answer-${verb}`);

      const fired = failAfterCommit(tenant, 1);
      const first = await lifecycle(transactionId, verb, token(), body, key);
      jest.restoreAllMocks();
      expect(fired()).toBe(1);
      expect(first.status).toBe(500);

      // (a) Committed, once.
      expect((await detail(transactionId)).status).toBe(to);
      expect(await statusChanges(transactionId, action)).toBe(1);

      // (b) The same key: the success the commit stored, every time.
      const replay = await lifecycle(transactionId, verb, token(), body, key).expect(200);
      expect(replay.body).toMatchObject({ id: transactionId, status: to });
      const record = await stored(tenant, `POST /v1/transactions/:id/${verb}`, key);
      expect(record).toMatchObject({ state: 'COMPLETED', responseStatus: 200 });
      expect(replay.body).toEqual(record!.responseBody);
      const again = await lifecycle(transactionId, verb, token(), body, key).expect(200);
      expect(again.body).toEqual(replay.body);
      expect(await statusChanges(transactionId, action)).toBe(1);

      // (c) Another key is a new request, judged against the applied state.
      const other = await lifecycle(transactionId, verb, token(), body, id('other')).expect(409);
      expect(other.body.code).toBe('INVALID_STATE_TRANSITION');

      if (verb === 'refund') {
        const after = await wallet();
        expect(BigInt(after.availableBalanceMinor)).toBe(
          BigInt(before.availableBalanceMinor) + 7000n,
        );
        expect(await journals(transactionId, 'FUNDS_REFUNDED')).toBe(1);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // The hold: an obligation recorded with its funds held
  // ---------------------------------------------------------------------------

  it('a held obligation: one obligation and one hold; the same key replays it', async () => {
    const sourceReference = id('ORD');
    const body = {
      transactionType: 'MARKETPLACE_ORDER',
      counterpartyOrganizationId: payee,
      grossAmountMinor: '9000',
      currency: 'IRR',
      holdFunds: true,
      sourceType: 'MARKETPLACE_ORDER',
      sourceReference,
    };
    const create = (key: string) =>
      request(http)
        .post('/v1/transactions')
        .set('authorization', asPayer())
        .set('idempotency-key', key)
        .send(body);
    const before = await wallet();
    const key = id('answer-hold');

    const fired = failAfterCommit(payer, 1);
    const first = await create(key);
    jest.restoreAllMocks();
    expect(fired()).toBe(1);
    expect(first.status).toBe(500);

    const rows = await runUnscoped('the suite reads the obligation', () =>
      harness.prisma.client.transaction.findMany({
        where: { organizationId: payer, sourceReference },
      }),
    );
    expect(rows).toHaveLength(1);
    const after = await wallet();
    expect(BigInt(after.pendingBalanceMinor)).toBe(BigInt(before.pendingBalanceMinor) + 9000n);

    const replay = await create(key).expect(201);
    expect(replay.body).toMatchObject({ id: rows[0]!.id, status: 'HELD' });
    expect((await create(key).expect(201)).body).toEqual(replay.body);
    expect(BigInt((await wallet()).pendingBalanceMinor)).toBe(BigInt(after.pendingBalanceMinor));

    // Another key for the same source fact is the duplicate it is.
    const other = await create(id('other')).expect(409);
    expect(other.body.code).toBe('CONFLICT');
  });

  // ---------------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------------

  it('settle: one settlement journal; the same key replays it; another key is refused', async () => {
    const transactionId = await transaction('authorised');
    const settle = (key: string) =>
      request(http)
        .post('/v1/settlements')
        .set('authorization', asPayer())
        .set('idempotency-key', key)
        .send({ transactionId });
    const key = id('answer-settle');

    const fired = failAfterCommit(payer, 1);
    const first = await settle(key);
    jest.restoreAllMocks();
    expect(fired()).toBe(1);
    expect(first.status).toBe(500);

    expect((await detail(transactionId)).status).toBe('SETTLED');
    expect(await journals(transactionId, 'SETTLEMENT')).toBe(1);

    const replay = await settle(key).expect(201);
    expect(replay.body).toMatchObject({ transactionId, grossAmountMinor: '7000' });
    expect((await settle(key).expect(201)).body).toEqual(replay.body);
    expect(await journals(transactionId, 'SETTLEMENT')).toBe(1);

    const other = await settle(id('other')).expect(409);
    expect(other.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  // ---------------------------------------------------------------------------
  // Top-up and the top-up's refund
  // ---------------------------------------------------------------------------

  it('top-up: one capture; the same key replays the stored response', async () => {
    const key = id('answer-capture');
    // The capture's transaction is the third of the request; the read-back
    // that follows a failed capture write is the fourth, failed too, so the
    // failure reaches the caller.
    const fired = failAfterCommit(payer, 3, 4);
    const first = await topUp('3000', undefined, key);
    jest.restoreAllMocks();
    expect(fired()).toBe(2);
    expect(first.status).toBe(500);

    const record = await stored(payer, 'POST /v1/wallets/:id/top-up', key);
    expect(record).toMatchObject({ state: 'COMPLETED', responseStatus: 201 });
    const replay = await topUp('3000', undefined, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(record!.responseBody);
    expect(replay.body).toMatchObject({ status: 'CAPTURED' });
    const captures = await runUnscoped('the suite reads the top-up transaction', () =>
      harness.prisma.client.transaction.count({
        where: { sourceType: 'PAYMENT_INTENT', sourceReference: replay.body.paymentIntentId },
      }),
    );
    expect(captures).toBe(1);

    const other = await topUp('3000');
    expect(other.status).toBe(201);
    expect(other.body.paymentIntentId).not.toBe(replay.body.paymentIntentId);
  });

  const refundTopUp = (paymentIntentId: string, key: string) =>
    request(http)
      .post(`/v1/payment-intents/${paymentIntentId}/refund`)
      .set('authorization', asRefunder())
      .set('idempotency-key', key)
      .send({ reason: 'customer asked for it back' });

  const reversals = (paymentIntentId: string) =>
    runUnscoped('the suite reads the refund announcements', async () => {
      const rows = await harness.prisma.client.outboxMessage.findMany({
        where: { aggregateId: paymentIntentId, eventName: ECONOMIC_EVENTS.PAYMENT_REFUNDED },
      });
      return rows.length;
    });

  it('a top-up refund: one reversal; the same key replays it; another key is refused', async () => {
    const intentId = (await topUp('4000')).body.paymentIntentId as string;
    const key = id('answer-refund');

    // Step 1 holds the amount; step 3, the second transaction, reverses it.
    const fired = failAfterCommit(payer, 2);
    const first = await refundTopUp(intentId, key);
    jest.restoreAllMocks();
    expect(fired()).toBe(1);
    expect(first.status).toBe(500);
    expect(await reversals(intentId)).toBe(1);

    const replay = await refundTopUp(intentId, key).expect(200);
    expect(replay.body).toMatchObject({ paymentIntentId: intentId, amountMinor: '4000' });
    expect((await refundTopUp(intentId, key).expect(200)).body).toEqual(replay.body);
    expect(await reversals(intentId)).toBe(1);

    const other = await refundTopUp(intentId, id('other')).expect(409);
    expect(other.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('a declined refund: the hold returned once, the provider asked once, the refusal replayed', async () => {
    const intentId = (await topUp('5000', 'fail-refund:NOT_PERMITTED')).body
      .paymentIntentId as string;
    const holds = () =>
      runUnscoped('the suite reads the refund holds', () =>
        harness.prisma.client.walletHold.findMany({ where: { reference: intentId } }),
      );
    const asked = provider.refundCalls;
    const key = id('answer-declined');

    // The return of the hold, with the refusal, is the second transaction.
    const fired = failAfterCommit(payer, 2);
    const first = await refundTopUp(intentId, key);
    jest.restoreAllMocks();
    expect(fired()).toBe(1);
    expect(first.status).toBeGreaterThanOrEqual(400);

    expect(await stored(payer, 'POST /v1/payment-intents/:id/refund', key)).toMatchObject({
      state: 'COMPLETED',
      responseStatus: 422,
      responseBody: { refusal: 'REFUND_DECLINED' },
    });
    const replay = await refundTopUp(intentId, key).expect(422);
    expect(replay.body.message).toBe('The payment provider refused the refund');
    expect(provider.refundCalls - asked).toBe(1);
    const placed = await holds();
    expect(placed).toHaveLength(1);
    expect(placed[0]!.status).not.toBe('ACTIVE');
  });

  // ---------------------------------------------------------------------------
  // The operator's requeue (its task was read back after the commit too)
  // ---------------------------------------------------------------------------

  it('a requeue: one requeue; the same key replays it; another key is a new requeue', async () => {
    const intentId = (await topUp('700')).body.paymentIntentId as string;
    provider.loseNextRefund = true;
    await refundTopUp(intentId, id('answer-lost'));
    await runUnscoped('the suite escalates the task', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE payment_reconciliation_task
            SET status = 'ESCALATED', escalated_at = now(), last_outcome = 'PROVIDER_OUTCOME_UNKNOWN'
          WHERE payment_intent_id = $1 AND status = 'PENDING'`,
        intentId,
      ),
    );
    const requeues = () =>
      runUnscoped('the suite reads the requeues', () =>
        harness.prisma.client.paymentReconciliationRequeue.count({
          where: { paymentIntentId: intentId },
        }),
      );
    const requeue = (key: string) =>
      request(http)
        .post(`/v1/payment-intents/${intentId}/reconciliation/requeue`)
        .set('authorization', asResolver())
        .set('idempotency-key', key)
        .send({ reason: 'The provider has answered the ticket' });
    const key = id('answer-requeue');

    const fired = failAfterCommit(payer, 1);
    const first = await requeue(key);
    jest.restoreAllMocks();
    expect(fired()).toBe(1);
    expect(first.status).toBe(500);
    expect(await requeues()).toBe(1);

    const replay = await requeue(key).expect(200);
    expect(replay.body).toMatchObject({ status: 'PENDING' });
    expect(replay.body).toEqual(
      (await stored(payer, 'POST /v1/payment-intents/:id/reconciliation/requeue', key))!
        .responseBody,
    );
    expect((await requeue(key).expect(200)).body).toEqual(replay.body);
    expect(await requeues()).toBe(1);

    await requeue(id('other')).expect(200);
    expect(await requeues()).toBe(2);
  });
});

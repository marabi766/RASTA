import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import type { RefundRequest, RefundResult } from '../src/payment/provider';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A replayed top-up answers with the historical response; the current state
 * is read from the payment intent (PM ruling, round 2 on #143; docs/06 § 6.8).
 *
 * Same key, same response: the idempotency store does not re-check state,
 * by design. So a top-up that was captured, and whose refund has since been
 * left unfinished, still replays `CAPTURED` — and `GET
 * /v1/payment-intents/:id` is what says the refund is unresolved.
 */
describe('a replayed top-up and the intent behind it (HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('REPLAY');
  /** Its own tenant for the N1 case, so a wallet it freezes touches no other test. */
  const pendingOrg = apiTenant('PENDING');
  const asOrg = (organization = org) => `Bearer ${admin(organization)}`;
  const asPlatform = (organization = org) => `Bearer ${admin(organization, ['UNION_ADMIN'])}`;

  /** A provider whose refund takes effect and whose answer is then lost. */
  class LosingRefundProvider extends MockPaymentProvider {
    loseNextRefund = false;
    /** Runs while the provider is asked: an operator's freeze, committed meanwhile. */
    duringNextRefund: (() => Promise<unknown>) | null = null;
    asked = 0;

    override async refund(request: RefundRequest): Promise<RefundResult> {
      this.asked += 1;
      const during = this.duringNextRefund;
      this.duringNextRefund = null;
      await during?.();
      const answer = await super.refund(request);
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
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org, pendingOrg]);
    await harness.close();
  });

  /** A top-up under `key`, which must answer 201 — first time or replayed. */
  async function topUp(key: string, organization = org) {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', asOrg(organization))
      .expect(200);
    return request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asOrg(organization))
      .set('idempotency-key', key)
      .send({ amountMinor: '4000' })
      .expect(201);
  }

  const intentOf = (paymentIntentId: string, organization = org) =>
    request(http)
      .get(`/v1/payment-intents/${paymentIntentId}`)
      .set('authorization', asOrg(organization))
      .expect(200);

  it('replays CAPTURED after a lost refund answer, while the intent reports REFUND_UNKNOWN', async () => {
    const key = id('replay-lost');
    const first = await topUp(key);
    expect(first.body).toMatchObject({ status: 'CAPTURED', simulated: true });

    provider.loseNextRefund = true;
    const refund = await request(http)
      .post(`/v1/payment-intents/${first.body.paymentIntentId}/refund`)
      .set('authorization', asPlatform())
      .set('idempotency-key', id('replay-lost-refund'))
      .send({ reason: 'the provider answer will be lost' });
    expect(refund.status).toBeGreaterThanOrEqual(500);

    // The historical response, byte for byte.
    const replay = await topUp(key);
    expect(replay.body).toEqual(first.body);

    // The current state.
    const intent = await intentOf(first.body.paymentIntentId);
    expect(intent.body).toMatchObject({
      id: first.body.paymentIntentId,
      status: 'CAPTURED',
      failureReason: 'REFUND_UNKNOWN',
    });
  });

  describe('what the caller is told when the provider refunded and the reversal waits (Codex PR-480 r2, N1)', () => {
    const NOT_SENT = 'This wallet is not active; a refund cannot take money out of it until it is';

    const setWalletStatus = (walletId: string, status: 'ACTIVE' | 'FROZEN' | 'CLOSED') =>
      runUnscoped('the suite changes the wallet status as an operator would', () =>
        harness.prisma.client.wallet.update({ where: { id: walletId }, data: { status } }),
      );

    const refund = (paymentIntentId: string, key: string) =>
      request(http)
        .post(`/v1/payment-intents/${paymentIntentId}/refund`)
        .set('authorization', asPlatform(pendingOrg))
        .set('idempotency-key', key)
        .send({ reason: 'the suite refunds' });

    /**
     * The closed refusal of a refund the provider made: a fixed text, no ids.
     * (The envelope's `path` echoes the request's own URL, intent id included.)
     */
    function expectReversalPending(
      body: Record<string, unknown>,
      intentId: string,
      walletId: string,
    ) {
      expect(body).toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        details: [
          {
            path: 'refund',
            code: 'REFUND_REVERSAL_PENDING',
            message: expect.stringContaining('provider has refunded'),
          },
        ],
      });
      expect(body.message).toBe((body.details as { message: string }[])[0]?.message);
      expect(body.message).not.toBe(NOT_SENT);
      expect(body).not.toHaveProperty('internalContext');
      expect(JSON.stringify(body)).not.toContain(walletId);
      expect(JSON.stringify([body.message, body.details])).not.toContain(intentId);
    }

    it('says "not sent" before the provider is asked, and "the provider has refunded" after', async () => {
      const first = await topUp(id('pending-topup'), pendingOrg);
      const intentId = first.body.paymentIntentId as string;
      const wallet = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', asOrg(pendingOrg))
        .expect(200);
      const walletId = wallet.body.id as string;

      // Frozen before the request: refused before any hold or provider call.
      await setWalletStatus(walletId, 'FROZEN');
      const asked = provider.asked;
      const notSent = await refund(intentId, id('pending-before')).expect(422);
      expect(notSent.body).toMatchObject({ code: 'BUSINESS_RULE_VIOLATION', message: NOT_SENT });
      expect(notSent.body).not.toHaveProperty('details');
      expect(provider.asked).toBe(asked);
      expect((await intentOf(intentId, pendingOrg)).body).toMatchObject({ failureReason: null });

      // Frozen while the provider is asked: the provider refunds, the reversal waits.
      await setWalletStatus(walletId, 'ACTIVE');
      provider.duringNextRefund = () => setWalletStatus(walletId, 'FROZEN');
      const key = id('pending-during');
      const pending = await refund(intentId, key).expect(422);
      expectReversalPending(pending.body, intentId, walletId);
      expect(provider.asked).toBe(asked + 1);
      expect((await intentOf(intentId, pendingOrg)).body).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUNDED_NOT_REVERSED',
      });

      // Every later attempt while it stays inactive — same key or a new one,
      // the wallet now closed — says the same, and asks the provider nothing.
      expectReversalPending((await refund(intentId, key).expect(422)).body, intentId, walletId);
      await setWalletStatus(walletId, 'CLOSED');
      expectReversalPending(
        (await refund(intentId, id('pending-later')).expect(422)).body,
        intentId,
        walletId,
      );
      expect(provider.asked).toBe(asked + 1);

      // Active again: the retry records the reversal, without the provider.
      await setWalletStatus(walletId, 'ACTIVE');
      const done = await refund(intentId, key).expect(200);
      expect(done.body).toMatchObject({
        paymentIntentId: intentId,
        reversalJournalId: expect.any(String),
      });
      expect(provider.asked).toBe(asked + 1);
      expect((await intentOf(intentId, pendingOrg)).body).toMatchObject({
        status: 'REFUNDED',
        failureReason: null,
      });
    });
  });

  it.each(['REFUNDED_NOT_REVERSED', 'REFUND_DECLINED_RELEASE_PENDING', 'REFUND_REQUESTED'])(
    'replays CAPTURED while the intent reports %s',
    async (marker) => {
      // Each marker is produced for real in payment-unknown-outcome.int-spec.ts;
      // here it is written directly so only the read path is under test.
      const key = id(`replay-${marker.toLowerCase()}`);
      const first = await topUp(key);
      await runUnscoped('the suite marks the intent', () =>
        harness.prisma.client.paymentIntent.update({
          where: { id: first.body.paymentIntentId },
          data: { failureReason: marker },
        }),
      );

      const replay = await topUp(key);
      expect(replay.body).toEqual(first.body);
      expect((await intentOf(first.body.paymentIntentId)).body).toMatchObject({
        status: 'CAPTURED',
        failureReason: marker,
      });
    },
  );
});

import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { asActor, cleanup, newPrisma, tenants, wire, type Wiring, testEnv } from './helpers';
import { PaymentService } from '../src/payment/payment.service';
import { PaymentReconciler } from '../src/payment/payment-reconciler';
import { PaymentReconciliationSweeper } from '../src/payment/payment-reconciliation.sweeper';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { ECONOMIC_EVENTS } from '../src/events/events';
import type { EconomicEnv } from '../src/config/env';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RefundRequest, RefundStatusQuery, RefundStatusResult } from '../src/payment/provider';

/**
 * `PAYMENT_REFUNDED` and `PAYMENT_REFUND_FAILED` (ADR-064 § 9; #150 triage
 * batch 2, item 7), against the real database.
 *
 * Before this, a refund reversed the top-up and returned the hold with no
 * intent-level event at all — on the operator's HTTP path not even a
 * reconciliation resolution. Each outcome is now announced exactly once, in
 * the transaction that records it, whichever path got it there: the operator's
 * request or the reconciler.
 */

/** A provider that vouches for absence, so a NOT_FOUND is acted on (step B2). */
class AbsenceVouchingProvider extends MockPaymentProvider {
  override readonly authoritativeAbsence = true;

  override async getRefundStatus(query: RefundStatusQuery): Promise<RefundStatusResult> {
    const answer = await super.getRefundStatus(query);
    return answer.refund === 'UNKNOWN'
      ? { refund: 'NOT_FOUND', authoritative: true, simulated: true }
      : answer;
  }
}

describe('the refund outcome events (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let payments: PaymentService;
  let provider: MockPaymentProvider;
  let env: EconomicEnv;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    env = testEnv();
    provider = new MockPaymentProvider();
    payments = new PaymentService(
      prisma,
      wiring.ledger,
      wiring.wallets,
      wiring.walletRepository,
      provider,
      wiring.paymentReconciliation,
      env,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  const sweeperWith = (withProvider: MockPaymentProvider = provider) =>
    new PaymentReconciliationSweeper(
      wiring.paymentReconciliation,
      new PaymentReconciler(
        prisma,
        payments,
        wiring.paymentReconciliation,
        withProvider,
        wiring.ledger,
        wiring.walletRepository,
        env,
      ),
      env,
    );

  const intentOf = (paymentIntentId: string) =>
    runUnscoped('the suite reads the intent', () =>
      prisma.client.paymentIntent.findUniqueOrThrow({ where: { id: paymentIntentId } }),
    );

  /** The REVERSAL journal that undid the intent's top-up, if any. */
  const reversalOf = async (paymentIntentId: string) => {
    const intent = await intentOf(paymentIntentId);
    return runUnscoped('the suite finds the reversal', async () => {
      const topUpJournal = await prisma.client.journal.findFirstOrThrow({
        where: { transactionId: intent.transactionId, journalType: 'WALLET_TOP_UP' },
      });
      return prisma.client.journal.findFirst({ where: { reversesId: topUpJournal.id } });
    });
  };

  /** The payloads of one event the organization's outbox holds, for one intent. */
  const eventsFor = async (organizationId: string, eventName: string, paymentIntentId: string) => {
    const rows = await runUnscoped('the suite reads the outbox', () =>
      prisma.client.outboxMessage.findMany({ where: { organizationId, eventName } }),
    );
    return rows
      .map((row) => ({
        partitionKey: row.partitionKey,
        payload: (row.payload as { payload: Record<string, unknown> }).payload,
      }))
      .filter((row) => row.payload.paymentIntentId === paymentIntentId);
  };

  const refunded = (organizationId: string, intentId: string) =>
    eventsFor(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUNDED, intentId);
  const failed = (organizationId: string, intentId: string) =>
    eventsFor(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_FAILED, intentId);

  async function topUp(organizationId: string, amountMinor: bigint, instrument?: string) {
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    const result = await asActor({ organizationId }, () =>
      payments.topUp(wallet.id, {
        amountMinor: amountMinor.toString(),
        idempotencyKey: `RFE-${ulid()}`,
        ...(instrument ? { instrument } : {}),
      }),
    );
    expect(result.status).toBe('CAPTURED');
    return { walletId: wallet.id, intentId: result.paymentIntentId };
  }

  const refundBy = (organizationId: string, intentId: string) =>
    asActor({ organizationId, userId: 'USR-REFUND-OPERATOR' }, () =>
      payments.refund(intentId, 'the suite refunds'),
    );

  const makeDue = (paymentIntentId: string) =>
    runUnscoped('the suite makes its task due', () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE payment_reconciliation_task SET next_attempt_at = now() - interval '1 second'
          WHERE payment_intent_id = $1 AND status = 'PENDING'`,
        paymentIntentId,
      ),
    );

  /**
   * Sweeps until this intent's task is no longer pending. One sweep claims a
   * bounded batch of due tasks, oldest first, so tasks other suites left due
   * in the same database can fill it; a bounded loop keeps this test about its
   * own intent.
   */
  async function sweepUntilSettled(paymentIntentId: string, withProvider?: MockPaymentProvider) {
    const sweeper = sweeperWith(withProvider);
    for (let round = 0; round < 10; round += 1) {
      await sweeper.runOnce();
      const [task] = await runUnscoped('the suite reads its task', () =>
        prisma.client.$queryRawUnsafe<{ status: string }[]>(
          `SELECT status::text AS status FROM payment_reconciliation_task
            WHERE payment_intent_id = $1 ORDER BY created_at DESC LIMIT 1`,
          paymentIntentId,
        ),
      );
      if (task && task.status !== 'PENDING') return;
    }
    throw new Error(`the task of ${paymentIntentId} was never settled`);
  }

  /** The provider refunds; its answer never arrives (REFUND_UNKNOWN). */
  function loseRefundResponse() {
    const real = provider.refund.bind(provider);
    return jest.spyOn(provider, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
      await real(request);
      throw new Error('provider response lost');
    });
  }

  describe("the operator's refund", () => {
    it('announces PAYMENT_REFUNDED once, keyed by the intent, naming the reversal it posted', async () => {
      const organizationId = `${org.a}-OK`;
      const made = await topUp(organizationId, 4_000n);

      const view = await refundBy(organizationId, made.intentId);

      const reversal = await reversalOf(made.intentId);
      expect(reversal?.id).toBe(view.reversalJournalId);
      expect(await refunded(organizationId, made.intentId)).toEqual([
        {
          partitionKey: made.intentId,
          payload: expect.objectContaining({
            paymentIntentId: made.intentId,
            organizationId,
            walletId: made.walletId,
            amountMinor: '4000',
            currency: 'IRR',
            reversalJournalId: view.reversalJournalId,
            refundedBy: 'USR-REFUND-OPERATOR',
            simulated: true,
          }),
        },
      ]);
      expect(await failed(organizationId, made.intentId)).toEqual([]);
    });

    it('announces PAYMENT_REFUND_FAILED once when the provider declines, and no refund', async () => {
      const organizationId = `${org.a}-DECLINED`;
      const made = await topUp(organizationId, 3_000n, 'fail-refund:NOT_PERMITTED');

      await expect(refundBy(organizationId, made.intentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });

      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect(await failed(organizationId, made.intentId)).toEqual([
        {
          partitionKey: made.intentId,
          payload: expect.objectContaining({
            paymentIntentId: made.intentId,
            amountMinor: '3000',
            reason: 'PROVIDER_DECLINED',
          }),
        },
      ]);
      expect(await refunded(organizationId, made.intentId)).toEqual([]);
    });

    it('announces neither while the outcome is unknown — only the unreconciled alert', async () => {
      const organizationId = `${org.a}-UNKNOWN`;
      const made = await topUp(organizationId, 2_000n);
      loseRefundResponse();

      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow(
        'provider response lost',
      );

      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_UNKNOWN');
      expect(await refunded(organizationId, made.intentId)).toEqual([]);
      expect(await failed(organizationId, made.intentId)).toEqual([]);
      expect(
        await eventsFor(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED, made.intentId),
      ).toHaveLength(1);
    });

    it('commits the announcement with the refund: a reversal that fails leaves no PAYMENT_REFUNDED', async () => {
      const organizationId = `${org.a}-ATOMIC`;
      const made = await topUp(organizationId, 1_500n);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('the reversal fails'));

      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow('the reversal fails');

      // The provider refunded; the ledger did not record it, so nothing says it did.
      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUNDED_NOT_REVERSED',
      });
      expect(await reversalOf(made.intentId)).toBeNull();
      expect(await refunded(organizationId, made.intentId)).toEqual([]);

      // The retry records it, and announces it — once.
      await refundBy(organizationId, made.intentId);
      expect((await intentOf(made.intentId)).status).toBe('REFUNDED');
      expect(await refunded(organizationId, made.intentId)).toHaveLength(1);
    });

    it('announces a decline once, when the retry finally returns the hold', async () => {
      const organizationId = `${org.a}-RELEASE`;
      const made = await topUp(organizationId, 1_200n, 'fail-refund:NOT_PERMITTED');
      jest.spyOn(wiring.wallets, 'refundHold').mockRejectedValueOnce(new Error('release fails'));

      await expect(refundBy(organizationId, made.intentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_DECLINED_RELEASE_PENDING');
      expect(await failed(organizationId, made.intentId)).toEqual([]);

      // The retry only returns the hold — and that is when the decline is announced.
      await expect(refundBy(organizationId, made.intentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect((await intentOf(made.intentId)).failureReason).toBeNull();
      expect(await failed(organizationId, made.intentId)).toHaveLength(1);
    });

    it('refuses a second refund of a refunded intent, and announces nothing more', async () => {
      const organizationId = `${org.a}-TWICE`;
      const made = await topUp(organizationId, 900n);
      await refundBy(organizationId, made.intentId);

      await expect(refundBy(organizationId, made.intentId)).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });

      expect(await refunded(organizationId, made.intentId)).toHaveLength(1);
    });

    it('lets no other tenant refund the intent, and writes no event under either', async () => {
      const owner = `${org.a}-OWNER`;
      const stranger = `${org.b}-STRANGER`;
      const made = await topUp(owner, 800n);

      await expect(refundBy(stranger, made.intentId)).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect((await intentOf(made.intentId)).status).toBe('CAPTURED');
      for (const organizationId of [owner, stranger]) {
        expect(await refunded(organizationId, made.intentId)).toEqual([]);
        expect(await failed(organizationId, made.intentId)).toEqual([]);
      }
    });
  });

  describe('the reconciler', () => {
    it('announces PAYMENT_REFUNDED once when it records a refund the provider made', async () => {
      const organizationId = `${org.c}-REC-OK`;
      const made = await topUp(organizationId, 700n);
      loseRefundResponse();
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow();
      await makeDue(made.intentId);

      await sweepUntilSettled(made.intentId);

      expect((await intentOf(made.intentId)).status).toBe('REFUNDED');
      const reversal = await reversalOf(made.intentId);
      expect(await refunded(organizationId, made.intentId)).toEqual([
        {
          partitionKey: made.intentId,
          payload: expect.objectContaining({
            paymentIntentId: made.intentId,
            reversalJournalId: reversal?.id,
            refundedBy: 'PAYMENT_RECONCILER',
          }),
        },
      ]);
      expect(
        await eventsFor(
          organizationId,
          ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED,
          made.intentId,
        ),
      ).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ resolution: 'REFUNDED' }) }),
      ]);
    });

    it('announces PAYMENT_REFUND_FAILED once when the provider says it declined', async () => {
      const organizationId = `${org.c}-REC-DECLINED`;
      const made = await topUp(organizationId, 600n);
      loseRefundResponse();
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow();
      await makeDue(made.intentId);
      // Declined for this intent only: other suites' tasks swept alongside it
      // get the provider's real answer.
      const real = provider.getRefundStatus.bind(provider);
      jest.spyOn(provider, 'getRefundStatus').mockImplementation(async (query) =>
        query.paymentIntentId === made.intentId
          ? {
              refund: 'DECLINED',
              authoritative: true,
              failureCode: 'NOT_PERMITTED',
              simulated: true,
            }
          : real(query),
      );

      await sweepUntilSettled(made.intentId);

      expect((await intentOf(made.intentId)).failureReason).toBeNull();
      expect(await failed(organizationId, made.intentId)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ reason: 'PROVIDER_DECLINED' }),
        }),
      ]);
      expect(await refunded(organizationId, made.intentId)).toEqual([]);
    });

    it('announces no decline for a refund that never reached the provider', async () => {
      const organizationId = `${org.c}-REC-NOT-REACHED`;
      const vouching = new AbsenceVouchingProvider();
      const made = await topUp(organizationId, 500n);
      jest.spyOn(provider, 'refund').mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow();
      await makeDue(made.intentId);

      await sweepUntilSettled(made.intentId, vouching);

      expect((await intentOf(made.intentId)).failureReason).toBeNull();
      expect(
        await eventsFor(
          organizationId,
          ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED,
          made.intentId,
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ resolution: 'REFUND_NOT_REACHED' }),
        }),
      ]);
      expect(await failed(organizationId, made.intentId)).toEqual([]);
      expect(await refunded(organizationId, made.intentId)).toEqual([]);
    });
  });
});

import { ulid } from 'ulid';
import { getOrganizationId, runUnscoped } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  newPrisma,
  readBalances,
  tenants,
  testEnv,
  wire,
  type Wiring,
} from './helpers';
import { PaymentService } from '../src/payment/payment.service';
import { PaymentReconciler } from '../src/payment/payment-reconciler';
import { PaymentReconciliationSweeper } from '../src/payment/payment-reconciliation.sweeper';
import type { HealCursor } from '../src/payment/payment-reconciliation.repository';
import { walletBalanceLimit } from '../src/wallet/wallet.repository';
import { LedgerBalanceAudit } from '../src/wallet/balance-audit';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { ECONOMIC_EVENTS } from '../src/events/events';
import type { EconomicEnv } from '../src/config/env';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RefundRequest, RefundStatusQuery, RefundStatusResult } from '../src/payment/provider';

/**
 * ADR-064 step B2: the reconciler that works B1's queue.
 *
 * Each test drives one row of the decision table (plan § 2.3) end to end on a
 * real database, and ends on what an auditor would check: the intent and its
 * marker, the hold, the journals (exactly one reversal, or none), the task,
 * the event in the outbox, and the wallet against its ledger.
 *
 * Tasks fall due after the grace period; a test that needs one now makes it
 * due directly, which is the only thing it writes to the queue by hand.
 */
/**
 * A provider that keeps durable records and vouches for their absence, as a
 * real adapter may declare (`authoritativeAbsence`). The mock never does
 * (Codex on #164, HIGH 2); this double stands in for one that can, so the
 * decision table's NOT_FOUND branch is exercised as it will be used.
 */
class AbsenceVouchingProvider extends MockPaymentProvider {
  override readonly authoritativeAbsence = true;

  override async getRefundStatus(query: RefundStatusQuery): Promise<RefundStatusResult> {
    const answer = await super.getRefundStatus(query);
    return answer.refund === 'UNKNOWN'
      ? { refund: 'NOT_FOUND', authoritative: true, simulated: true }
      : answer;
  }
}

describe('the payment reconciler (real database)', () => {
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
      testEnv(),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  const reconcilerWith = (overrides: Partial<EconomicEnv> = {}, withProvider = provider) =>
    new PaymentReconciler(
      prisma,
      payments,
      wiring.paymentReconciliation,
      withProvider,
      wiring.ledger,
      wiring.walletRepository,
      { ...env, ...overrides },
    );

  const sweeperWith = (overrides: Partial<EconomicEnv> = {}, withProvider = provider) =>
    new PaymentReconciliationSweeper(
      wiring.paymentReconciliation,
      reconcilerWith(overrides, withProvider),
      { ...env, ...overrides },
    );

  interface TaskRow {
    id: string;
    status: string;
    attempts: number;
    lastOutcome: string | null;
    resolution: string | null;
    resolvedBy: string | null;
    leaseToken: string | null;
    escalatedAt: Date | null;
    dueIn: number;
  }

  const tasksOf = (paymentIntentId: string) =>
    runUnscoped('the suite reads the tasks it caused', () =>
      prisma.client.$queryRawUnsafe<TaskRow[]>(
        `SELECT id, status::text AS status, attempts, last_outcome AS "lastOutcome", resolution,
                resolved_by AS "resolvedBy", lease_token AS "leaseToken",
                escalated_at AS "escalatedAt",
                extract(epoch FROM next_attempt_at - now())::float8 AS "dueIn"
           FROM payment_reconciliation_task
          WHERE payment_intent_id = $1
          ORDER BY created_at, id`,
        paymentIntentId,
      ),
    );

  /** Makes the intent's pending task due now: the grace is what a test skips. */
  const makeDue = (paymentIntentId: string) =>
    runUnscoped('the suite makes its task due', () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE payment_reconciliation_task SET next_attempt_at = now() - interval '1 second'
          WHERE payment_intent_id = $1 AND status = 'PENDING'`,
        paymentIntentId,
      ),
    );

  const intentOf = (paymentIntentId: string) =>
    runUnscoped('the suite reads the intent', () =>
      prisma.client.paymentIntent.findUniqueOrThrow({ where: { id: paymentIntentId } }),
    );

  const holdsOf = (walletId: string) =>
    runUnscoped('the suite reads the refund holds', () =>
      prisma.client.walletHold.findMany({ where: { walletId, referenceType: 'PAYMENT_REFUND' } }),
    );

  /** Reversals of the intent's top-up journal: one after a refund, none otherwise. */
  const reversalsOf = async (paymentIntentId: string) => {
    const intent = await intentOf(paymentIntentId);
    const [row] = await runUnscoped('the suite counts reversals', () =>
      prisma.client.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM journal
          WHERE reverses_id IN (SELECT id FROM journal
                                 WHERE transaction_id = $1 AND journal_type = 'WALLET_TOP_UP')`,
        intent.transactionId,
      ),
    );
    return Number(row?.count ?? 0);
  };

  const eventsOf = async (organizationId: string, eventName: string) => {
    const rows = await runUnscoped('the suite reads the outbox', () =>
      prisma.client.outboxMessage.findMany({ where: { organizationId, eventName } }),
    );
    return rows.map((row) => (row.payload as { payload: Record<string, unknown> }).payload);
  };

  const deviations = () =>
    new LedgerBalanceAudit(wiring.walletRepository, wiring.ledger, env).run();

  async function topUp(organizationId: string, amountMinor: bigint) {
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    const result = await asActor({ organizationId }, () =>
      payments.topUp(wallet.id, {
        amountMinor: amountMinor.toString(),
        idempotencyKey: `REC-${ulid()}`,
      }),
    );
    return { walletId: wallet.id, intentId: result.paymentIntentId };
  }

  const refundBy = (organizationId: string, intentId: string) =>
    asActor({ organizationId }, () => payments.refund(intentId, 'the suite refunds'));

  /** The provider refunds; its answer never arrives. */
  function loseRefundResponse(target: MockPaymentProvider = provider) {
    const real = target.refund.bind(target);
    return jest.spyOn(target, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
      await real(request);
      throw new Error('provider response lost');
    });
  }

  /** The call fails before it reaches the provider: nothing happened there. */
  function refundNeverArrives() {
    return jest.spyOn(provider, 'refund').mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
  }

  /** A refund left REFUND_UNKNOWN, the provider having really refunded. */
  async function unknownButRefunded(organizationId: string, amount = 500n) {
    const made = await topUp(organizationId, amount);
    loseRefundResponse();
    await expect(refundBy(organizationId, made.intentId)).rejects.toThrow('provider response lost');
    expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_UNKNOWN');
    await makeDue(made.intentId);
    return made;
  }

  function expectRecordedRefund(made: { walletId: string; intentId: string }) {
    return (async () => {
      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'REFUNDED',
        failureReason: null,
      });
      expect(await reversalsOf(made.intentId)).toBe(1);
      expect(
        (await holdsOf(made.walletId))
          .filter((hold) => hold.reference === made.intentId)
          .map((hold) => hold.status),
      ).toEqual(['REFUNDED']);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({
        ledger: 0n,
        pending: 0n,
        available: 0n,
      });
    })();
  }

  function expectReturnedHold(made: { walletId: string; intentId: string }, amount: bigint) {
    return (async () => {
      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect(await reversalsOf(made.intentId)).toBe(0);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({
        ledger: amount,
        pending: 0n,
        available: amount,
      });
    })();
  }

  describe('an unknown refund: the provider is asked first', () => {
    it('records a refund the provider made, once, and says so', async () => {
      const organizationId = `${org.a}-REFUNDED`;
      const made = await unknownButRefunded(organizationId);
      const ask = jest.spyOn(provider, 'getRefundStatus');

      await sweeperWith().runOnce();

      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentIntentId: made.intentId,
          providerReference: `mock_${made.intentId}`,
          idempotencyKey: expect.stringMatching(/:refund$/),
        }),
      );
      await expectRecordedRefund(made);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({
          status: 'DONE',
          resolution: 'REFUNDED',
          resolvedBy: 'PAYMENT_RECONCILER',
          leaseToken: null,
        }),
      ]);
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED),
      ).toEqual([
        expect.objectContaining({
          paymentIntentId: made.intentId,
          organizationId,
          kind: 'REFUND',
          marker: 'REFUND_UNKNOWN',
          providerRefund: 'REFUNDED',
          resolution: 'REFUNDED',
          resolvedBy: 'PAYMENT_RECONCILER',
          simulated: true,
        }),
      ]);
      expect(await deviations()).toEqual([]);

      // A second sweep finds nothing to do and moves nothing again.
      await makeDue(made.intentId);
      await sweeperWith().runOnce();
      expect(await reversalsOf(made.intentId)).toBe(1);
    });

    it('finishes a refund a crash left REFUND_REQUESTED', async () => {
      const organizationId = `${org.a}-CRASHED`;
      const made = await topUp(organizationId, 450n);
      loseRefundResponse();
      const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
      jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (tx, input) => {
        if (input.eventName === ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED) {
          throw new Error('outbox down');
        }
        return enqueue(tx, input);
      });
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow();
      jest.restoreAllMocks();
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_REQUESTED');
      await makeDue(made.intentId);

      await sweeperWith().runOnce();

      await expectRecordedRefund(made);
    });

    it('returns the hold when the provider vouches the attempt never reached it', async () => {
      const organizationId = `${org.a}-NOT-REACHED`;
      const made = await topUp(organizationId, 600n);
      refundNeverArrives();
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow('ETIMEDOUT');
      await makeDue(made.intentId);

      await sweeperWith({}, new AbsenceVouchingProvider()).runOnce();

      await expectReturnedHold(made, 600n);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'DONE', resolution: 'REFUND_NOT_REACHED' }),
      ]);
      const [returned] = (await holdsOf(made.walletId)).filter(
        (hold) => hold.reference === made.intentId,
      );
      expect(returned?.resolutionNote).toMatch(/never reached the provider/);
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED),
      ).toEqual([
        expect.objectContaining({ providerRefund: 'NOT_FOUND', resolution: 'REFUND_NOT_REACHED' }),
      ]);

      // The intent is refundable again, and the next refund is a new attempt.
      await refundBy(organizationId, made.intentId);
      expect((await intentOf(made.intentId)).status).toBe('REFUNDED');
      expect(await deviations()).toEqual([]);
    });

    it('moves nothing when the mock never saw the attempt: it cannot vouch for an absence', async () => {
      // Codex on #164, HIGH 2: an empty process-local memory is not evidence.
      const organizationId = `${org.a}-MOCK-ABSENT`;
      const made = await topUp(organizationId, 610n);
      refundNeverArrives();
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow('ETIMEDOUT');
      await makeDue(made.intentId);

      await sweeperWith().runOnce();

      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_UNKNOWN');
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 610n });
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({
          status: 'PENDING',
          attempts: 1,
          lastOutcome: 'PROVIDER_OUTCOME_UNKNOWN',
        }),
      ]);
    });

    it('keeps the hold when replica B is asked about a refund replica A made', async () => {
      const organizationId = `${org.a}-REPLICAS`;
      const made = await unknownButRefunded(organizationId, 620n); // refunded by `provider`
      const replicaB = new MockPaymentProvider();

      await sweeperWith({}, replicaB).runOnce();

      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUND_UNKNOWN',
      });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 620n });
      expect(await reversalsOf(made.intentId)).toBe(0);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ lastOutcome: 'PROVIDER_OUTCOME_UNKNOWN' }),
      ]);
    });

    it('does not act on a NOT_FOUND from a provider that never declared it can vouch', async () => {
      const organizationId = `${org.a}-NO-CAPABILITY`;
      const made = await unknownButRefunded(organizationId, 630n);
      jest.spyOn(provider, 'getRefundStatus').mockResolvedValueOnce({
        refund: 'NOT_FOUND',
        authoritative: true,
        simulated: true,
      });

      await sweeperWith().runOnce();

      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 630n });
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ lastOutcome: 'PROVIDER_NOT_FOUND_UNCERTAIN' }),
      ]);
    });

    it('returns the hold when the provider says it declined', async () => {
      const organizationId = `${org.a}-DECLINED`;
      const made = await unknownButRefunded(organizationId, 350n);
      jest.spyOn(provider, 'getRefundStatus').mockResolvedValueOnce({
        refund: 'DECLINED',
        authoritative: true,
        failureCode: 'NOT_PERMITTED',
        simulated: true,
      });

      await sweeperWith().runOnce();

      await expectReturnedHold(made, 350n);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'DONE', resolution: 'REFUND_DECLINED' }),
      ]);
    });

    it('moves nothing when a restarted provider cannot vouch, and asks again later', async () => {
      const organizationId = `${org.a}-RESTARTED`;
      const made = await unknownButRefunded(organizationId, 250n);
      const restarted = new MockPaymentProvider();

      const outcome = await sweeperWith({}, restarted).runOnce();

      expect(outcome.retried).toBeGreaterThanOrEqual(1);
      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUND_UNKNOWN',
      });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 250n });
      expect(await reversalsOf(made.intentId)).toBe(0);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({
          status: 'PENDING',
          attempts: 1,
          lastOutcome: 'PROVIDER_OUTCOME_UNKNOWN',
          leaseToken: null,
          dueIn: expect.any(Number),
        }),
      ]);
      const [task] = await tasksOf(made.intentId);
      expect(task!.dueIn).toBeGreaterThan(env.ECONOMIC_PAYMENT_RECONCILER_BACKOFF_SECONDS - 30);
    });

    it('moves nothing when the provider cannot be reached', async () => {
      const organizationId = `${org.a}-UNREACHABLE`;
      const made = await unknownButRefunded(organizationId, 260n);
      jest.spyOn(provider, 'getRefundStatus').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await sweeperWith().runOnce();

      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_UNKNOWN');
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ attempts: 1, lastOutcome: 'PROVIDER_UNREACHABLE' }),
      ]);
    });
  });

  describe('a known outcome: recorded without asking', () => {
    it('reverses a refund the provider made and the ledger could not record', async () => {
      const organizationId = `${org.b}-NOT-REVERSED`;
      const made = await topUp(organizationId, 700n);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow('connection reset');
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUNDED_NOT_REVERSED');
      const ask = jest.spyOn(provider, 'getRefundStatus');
      const refund = jest.spyOn(provider, 'refund');

      await sweeperWith().runOnce();

      expect(ask).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
      await expectRecordedRefund(made);
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED),
      ).toEqual([
        expect.objectContaining({ marker: 'REFUNDED_NOT_REVERSED', providerRefund: null }),
      ]);
    });

    it('returns a declined refund’s hold the request path could not return', async () => {
      const organizationId = `${org.b}-RELEASE`;
      const made = await topUp(organizationId, 650n);
      jest.spyOn(provider, 'refund').mockResolvedValueOnce({
        outcome: 'FAILED',
        providerReference: 'x',
        failureCode: 'NOT_PERMITTED',
        simulated: true,
      });
      jest.spyOn(wiring.wallets, 'refundHold').mockRejectedValueOnce(new Error('connection reset'));
      await expect(refundBy(organizationId, made.intentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_DECLINED_RELEASE_PENDING');
      const ask = jest.spyOn(provider, 'getRefundStatus');

      await sweeperWith().runOnce();

      expect(ask).not.toHaveBeenCalled();
      await expectReturnedHold(made, 650n);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'DONE', resolution: 'REFUND_DECLINED' }),
      ]);
    });

    it('defers a reversal from a frozen wallet without counting an attempt, then records it', async () => {
      const organizationId = `${org.b}-FROZEN`;
      const made = await topUp(organizationId, 720n);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow('connection reset');
      const setStatus = (status: 'ACTIVE' | 'FROZEN') =>
        runUnscoped('the suite freezes or thaws the wallet', () =>
          prisma.client.wallet.update({ where: { id: made.walletId }, data: { status } }),
        );
      await setStatus('FROZEN');

      const outcome = await sweeperWith().runOnce();

      expect(outcome.deferred).toBeGreaterThanOrEqual(1);
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUNDED_NOT_REVERSED');
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 720n });
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({
          status: 'PENDING',
          attempts: 0,
          lastOutcome: 'WALLET_NOT_ACTIVE',
        }),
      ]);

      await setStatus('ACTIVE');
      await makeDue(made.intentId);
      await sweeperWith().runOnce();
      await expectRecordedRefund(made);
    });
  });

  describe('escalation', () => {
    it('escalates at the attempt limit, keeps the hold, and stops claiming the task', async () => {
      const organizationId = `${org.b}-ESCALATE`;
      const made = await unknownButRefunded(organizationId, 300n);
      const restarted = new MockPaymentProvider();
      const limits = { ECONOMIC_PAYMENT_RECONCILER_MAX_ATTEMPTS: 2 };

      await sweeperWith(limits, restarted).runOnce();
      expect((await tasksOf(made.intentId))[0]).toMatchObject({ status: 'PENDING', attempts: 1 });

      await makeDue(made.intentId);
      const outcome = await sweeperWith(limits, restarted).runOnce();

      expect(outcome.escalated).toBeGreaterThanOrEqual(1);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({
          status: 'ESCALATED',
          attempts: 2,
          lastOutcome: 'PROVIDER_OUTCOME_UNKNOWN',
          leaseToken: null,
          escalatedAt: expect.any(Date),
        }),
      ]);
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_ESCALATED),
      ).toEqual([
        expect.objectContaining({
          paymentIntentId: made.intentId,
          kind: 'REFUND',
          marker: 'REFUND_UNKNOWN',
          lastOutcome: 'PROVIDER_OUTCOME_UNKNOWN',
          attempts: 2,
          simulated: true,
        }),
      ]);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 300n });
      expect((await wiring.paymentReconciliation.backlog()).escalated).toBeGreaterThanOrEqual(1);

      // Escalated is a person's: no sweep takes it again, due or not.
      await runUnscoped('the suite backdates the task', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE payment_reconciliation_task SET next_attempt_at = now() - interval '1 hour'
            WHERE payment_intent_id = $1`,
          made.intentId,
        ),
      );
      const ask = jest.spyOn(restarted, 'getRefundStatus');
      await sweeperWith(limits, restarted).runOnce();
      expect(ask).not.toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: made.intentId }),
      );
    });

    it('escalates a refund hold that outlived its marker instead of closing it', async () => {
      const organizationId = `${org.b}-ORPHAN`;
      const made = await unknownButRefunded(organizationId, 310n);
      await runUnscoped('the suite corrupts the marker', () =>
        prisma.client.paymentIntent.update({
          where: { id: made.intentId },
          data: { failureReason: null },
        }),
      );

      await sweeperWith().runOnce();

      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'ESCALATED', lastOutcome: 'HOLD_WITHOUT_MARKER' }),
      ]);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 310n });
    });
  });

  describe('an uncreditable capture whose refund answer was lost (U6)', () => {
    async function uncreditable(organizationId: string, lose: boolean) {
      const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
      const key = `REC-U6-${ulid()}`;
      jest
        .spyOn(wiring.wallets, 'credit')
        .mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
      if (lose) loseRefundResponse();
      else jest.spyOn(provider, 'refund').mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
      await expect(
        asActor({ organizationId }, () =>
          payments.topUp(wallet.id, { amountMinor: '800', idempotencyKey: key }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      jest.restoreAllMocks();
      const [intent] = await runUnscoped('the suite reads its intent', () =>
        prisma.client.paymentIntent.findMany({ where: { organizationId } }),
      );
      expect(intent?.failureReason).toBe('CAPTURED_REFUND_UNKNOWN');
      await makeDue(intent!.id);
      return { walletId: wallet.id, intentId: intent!.id, key };
    }

    it('fails the intent when the provider did refund: nothing was credited, nothing moves', async () => {
      const organizationId = `${org.c}-U6-REFUNDED`;
      const made = await uncreditable(organizationId, true);

      await sweeperWith().runOnce();

      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'FAILED',
        failureReason: 'CAPTURE_NOT_CREDITED',
      });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ ledger: 0n, pending: 0n });
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'DONE', resolution: 'UNCREDITED_REFUNDED' }),
      ]);
      expect(await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_FAILED)).toEqual([
        expect.objectContaining({ paymentIntentId: made.intentId }),
      ]);
    });

    it('makes it creditable when the refund never reached the provider, and a retry credits it', async () => {
      const organizationId = `${org.c}-U6-NOT-REACHED`;
      const made = await uncreditable(organizationId, false);

      await sweeperWith({}, new AbsenceVouchingProvider()).runOnce();

      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'AUTHORIZED',
        failureReason: 'CAPTURED_NOT_CREDITED',
      });
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'DONE', resolution: 'UNCREDITED_NOT_REACHED' }),
      ]);

      const retried = await asActor({ organizationId }, () =>
        payments.topUp(made.walletId, { amountMinor: '800', idempotencyKey: made.key }),
      );
      expect(retried).toMatchObject({ paymentIntentId: made.intentId, status: 'CAPTURED' });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ ledger: 800n });
    });
  });

  describe('concurrency: each resolution happens once', () => {
    it('lets two sweepers on the same due set resolve each intent once', async () => {
      const organizationId = `${org.c}-TWO-SWEEPERS`;
      const first = await unknownButRefunded(`${organizationId}-1`, 210n);
      const second = await unknownButRefunded(`${organizationId}-2`, 220n);

      await Promise.all([sweeperWith().runOnce(), sweeperWith().runOnce()]);

      for (const made of [first, second]) {
        await expectRecordedRefund({ ...made, walletId: made.walletId });
      }
      for (const suffix of ['-1', '-2']) {
        expect(
          await eventsOf(
            `${organizationId}${suffix}`,
            ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED,
          ),
        ).toHaveLength(1);
      }
    });

    it('fences off a sweeper whose lease was taken back while it asked the provider', async () => {
      const organizationId = `${org.c}-FENCE`;
      const made = await unknownButRefunded(organizationId, 230n);

      // Sweeper A claims and asks; its answer is held until B has finished.
      let releaseA!: () => void;
      const heldA = new Promise<void>((resolve) => (releaseA = resolve));
      let askedA!: () => void;
      const asking = new Promise<void>((resolve) => (askedA = resolve));
      const slow = new MockPaymentProvider();
      const real = provider.getRefundStatus.bind(provider);
      jest
        .spyOn(slow, 'getRefundStatus')
        .mockImplementation(async (query: RefundStatusQuery): Promise<RefundStatusResult> => {
          askedA();
          await heldA;
          return real(query);
        });
      const sweepA = sweeperWith({}, slow).runOnce();
      await asking;

      // A's lease lapses; B takes the task and resolves it.
      await runUnscoped('the suite expires the lease', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE payment_reconciliation_task SET lease_until = now() - interval '1 second'
            WHERE payment_intent_id = $1`,
          made.intentId,
        ),
      );
      await sweeperWith().runOnce();
      await expectRecordedRefund(made);

      releaseA();
      const outcomeA = await sweepA;

      expect(outcomeA.lost).toBe(1);
      expect(await reversalsOf(made.intentId)).toBe(1);
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED),
      ).toHaveLength(1);
    });

    it('resolves once when the sweeper races a late retry of the refund', async () => {
      const organizationId = `${org.c}-RACE`;
      const made = await topUp(organizationId, 240n);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow('connection reset');

      const results = await Promise.allSettled([
        sweeperWith().runOnce(),
        refundBy(organizationId, made.intentId),
      ]);

      expect(results[0].status).toBe('fulfilled');
      await expectRecordedRefund(made);
      expect(await tasksOf(made.intentId)).toEqual([expect.objectContaining({ status: 'DONE' })]);
    });
  });

  /**
   * Codex on #161, HIGH 1 (PM ruling): a B0 instance still running during the
   * deploy writes markers without tasks and resolves intents without closing
   * them. The sweeper heals both directions every cycle, so correctness does
   * not depend on deploy order. "B0-style" below is this code with the task
   * writes switched off — exactly what the old build does.
   */
  describe('healing a mixed-version deploy', () => {
    it('opens a task for a marker a B0 instance left without one, and then resolves it', async () => {
      const organizationId = `${org.b}-HEAL-OPEN`;
      const unknown = await topUp(`${organizationId}-U`, 330n);
      const known = await topUp(`${organizationId}-K`, 340n);
      const b0 = jest.spyOn(wiring.paymentReconciliation, 'open').mockResolvedValue(undefined);
      loseRefundResponse();
      await expect(refundBy(`${organizationId}-U`, unknown.intentId)).rejects.toThrow('lost');
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
      await expect(refundBy(`${organizationId}-K`, known.intentId)).rejects.toThrow(
        'connection reset',
      );
      b0.mockRestore();
      expect(await tasksOf(unknown.intentId)).toEqual([]);
      expect(await tasksOf(known.intentId)).toEqual([]);

      const outcome = await sweeperWith().runOnce();

      expect(outcome.healedOpened).toBeGreaterThanOrEqual(2);
      // Unknown: due after the grace, as if the request path had opened it —
      // a B0 provider call may still be running.
      expect(await tasksOf(unknown.intentId)).toEqual([
        expect.objectContaining({ status: 'PENDING', lastOutcome: 'MISSING_TASK' }),
      ]);
      expect((await tasksOf(unknown.intentId))[0]!.dueIn).toBeGreaterThan(
        env.ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS - 30,
      );
      // Known: due at once, and claimed in the same cycle.
      await expectRecordedRefund(known);
      expect(await tasksOf(known.intentId)).toEqual([
        expect.objectContaining({ status: 'DONE', resolution: 'REFUNDED' }),
      ]);

      await makeDue(unknown.intentId);
      await sweeperWith().runOnce();
      await expectRecordedRefund(unknown);
    });

    it('closes an open task whose intent a B0 instance resolved, and moves nothing', async () => {
      const organizationId = `${org.b}-HEAL-CLOSE`;
      const pending = { ...(await topUp(`${organizationId}-P`, 350n)), org: `${organizationId}-P` };
      const escalated = {
        ...(await topUp(`${organizationId}-E`, 360n)),
        org: `${organizationId}-E`,
      };
      for (const made of [pending, escalated]) {
        jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
        await expect(refundBy(made.org, made.intentId)).rejects.toThrow('connection reset');
      }
      await runUnscoped('the suite escalates one task and pushes the other out', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE payment_reconciliation_task
              SET status = CASE WHEN payment_intent_id = $2 THEN 'ESCALATED'::"PaymentReconciliationStatus"
                                ELSE status END,
                  escalated_at = CASE WHEN payment_intent_id = $2 THEN now() ELSE escalated_at END,
                  next_attempt_at = now() + interval '1 hour'
            WHERE payment_intent_id IN ($1, $2)`,
          pending.intentId,
          escalated.intentId,
        ),
      );
      // B0 finishes both refunds and closes nothing.
      const b0 = jest.spyOn(wiring.paymentReconciliation, 'close').mockResolvedValue(0);
      await refundBy(pending.org, pending.intentId);
      await refundBy(escalated.org, escalated.intentId);
      b0.mockRestore();
      expect((await tasksOf(pending.intentId))[0]?.status).toBe('PENDING');
      expect((await tasksOf(escalated.intentId))[0]?.status).toBe('ESCALATED');
      const ask = jest.spyOn(provider, 'getRefundStatus');

      const outcome = await sweeperWith().runOnce();

      expect(outcome.healedClosed).toBeGreaterThanOrEqual(2);
      for (const made of [pending, escalated]) {
        expect(await tasksOf(made.intentId)).toEqual([
          expect.objectContaining({
            status: 'DONE',
            resolution: 'NOTHING_TO_RECONCILE',
            resolvedBy: 'PAYMENT_RECONCILER',
          }),
        ]);
        await expectRecordedRefund(made);
      }
      expect(ask).not.toHaveBeenCalled();
    });

    /** The database clock, for a cursor that starts just before this test's rows. */
    const dbNow = async () => {
      const [row] = await runUnscoped('the suite reads the clock', () =>
        prisma.client.$queryRawUnsafe<{ now: Date }[]>(`SELECT clock_timestamp() AS now`),
      );
      return row!.now;
    };

    it('examines a bounded window of marked intents per sweep, whatever the backlog (Codex on #164)', async () => {
      const organizationId = `${org.b}-HEAL-WINDOW`;
      const from = await dbNow();
      // Three marked intents that have their tasks, then two B0 left without.
      for (const index of [0, 1, 2]) await unknownButRefunded(`${organizationId}-H${index}`, 100n);
      const missing: string[] = [];
      for (const index of [0, 1]) {
        const tenant = `${organizationId}-M${index}`;
        const made = await topUp(tenant, 100n);
        const b0 = jest.spyOn(wiring.paymentReconciliation, 'open').mockResolvedValue(undefined);
        loseRefundResponse();
        await expect(refundBy(tenant, made.intentId)).rejects.toThrow('lost');
        b0.mockRestore();
        missing.push(made.intentId);
      }
      const start = { createdAt: from, id: '' };
      let cursor: HealCursor = { missing: start, stale: start };

      // Window 1: H0, H1 — both have tasks. Nothing opened, however many are behind.
      let pass = await wiring.paymentReconciliation.heal(2, cursor);
      expect(pass.opened).toBe(0);
      // Window 2: H2, M0.
      cursor = pass.cursor;
      pass = await wiring.paymentReconciliation.heal(2, cursor);
      expect(pass.opened).toBe(1);
      expect(await tasksOf(missing[0]!)).toHaveLength(1);
      expect(await tasksOf(missing[1]!)).toHaveLength(0);
      // Window 3: M1, then the end: the cursor starts over.
      pass = await wiring.paymentReconciliation.heal(2, pass.cursor);
      expect(pass.opened).toBe(1);
      expect(await tasksOf(missing[1]!)).toHaveLength(1);
      expect(pass.cursor.missing).toBeNull();
    });

    it('examines a bounded window of open tasks per sweep, closing the settled ones in it', async () => {
      const organizationId = `${org.b}-HEAL-WINDOW-CLOSE`;
      const from = await dbNow();
      // Two open tasks still owed, then three whose intents B0 settled.
      for (const index of [0, 1]) await unknownButRefunded(`${organizationId}-O${index}`, 100n);
      const settled: string[] = [];
      for (const index of [0, 1, 2]) {
        const tenant = `${organizationId}-S${index}`;
        const made = await topUp(tenant, 100n);
        jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
        await expect(refundBy(tenant, made.intentId)).rejects.toThrow('connection reset');
        const b0 = jest.spyOn(wiring.paymentReconciliation, 'close').mockResolvedValue(0);
        await refundBy(tenant, made.intentId);
        b0.mockRestore();
        settled.push(made.intentId);
      }
      const start = { createdAt: from, id: '' };

      let pass = await wiring.paymentReconciliation.heal(2, { missing: start, stale: start });
      expect(pass.closed).toBe(0); // O0, O1: still owed
      pass = await wiring.paymentReconciliation.heal(2, pass.cursor);
      expect(pass.closed).toBe(2); // S0, S1
      pass = await wiring.paymentReconciliation.heal(2, pass.cursor);
      expect(pass.closed).toBe(1); // S2, then the end
      expect(pass.cursor.stale).toBeNull();
      for (const id of settled) {
        expect(await tasksOf(id)).toEqual([
          expect.objectContaining({ status: 'DONE', resolution: 'NOTHING_TO_RECONCILE' }),
        ]);
      }
    });

    it('leaves a task alone whose refund hold outlived its marker: that is for a person', async () => {
      const organizationId = `${org.b}-HEAL-KEEP`;
      const made = await unknownButRefunded(organizationId, 370n);
      await runUnscoped('the suite corrupts the marker and pushes the task out', async () => {
        await prisma.client.paymentIntent.update({
          where: { id: made.intentId },
          data: { failureReason: null },
        });
        await prisma.client.$executeRawUnsafe(
          `UPDATE payment_reconciliation_task SET next_attempt_at = now() + interval '1 hour'
            WHERE payment_intent_id = $1`,
          made.intentId,
        );
      });

      await sweeperWith().runOnce();

      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'PENDING' }),
      ]);
    });
  });

  describe('when its own writes cannot complete', () => {
    it('keeps the hold and retries when applying the outcome fails', async () => {
      const organizationId = `${org.a}-APPLY-FAILS`;
      const made = await unknownButRefunded(organizationId, 410n);
      jest.spyOn(payments, 'recordRefund').mockRejectedValueOnce(new Error('connection reset'));

      const outcome = await sweeperWith().runOnce();

      expect(outcome.retried).toBeGreaterThanOrEqual(1);
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_UNKNOWN');
      expect(await reversalsOf(made.intentId)).toBe(0);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 410n });
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'PENDING', attempts: 1, lastOutcome: 'APPLY_FAILED' }),
      ]);
    });

    it('rolls the whole effect back when finishing its task touches no row', async () => {
      const organizationId = `${org.a}-FINISH-LOST`;
      const made = await unknownButRefunded(organizationId, 420n);
      const real = wiring.paymentReconciliation.ownershipOf.bind(wiring.paymentReconciliation);
      jest.spyOn(wiring.paymentReconciliation, 'ownershipOf').mockImplementation((task) => ({
        ...real(task),
        finish: async () => 0,
      }));

      const outcome = await sweeperWith().runOnce();

      expect(outcome.lost).toBeGreaterThanOrEqual(1);
      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUND_UNKNOWN',
      });
      expect(await reversalsOf(made.intentId)).toBe(0);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 420n });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED),
      ).toEqual([]);
    });

    it('reports a put-back or an escalation it no longer owns as lost', async () => {
      const organizationId = `${org.a}-PUTBACK-LOST`;
      const made = await unknownButRefunded(organizationId, 430n);
      const restarted = new MockPaymentProvider();
      jest.spyOn(wiring.paymentReconciliation, 'retryLater').mockResolvedValueOnce(0);
      expect((await sweeperWith({}, restarted).runOnce()).lost).toBeGreaterThanOrEqual(1);

      await runUnscoped('the suite frees the lease', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE payment_reconciliation_task
              SET lease_until = NULL, lease_token = NULL, next_attempt_at = now() - interval '1 second'
            WHERE payment_intent_id = $1`,
          made.intentId,
        ),
      );
      const real = wiring.paymentReconciliation.ownershipOf.bind(wiring.paymentReconciliation);
      jest.spyOn(wiring.paymentReconciliation, 'ownershipOf').mockImplementation((task) => ({
        ...real(task),
        escalate: async () => 0,
      }));
      const outcome = await sweeperWith(
        { ECONOMIC_PAYMENT_RECONCILER_MAX_ATTEMPTS: 1 },
        restarted,
      ).runOnce();
      expect(outcome.lost).toBeGreaterThanOrEqual(1);
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_ESCALATED),
      ).toEqual([]);
    });

    it('finishes a due task whose intent was settled without it, when the heal has not run', async () => {
      const organizationId = `${org.a}-NOOP`;
      const made = await topUp(organizationId, 440n);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow('connection reset');
      const b0 = jest.spyOn(wiring.paymentReconciliation, 'close').mockResolvedValue(0);
      await refundBy(organizationId, made.intentId);
      b0.mockRestore();
      jest
        .spyOn(wiring.paymentReconciliation, 'heal')
        .mockResolvedValue({ opened: 0, closed: 0, cursor: { missing: null, stale: null } });

      const outcome = await sweeperWith().runOnce();

      expect(outcome.noop).toBeGreaterThanOrEqual(1);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'DONE', resolution: 'NOTHING_TO_RECONCILE' }),
      ]);
      expect(await reversalsOf(made.intentId)).toBe(1);
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED),
      ).toEqual([
        expect.objectContaining({
          marker: null,
          providerRefund: null,
          resolution: 'NOTHING_TO_RECONCILE',
        }),
      ]);
    });

    it('escalates a reversal still waiting on a frozen wallet at the age limit, counting no attempt', async () => {
      const organizationId = `${org.a}-FROZEN-AGED`;
      const made = await topUp(organizationId, 450n);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
      await expect(refundBy(organizationId, made.intentId)).rejects.toThrow('connection reset');
      await runUnscoped('the suite freezes the wallet and ages the task', async () => {
        await prisma.client.wallet.update({
          where: { id: made.walletId },
          data: { status: 'FROZEN' },
        });
        await prisma.client.$executeRawUnsafe(
          `UPDATE payment_reconciliation_task
              SET created_at = now() - make_interval(hours => $2::int + 1)
            WHERE payment_intent_id = $1`,
          made.intentId,
          env.ECONOMIC_PAYMENT_RECONCILER_MAX_AGE_HOURS,
        );
      });

      await sweeperWith().runOnce();

      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({
          status: 'ESCALATED',
          attempts: 0,
          lastOutcome: 'WALLET_NOT_ACTIVE',
        }),
      ]);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 450n });
    });
  });

  describe('tenant isolation', () => {
    it('works each task in its own tenant and touches nothing of another', async () => {
      const mine = `${org.c}-ISO-A`;
      const theirs = `${org.c}-ISO-B`;
      const made = await unknownButRefunded(mine, 270n);
      const bystander = await topUp(theirs, 280n);
      const seen: string[] = [];
      const real = provider.getRefundStatus.bind(provider);
      jest.spyOn(provider, 'getRefundStatus').mockImplementation(async (query) => {
        if (query.paymentIntentId === made.intentId) seen.push(getOrganizationId());
        return real(query);
      });

      await sweeperWith().runOnce();

      expect(seen).toEqual([mine]);
      await expectRecordedRefund(made);
      expect(await eventsOf(theirs, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED)).toEqual([]);
      expect(await intentOf(bystander.intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect(await readBalances(prisma, bystander.walletId)).toMatchObject({ available: 280n });
      expect(await tasksOf(bystander.intentId)).toEqual([]);
    });
  });

  describe('tenant isolation, from the wrong side', () => {
    it('reads nothing and changes nothing for a task presented in the wrong tenant', async () => {
      const mine = `${org.c}-WRONG-A`;
      const theirs = `${org.c}-WRONG-B`;
      const made = await unknownButRefunded(mine, 275n);
      const [claimed] = await wiring.paymentReconciliation
        .claimDue(100, 60, `TOKEN-${ulid()}`)
        .then((tasks) => tasks.filter((task) => task.paymentIntentId === made.intentId));
      expect(claimed).toBeDefined();

      const result = await asActor({ organizationId: theirs }, () =>
        reconcilerWith().reconcile({ ...claimed!, organizationId: theirs }),
      );

      // The tenant guard hides the intent; the fenced escalation names the wrong
      // tenant and touches nothing.
      expect(result).toBe('lost_lease');
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'PENDING' }),
      ]);
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_UNKNOWN');
      expect(await eventsOf(theirs, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_ESCALATED)).toEqual([]);
    });
  });

  describe('the sweeper itself', () => {
    it('does not run on a timer when switched off, and stops cleanly when on', async () => {
      const off = sweeperWith({ ECONOMIC_PAYMENT_RECONCILER_ENABLED: false });
      off.onModuleInit();
      await off.onApplicationShutdown();

      const on = sweeperWith({ ECONOMIC_PAYMENT_RECONCILER_ENABLED: true });
      const run = jest.spyOn(on, 'runOnce');
      on.onModuleInit();
      await on.onApplicationShutdown();
      expect(run).not.toHaveBeenCalled();
    });

    it('reports the backlog it sees', async () => {
      const organizationId = `${org.c}-BACKLOG`;
      await unknownButRefunded(organizationId, 290n);
      const backlog = await wiring.paymentReconciliation.backlog();
      expect(backlog.open).toBeGreaterThanOrEqual(1);
      expect(backlog.oldestDueAgeSeconds).toBeGreaterThanOrEqual(0);
    });
  });
});

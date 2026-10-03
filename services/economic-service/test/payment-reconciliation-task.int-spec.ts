import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
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
import { walletBalanceLimit } from '../src/wallet/wallet.repository';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { ECONOMIC_EVENTS } from '../src/events/events';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RefundRequest } from '../src/payment/provider';

/**
 * ADR-064 step B1: every refund that can strand money has a reconciliation
 * task, written in the same transaction as the risk, and closed in the same
 * transaction as the outcome.
 *
 * B0 (#143) left the markers without anything that finds them again: an aged
 * `REFUND_REQUESTED` or a `REFUND_UNKNOWN` was refused forever. This suite
 * proves the queue the sweeper (B2) and the operator path (B3) will work from:
 * a crash leaves the marker *and* its task, every terminal outcome closes it,
 * and a task belongs to the intent's tenant and to no other.
 */
describe('payment reconciliation tasks (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let payments: PaymentService;
  let provider: MockPaymentProvider;
  const org = tenants();
  const grace = testEnv().ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS;

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
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

  interface TaskRow {
    id: string;
    organizationId: string;
    paymentIntentId: string;
    kind: string;
    status: string;
    attempts: number;
    lastOutcome: string | null;
    resolution: string | null;
    resolvedBy: string | null;
    doneAt: Date | null;
    /** Seconds from the database's `now()` to `next_attempt_at`. */
    dueIn: number;
  }

  /** Every task of an intent, oldest first, timed by the database clock. */
  const tasksOf = (paymentIntentId: string) =>
    runUnscoped('the suite reads the tasks it caused', () =>
      prisma.client.$queryRawUnsafe<TaskRow[]>(
        `SELECT id, organization_id AS "organizationId", payment_intent_id AS "paymentIntentId",
                kind::text AS kind, status::text AS status, attempts,
                last_outcome AS "lastOutcome", resolution, resolved_by AS "resolvedBy",
                done_at AS "doneAt",
                extract(epoch FROM next_attempt_at - now())::float8 AS "dueIn"
           FROM payment_reconciliation_task
          WHERE payment_intent_id = $1
          ORDER BY created_at, id`,
        paymentIntentId,
      ),
    );

  const intentOf = (paymentIntentId: string) =>
    runUnscoped('the suite reads the intent it created', () =>
      prisma.client.paymentIntent.findUniqueOrThrow({ where: { id: paymentIntentId } }),
    );

  async function topUp(organizationId: string, amountMinor: bigint) {
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    const result = await asActor({ organizationId }, () =>
      payments.topUp(wallet.id, {
        amountMinor: amountMinor.toString(),
        idempotencyKey: `PRT-${ulid()}`,
      }),
    );
    return { walletId: wallet.id, intentId: result.paymentIntentId };
  }

  const refundBy = (organizationId: string, intentId: string, userId?: string) =>
    asActor({ organizationId, ...(userId ? { userId } : {}) }, () =>
      payments.refund(intentId, 'the suite refunds'),
    );

  /** The provider refunds, and the answer never arrives. */
  function loseRefundResponse() {
    const real = provider.refund.bind(provider);
    return jest.spyOn(provider, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
      await real(request);
      throw new Error('provider response lost');
    });
  }

  /** Makes the unreconciled event — and so the marker written with it — fail. */
  function failUnreconciledMark() {
    const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
    jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (tx, input) => {
      if (input.eventName === ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED) {
        throw new Error('outbox down');
      }
      return enqueue(tx, input);
    });
  }

  /** `dueIn` is within a few seconds of `seconds` from now. */
  const dueAbout = (seconds: number) => ({
    asymmetricMatch: (dueIn: number) => Math.abs(dueIn - seconds) < 30,
    toString: () => `due in about ${seconds}s`,
  });

  describe('birth: the task is written with the risk', () => {
    it('opens a REFUND task due after the grace period in the step that holds the money', async () => {
      const organizationId = `${org.a}-BIRTH`;
      const { intentId } = await topUp(organizationId, 500n);
      const real = provider.refund.bind(provider);
      let seenDuringCall: TaskRow[] = [];
      jest.spyOn(provider, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
        seenDuringCall = await tasksOf(intentId);
        return real(request);
      });

      await refundBy(organizationId, intentId);

      expect(seenDuringCall).toEqual([
        expect.objectContaining({
          organizationId,
          paymentIntentId: intentId,
          kind: 'REFUND',
          status: 'PENDING',
          attempts: 0,
          lastOutcome: 'REFUND_REQUESTED',
          dueIn: dueAbout(grace),
        }),
      ]);
      expect(seenDuringCall[0]?.id).toMatch(/^PRT_[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('leaves the marker and a due task after a crash that follows the hold', async () => {
      // A lost answer whose unknown outcome cannot be recorded either: what a
      // process that dies right after step 1 leaves behind.
      const organizationId = `${org.a}-CRASH`;
      const { intentId } = await topUp(organizationId, 400n);
      loseRefundResponse();
      failUnreconciledMark();

      await expect(refundBy(organizationId, intentId)).rejects.toThrow('provider response lost');

      expect(await intentOf(intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUND_REQUESTED',
      });
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({
          kind: 'REFUND',
          status: 'PENDING',
          lastOutcome: 'REFUND_REQUESTED',
          dueIn: dueAbout(grace),
        }),
      ]);
    });

    it('writes no task when the refund is refused before the hold', async () => {
      const organizationId = `${org.a}-REFUSED`;
      const { walletId, intentId } = await topUp(organizationId, 300n);
      await runUnscoped('the suite freezes its wallet', () =>
        prisma.client.wallet.update({ where: { id: walletId }, data: { status: 'FROZEN' } }),
      );

      await expect(refundBy(organizationId, intentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect(await tasksOf(intentId)).toEqual([]);
    });

    it('opens an UNCREDITED_REFUND task when an uncreditable capture’s refund answer is lost', async () => {
      const organizationId = `${org.a}-U6`;
      jest
        .spyOn(wiring.wallets, 'credit')
        .mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
      loseRefundResponse();

      const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
      await expect(
        asActor({ organizationId }, () =>
          payments.topUp(wallet.id, { amountMinor: '900', idempotencyKey: `PRT-U6-${ulid()}` }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

      const [intent] = await runUnscoped('the suite reads its intent', () =>
        prisma.client.paymentIntent.findMany({ where: { organizationId } }),
      );
      expect(intent).toMatchObject({
        status: 'AUTHORIZED',
        failureReason: 'CAPTURED_REFUND_UNKNOWN',
      });
      expect(await tasksOf(intent!.id)).toEqual([
        expect.objectContaining({
          organizationId,
          kind: 'UNCREDITED_REFUND',
          status: 'PENDING',
          lastOutcome: 'PROVIDER_OUTCOME_UNKNOWN',
          dueIn: dueAbout(grace),
        }),
      ]);
    });

    it('opens no task for an uncreditable capture whose refund the provider answered', async () => {
      const organizationId = `${org.a}-U6-KNOWN`;
      const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));

      // Declined: the capture is certainly still held, and a same-key retry
      // credits it (B0). Nothing for a reconciler to ask.
      jest
        .spyOn(wiring.wallets, 'credit')
        .mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
      jest.spyOn(provider, 'refund').mockResolvedValueOnce({
        outcome: 'FAILED',
        providerReference: 'mock_refund_declined',
        failureCode: 'REFUND_DECLINED',
        simulated: true,
      });
      await expect(
        asActor({ organizationId }, () =>
          payments.topUp(wallet.id, { amountMinor: '600', idempotencyKey: `PRT-D-${ulid()}` }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

      // Refunded: the intent is FAILED, and nothing is left to reconcile.
      jest
        .spyOn(wiring.wallets, 'credit')
        .mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
      const failed = await asActor({ organizationId }, () =>
        payments.topUp(wallet.id, { amountMinor: '700', idempotencyKey: `PRT-R-${ulid()}` }),
      );
      expect(failed.status).toBe('FAILED');

      const intents = await runUnscoped('the suite reads its intents', () =>
        prisma.client.paymentIntent.findMany({ where: { organizationId } }),
      );
      expect(intents.map((intent) => intent.failureReason).sort()).toEqual([
        'CAPTURED_NOT_CREDITED',
        'WALLET_BALANCE_LIMIT',
      ]);
      for (const intent of intents) expect(await tasksOf(intent.id)).toEqual([]);
    });
  });

  describe('rescheduling: an unresolved outcome keeps its task and says when to look', () => {
    it('keeps a lost answer’s task due after the grace period, with its outcome', async () => {
      const organizationId = `${org.b}-UNKNOWN`;
      const { intentId } = await topUp(organizationId, 800n);
      loseRefundResponse();

      await expect(refundBy(organizationId, intentId)).rejects.toThrow('provider response lost');

      expect((await intentOf(intentId)).failureReason).toBe('REFUND_UNKNOWN');
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({
          kind: 'REFUND',
          status: 'PENDING',
          lastOutcome: 'PROVIDER_OUTCOME_UNKNOWN',
          dueIn: dueAbout(grace),
        }),
      ]);
    });

    it('makes a known outcome due now, and closes it when a retry records it', async () => {
      const organizationId = `${org.b}-REVERSAL`;
      const { intentId } = await topUp(organizationId, 1_000n);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));

      await expect(refundBy(organizationId, intentId)).rejects.toThrow('connection reset');

      expect((await intentOf(intentId)).failureReason).toBe('REFUNDED_NOT_REVERSED');
      const [open] = await tasksOf(intentId);
      expect(open).toMatchObject({
        status: 'PENDING',
        lastOutcome: 'REVERSAL_FAILED',
        dueIn: dueAbout(0),
      });

      await refundBy(organizationId, intentId, 'USR-PRT-RETRY');

      expect((await intentOf(intentId)).status).toBe('REFUNDED');
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({
          id: open?.id,
          status: 'DONE',
          resolution: 'REFUNDED',
          resolvedBy: 'USR-PRT-RETRY',
          doneAt: expect.any(Date),
        }),
      ]);
    });

    it('makes a decline whose hold was not returned due now, and closes it on release', async () => {
      const organizationId = `${org.b}-DECLINED-PENDING`;
      const { intentId } = await topUp(organizationId, 650n);
      jest.spyOn(provider, 'refund').mockResolvedValueOnce({
        outcome: 'FAILED',
        providerReference: 'mock_refund_declined',
        failureCode: 'REFUND_DECLINED',
        simulated: true,
      });
      jest.spyOn(wiring.wallets, 'refundHold').mockRejectedValueOnce(new Error('connection reset'));

      await expect(refundBy(organizationId, intentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect((await intentOf(intentId)).failureReason).toBe('REFUND_DECLINED_RELEASE_PENDING');
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({
          status: 'PENDING',
          lastOutcome: 'PROVIDER_DECLINED_RELEASE_PENDING',
          dueIn: dueAbout(0),
        }),
      ]);

      await expect(refundBy(organizationId, intentId, 'USR-PRT-RELEASE')).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });

      expect((await intentOf(intentId)).failureReason).toBeNull();
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({
          status: 'DONE',
          resolution: 'REFUND_DECLINED',
          resolvedBy: 'USR-PRT-RELEASE',
        }),
      ]);
    });
  });

  describe('death: every terminal outcome closes the task in the same transaction', () => {
    it('closes it when the refund completes', async () => {
      const organizationId = `${org.b}-DONE`;
      const { intentId } = await topUp(organizationId, 500n);

      await refundBy(organizationId, intentId, 'USR-PRT-DONE');

      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({
          status: 'DONE',
          resolution: 'REFUNDED',
          resolvedBy: 'USR-PRT-DONE',
          doneAt: expect.any(Date),
        }),
      ]);
    });

    it('closes it on a decline, and a later refund opens a task of its own', async () => {
      const organizationId = `${org.b}-DECLINE`;
      const { intentId } = await topUp(organizationId, 550n);
      jest.spyOn(provider, 'refund').mockResolvedValueOnce({
        outcome: 'FAILED',
        providerReference: 'mock_refund_declined',
        failureCode: 'REFUND_DECLINED',
        simulated: true,
      });

      await expect(refundBy(organizationId, intentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({ status: 'DONE', resolution: 'REFUND_DECLINED' }),
      ]);

      await refundBy(organizationId, intentId);

      const tasks = await tasksOf(intentId);
      expect(tasks).toHaveLength(2);
      expect(tasks.map((task) => task.resolution)).toEqual(['REFUND_DECLINED', 'REFUNDED']);
      expect(new Set(tasks.map((task) => task.id)).size).toBe(2);
    });

    it('rolls the outcome back when its task cannot be closed', async () => {
      // Closing is part of step 3's transaction: a refund recorded without its
      // task closed would leave the sweeper a task for work already done, and
      // the reverse would leave money moved with a task still promising to.
      const organizationId = `${org.b}-ROLLBACK`;
      const { walletId, intentId } = await topUp(organizationId, 750n);
      jest
        .spyOn(wiring.paymentReconciliation, 'close')
        .mockRejectedValueOnce(new Error('queue down'));

      await expect(refundBy(organizationId, intentId)).rejects.toThrow('queue down');

      expect(await intentOf(intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUNDED_NOT_REVERSED',
      });
      expect(await readBalances(prisma, walletId)).toMatchObject({ ledger: 750n, pending: 750n });
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({ status: 'PENDING', lastOutcome: 'REVERSAL_FAILED' }),
      ]);

      await refundBy(organizationId, intentId);
      expect((await intentOf(intentId)).status).toBe('REFUNDED');
      expect(await readBalances(prisma, walletId)).toMatchObject({ ledger: 0n, pending: 0n });
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({ status: 'DONE', resolution: 'REFUNDED' }),
      ]);
    });
  });

  describe('the queue itself', () => {
    it('keeps at most one open task per intent: a second opening reschedules the first', async () => {
      const organizationId = `${org.c}-COALESCE`;
      const { intentId } = await topUp(organizationId, 200n);
      const open = (outcome: string, due: 'NOW' | 'GRACE') =>
        asActor({ organizationId }, () =>
          prisma.transaction((tx) =>
            wiring.paymentReconciliation.open(tx, {
              organizationId,
              paymentIntentId: intentId,
              kind: 'REFUND',
              outcome,
              due,
            }),
          ),
        );

      await open('REFUND_REQUESTED', 'GRACE');
      await open('REVERSAL_FAILED', 'NOW');

      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({
          status: 'PENDING',
          lastOutcome: 'REVERSAL_FAILED',
          dueIn: dueAbout(0),
        }),
      ]);

      // An escalated task is a person's now: a later outcome does not move it.
      await runUnscoped('the suite escalates the task', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE payment_reconciliation_task
              SET status = 'ESCALATED', escalated_at = now()
            WHERE payment_intent_id = $1`,
          intentId,
        ),
      );
      await open('PROVIDER_OUTCOME_UNKNOWN', 'GRACE');
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({ status: 'ESCALATED', lastOutcome: 'REVERSAL_FAILED' }),
      ]);
    });

    it('refuses a second open task for one intent at the database', async () => {
      const organizationId = `${org.c}-UNIQUE`;
      const { intentId } = await topUp(organizationId, 210n);
      const insert = () =>
        runUnscoped('the suite writes a task directly', () =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO payment_reconciliation_task
               (id, organization_id, payment_intent_id, kind, next_attempt_at, correlation_id,
                created_at, updated_at)
             VALUES ($1, $2, $3, 'REFUND', now(), 'COR-PRT', now(), now())`,
            `PRT_${ulid()}`,
            organizationId,
            intentId,
          ),
        );

      await insert();
      // Prisma reports the key rather than the index name: 23505 on the intent.
      await expect(insert()).rejects.toThrow(/23505.*Key \(payment_intent_id\)/s);
    });

    it('holds its own invariants: a closed code, a lease pair, and DONE with its resolution', async () => {
      const organizationId = `${org.c}-CHECKS`;
      const { intentId } = await topUp(organizationId, 220n);
      const insert = (columns: string, values: string) =>
        runUnscoped('the suite writes a task directly', () =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO payment_reconciliation_task
               (id, organization_id, payment_intent_id, kind, next_attempt_at, correlation_id,
                created_at, updated_at${columns})
             VALUES ($1, $2, $3, 'REFUND', now(), 'COR-PRT', now(), now()${values})`,
            `PRT_${ulid()}`,
            organizationId,
            intentId,
          ),
        );

      await expect(insert(', last_outcome', `, 'card 6037 9911'`)).rejects.toThrow(
        /ck_payment_reconciliation_codes/,
      );
      await expect(insert(', lease_token', `, 'token-without-time'`)).rejects.toThrow(
        /ck_payment_reconciliation_lease_pair/,
      );
      await expect(insert(', status', `, 'DONE'`)).rejects.toThrow(
        /ck_payment_reconciliation_done_complete/,
      );
      await expect(insert(', status', `, 'ESCALATED'`)).rejects.toThrow(
        /ck_payment_reconciliation_escalated/,
      );
      await expect(insert(', attempts', ', -1')).rejects.toThrow(
        /ck_payment_reconciliation_attempts_nonneg/,
      );
    });
  });

  describe('tenant isolation', () => {
    it('binds a task to its intent’s tenant, and no other tenant reads or closes it', async () => {
      const organizationId = `${org.c}-TENANT-A`;
      const other = `${org.c}-TENANT-B`;
      const { intentId } = await topUp(organizationId, 330n);
      loseRefundResponse();
      await expect(refundBy(organizationId, intentId)).rejects.toThrow('provider response lost');

      // The owner sees it through the tenant guard; the other tenant does not.
      const seenByOwner = await asActor({ organizationId }, () =>
        prisma.client.paymentReconciliationTask.findMany({
          where: { paymentIntentId: intentId },
        }),
      );
      expect(seenByOwner).toHaveLength(1);
      const seenByOther = await asActor({ organizationId: other }, () =>
        prisma.client.paymentReconciliationTask.findMany({
          where: { paymentIntentId: intentId },
        }),
      );
      expect(seenByOther).toEqual([]);

      // Closing names the organization: another tenant's close touches nothing.
      const closed = await asActor({ organizationId: other }, () =>
        prisma.transaction((tx) =>
          wiring.paymentReconciliation.close(tx, {
            organizationId: other,
            paymentIntentId: intentId,
            resolution: 'REFUNDED',
            resolvedBy: 'USR-OTHER',
          }),
        ),
      );
      expect(closed).toBe(0);
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({ organizationId, status: 'PENDING' }),
      ]);

      // Nor can another tenant open or reschedule one on this intent. While
      // the owner's task is open, the upsert finds it and changes nothing …
      const openAs = (organizationId: string) =>
        asActor({ organizationId }, () =>
          prisma.transaction((tx) =>
            wiring.paymentReconciliation.open(tx, {
              organizationId,
              paymentIntentId: intentId,
              kind: 'REFUND',
              outcome: 'REVERSAL_FAILED',
              due: 'NOW',
            }),
          ),
        );
      await openAs(other);
      expect(await tasksOf(intentId)).toEqual([
        expect.objectContaining({
          organizationId,
          status: 'PENDING',
          lastOutcome: 'PROVIDER_OUTCOME_UNKNOWN',
          dueIn: dueAbout(grace),
        }),
      ]);

      // … and once it is closed, the foreign key binds a new task to the
      // intent *in its tenant*.
      await asActor({ organizationId }, () =>
        prisma.transaction((tx) =>
          wiring.paymentReconciliation.close(tx, {
            organizationId,
            paymentIntentId: intentId,
            resolution: 'REFUNDED',
            resolvedBy: 'USR-OWNER',
          }),
        ),
      );
      await expect(openAs(other)).rejects.toThrow(
        /payment_reconciliation_task_organization_id_payment_intent_fkey/,
      );

      await cleanup(prisma, [organizationId, other]);
    });
  });
});

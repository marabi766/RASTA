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
import { PaymentReconciler } from '../src/payment/payment-reconciler';
import { PaymentReconciliationOperator } from '../src/payment/payment-reconciliation.operator';
import { walletBalanceLimit } from '../src/wallet/wallet.repository';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { ECONOMIC_EVENTS } from '../src/events/events';
import type { EconomicEnv } from '../src/config/env';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RefundRequest } from '../src/payment/provider';

/**
 * ADR-064 § 6, step B3: the operator path, with four-eyes (Q-82; PM ruling
 * Q-B3). It replaces the runbook's manual UPDATE of a marker.
 *
 *   - `propose` records the provider's outcome as the evidence shows it and
 *     moves nothing (`PENDING_APPROVAL`);
 *   - a second resolver — neither the proposer nor the intent's creator —
 *     approves or rejects; only approval runs the apply function, the same
 *     one a provider answer goes through, under the same locks;
 *   - both actors and the evidence go on the event (and so to audit);
 *   - `requeue` puts an escalated task back for the sweeper, single-actor.
 */
describe('the payment reconciliation operator path (real database)', () => {
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

  const operatorWith = (overrides: Partial<EconomicEnv> = {}) => {
    const config = { ...env, ...overrides };
    const reconciler = new PaymentReconciler(
      prisma,
      payments,
      wiring.paymentReconciliation,
      provider,
      wiring.ledger,
      wiring.walletRepository,
      config,
    );
    return new PaymentReconciliationOperator(
      prisma,
      payments,
      reconciler,
      wiring.paymentReconciliation,
      wiring.walletRepository,
      wiring.ledger,
      provider,
      config,
    );
  };

  /**
   * A SYSTEM_ADMIN of the tenant, by name, so separation can be shown. Their
   * token carries the platform id (`userId`) and an IdP subject of its own.
   */
  const as = <T>(
    organizationId: string,
    userId: string,
    fn: () => Promise<T>,
    roles = ['SYSTEM_ADMIN'],
    subject = `sub-${userId.toLowerCase()}`,
  ) => asActor({ organizationId, userId, roles, subject }, fn);

  const intentOf = (id: string) =>
    runUnscoped('the suite reads the intent', () =>
      prisma.client.paymentIntent.findUniqueOrThrow({ where: { id } }),
    );

  const taskOf = async (paymentIntentId: string) => {
    const tasks = await runUnscoped('the suite reads the tasks', () =>
      prisma.client.paymentReconciliationTask.findMany({
        where: { paymentIntentId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return tasks[tasks.length - 1];
  };

  const reversalsOf = async (paymentIntentId: string) => {
    const intent = await intentOf(paymentIntentId);
    if (!intent.transactionId) return 0;
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
      prisma.client.outboxMessage.findMany({
        where: { organizationId, eventName },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((row) => (row.payload as { payload: Record<string, unknown> }).payload);
  };

  /** A refund left REFUND_UNKNOWN (the provider really refunded), escalated. */
  async function escalatedUnknown(organizationId: string, amount = 500n, creator = 'USR-CREATOR') {
    const wallet = await as(organizationId, creator, () => wiring.wallets.getOrOpen('IRR'));
    const topUp = await as(organizationId, creator, () =>
      payments.topUp(wallet.id, {
        amountMinor: amount.toString(),
        idempotencyKey: `OP-${ulid()}`,
      }),
    );
    const real = provider.refund.bind(provider);
    jest.spyOn(provider, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
      await real(request);
      throw new Error('provider response lost');
    });
    await expect(
      as(organizationId, 'USR-REFUNDER', () =>
        payments.refund(topUp.paymentIntentId, 'the suite refunds'),
      ),
    ).rejects.toThrow('provider response lost');
    jest.restoreAllMocks();
    await runUnscoped('the suite escalates the task', () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE payment_reconciliation_task
            SET status = 'ESCALATED', escalated_at = now(), attempts = 12,
                last_outcome = 'PROVIDER_OUTCOME_UNKNOWN'
          WHERE payment_intent_id = $1 AND status = 'PENDING'`,
        topUp.paymentIntentId,
      ),
    );
    return { walletId: wallet.id, intentId: topUp.paymentIntentId };
  }

  /** The reconciler gives the task up to a person, as at its attempt or age limit. */
  const escalate = (paymentIntentId: string) =>
    runUnscoped('the suite escalates the task', () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE payment_reconciliation_task
            SET status = 'ESCALATED', escalated_at = now(), last_outcome = 'PROVIDER_OUTCOME_UNKNOWN'
          WHERE payment_intent_id = $1 AND status = 'PENDING'`,
        paymentIntentId,
      ),
    );

  const proposal = (providerOutcome: 'REFUNDED' | 'DECLINED' | 'NOT_REACHED') => ({
    providerOutcome,
    evidenceReference: `TICKET-${ulid().slice(-6)}`,
    reason: 'Provider statement attached to the ticket',
  });

  describe('four-eyes: propose, then a second resolver decides', () => {
    it('moves nothing on a proposal; the approval records the refund, naming both actors', async () => {
      const organizationId = `${org.a}-APPROVE`;
      const made = await escalatedUnknown(organizationId);
      const operator = operatorWith();
      const evidence = proposal('REFUNDED');

      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, evidence),
      );

      expect(proposed).toMatchObject({
        status: 'PENDING_APPROVAL',
        providerOutcome: 'REFUNDED',
        evidenceReference: evidence.evidenceReference,
        proposedBy: 'USR-ALICE',
        fourEyes: true,
        decidedBy: null,
      });
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_UNKNOWN');
      expect(await reversalsOf(made.intentId)).toBe(0);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 500n });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_OPERATOR_ACTION),
      ).toEqual([
        expect.objectContaining({
          action: 'PROPOSED',
          actor: 'USR-ALICE',
          resolutionId: proposed.id,
          providerOutcome: 'REFUNDED',
          evidenceReference: evidence.evidenceReference,
          fourEyes: true,
        }),
      ]);

      const approved = await as(organizationId, 'USR-BOB', () =>
        operator.approve(made.intentId, proposed.id, 'Checked the statement against the ticket'),
      );

      expect(approved).toMatchObject({ status: 'APPROVED', decidedBy: 'USR-BOB' });
      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'REFUNDED',
        failureReason: null,
      });
      expect(await reversalsOf(made.intentId)).toBe(1);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({
        ledger: 0n,
        pending: 0n,
      });
      expect(await taskOf(made.intentId)).toMatchObject({
        status: 'DONE',
        resolution: 'REFUNDED',
        resolvedBy: 'USR-BOB',
      });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED),
      ).toEqual([
        expect.objectContaining({
          resolution: 'REFUNDED',
          providerRefund: 'REFUNDED',
          resolvedBy: 'USR-BOB',
          proposedBy: 'USR-ALICE',
          approvedBy: 'USR-BOB',
          evidenceReference: evidence.evidenceReference,
          resolutionId: proposed.id,
          fourEyes: true,
        }),
      ]);
    });

    it.each([
      ['DECLINED', 'REFUND_DECLINED'],
      ['NOT_REACHED', 'REFUND_NOT_REACHED'],
    ] as const)('returns the hold on an approved %s', async (outcome, resolution) => {
      const organizationId = `${org.a}-${outcome}`;
      const made = await escalatedUnknown(organizationId, 320n);
      const operator = operatorWith();
      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal(outcome)),
      );
      await as(organizationId, 'USR-BOB', () =>
        operator.approve(made.intentId, proposed.id, 'Checked against the provider'),
      );

      expect(await intentOf(made.intentId)).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect(await reversalsOf(made.intentId)).toBe(0);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({
        ledger: 320n,
        pending: 0n,
        available: 320n,
      });
      expect(await taskOf(made.intentId)).toMatchObject({ status: 'DONE', resolution });
    });

    it('moves nothing on a rejection, and a new proposal may follow', async () => {
      const organizationId = `${org.a}-REJECT`;
      const made = await escalatedUnknown(organizationId, 330n);
      const operator = operatorWith();
      const first = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );

      const rejected = await as(organizationId, 'USR-BOB', () =>
        operator.reject(made.intentId, first.id, 'The statement is for another payment'),
      );

      expect(rejected).toMatchObject({ status: 'REJECTED', decidedBy: 'USR-BOB' });
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUND_UNKNOWN');
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 330n });
      expect(await taskOf(made.intentId)).toMatchObject({ status: 'ESCALATED' });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_OPERATOR_ACTION),
      ).toEqual([
        expect.objectContaining({ action: 'PROPOSED', actor: 'USR-ALICE' }),
        expect.objectContaining({
          action: 'REJECTED',
          actor: 'USR-BOB',
          proposedBy: 'USR-ALICE',
          resolutionId: first.id,
        }),
      ]);

      const second = await as(organizationId, 'USR-CAROL', () =>
        operator.propose(made.intentId, proposal('REFUNDED')),
      );
      expect(second.status).toBe('PENDING_APPROVAL');
    });

    it('refuses a second proposal while one awaits approval', async () => {
      const organizationId = `${org.a}-ONE-PENDING`;
      const made = await escalatedUnknown(organizationId, 340n);
      const operator = operatorWith();
      await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );
      await expect(
        as(organizationId, 'USR-CAROL', () =>
          operator.propose(made.intentId, proposal('REFUNDED')),
        ),
      ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    });

    it('decides a proposal once: a second approval or a rejection after it is refused', async () => {
      const organizationId = `${org.a}-ONCE`;
      const made = await escalatedUnknown(organizationId, 350n);
      const operator = operatorWith();
      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );
      await as(organizationId, 'USR-BOB', () =>
        operator.approve(made.intentId, proposed.id, 'Checked against the provider'),
      );

      await expect(
        as(organizationId, 'USR-CAROL', () =>
          operator.approve(made.intentId, proposed.id, 'Checked again'),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      await expect(
        as(organizationId, 'USR-CAROL', () =>
          operator.reject(made.intentId, proposed.id, 'Too late to reject'),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ available: 350n });
    });
  });

  describe('separation of duties and roles', () => {
    it('refuses the proposer as approver, and the intent’s creator on either side', async () => {
      const organizationId = `${org.b}-SEPARATION`;
      const made = await escalatedUnknown(organizationId, 360n, 'USR-CREATOR');
      const operator = operatorWith();

      await expect(
        as(organizationId, 'USR-CREATOR', () =>
          operator.propose(made.intentId, proposal('DECLINED')),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );
      await expect(
        as(organizationId, 'USR-ALICE', () =>
          operator.approve(made.intentId, proposed.id, 'Approving my own'),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        as(organizationId, 'USR-CREATOR', () =>
          operator.approve(made.intentId, proposed.id, 'Approving my own payment'),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        as(organizationId, 'USR-ALICE', () =>
          operator.reject(made.intentId, proposed.id, 'Rejecting my own'),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 360n });
    });

    it('treats two tokens of one subject as one person (Codex on #175, HIGH 1)', async () => {
      const organizationId = `${org.b}-ALIAS`;
      const made = await escalatedUnknown(organizationId, 365n);
      const operator = operatorWith();
      const proposed = await as(
        organizationId,
        'USR-ALICE',
        () => operator.propose(made.intentId, proposal('DECLINED')),
        ['SYSTEM_ADMIN'],
        'sub-alice',
      );

      // The same IdP subject under another platform id may neither approve nor reject.
      for (const decide of [
        () => operator.approve(made.intentId, proposed.id, 'Approving my own'),
        () => operator.reject(made.intentId, proposed.id, 'Rejecting my own'),
      ]) {
        await expect(
          as(organizationId, 'USR-ALICE-2', decide, ['SYSTEM_ADMIN'], 'sub-alice'),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 365n });

      // Another person approves; the record names both identities.
      await as(organizationId, 'USR-BOB', () =>
        operator.approve(made.intentId, proposed.id, 'Checked against the provider'),
      );
      const row = await runUnscoped('the suite reads the resolution', () =>
        prisma.client.paymentReconciliationResolution.findUniqueOrThrow({
          where: { id: proposed.id },
        }),
      );
      expect(row).toMatchObject({
        proposedBySubject: 'sub-alice',
        proposedByIssuer: env.OIDC_ISSUER_URL,
        decidedBy: 'USR-BOB',
        decidedBySubject: 'sub-usr-bob',
        decidedByIssuer: env.OIDC_ISSUER_URL,
      });
    });

    it('fails closed for a token without the platform user id, on every method', async () => {
      const organizationId = `${org.b}-NO-UID`;
      const made = await escalatedUnknown(organizationId, 366n);
      const operator = operatorWith();
      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );

      // The guard's fallback (`userId` = the subject), and no subject at all.
      for (const actor of [
        { userId: 'sub-bob', subject: 'sub-bob' },
        { userId: 'USR-BOB', subject: undefined },
      ]) {
        for (const attempt of [
          (): Promise<unknown> => operator.view(made.intentId),
          () => operator.propose(made.intentId, proposal('DECLINED')),
          () => operator.approve(made.intentId, proposed.id, 'Checked'),
          () => operator.reject(made.intentId, proposed.id, 'Checked'),
          () => operator.requeue(made.intentId, 'Ask again'),
        ]) {
          await expect(
            asActor({ organizationId, roles: ['SYSTEM_ADMIN'], ...actor }, attempt),
          ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
      }
    });

    it('takes the guard’s word on the platform user id: a rasta_uid that equals the subject is not refused (#188)', async () => {
      const organizationId = `${org.b}-UID-IS-SUB`;
      const made = await escalatedUnknown(organizationId, 369n);
      const operator = operatorWith();
      const erin = {
        organizationId,
        roles: ['SYSTEM_ADMIN'],
        userId: 'sub-erin',
        subject: 'sub-erin',
      };
      // The token carried rasta_uid, whose value happens to be the subject.
      const view = await asActor({ ...erin, platformUserId: true }, () =>
        operator.view(made.intentId),
      );
      expect(view.task).not.toBeNull();
      // The same values from the guard's fallback (no rasta_uid) are refused.
      await expect(
        asActor({ ...erin, platformUserId: false }, () => operator.view(made.intentId)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('recognises the creator by the subject their intent was created under', async () => {
      const organizationId = `${org.b}-CREATOR-ALIAS`;
      // Created by a token without `rasta_uid`: `created_by` holds the subject.
      const made = await escalatedUnknown(organizationId, 367n, 'sub-zed');
      const operator = operatorWith();
      await expect(
        as(
          organizationId,
          'USR-ZED',
          () => operator.propose(made.intentId, proposal('DECLINED')),
          ['SYSTEM_ADMIN'],
          'sub-zed',
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('recognises the creator under another platform id by their recorded identity', async () => {
      const organizationId = `${org.b}-CREATOR-PAIR`;
      // Created as USR-ZOE with IdP subject sub-zoe; the intent records both.
      const made = await escalatedUnknown(organizationId, 368n, 'USR-ZOE');
      const intent = await intentOf(made.intentId);
      expect(intent).toMatchObject({
        createdBy: 'USR-ZOE',
        createdByIssuer: env.OIDC_ISSUER_URL,
        createdBySubject: 'sub-usr-zoe',
      });
      const operator = operatorWith();
      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );

      // A later token for the same subject carries another platform id.
      const laterZoe = <T>(fn: () => Promise<T>) =>
        as(organizationId, 'USR-ZOE-2', fn, ['SYSTEM_ADMIN'], 'sub-usr-zoe');
      for (const attempt of [
        () => operator.approve(made.intentId, proposed.id, 'Approving my own payment'),
        () => operator.reject(made.intentId, proposed.id, 'Rejecting on my own payment'),
        () => operator.propose(made.intentId, proposal('DECLINED')),
      ]) {
        await expect(laterZoe(attempt)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 368n });
    });

    it('refuses anyone outside the configured resolver roles, and a service caller', async () => {
      const organizationId = `${org.b}-ROLES`;
      const made = await escalatedUnknown(organizationId, 370n);
      const operator = operatorWith();

      for (const roles of [['UNION_ADMIN'], ['ORGANIZATION_ADMIN'], ['AUDITOR']]) {
        await expect(
          as(
            organizationId,
            'USR-ALICE',
            () => operator.propose(made.intentId, proposal('DECLINED')),
            roles,
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          as(
            organizationId,
            'USR-ALICE',
            () => operator.requeue(made.intentId, 'Try again'),
            roles,
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      await expect(
        asActor(
          {
            organizationId,
            userId: 'economic-service',
            roles: ['SYSTEM_ADMIN'],
            authType: 'SERVICE',
          },
          () => operator.propose(made.intentId, proposal('DECLINED')),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // Configuration widens within the platform roles.
      const widened = operatorWith({
        ECONOMIC_PAYMENT_RECONCILIATION_RESOLVER_ROLES: ['SYSTEM_ADMIN', 'UNION_ADMIN'],
      });
      const proposed = await as(
        organizationId,
        'USR-UNION',
        () => widened.propose(made.intentId, proposal('DECLINED')),
        ['UNION_ADMIN'],
      );
      expect(proposed.status).toBe('PENDING_APPROVAL');
    });

    it('applies at once, recorded as single-actor, only where four-eyes is configured off', async () => {
      const organizationId = `${org.b}-NO-FOUR-EYES`;
      const made = await escalatedUnknown(organizationId, 380n);
      const operator = operatorWith({
        ECONOMIC_PAYMENT_RECONCILIATION_RESOLUTION_FOUR_EYES: false,
      });

      const resolved = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );

      expect(resolved).toMatchObject({
        status: 'APPROVED',
        proposedBy: 'USR-ALICE',
        decidedBy: 'USR-ALICE',
        fourEyes: false,
      });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ available: 380n });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED),
      ).toEqual([expect.objectContaining({ fourEyes: false, approvedBy: 'USR-ALICE' })]);
    });
  });

  describe('what a proposal or an approval may not do', () => {
    it('refuses a resolution of a known outcome: the sweeper or a requeue records it', async () => {
      const organizationId = `${org.b}-KNOWN`;
      const wallet = await as(organizationId, 'USR-CREATOR', () => wiring.wallets.getOrOpen('IRR'));
      const topUp = await as(organizationId, 'USR-CREATOR', () =>
        payments.topUp(wallet.id, { amountMinor: '390', idempotencyKey: `OP-K-${ulid()}` }),
      );
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
      await expect(
        as(organizationId, 'USR-REFUNDER', () => payments.refund(topUp.paymentIntentId, 'refund')),
      ).rejects.toThrow('connection reset');
      expect((await intentOf(topUp.paymentIntentId)).failureReason).toBe('REFUNDED_NOT_REVERSED');

      await expect(
        as(organizationId, 'USR-ALICE', () =>
          operatorWith().propose(topUp.paymentIntentId, proposal('DECLINED')),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('refuses to take money out of a wallet that is not active, at proposal and at approval', async () => {
      const organizationId = `${org.b}-FROZEN`;
      const made = await escalatedUnknown(organizationId, 400n);
      const operator = operatorWith();
      const setStatus = (status: 'ACTIVE' | 'FROZEN') =>
        runUnscoped('the suite freezes or thaws the wallet', () =>
          prisma.client.wallet.update({ where: { id: made.walletId }, data: { status } }),
        );

      await setStatus('FROZEN');
      await expect(
        as(organizationId, 'USR-ALICE', () =>
          operator.propose(made.intentId, proposal('REFUNDED')),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

      await setStatus('ACTIVE');
      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('REFUNDED')),
      );
      await setStatus('FROZEN');
      await expect(
        as(organizationId, 'USR-BOB', () =>
          operator.approve(made.intentId, proposed.id, 'Checked against the provider'),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      expect(await reversalsOf(made.intentId)).toBe(0);
      expect(
        await runUnscoped('the suite reads the resolution', () =>
          prisma.client.paymentReconciliationResolution.findUniqueOrThrow({
            where: { id: proposed.id },
          }),
        ),
      ).toMatchObject({ status: 'PENDING_APPROVAL' });

      // A decline moves money back in: allowed even from a frozen wallet.
      await as(organizationId, 'USR-BOB', () =>
        operator.reject(made.intentId, proposed.id, 'Wrong outcome stated'),
      );
      const declined = await as(organizationId, 'USR-CAROL', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );
      await as(organizationId, 'USR-DAVE', () =>
        operator.approve(made.intentId, declined.id, 'Checked against the provider'),
      );
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 0n });
    });

    it('waits for a sweeper that holds the task, rather than racing it', async () => {
      const organizationId = `${org.b}-LEASED`;
      const made = await escalatedUnknown(organizationId, 410n);
      const operator = operatorWith();
      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );
      await runUnscoped('the suite leases the task as a sweeper would', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE payment_reconciliation_task
              SET status = 'PENDING', lease_until = now() + interval '1 minute', lease_token = 'SWEEPER'
            WHERE payment_intent_id = $1`,
          made.intentId,
        ),
      );

      await expect(
        as(organizationId, 'USR-BOB', () =>
          operator.approve(made.intentId, proposed.id, 'Checked against the provider'),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 410n });
    });

    it('refuses an approval once the intent has moved on: nothing moves, the proposal stays to reject', async () => {
      const organizationId = `${org.b}-MOVED-ON`;
      const made = await escalatedUnknown(organizationId, 415n);
      const operator = operatorWith();
      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );
      // The marker is gone, its hold still out: not a state this resolution applies to.
      await runUnscoped('the suite clears the marker', () =>
        prisma.client.paymentIntent.update({
          where: { id: made.intentId },
          data: { failureReason: null },
        }),
      );

      await expect(
        as(organizationId, 'USR-BOB', () =>
          operator.approve(made.intentId, proposed.id, 'Checked against the provider'),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 415n });
      expect(await taskOf(made.intentId)).toMatchObject({ status: 'ESCALATED' });
      await expect(
        as(organizationId, 'USR-BOB', () =>
          operator.reject(made.intentId, proposed.id, 'Superseded'),
        ),
      ).resolves.toMatchObject({ status: 'REJECTED' });
    });

    it('takes proposals only for an escalated task no sweeper holds (Codex round 2 on #175)', async () => {
      const organizationId = `${org.b}-ESCALATED-ONLY`;
      const made = await escalatedUnknown(organizationId, 411n);
      const operator = operatorWith();
      const setTask = (sql: string) =>
        runUnscoped('the suite moves the task as the reconciler would', () =>
          prisma.client.$executeRawUnsafe(
            `UPDATE payment_reconciliation_task SET ${sql} WHERE payment_intent_id = $1`,
            made.intentId,
          ),
        );

      // PENDING and due: a sweeper may still claim and settle it.
      await setTask(`status = 'PENDING', next_attempt_at = now()`);
      await expect(
        as(organizationId, 'USR-ALICE', () =>
          operator.propose(made.intentId, proposal('DECLINED')),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

      // PENDING and claimed by a sweeper.
      await setTask(`lease_until = now() + interval '1 minute', lease_token = 'SWEEPER'`);
      await expect(
        as(organizationId, 'USR-ALICE', () =>
          operator.propose(made.intentId, proposal('DECLINED')),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

      // ESCALATED but still leased (a sweeper that has not yet let go).
      await setTask(`status = 'ESCALATED', escalated_at = now()`);
      await expect(
        as(organizationId, 'USR-ALICE', () =>
          operator.propose(made.intentId, proposal('DECLINED')),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(
        await runUnscoped('the suite counts resolutions', () =>
          prisma.client.paymentReconciliationResolution.count({
            where: { paymentIntentId: made.intentId },
          }),
        ),
      ).toBe(0);
    });

    it('keeps a pending proposal and the sweeper apart, in either order', async () => {
      const organizationId = `${org.b}-INTERLEAVE`;
      const made = await escalatedUnknown(organizationId, 412n);
      const operator = operatorWith();
      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );

      // The sweeper's own claim never takes an ESCALATED task, so it cannot
      // settle this one under the proposal. (A one-second lease on anything
      // else it claims here lapses at once.)
      const claimed = await wiring.paymentReconciliation.claimDue(500, 1, `TEST-${ulid()}`);
      expect(claimed.map((task) => task.paymentIntentId)).not.toContain(made.intentId);
      expect(await taskOf(made.intentId)).toMatchObject({
        status: 'ESCALATED',
        leaseToken: null,
      });

      // Nor can it be handed back to the sweeper while the proposal waits.
      await expect(
        as(organizationId, 'USR-BOB', () => operator.requeue(made.intentId, 'Ask again')),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

      // The second resolver decides it; only then is the task DONE.
      await as(organizationId, 'USR-BOB', () =>
        operator.approve(made.intentId, proposed.id, 'Checked against the provider'),
      );
      expect(await taskOf(made.intentId)).toMatchObject({
        status: 'DONE',
        resolution: 'REFUND_DECLINED',
      });
    });

    it('fails closed across an issuer change: a proposer recorded under another issuer cannot be told apart (#188)', async () => {
      const organizationId = `${org.b}-ISSUER`;
      const made = await escalatedUnknown(organizationId, 414n);
      const operator = operatorWith();
      // Proposed while the platform verified tokens of another issuer: same subject
      // space, so one Keycloak user may now arrive under a new platform id.
      const proposed = await asActor(
        {
          organizationId,
          userId: 'USR-ALICE',
          roles: ['SYSTEM_ADMIN'],
          subject: 'sub-alice',
          issuer: 'http://old-issuer.invalid/realms/rasta',
        },
        () => operator.propose(made.intentId, proposal('DECLINED')),
      );
      await expect(
        as(organizationId, 'USR-BOB', () =>
          operator.approve(made.intentId, proposed.id, 'Checked against the provider'),
        ),
      ).rejects.toMatchObject({ code: 'ACTOR_IDENTITY_UNKNOWN', status: 422 });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 414n });
      // A rejection moves nothing and stays possible.
      await as(organizationId, 'USR-BOB', () =>
        operator.reject(made.intentId, proposed.id, 'Cannot be approved here'),
      );
    });

    it('fails closed when the intent records no creator identity (Codex round 2 on #175)', async () => {
      const organizationId = `${org.b}-LEGACY`;
      const made = await escalatedUnknown(organizationId, 413n);
      // An intent created before the identity was recorded.
      await runUnscoped('the suite makes the intent a legacy one', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE payment_intent SET created_by_issuer = NULL, created_by_subject = NULL WHERE id = $1`,
          made.intentId,
        ),
      );
      const operator = operatorWith();
      const proposed = await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );
      await expect(
        as(organizationId, 'USR-BOB', () =>
          operator.approve(made.intentId, proposed.id, 'Checked against the provider'),
        ),
      ).rejects.toMatchObject({ code: 'ACTOR_IDENTITY_UNKNOWN', status: 422 });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 413n });

      // Rejecting moves nothing and stays possible; nor does four-eyes-off bypass it.
      await as(organizationId, 'USR-BOB', () =>
        operator.reject(made.intentId, proposed.id, 'Cannot be approved here'),
      );
      await expect(
        as(organizationId, 'USR-ALICE', () =>
          operatorWith({ ECONOMIC_PAYMENT_RECONCILIATION_RESOLUTION_FOUR_EYES: false }).propose(
            made.intentId,
            proposal('DECLINED'),
          ),
        ),
      ).rejects.toMatchObject({ code: 'ACTOR_IDENTITY_UNKNOWN' });
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 413n });
    });

    it('resolves an uncreditable capture: REFUNDED fails it, NOT_REACHED makes it creditable', async () => {
      for (const [outcome, status, marker] of [
        ['REFUNDED', 'FAILED', 'CAPTURE_NOT_CREDITED'],
        ['NOT_REACHED', 'AUTHORIZED', 'CAPTURED_NOT_CREDITED'],
      ] as const) {
        const organizationId = `${org.c}-U6-${outcome}`;
        const wallet = await as(organizationId, 'USR-CREATOR', () =>
          wiring.wallets.getOrOpen('IRR'),
        );
        jest
          .spyOn(wiring.wallets, 'credit')
          .mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
        jest.spyOn(provider, 'refund').mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
        await expect(
          as(organizationId, 'USR-CREATOR', () =>
            payments.topUp(wallet.id, { amountMinor: '800', idempotencyKey: `OP-U6-${ulid()}` }),
          ),
        ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
        jest.restoreAllMocks();
        const [intent] = await runUnscoped('the suite reads its intent', () =>
          prisma.client.paymentIntent.findMany({ where: { organizationId } }),
        );
        expect(intent?.failureReason).toBe('CAPTURED_REFUND_UNKNOWN');
        await escalate(intent!.id);

        const operator = operatorWith();
        const proposed = await as(organizationId, 'USR-ALICE', () =>
          operator.propose(intent!.id, proposal(outcome)),
        );
        await as(organizationId, 'USR-BOB', () =>
          operator.approve(intent!.id, proposed.id, 'Checked against the provider'),
        );
        expect(await intentOf(intent!.id)).toMatchObject({ status, failureReason: marker });
      }
    });
  });

  describe('requeue: single-actor, nothing moves', () => {
    it('puts an escalated task back for the sweeper, due now, attempts reset', async () => {
      const organizationId = `${org.c}-REQUEUE`;
      const made = await escalatedUnknown(organizationId, 420n);

      const task = await as(organizationId, 'USR-ALICE', () =>
        operatorWith().requeue(made.intentId, 'The provider has its records back'),
      );

      expect(task).toMatchObject({ status: 'PENDING', attempts: 0 });
      const row = await taskOf(made.intentId);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 0, lastOutcome: 'REQUEUED' });
      expect(row!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 420n });

      // The reason is kept in a requeue row — tenant-scoped, append-only — and
      // the event carries its id, never the text (Codex on #175, MED 4).
      const [requeue] = await runUnscoped('the suite reads the requeue rows', () =>
        prisma.client.paymentReconciliationRequeue.findMany({
          where: { paymentIntentId: made.intentId },
        }),
      );
      expect(requeue).toMatchObject({
        organizationId,
        taskId: row!.id,
        reason: 'The provider has its records back',
        requestedBy: 'USR-ALICE',
        requestedBySubject: 'sub-usr-alice',
      });
      const events = await eventsOf(
        organizationId,
        ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_OPERATOR_ACTION,
      );
      expect(events).toEqual([
        expect.objectContaining({ action: 'REQUEUED', actor: 'USR-ALICE', requeueId: requeue!.id }),
      ]);
      expect(JSON.stringify(events)).not.toContain('records back');

      // Append-only at the database.
      for (const statement of [
        `UPDATE payment_reconciliation_requeue SET reason = 'rewritten' WHERE id = $1`,
        `DELETE FROM payment_reconciliation_requeue WHERE id = $1`,
      ]) {
        await expect(
          runUnscoped('the suite tries to rewrite history', () =>
            prisma.client.$executeRawUnsafe(statement, requeue!.id),
          ),
        ).rejects.toThrow(/append-only/);
      }

      // The owner's view lists it.
      const view = await as(organizationId, 'USR-BOB', () => operatorWith().view(made.intentId));
      expect(view.requeues).toEqual([
        expect.objectContaining({ id: requeue!.id, reason: 'The provider has its records back' }),
      ]);
    });

    it('refuses a requeue while a resolution awaits approval', async () => {
      const organizationId = `${org.c}-REQUEUE-PENDING`;
      const made = await escalatedUnknown(organizationId, 425n);
      const operator = operatorWith();
      await as(organizationId, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );
      await expect(
        as(organizationId, 'USR-BOB', () => operator.requeue(made.intentId, 'Ask again')),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(await taskOf(made.intentId)).toMatchObject({ status: 'ESCALATED' });
    });

    it('refuses a requeue with no open task, or one a sweeper holds', async () => {
      const organizationId = `${org.c}-REQUEUE-NONE`;
      const wallet = await as(organizationId, 'USR-CREATOR', () => wiring.wallets.getOrOpen('IRR'));
      const topUp = await as(organizationId, 'USR-CREATOR', () =>
        payments.topUp(wallet.id, { amountMinor: '100', idempotencyKey: `OP-N-${ulid()}` }),
      );
      await expect(
        as(organizationId, 'USR-ALICE', () =>
          operatorWith().requeue(topUp.paymentIntentId, 'Nothing to requeue'),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

      const made = await escalatedUnknown(`${organizationId}-LEASED`, 100n);
      await runUnscoped('the suite leases the task', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE payment_reconciliation_task
              SET status = 'PENDING', lease_until = now() + interval '1 minute', lease_token = 'SWEEPER'
            WHERE payment_intent_id = $1`,
          made.intentId,
        ),
      );
      await expect(
        as(`${organizationId}-LEASED`, 'USR-ALICE', () =>
          operatorWith().requeue(made.intentId, 'Racing the sweeper'),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });
  });

  describe('tenant isolation', () => {
    it('answers 404 to another tenant’s resolver, and never decides across tenants', async () => {
      const mine = `${org.c}-ISO-A`;
      const theirs = `${org.c}-ISO-B`;
      const made = await escalatedUnknown(mine, 430n);
      const operator = operatorWith();
      const proposed = await as(mine, 'USR-ALICE', () =>
        operator.propose(made.intentId, proposal('DECLINED')),
      );

      for (const attempt of [
        (): Promise<unknown> => operator.view(made.intentId),
        () => operator.propose(made.intentId, proposal('DECLINED')),
        () => operator.approve(made.intentId, proposed.id, 'Across tenants'),
        () => operator.reject(made.intentId, proposed.id, 'Across tenants'),
        () => operator.requeue(made.intentId, 'Across tenants'),
      ]) {
        await expect(as(theirs, 'USR-MALLORY', attempt)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      }
      expect(await readBalances(prisma, made.walletId)).toMatchObject({ pending: 430n });

      // The owner sees the task and its resolutions.
      const view = await as(mine, 'USR-BOB', () => operator.view(made.intentId));
      expect(view).toMatchObject({
        paymentIntentId: made.intentId,
        task: expect.objectContaining({ status: 'ESCALATED' }),
        resolutions: [expect.objectContaining({ id: proposed.id, status: 'PENDING_APPROVAL' })],
      });
    });
  });

  describe('the table holds its own invariants', () => {
    it('refuses free-text evidence, and an approver who is the proposer under four-eyes', async () => {
      const organizationId = `${org.c}-CHECKS`;
      const made = await escalatedUnknown(organizationId, 440n);
      const task = await taskOf(made.intentId);
      const insert = (
        evidence: string,
        decidedBy: string | null,
        fourEyes = true,
        decidedBySubject = 'sub-other',
      ) =>
        runUnscoped('the suite writes a resolution directly', () =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO payment_reconciliation_resolution
               (id, organization_id, payment_intent_id, task_id, status, provider_outcome,
                evidence_reference, reason, four_eyes, proposed_by, proposed_by_issuer,
                proposed_by_subject, proposed_at, decided_by, decided_by_issuer,
                decided_by_subject, decided_at, correlation_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::"PaymentResolutionStatus", 'DECLINED', $6,
                     'a reason', $7, 'USR-ALICE', 'https://idp.test', 'sub-alice', now(), $8,
                     CASE WHEN $8::text IS NULL THEN NULL ELSE 'https://idp.test' END,
                     CASE WHEN $8::text IS NULL THEN NULL ELSE $9 END,
                     CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, 'COR', now(), now())`,
            `PRR_${ulid()}`,
            organizationId,
            made.intentId,
            task!.id,
            decidedBy ? 'APPROVED' : 'PENDING_APPROVAL',
            evidence,
            fourEyes,
            decidedBy,
            decidedBySubject,
          ),
        );

      await expect(insert('see the attached statement', null)).rejects.toThrow(
        /ck_payment_resolution_evidence|23514/,
      );
      await expect(insert('TICKET-1', 'USR-ALICE')).rejects.toThrow(
        /ck_payment_resolution_four_eyes|23514/,
      );
      // Another platform id on the proposer's own issuer and subject: one person.
      await expect(insert('TICKET-3', 'USR-ALICE-2', true, 'sub-alice')).rejects.toThrow(
        /ck_payment_resolution_four_eyes|23514/,
      );
      await expect(insert('TICKET-2', 'USR-ALICE', false, 'sub-alice')).resolves.toBe(1);

      // History: a resolution is never deleted, and a decided one never changes.
      const decided = await runUnscoped('the suite reads the decided row', () =>
        prisma.client.paymentReconciliationResolution.findFirstOrThrow({
          where: { organizationId, evidenceReference: 'TICKET-2' },
        }),
      );
      for (const statement of [
        `DELETE FROM payment_reconciliation_resolution WHERE id = $1`,
        `UPDATE payment_reconciliation_resolution SET status = 'REJECTED' WHERE id = $1`,
        `UPDATE payment_reconciliation_resolution SET evidence_reference = 'TICKET-9' WHERE id = $1`,
      ]) {
        await expect(
          runUnscoped('the suite tries to rewrite history', () =>
            prisma.client.$executeRawUnsafe(statement, decided.id),
          ),
        ).rejects.toThrow(/append-only/);
      }
    });
  });
});

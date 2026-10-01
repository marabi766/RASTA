import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor } from '../shared/money';
import { paymentIntentsTotal } from '../observability/metrics';
import { ENV, PAYMENT_PROVIDER } from '../tokens';
import { SERVICE_NAME, type EconomicEnv } from '../config/env';
import { assertNotAuditor } from '../access/access';
import type {
  PaymentIntent,
  PaymentReconciliationResolution,
  PaymentReconciliationTask,
} from '../generated/prisma';
import type { PaymentProvider } from './provider';
import { PaymentService, REFUND_HOLD_REFERENCE_TYPE } from './payment.service';
import { LeaseLost, PaymentReconciler } from './payment-reconciler';
import {
  PaymentReconciliationRepository,
  type OpenTaskRow,
  type PaymentReconciliationKind,
} from './payment-reconciliation.repository';
import {
  decideReconciliation,
  needsProviderAnswer,
  type ProviderRefundAnswer,
  type Verdict,
} from './payment-reconciliation.decision';

/** What the provider did with the refund attempt, as the operator's evidence shows it. */
export type OperatorProviderOutcome = 'REFUNDED' | 'DECLINED' | 'NOT_REACHED';

export interface ProposeResolution {
  providerOutcome: OperatorProviderOutcome;
  /** A reference to the evidence (a ticket, a document id) — pattern-checked, never free text. */
  evidenceReference: string;
  reason: string;
}

export interface ResolutionView {
  id: string;
  paymentIntentId: string;
  taskId: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  providerOutcome: OperatorProviderOutcome;
  evidenceReference: string;
  reason: string;
  fourEyes: boolean;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface ReconciliationTaskView {
  id: string;
  kind: PaymentReconciliationKind;
  status: 'PENDING' | 'ESCALATED' | 'DONE';
  attempts: number;
  nextAttemptAt: string;
  lastOutcome: string | null;
  escalatedAt: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  doneAt: string | null;
  createdAt: string;
}

export interface ReconciliationView {
  paymentIntentId: string;
  failureReason: string | null;
  /** The intent's latest task — the open one when there is one — or null. */
  task: ReconciliationTaskView | null;
  /** Newest first. */
  resolutions: ResolutionView[];
}

/**
 * The operator path for a payment reconciliation (ADR-064 § 6, step B3; Q-82;
 * PM ruling Q-B3). It replaces the runbook's manual UPDATE of a marker: an
 * operator never writes a marker, a balance or a task by hand.
 *
 *   - **propose** records the provider's outcome as the evidence shows it.
 *     Nothing moves: the resolution is `PENDING_APPROVAL`.
 *   - **approve**, by a second resolver who is neither the proposer nor the
 *     intent's creator, runs {@link PaymentReconciler.apply} — the very path a
 *     provider answer goes through, under the same locks and the same
 *     decision table — with the operator's outcome standing in for the
 *     provider's answer. Only approval moves money.
 *   - **reject**, by such a second resolver, moves nothing; a new proposal may
 *     follow.
 *   - **requeue** puts an open task back for the sweeper, due now — single
 *     actor, since it moves nothing and the sweeper still needs a provider
 *     answer.
 *
 * Who may resolve is configuration (`ECONOMIC_PAYMENT_RECONCILIATION_RESOLVER_ROLES`,
 * `SYSTEM_ADMIN` by default); a service caller never may. Separation of duties
 * is `ECONOMIC_PAYMENT_RECONCILIATION_RESOLUTION_FOUR_EYES`, on by default and
 * refused off outside development and test (`loadEconomicEnv`). With it off,
 * a proposal is approved at once by its proposer and recorded as such.
 *
 * Every action names its actor and the evidence on an event —
 * `PAYMENT_RECONCILIATION_OPERATOR_ACTION`, or `PAYMENT_RECONCILIATION_RESOLVED`
 * for an approval — in the transaction that takes it, so audit-service's
 * record cannot disagree with what happened.
 *
 * ## Tenancy
 *
 * Every method acts on the caller's own organization: the intent is locked
 * by `(id, organization_id)`, so another tenant's intent is NOT_FOUND, as on
 * every other route.
 */
@Injectable()
export class PaymentReconciliationOperator {
  private readonly logger = new Logger(PaymentReconciliationOperator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly reconciler: PaymentReconciler,
    private readonly tasks: PaymentReconciliationRepository,
    private readonly walletRepository: WalletRepository,
    private readonly ledger: LedgerService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(ENV) private readonly env: EconomicEnv,
  ) {}

  private get fourEyes(): boolean {
    return this.env.ECONOMIC_PAYMENT_RECONCILIATION_RESOLUTION_FOUR_EYES;
  }

  /** The intent's reconciliation as an operator needs it: the task and every resolution. */
  async view(paymentIntentId: string): Promise<ReconciliationView> {
    this.resolver();
    const organizationId = getOrganizationId();
    const intent = await this.prisma.client.paymentIntent.findFirst({
      where: { id: paymentIntentId, organizationId },
    });
    if (!intent) throw RastaError.notFound('PaymentIntent', paymentIntentId);
    const [task, resolutions] = await Promise.all([
      this.prisma.client.paymentReconciliationTask.findFirst({
        where: { paymentIntentId, organizationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.client.paymentReconciliationResolution.findMany({
        where: { paymentIntentId, organizationId },
        orderBy: [{ proposedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    return {
      paymentIntentId,
      failureReason: intent.failureReason,
      task: task ? toTaskView(task) : null,
      resolutions: resolutions.map(toResolutionView),
    };
  }

  /** Puts the open task back for the sweeper, due now, attempts reset. Moves nothing. */
  async requeue(paymentIntentId: string, reason: string): Promise<ReconciliationTaskView> {
    const actor = this.resolver();
    const organizationId = getOrganizationId();
    const taskId = await this.prisma.transaction(async (tx) => {
      const intent = await this.lockIntent(tx, paymentIntentId, organizationId);
      const task = await this.tasks.lockOpenTask(tx, organizationId, paymentIntentId);
      if (!task) throw noOpenTask('REQUEUED');
      if (task.leased) throw sweeperHolds('REQUEUED');
      if (await this.pendingOf(tx, task.id)) {
        throw RastaError.invalidStateTransition(
          'PaymentReconciliationTask',
          task.status,
          'PENDING',
          'A resolution awaits approval: approve or reject it first',
        );
      }
      if ((await this.tasks.requeue(tx, task)) !== 1) throw sweeperHolds('REQUEUED');
      await this.enqueueAction(tx, intent, task.kind, {
        action: 'REQUEUED',
        actor,
        resolutionId: null,
        providerOutcome: null,
        evidenceReference: null,
        proposedBy: null,
      });
      return task.id;
    });
    this.logger.warn(
      `Reconciliation of payment intent ${paymentIntentId} requeued by ${actor}: ${oneLine(reason)}`,
    );
    const row = await this.prisma.client.paymentReconciliationTask.findFirstOrThrow({
      where: { id: taskId, organizationId },
    });
    return toTaskView(row);
  }

  /**
   * Records the provider's outcome as the evidence shows it, for a second
   * resolver's approval. Refused up front where the approval could not apply
   * it: a known marker (the sweeper or a requeue records it), a wallet that
   * is not active for a refund, a second pending proposal.
   */
  async propose(paymentIntentId: string, input: ProposeResolution): Promise<ResolutionView> {
    const actor = this.resolver();
    const organizationId = getOrganizationId();
    const fourEyes = this.fourEyes;
    const { resolution, verdict } = await this.prisma.transaction(async (tx) => {
      const intent = await this.lockIntent(tx, paymentIntentId, organizationId);
      if (intent.createdBy === actor) throw separation('the payment’s creator may not resolve it');
      const [wallet] = await this.walletRepository.lock(tx, [intent.walletId]);
      if (!wallet) throw RastaError.internal('Wallet vanished while locking it');
      const task = await this.tasks.lockOpenTask(tx, organizationId, paymentIntentId);
      if (!task) throw noOpenTask('PROPOSED');
      if (!needsProviderAnswer(task.kind, intent.failureReason)) {
        throw RastaError.businessRule(
          'This payment’s outcome is not unknown: there is nothing for an operator to vouch ' +
            'for. Requeue it, and the reconciler records it.',
          { paymentIntentId, marker: intent.failureReason },
        );
      }
      const hold = await this.walletRepository.findActiveHold(tx, wallet.id, intent.id);
      refuseUnlessEffect(
        decideReconciliation({
          kind: task.kind,
          intentStatus: intent.status,
          marker: intent.failureReason,
          walletStatus: wallet.status,
          refundHoldActive: hold?.referenceType === REFUND_HOLD_REFERENCE_TYPE,
          answer: answerOf(input.providerOutcome),
        }),
      );
      const pending = await this.pendingOf(tx, task.id);
      if (pending) throw RastaError.alreadyExists('PaymentReconciliationResolution', pending.id);

      const now = new Date();
      const proposed = await tx.paymentReconciliationResolution.create({
        data: {
          id: `PRR_${ulid()}`,
          organizationId,
          paymentIntentId,
          taskId: task.id,
          status: 'PENDING_APPROVAL',
          providerOutcome: input.providerOutcome,
          evidenceReference: input.evidenceReference,
          reason: input.reason,
          fourEyes,
          proposedBy: actor,
          proposedAt: now,
          correlationId: getContext().correlationId,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.enqueueAction(tx, intent, task.kind, {
        action: 'PROPOSED',
        actor,
        resolutionId: proposed.id,
        providerOutcome: proposed.providerOutcome,
        evidenceReference: proposed.evidenceReference,
        proposedBy: actor,
      });
      if (fourEyes) return { resolution: proposed, verdict: null };
      // Separation of duties configured off (development and test only): the
      // proposer is the approver, and the record says so.
      return this.approveLocked(tx, task, proposed, actor, input.reason);
    });
    this.logger.warn(
      `Reconciliation of payment intent ${paymentIntentId}: resolution ${resolution.id} ` +
        `(${resolution.providerOutcome}) proposed by ${actor}` +
        (fourEyes ? '; awaiting approval' : '; applied at once (four-eyes is off)'),
    );
    this.countFailure(verdict);
    return toResolutionView(resolution);
  }

  /** A second resolver's approval: the only step that moves money. */
  async approve(
    paymentIntentId: string,
    resolutionId: string,
    reason: string,
  ): Promise<ResolutionView> {
    const actor = this.resolver();
    const organizationId = getOrganizationId();
    const { resolution, verdict } = await this.prisma.transaction(async (tx) => {
      const intent = await this.lockIntent(tx, paymentIntentId, organizationId);
      const proposed = await this.decidable(tx, intent, resolutionId, actor, 'APPROVED');
      const task = await tx.paymentReconciliationTask.findFirstOrThrow({
        where: { id: proposed.taskId, organizationId },
      });
      return this.approveLocked(tx, task, proposed, actor, reason);
    });
    this.logger.warn(
      `Reconciliation of payment intent ${paymentIntentId}: resolution ${resolution.id} ` +
        `approved by ${actor} (proposed by ${resolution.proposedBy})`,
    );
    this.countFailure(verdict);
    return toResolutionView(resolution);
  }

  /** A second resolver's rejection. Moves nothing; a new proposal may follow. */
  async reject(
    paymentIntentId: string,
    resolutionId: string,
    reason: string,
  ): Promise<ResolutionView> {
    const actor = this.resolver();
    const organizationId = getOrganizationId();
    const resolution = await this.prisma.transaction(async (tx) => {
      const intent = await this.lockIntent(tx, paymentIntentId, organizationId);
      const proposed = await this.decidable(tx, intent, resolutionId, actor, 'REJECTED');
      const decided = await this.decide(tx, proposed, 'REJECTED', actor, reason);
      const task = await tx.paymentReconciliationTask.findFirstOrThrow({
        where: { id: proposed.taskId, organizationId },
      });
      await this.enqueueAction(tx, intent, task.kind, {
        action: 'REJECTED',
        actor,
        resolutionId: decided.id,
        providerOutcome: decided.providerOutcome,
        evidenceReference: decided.evidenceReference,
        proposedBy: decided.proposedBy,
        fourEyes: decided.fourEyes,
      });
      return decided;
    });
    this.logger.warn(
      `Reconciliation of payment intent ${paymentIntentId}: resolution ${resolution.id} ` +
        `rejected by ${actor} (proposed by ${resolution.proposedBy})`,
    );
    return toResolutionView(resolution);
  }

  // ==========================================================================

  /**
   * Runs the approved outcome through the reconciler's apply, then records
   * the decision — one transaction, so a refused apply leaves the resolution
   * pending and nothing moved.
   */
  private async approveLocked(
    tx: ExtendedPrismaClient,
    task: Pick<
      PaymentReconciliationTask | OpenTaskRow,
      'id' | 'organizationId' | 'paymentIntentId' | 'kind' | 'attempts'
    >,
    proposed: PaymentReconciliationResolution,
    actor: string,
    reason: string,
  ): Promise<{ resolution: PaymentReconciliationResolution; verdict: Verdict }> {
    let verdict: Verdict;
    try {
      verdict = await this.reconciler.apply(
        tx,
        {
          id: task.id,
          organizationId: task.organizationId,
          paymentIntentId: task.paymentIntentId,
          kind: task.kind,
          attempts: task.attempts,
        },
        this.tasks.operatorOwnershipOf(task),
        answerOf(proposed.providerOutcome),
        {
          actor,
          because: `approved operator resolution ${proposed.id} (evidence ${proposed.evidenceReference})`,
          operator: {
            resolutionId: proposed.id,
            proposedBy: proposed.proposedBy,
            approvedBy: actor,
            evidenceReference: proposed.evidenceReference,
            fourEyes: proposed.fourEyes,
          },
        },
      );
    } catch (error) {
      if (error instanceof LeaseLost) throw sweeperHolds('APPROVED');
      throw error;
    }
    refuseUnlessEffect(verdict);
    const resolution = await this.decide(tx, proposed, 'APPROVED', actor, reason);
    return { resolution, verdict };
  }

  /** The pending resolution `actor` may decide, or the refusal that says why not. */
  private async decidable(
    tx: ExtendedPrismaClient,
    intent: PaymentIntent,
    resolutionId: string,
    actor: string,
    to: 'APPROVED' | 'REJECTED',
  ): Promise<PaymentReconciliationResolution> {
    const proposed = await tx.paymentReconciliationResolution.findFirst({
      where: {
        id: resolutionId,
        paymentIntentId: intent.id,
        organizationId: intent.organizationId,
      },
    });
    if (!proposed) throw RastaError.notFound('PaymentReconciliationResolution', resolutionId);
    if (proposed.fourEyes && proposed.proposedBy === actor) {
      throw separation('a resolution is decided by someone other than its proposer');
    }
    if (intent.createdBy === actor) throw separation('the payment’s creator may not resolve it');
    if (proposed.status !== 'PENDING_APPROVAL') {
      throw RastaError.invalidStateTransition(
        'PaymentReconciliationResolution',
        proposed.status,
        to,
      );
    }
    return proposed;
  }

  /** Records the decision on a still-pending resolution, or refuses a concurrent second one. */
  private async decide(
    tx: ExtendedPrismaClient,
    proposed: PaymentReconciliationResolution,
    status: 'APPROVED' | 'REJECTED',
    actor: string,
    reason: string,
  ): Promise<PaymentReconciliationResolution> {
    const now = new Date();
    const { count } = await tx.paymentReconciliationResolution.updateMany({
      where: {
        id: proposed.id,
        organizationId: proposed.organizationId,
        status: 'PENDING_APPROVAL',
      },
      data: { status, decidedBy: actor, decidedAt: now, decisionReason: reason, updatedAt: now },
    });
    if (count !== 1) {
      throw RastaError.invalidStateTransition('PaymentReconciliationResolution', 'DECIDED', status);
    }
    return { ...proposed, status, decidedBy: actor, decidedAt: now, decisionReason: reason };
  }

  /** The intent, row-locked first (the one lock order), in the caller's organization. */
  private async lockIntent(
    tx: ExtendedPrismaClient,
    paymentIntentId: string,
    organizationId: string,
  ): Promise<PaymentIntent> {
    const status = await this.payments.lockIntent(tx, paymentIntentId, organizationId);
    if (status === undefined) throw RastaError.notFound('PaymentIntent', paymentIntentId);
    return tx.paymentIntent.findFirstOrThrow({ where: { id: paymentIntentId, organizationId } });
  }

  private pendingOf(tx: ExtendedPrismaClient, taskId: string) {
    return tx.paymentReconciliationResolution.findFirst({
      where: { taskId, status: 'PENDING_APPROVAL' },
    });
  }

  private async enqueueAction(
    tx: ExtendedPrismaClient,
    intent: PaymentIntent,
    kind: PaymentReconciliationKind,
    action: {
      action: 'REQUEUED' | 'PROPOSED' | 'REJECTED';
      actor: string;
      resolutionId: string | null;
      providerOutcome: OperatorProviderOutcome | null;
      evidenceReference: string | null;
      proposedBy: string | null;
      fourEyes?: boolean;
    },
  ): Promise<void> {
    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_OPERATOR_ACTION,
      aggregateId: intent.id,
      organizationId: intent.organizationId,
      payload: {
        paymentIntentId: intent.id,
        organizationId: intent.organizationId,
        walletId: intent.walletId,
        kind,
        ...action,
        fourEyes: action.fourEyes ?? this.fourEyes,
        amountMinor: formatMinor(intent.amountMinor),
        currency: intent.currency,
        provider: this.provider.name,
        simulated: this.provider.simulated,
        occurredAt: new Date().toISOString(),
      },
    });
  }

  /**
   * The caller, if they may resolve: a person (never a service), not the
   * oversight role, holding one of the configured resolver roles.
   */
  private resolver(): string {
    const context = getContext();
    assertNotAuditor();
    const allowed = this.env.ECONOMIC_PAYMENT_RECONCILIATION_RESOLVER_ROLES;
    if (
      context.authType !== 'USER' ||
      !context.userId ||
      !allowed.some((role) => context.roles.includes(role))
    ) {
      throw RastaError.forbidden('Only a payment reconciliation resolver may do this');
    }
    return context.userId;
  }

  /** An approved uncreditable capture failed: the same count the sweeper keeps. */
  private countFailure(verdict: Verdict | null): void {
    if (verdict?.action !== 'FAIL_UNCREDITED') return;
    paymentIntentsTotal.inc({
      service: SERVICE_NAME,
      provider: this.provider.name,
      simulated: String(this.provider.simulated),
      outcome: 'FAILED',
    });
  }
}

/**
 * The operator's outcome in the form the decision table takes. Authoritative
 * by construction: the evidence — not the provider port — vouches for it, and
 * a second person has checked it. That is why `NOT_REACHED` may return a hold
 * here although the simulated provider's own NOT_FOUND never does.
 */
function answerOf(outcome: OperatorProviderOutcome): ProviderRefundAnswer {
  const refund = outcome === 'NOT_REACHED' ? 'NOT_FOUND' : outcome;
  return { refund, authoritative: true, simulated: false };
}

/** Only an outcome that moves the intent on may be proposed or approved. */
function refuseUnlessEffect(verdict: Verdict): void {
  switch (verdict.action) {
    case 'RECORD_REFUNDED':
    case 'RETURN_HOLD':
    case 'FAIL_UNCREDITED':
    case 'MARK_CREDITABLE':
      return;
    case 'DEFER':
      throw RastaError.businessRule(
        'The wallet is not active: a refund is not taken out of it. Reactivate it first, ' +
          'or record what the evidence shows when it is.',
        { outcome: verdict.outcome },
      );
    default:
      throw RastaError.invalidStateTransition(
        'PaymentReconciliationTask',
        verdict.action,
        'RESOLVED',
        'The payment is no longer in a state this resolution applies to',
      );
  }
}

function noOpenTask(to: string): RastaError {
  return RastaError.invalidStateTransition(
    'PaymentReconciliationTask',
    'NONE',
    to,
    'This payment has no open reconciliation task',
  );
}

function sweeperHolds(to: string): RastaError {
  return RastaError.invalidStateTransition(
    'PaymentReconciliationTask',
    'LEASED',
    to,
    'The reconciler is working on this payment now, or its task is no longer open; try again',
  );
}

function separation(why: string): RastaError {
  return RastaError.forbidden(`Separation of duties: ${why}`);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

function toResolutionView(row: PaymentReconciliationResolution): ResolutionView {
  return {
    id: row.id,
    paymentIntentId: row.paymentIntentId,
    taskId: row.taskId,
    status: row.status,
    providerOutcome: row.providerOutcome,
    evidenceReference: row.evidenceReference,
    reason: row.reason,
    fourEyes: row.fourEyes,
    proposedBy: row.proposedBy,
    proposedAt: row.proposedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
  };
}

function toTaskView(row: PaymentReconciliationTask): ReconciliationTaskView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastOutcome: row.lastOutcome,
    escalatedAt: row.escalatedAt?.toISOString() ?? null,
    resolution: row.resolution,
    resolvedBy: row.resolvedBy,
    doneAt: row.doneAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

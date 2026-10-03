import { Inject, Injectable, Logger } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor } from '../shared/money';
import {
  paymentIntentsTotal,
  paymentProviderRefundStatusTotal,
  paymentReconciliationTotal,
} from '../observability/metrics';
import { ENV, PAYMENT_PROVIDER } from '../tokens';
import { SERVICE_NAME, type EconomicEnv } from '../config/env';
import type { PaymentIntent } from '../generated/prisma';
import type { PaymentProvider } from './provider';
import {
  CAPTURED_NOT_CREDITED,
  PaymentService,
  REFUND_HOLD_REFERENCE_TYPE,
} from './payment.service';
import {
  PAYMENT_RECONCILER,
  PaymentReconciliationRepository,
  type ClaimedTask,
  type TaskOwnership,
} from './payment-reconciliation.repository';
import {
  backoffSeconds,
  decideReconciliation,
  needsProviderAnswer,
  shouldEscalate,
  type ProviderRefundAnswer,
  type Verdict,
} from './payment-reconciliation.decision';

/** What happened to one claimed task: the metric's `result`, and the sweep's tally. */
export type ReconcileResult =
  | 'resolved_refunded'
  | 'resolved_declined'
  | 'resolved_not_reached'
  | 'resolved_uncredited'
  | 'noop'
  | 'retried'
  | 'deferred'
  | 'escalated'
  | 'lost_lease';

/**
 * Thrown inside an apply transaction whose task its caller no longer holds —
 * another sweeper re-claimed it, or (for an operator) a sweeper holds it or it
 * is no longer open: rolls it all back.
 */
export class LeaseLost extends Error {
  constructor() {
    super('The reconciliation task is no longer held by this caller');
  }
}

/** The task an apply transaction finishes: a claimed one, or one an operator locked. */
export type AppliedTask = Pick<
  ClaimedTask,
  'id' | 'organizationId' | 'paymentIntentId' | 'kind' | 'attempts'
>;

/**
 * Who resolves, and what their resolution adds to the record (ADR-064 step B3).
 * The sweeper is {@link SWEEPER}; an approved operator resolution names the
 * approver as `actor`, and both actors and the evidence go on the event.
 */
export interface Resolver {
  /** `resolved_by` on the task and the event; the actor of the reversal. */
  actor: string;
  /** Why the reversal is recorded, for its journal. */
  because: string;
  operator?: {
    resolutionId: string;
    proposedBy: string;
    approvedBy: string;
    evidenceReference: string;
    fourEyes: boolean;
  };
}

const SWEEPER: Resolver = {
  actor: PAYMENT_RECONCILER,
  because: 'the provider confirmed the refund',
};

/**
 * Resolves one claimed reconciliation task (ADR-064 step B2, plan § 2.3).
 *
 *   1. **Read** the intent — no lock, no provider call yet.
 *   2. **Ask** the provider, outside any transaction, only for an unknown
 *      marker: `getRefundStatus` for the exact attempt (`<key>:refund` or
 *      `<key>:uncredited`). A thrown call or a timeout is "unreachable".
 *   3. **Apply** in one transaction: the intent's row lock, then the wallet's
 *      (the request path's order), then the task's — and the task must still
 *      be this sweeper's (the fence) or everything rolls back. The marker is
 *      re-read under the lock and {@link decideReconciliation} picks the
 *      effect, which runs through the request path's own code
 *      (`recordRefund`, `returnDeclinedHold`, `recordFailure`). The task is
 *      finished and `PAYMENT_RECONCILIATION_RESOLVED` enqueued in the same
 *      transaction.
 *
 * An answer that is not an answer moves nothing: the task is put back with a
 * backoff, and escalated — with `PAYMENT_RECONCILIATION_ESCALATED`, the hold
 * still in place — at the attempt or age limit. No posted ledger entry is
 * ever edited; money moves only through `refundHold` and `ledger.reverse`.
 */
@Injectable()
export class PaymentReconciler {
  private readonly logger = new Logger(PaymentReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly tasks: PaymentReconciliationRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly walletRepository: WalletRepository,
    @Inject(ENV) private readonly env: EconomicEnv,
  ) {}

  /** Runs in the task's tenant context (the sweeper sets it). */
  async reconcile(task: ClaimedTask): Promise<ReconcileResult> {
    const result = await this.attempt(task);
    paymentReconciliationTotal.inc({ service: SERVICE_NAME, result });
    return result;
  }

  private async attempt(task: ClaimedTask): Promise<ReconcileResult> {
    const intent = await this.prisma.client.paymentIntent.findUnique({
      where: { id: task.paymentIntentId },
    });
    if (!intent || intent.organizationId !== task.organizationId) {
      // The composite foreign key makes this unreachable; never guess past it.
      return this.giveUp(task, 'INTENT_NOT_FOUND', null, intent);
    }

    const answer = needsProviderAnswer(task.kind, intent.failureReason)
      ? await this.ask(task, intent)
      : null;

    const ownership = this.tasks.ownershipOf(task);
    let verdict: Verdict;
    try {
      verdict = await this.prisma.transaction((tx) =>
        this.apply(tx, task, ownership, answer, SWEEPER),
      );
    } catch (error) {
      if (error instanceof LeaseLost) {
        this.logger.warn(
          `Reconciliation task ${task.id}: lease lost before the write; nothing moved`,
        );
        return 'lost_lease';
      }
      this.logger.error(
        `Reconciliation task ${task.id}: applying the outcome failed; it is retried`,
        error instanceof Error ? error.stack : String(error),
      );
      return this.retry(task, 'APPLY_FAILED', intent);
    }

    switch (verdict.action) {
      case 'RECORD_REFUNDED':
        return 'resolved_refunded';
      case 'RETURN_HOLD':
        return verdict.resolution === 'REFUND_DECLINED'
          ? 'resolved_declined'
          : 'resolved_not_reached';
      case 'FAIL_UNCREDITED':
        paymentIntentsTotal.inc({
          service: SERVICE_NAME,
          provider: this.provider.name,
          simulated: String(this.provider.simulated),
          outcome: 'FAILED',
        });
        return 'resolved_uncredited';
      case 'MARK_CREDITABLE':
        return 'resolved_uncredited';
      case 'NOOP':
        return 'noop';
      case 'RETRY':
        return this.retry(task, verdict.outcome, intent);
      case 'DEFER':
        return this.defer(task, verdict.outcome, intent);
      case 'ESCALATE':
        return this.giveUp(task, verdict.outcome, intent.failureReason, intent);
    }
  }

  /** The provider's record of the exact attempt, or `UNREACHABLE`. Never throws. */
  private async ask(task: ClaimedTask, intent: PaymentIntent): Promise<ProviderRefundAnswer> {
    const refund = task.kind === 'REFUND';
    try {
      const said = await this.provider.getRefundStatus({
        paymentIntentId: intent.id,
        providerReference: intent.providerReference ?? intent.id,
        idempotencyKey: `${intent.idempotencyKey}:${refund ? 'refund' : 'uncredited'}`,
      });
      // "Never received" is evidence only from a provider that declares it
      // can vouch for an absence (Codex on #164, HIGH 2). The mock cannot:
      // its memory is one process's. Its NOT_FOUND is taken as unknown.
      const answer =
        said.refund === 'NOT_FOUND' && !this.provider.authoritativeAbsence
          ? { ...said, authoritative: false }
          : said;
      paymentProviderRefundStatusTotal.inc({
        service: SERVICE_NAME,
        provider: this.provider.name,
        simulated: String(this.provider.simulated),
        refund: answer.refund,
        authoritative: String(answer.authoritative),
      });
      return answer;
    } catch (error) {
      paymentProviderRefundStatusTotal.inc({
        service: SERVICE_NAME,
        provider: this.provider.name,
        simulated: String(this.provider.simulated),
        refund: 'UNREACHABLE',
        authoritative: 'false',
      });
      this.logger.warn(
        `Reconciliation task ${task.id}: the provider could not be asked (${
          (error as { code?: string } | null)?.code ?? 'ERROR'
        })`,
      );
      return 'UNREACHABLE';
    }
  }

  /**
   * Step 3 for one task, in the caller's transaction: the locks, the fence,
   * the decision under lock, the effect, the task finished and the event —
   * or {@link LeaseLost}, and nothing. The sweeper and an approved operator
   * resolution (step B3) both come through here: one path that moves money.
   *
   * A verdict that moves nothing (RETRY, DEFER, ESCALATE) is returned with
   * nothing written. So is NOOP for an operator: approving "nothing to
   * reconcile" is refused by the caller, not recorded as a resolution.
   */
  async apply(
    tx: ExtendedPrismaClient,
    task: AppliedTask,
    ownership: Pick<TaskOwnership, 'verify' | 'finish'>,
    answer: ProviderRefundAnswer,
    resolver: Resolver,
  ): Promise<Verdict> {
    const status = await this.payments.lockIntent(tx, task.paymentIntentId, task.organizationId);
    if (status === undefined) throw RastaError.notFound('PaymentIntent', task.paymentIntentId);
    const row = await tx.paymentIntent.findUniqueOrThrow({ where: { id: task.paymentIntentId } });
    const [wallet] = await this.walletRepository.lock(tx, [row.walletId]);
    if (!wallet) throw RastaError.internal('Wallet vanished while locking it');
    if (!(await ownership.verify(tx))) throw new LeaseLost();

    const hold = await this.walletRepository.findActiveHold(tx, wallet.id, row.id);
    const verdict = decideReconciliation({
      kind: task.kind,
      intentStatus: row.status,
      marker: row.failureReason,
      walletStatus: wallet.status,
      refundHoldActive: hold?.referenceType === REFUND_HOLD_REFERENCE_TYPE,
      answer,
    });

    switch (verdict.action) {
      case 'RECORD_REFUNDED':
        await this.payments.recordRefund(tx, row, wallet, resolver.actor, resolver.because);
        break;
      case 'RETURN_HOLD':
        await this.payments.returnDeclinedHold(
          tx,
          row,
          wallet,
          resolver.actor,
          verdict.resolution === 'REFUND_DECLINED' ? 'DECLINED' : 'NOT_REACHED',
        );
        break;
      case 'FAIL_UNCREDITED':
        await this.payments.recordFailure(tx, {
          intentId: row.id,
          organizationId: row.organizationId,
          amountMinor: row.amountMinor,
          currency: row.currency,
          reason: 'CAPTURE_NOT_CREDITED',
        });
        break;
      case 'MARK_CREDITABLE':
        await tx.paymentIntent.update({
          where: { id: row.id },
          data: { failureReason: CAPTURED_NOT_CREDITED },
        });
        break;
      case 'NOOP':
        if (resolver.operator) return verdict;
        break;
      default:
        // RETRY, DEFER, ESCALATE: nothing moves in this transaction.
        return verdict;
    }

    if ((await ownership.finish(tx, verdict.resolution, resolver.actor)) !== 1) {
      throw new LeaseLost();
    }
    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_RESOLVED,
      aggregateId: row.id,
      organizationId: row.organizationId,
      payload: {
        paymentIntentId: row.id,
        organizationId: row.organizationId,
        walletId: row.walletId,
        kind: task.kind,
        marker: markerOf(row.failureReason),
        providerRefund: providerRefundOf(answer),
        resolution: verdict.resolution,
        resolvedBy: resolver.actor,
        attempts: task.attempts,
        amountMinor: formatMinor(row.amountMinor),
        currency: row.currency,
        provider: this.provider.name,
        simulated: this.provider.simulated,
        resolvedAt: new Date().toISOString(),
        ...(resolver.operator ?? {}),
      },
    });
    this.logger.log(
      `Reconciliation task ${task.id}: payment intent ${row.id} resolved as ${verdict.resolution}` +
        (resolver.operator ? ` by an approved operator resolution` : ''),
    );
    return verdict;
  }

  /** One more unanswered attempt: later, or to a person at the limit. */
  private async retry(
    task: ClaimedTask,
    outcome: string,
    intent: PaymentIntent,
  ): Promise<ReconcileResult> {
    const attempts = task.attempts + 1;
    if (
      shouldEscalate({
        attempts,
        createdAt: task.createdAt,
        now: new Date(),
        maxAttempts: this.env.ECONOMIC_PAYMENT_RECONCILER_MAX_ATTEMPTS,
        maxAgeHours: this.env.ECONOMIC_PAYMENT_RECONCILER_MAX_AGE_HOURS,
      })
    ) {
      return this.escalate(task, outcome, intent.failureReason, intent, true);
    }
    const delay = backoffSeconds(
      task.attempts,
      this.env.ECONOMIC_PAYMENT_RECONCILER_BACKOFF_SECONDS,
      this.env.ECONOMIC_PAYMENT_RECONCILER_BACKOFF_MAX_SECONDS,
    );
    const put = await this.tasks.retryLater(task, outcome, delay, true);
    this.logger.warn(
      `Reconciliation task ${task.id} (attempt ${attempts}): ${outcome}; asking again in ${delay}s`,
    );
    return put === 1 ? 'retried' : 'lost_lease';
  }

  /** Nothing asked, nothing counted: the same wait again — to a person only at the age limit. */
  private async defer(
    task: ClaimedTask,
    outcome: string,
    intent: PaymentIntent,
  ): Promise<ReconcileResult> {
    const aged = shouldEscalate({
      attempts: 0,
      createdAt: task.createdAt,
      now: new Date(),
      maxAttempts: Number.POSITIVE_INFINITY,
      maxAgeHours: this.env.ECONOMIC_PAYMENT_RECONCILER_MAX_AGE_HOURS,
    });
    if (aged) return this.escalate(task, outcome, intent.failureReason, intent, false);
    const delay = backoffSeconds(
      task.attempts,
      this.env.ECONOMIC_PAYMENT_RECONCILER_BACKOFF_SECONDS,
      this.env.ECONOMIC_PAYMENT_RECONCILER_BACKOFF_MAX_SECONDS,
    );
    const put = await this.tasks.retryLater(task, outcome, delay, false);
    return put === 1 ? 'deferred' : 'lost_lease';
  }

  /** A state nothing here may guess about: straight to a person, no attempt counted. */
  private giveUp(
    task: ClaimedTask,
    outcome: string,
    marker: string | null,
    intent: PaymentIntent | null,
  ): Promise<ReconcileResult> {
    return this.escalate(task, outcome, marker, intent, false);
  }

  private async escalate(
    task: ClaimedTask,
    outcome: string,
    marker: string | null,
    intent: PaymentIntent | null,
    countAttempt: boolean,
  ): Promise<ReconcileResult> {
    const ownership = this.tasks.ownershipOf(task);
    const escalated = await this.prisma.transaction(async (tx) => {
      if ((await ownership.escalate(tx, outcome, countAttempt)) !== 1) return false;
      if (intent) {
        await this.ledger.enqueue(tx, {
          eventName: ECONOMIC_EVENTS.PAYMENT_RECONCILIATION_ESCALATED,
          aggregateId: intent.id,
          organizationId: intent.organizationId,
          payload: {
            paymentIntentId: intent.id,
            organizationId: intent.organizationId,
            walletId: intent.walletId,
            kind: task.kind,
            marker: markerOf(marker),
            lastOutcome: outcome,
            attempts: task.attempts + (countAttempt ? 1 : 0),
            amountMinor: formatMinor(intent.amountMinor),
            currency: intent.currency,
            provider: this.provider.name,
            simulated: this.provider.simulated,
            escalatedAt: new Date().toISOString(),
          },
        });
      }
      return true;
    });
    if (!escalated) return 'lost_lease';
    this.logger.error(
      `Reconciliation task ${task.id}: payment intent ${task.paymentIntentId} escalated ` +
        `(${outcome}); its refund hold stays until a person resolves it`,
    );
    return 'escalated';
  }
}

const MARKERS = new Set([
  'REFUND_REQUESTED',
  'REFUND_UNKNOWN',
  'REFUNDED_NOT_REVERSED',
  'REFUND_DECLINED_RELEASE_PENDING',
  'CAPTURED_REFUND_UNKNOWN',
]);

/** The marker as the event's closed set has it, or null. */
function markerOf(
  failureReason: string | null,
):
  | 'REFUND_REQUESTED'
  | 'REFUND_UNKNOWN'
  | 'REFUNDED_NOT_REVERSED'
  | 'REFUND_DECLINED_RELEASE_PENDING'
  | 'CAPTURED_REFUND_UNKNOWN'
  | null {
  return failureReason !== null && MARKERS.has(failureReason)
    ? (failureReason as ReturnType<typeof markerOf>)
    : null;
}

/** The provider answer a resolution rests on, or null when nobody was asked. */
function providerRefundOf(
  answer: ProviderRefundAnswer,
): 'REFUNDED' | 'DECLINED' | 'NOT_FOUND' | null {
  if (answer === null || answer === 'UNREACHABLE' || answer.refund === 'UNKNOWN') return null;
  return answer.refund;
}

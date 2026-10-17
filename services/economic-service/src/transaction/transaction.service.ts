import { Inject, Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { TransactionRepository, type TransactionFilter } from './transaction.repository';
import { nextStatus } from './state-machine';
import {
  assertMayRefund,
  assertTransactionVisible,
  canActFinanciallyFor,
  reconfirmFinancialAuthority,
  recordFinancialCommand,
  type FinancialAuthority,
  type FinancialCommand,
  type RefundableTransaction,
} from '../access/access';
import { OrganizationHierarchy } from '../organization/organization-hierarchy';
import { formatMinor, parseMinor } from '../shared/money';
import { isUniqueViolation } from '../ledger/ledger.repository';
import { LedgerService } from '../ledger/ledger.service';
import { CommissionService } from '../commission/commission.service';
import { ECONOMIC_EVENTS } from '../events/events';
import { financialTransactionDuration, transactionsCreatedTotal } from '../observability/metrics';
import { SERVICE_NAME, type EconomicEnv } from '../config/env';
import { ENV } from '../tokens';
import type { IdempotentAnswer } from '../shared/idempotency';
import type { BusinessLine, Prisma, TransactionStatus, TransactionType } from '../generated/prisma';
import type { CreateTransactionDto, DisputeTransactionDto, ResolveDisputeDto } from './dto';

/**
 * Transactions — the obligations everything else in this service acts on.
 *
 * A transaction is a *record of what is owed*, and recording one moves no
 * money by itself. Money moves when funds are held against it, when it is
 * settled, or when a hold is refunded — each of which is a separate,
 * explicitly authorised act.
 *
 * That separation is what lets an approved maintenance repair be recorded even
 * when the payer's wallet is empty (ADR-032): the obligation exists, is
 * visible, and waits, rather than the event being dead-lettered and a person's
 * approval being lost.
 */
@Injectable()
export class TransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: TransactionRepository,
    private readonly wallets: WalletService,
    private readonly walletRepository: WalletRepository,
    @Inject(ENV) private readonly env: EconomicEnv,
    private readonly ledger: LedgerService,
    private readonly commissions: CommissionService,
    private readonly hierarchy: OrganizationHierarchy,
  ) {}

  // ==========================================================================
  // Creating
  // ==========================================================================

  /**
   * Records a transaction, optionally holding funds against it in the same
   * breath.
   *
   * `holdFunds` exists because that is what an order needs: `ORDER_CREATED`
   * has to reserve the money at the moment the obligation is created, and
   * splitting it into two calls would leave a window in which the obligation
   * exists and the money is still spendable (docs/10 § 10.5).
   *
   * Both happen in one transaction, so a hold that fails for insufficient
   * balance leaves no orphaned obligation behind.
   */
  async create(
    dto: CreateTransactionDto,
    answer?: IdempotentAnswer<TransactionDetail>,
  ): Promise<TransactionDetail> {
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? SERVICE_NAME;
    const grossAmountMinor = parseMinor(dto.grossAmountMinor, 'grossAmountMinor');

    if (dto.counterpartyOrganizationId === organizationId) {
      throw RastaError.businessRule('A transaction cannot have the same payer and payee');
    }
    if (dto.holdFunds && !dto.counterpartyOrganizationId) {
      throw RastaError.businessRule('Funds can only be held against a transaction with a payee');
    }

    // Resolved *before* the transaction opens, and that placement is the fix
    // for a real defect the concurrency suite caught: `getOrOpen` opens its own
    // transaction when the wallet does not exist yet, and Prisma runs a nested
    // interactive transaction on a **different connection** — so the inner one
    // waits on locks the outer one holds, and the pair deadlocks until the
    // timeout. Anything that might open a transaction of its own has to happen
    // before the money-moving one begins.
    const payerWallet = dto.holdFunds ? await this.wallets.getOrOpen(dto.currency ?? 'IRR') : null;

    const stop = financialTransactionDuration.startTimer({
      service: SERVICE_NAME,
      operation: 'create-transaction',
    });

    try {
      const created = await this.prisma.transaction(async (tx) => {
        const id = `${ID_PREFIXES.transaction}_${ulid()}`;
        const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
        const pricing = dto.counterpartyOrganizationId
          ? await this.commissions.pricingOf(tx, {
              organizationId: dto.counterpartyOrganizationId,
              transactionType: dto.transactionType,
              businessLine: dto.businessLine ?? null,
              occurredAt,
              grossAmountMinor,
              currency: dto.currency ?? 'IRR',
            })
          : UNPRICED;

        await this.repository.create(
          tx,
          {
            id,
            organizationId,
            counterpartyOrganizationId: dto.counterpartyOrganizationId ?? null,
            transactionType: dto.transactionType,
            businessLine: dto.businessLine ?? null,
            ...pricing,
            status: 'CREATED',
            grossAmountMinor,
            currency: dto.currency ?? 'IRR',
            occurredAt,
            sourceType: dto.sourceType ?? null,
            sourceReference: dto.sourceReference ?? null,
            idempotencyKey: dto.idempotencyKey ?? null,
            correlationId: getContext().correlationId,
            createdBy: actor,
          },
          this.legsFor(
            id,
            organizationId,
            dto.counterpartyOrganizationId ?? null,
            grossAmountMinor,
            dto.currency ?? 'IRR',
          ),
        );

        if (payerWallet) {
          const [locked] = await this.walletRepository.lock(tx, [payerWallet.id]);
          if (!locked) throw RastaError.internal('Wallet vanished while locking it');

          await this.wallets.placeHold(tx, {
            wallet: locked,
            amountMinor: grossAmountMinor,
            reference: id,
            referenceType: 'TRANSACTION',
            transactionId: id,
            placedBy: actor,
          });

          await this.repository.transition(
            tx,
            id,
            'CREATED',
            nextStatus(id, 'CREATED', 'HOLD_PLACED'),
          );
        }

        // One record of the creation, naming the status the row ends in: a
        // hold placed in the same breath is announced by its own FUNDS_HELD.
        await this.announce(
          tx,
          {
            id,
            organizationId,
            counterpartyOrganizationId: dto.counterpartyOrganizationId ?? null,
            transactionType: dto.transactionType,
            grossAmountMinor,
            currency: dto.currency ?? 'IRR',
          },
          {
            action: 'CREATE',
            from: null,
            to: payerWallet ? 'HELD' : 'CREATED',
            by: actor,
            at: new Date(),
          },
        );

        return this.answered(tx, id, answer);
      });

      transactionsCreatedTotal.inc({
        service: SERVICE_NAME,
        type: dto.transactionType,
        source: 'api',
      });

      return created;
    } catch (error) {
      throw await this.duplicateSourceOr(error, organizationId, dto);
    } finally {
      stop();
    }
  }

  /**
   * A second obligation for a source fact this payer already recorded is a
   * 409, not a 500.
   *
   * Different idempotency keys are different requests, so the idempotency
   * store cannot catch this; `ux_transaction_source_fact` does. Confirmed by
   * reading the row back rather than by parsing the driver's constraint name,
   * so another unique violation is never mislabelled as this one. Nothing is
   * said about the existing row beyond that it exists — the caller is its
   * payer and can list it by `sourceReference`.
   */
  private async duplicateSourceOr(
    error: unknown,
    organizationId: string,
    dto: CreateTransactionDto,
  ): Promise<unknown> {
    if (!isUniqueViolation(error) || !dto.sourceType || !dto.sourceReference) return error;
    const existing = await this.repository.findBySource(
      this.prisma.client,
      organizationId,
      dto.sourceType,
      dto.sourceReference,
    );
    if (!existing) return error;
    return new RastaError(
      'CONFLICT',
      'An obligation for this source is already recorded for this organization',
    );
  }

  /**
   * Records an obligation that arrived as an event, already authorised to
   * settle (ADR-032).
   *
   * Used by the `MAINTENANCE_APPROVED` consumer. No wallet is touched: the
   * work is done and the amount is owed, so refusing to record it because a
   * wallet is empty would lose a person's approval rather than protect
   * anything.
   *
   * Idempotent on `(organizationId, sourceType, sourceReference)` in addition
   * to `processed_event`, because a producer that re-emits the same approval
   * under a new event id would otherwise create a second obligation for one
   * repair. The read below is only the fast path: two such events processed
   * concurrently both miss it, and it is `ux_transaction_source_fact` that
   * decides — the loser writes nothing and returns the winner's row.
   */
  async recordAuthorisedObligation(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      counterpartyOrganizationId: string;
      transactionType: TransactionType;
      /**
       * Stated by the consumer that knows what the fact is (ADR-045 § 4), or
       * null where the line is an open question (docs/24 Q-130): priced then
       * by the type-only rules alone.
       */
      businessLine: BusinessLine | null;
      grossAmountMinor: bigint;
      currency: string;
      occurredAt: Date;
      sourceType: string;
      sourceReference: string;
      causationId?: string;
    },
  ): Promise<{ id: string; created: boolean }> {
    const existing = await this.repository.findBySource(
      tx,
      input.organizationId,
      input.sourceType,
      input.sourceReference,
    );
    if (existing) return { id: existing.id, created: false };

    const id = `${ID_PREFIXES.transaction}_${ulid()}`;
    // At the approval's own time, under the cutover: an approval given before
    // business lines priced anything is priced as it would have been then.
    const pricing = await this.commissions.pricingOf(tx, {
      organizationId: input.counterpartyOrganizationId,
      transactionType: input.transactionType,
      businessLine: input.businessLine,
      occurredAt: input.occurredAt,
      grossAmountMinor: input.grossAmountMinor,
      currency: input.currency,
    });

    const written = await this.repository.createForSource(
      tx,
      {
        id,
        organizationId: input.organizationId,
        counterpartyOrganizationId: input.counterpartyOrganizationId,
        transactionType: input.transactionType,
        businessLine: input.businessLine,
        ...pricing,
        // Straight to PENDING_SETTLEMENT: the authorising fact is the event
        // itself. The state machine permits this edge from CREATED, and the
        // row is written in its post-transition state rather than moved twice.
        status: 'PENDING_SETTLEMENT',
        grossAmountMinor: input.grossAmountMinor,
        currency: input.currency,
        occurredAt: input.occurredAt,
        sourceType: input.sourceType,
        sourceReference: input.sourceReference,
        correlationId: getContext().correlationId,
        causationId: input.causationId ?? null,
        createdBy: SERVICE_NAME,
      },
      this.legsFor(
        id,
        input.organizationId,
        input.counterpartyOrganizationId,
        input.grossAmountMinor,
        input.currency,
      ),
    );

    if (!written) {
      const winner = await this.repository.findBySource(
        tx,
        input.organizationId,
        input.sourceType,
        input.sourceReference,
      );
      if (!winner) {
        throw RastaError.internal('An obligation for this source fact conflicted and vanished');
      }
      return { id: winner.id, created: false };
    }

    await this.announce(
      tx,
      {
        id,
        organizationId: input.organizationId,
        counterpartyOrganizationId: input.counterpartyOrganizationId,
        transactionType: input.transactionType,
        grossAmountMinor: input.grossAmountMinor,
        currency: input.currency,
      },
      {
        action: 'RECORD_AUTHORISED_OBLIGATION',
        from: null,
        to: 'PENDING_SETTLEMENT',
        by: SERVICE_NAME,
        at: new Date(),
        causationId: input.causationId,
      },
    );

    transactionsCreatedTotal.inc({
      service: SERVICE_NAME,
      type: input.transactionType,
      source: 'event',
    });

    return { id, created: true };
  }

  /**
   * The parties to a transaction and what each is owed.
   *
   * At creation both legs carry the gross: the rule is chosen now
   * (`pricing_*`), but the split is computed and posted at settlement, which
   * records it on the transaction and on the `commission` row.
   */
  private legsFor(
    transactionId: string,
    payerOrganizationId: string,
    payeeOrganizationId: string | null,
    grossAmountMinor: bigint,
    currency: string,
  ): Prisma.TransactionLegCreateManyInput[] {
    const legs: Prisma.TransactionLegCreateManyInput[] = [
      {
        id: `TXL_${ulid()}`,
        transactionId,
        organizationId: payerOrganizationId,
        role: 'PAYER',
        amountMinor: grossAmountMinor,
        currency,
      },
    ];
    if (payeeOrganizationId) {
      legs.push({
        id: `TXL_${ulid()}`,
        transactionId,
        organizationId: payeeOrganizationId,
        role: 'PAYEE',
        amountMinor: grossAmountMinor,
        currency,
      });
    }
    return legs;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Authorises settlement — the "receipt confirmed" step (docs/10 § 10.5).
   *
   * Separated from settlement itself because they are two decisions by
   * potentially two different people: confirming that the goods arrived, and
   * releasing the money. Collapsing them would make the product document's
   * "تأیید دریافت" control indistinguishable from the payment.
   *
   * A service's authorisation also keeps which service asked and under which
   * `idempotencyKey`, on the row, for good. The stored answer expires; this
   * does not. It is how the order saga proves its own authorisation took
   * effect when its retry comes after that expiry and finds the transaction
   * DISPUTED — a state a dispute reaches from HELD too, with no authorisation
   * at all (docs/23 D-053). A person's key is their client's, and the row is
   * shown to the payee, so it is not kept.
   */
  async authoriseSettlement(
    transactionId: string,
    answer?: IdempotentAnswer<TransactionDetail>,
    idempotencyKey?: string,
  ): Promise<TransactionDetail> {
    const context = getContext();
    const actor = context.userId ?? SERVICE_NAME;
    // The signed caller, never a header (ADR-035).
    const service = context.authType === 'SERVICE' ? (context.callerService ?? null) : null;
    const at = new Date();
    return this.move(
      transactionId,
      'AUTHORISE_SETTLEMENT',
      actor,
      at,
      {
        settlementAuthorisedAt: at,
        settlementAuthorisedBy: actor,
        settlementAuthorisedService: service,
        settlementAuthorisationKey: service ? (idempotencyKey ?? null) : null,
      },
      answer,
    );
  }

  /**
   * Registers an objection. **Settlement stops completely** (docs/10 § 10.5).
   *
   * There is no timeout that clears it and no automatic resolution: the state
   * machine has no edge from `DISPUTED` to `SETTLED`, only to
   * `PENDING_SETTLEMENT` by an explicit human decision, or to `REFUNDED`.
   */
  async dispute(
    transactionId: string,
    dto: DisputeTransactionDto,
    answer?: IdempotentAnswer<TransactionDetail>,
  ): Promise<TransactionDetail> {
    const actor = getContext().userId ?? SERVICE_NAME;
    const at = new Date();
    return this.move(
      transactionId,
      'DISPUTE',
      actor,
      at,
      { disputedAt: at, disputedBy: actor, disputeReason: dto.reason },
      answer,
    );
  }

  /**
   * Resolves a dispute back into the settlement queue.
   *
   * With `dto.disputeId`, the decision is about that dispute and no other:
   * refused unless the transaction still holds it (Codex on #318 round 2, N1).
   * The order saga names the dispute its operator decided; without the name,
   * a dispute resolved here and replaced by another meanwhile was the one
   * decided, and the new one was cleared with it.
   *
   * A human decision, recorded with who made it. It does not settle — it only
   * unblocks, so that releasing the money remains a separate, deliberate act.
   */
  async resolveDispute(
    transactionId: string,
    dto: ResolveDisputeDto,
    answer?: IdempotentAnswer<TransactionDetail>,
  ): Promise<TransactionDetail> {
    const actor = getContext().userId ?? SERVICE_NAME;
    const at = new Date();
    return this.move(
      transactionId,
      'RESOLVE_DISPUTE',
      actor,
      at,
      { disputeResolvedAt: at, disputeResolvedBy: actor, disputeReason: dto.resolution },
      answer,
      dto.disputeId,
    );
  }

  /**
   * Refunds a held transaction to the payer.
   *
   * Posts the refund journal and returns the escrowed funds, then moves the
   * transaction to `REFUNDED` — all in one transaction, so a refund that fails
   * halfway leaves the money exactly where it was.
   *
   * Who may ask is {@link assertMayRefund}: never the payer, and for a
   * disputed transaction only a platform decision or the order saga (docs/24
   * Q-62). Checked under the row lock, against the status the state machine is
   * about to read, so the two cannot disagree.
   */
  async refund(
    transactionId: string,
    reason: string,
    answer?: IdempotentAnswer<TransactionDetail>,
  ): Promise<TransactionDetail> {
    const actor = getContext().userId ?? SERVICE_NAME;
    const stop = financialTransactionDuration.startTimer({
      service: SERVICE_NAME,
      operation: 'refund',
    });

    try {
      const { detail, authority } = await this.prisma.transaction(async (tx) => {
        const transaction = await this.repository.lockForUpdate(tx, transactionId);
        if (!transaction) throw RastaError.notFound('Transaction', transactionId);
        const lockedRowAuthority = await this.authorizeAct(transaction, 'REFUND');

        const target = nextStatus(transactionId, transaction.status, 'REFUND');

        const wallet = await this.walletRepository.findByOrganizationUnscoped(
          tx,
          transaction.organizationId,
          transaction.currency,
        );
        if (!wallet) throw RastaError.notFound('Wallet', transaction.organizationId);

        const [locked] = await this.walletRepository.lock(tx, [wallet.id]);
        if (!locked) throw RastaError.internal('Wallet vanished while locking it');

        const hold = await this.walletRepository.findActiveHold(tx, wallet.id, transactionId);

        // The wallet lock was the last lock this refund takes: ask the
        // hierarchy again, so a union administrator's authority is the one
        // confirmed after that wait, immediately before the refund journal
        // (docs/23 D-054; Codex on #314 round 3, F2).
        const authority = await reconfirmFinancialAuthority(lockedRowAuthority, this.hierarchy);

        if (hold) {
          // The refund journal is the payer's — it moves the payer's escrow back
          // into the payer's wallet — but the caller may be another party: the
          // payee, a platform administrator or the order saga. The journal
          // header is tenant-scoped (`LedgerRepository.createJournal`), so
          // without this crossing any refund not asked for by the payer itself
          // was refused as an implicit cross-tenant write and surfaced as a 500.
          // The authority to make it was decided above, under the row lock.
          await runUnscoped(
            'a refund posts the payer journal on the authority of another party to the transaction',
            () =>
              this.wallets.refundHold(tx, {
                wallet: locked,
                holdId: hold.id,
                transactionId,
                note: reason,
                resolvedBy: actor,
              }),
          );
        }

        const refundedAt = new Date();
        const moved = await this.repository.transition(
          tx,
          transactionId,
          transaction.status,
          target,
          { failureReason: reason, refundedAt, refundedBy: actor },
        );
        if (moved === 0) throw RastaError.optimisticLockFailed('Transaction', transactionId);

        await this.announce(tx, transaction, {
          action: 'REFUND',
          from: transaction.status,
          to: target,
          by: actor,
          at: refundedAt,
        });

        return { detail: await this.answered(tx, transactionId, answer), authority };
      });
      recordFinancialCommand(transactionId, authority);
      return detail;
    } finally {
      stop();
    }
  }

  /** Cancels a transaction nothing has moved against yet. */
  async cancel(
    transactionId: string,
    reason: string,
    answer?: IdempotentAnswer<TransactionDetail>,
  ): Promise<TransactionDetail> {
    const actor = getContext().userId ?? SERVICE_NAME;
    const at = new Date();
    return this.move(
      transactionId,
      'CANCEL',
      actor,
      at,
      { failureReason: reason, cancelledAt: at, cancelledBy: actor },
      answer,
    );
  }

  /**
   * One guarded state change, with no money movement.
   *
   * Under the row lock so that the read of the current status and the write of
   * the next one are one decision — and with `assertTransactionVisible` so
   * that a caller who is neither payer nor payee gets a 404 rather than
   * discovering the transaction exists. The actor and the instant go on the
   * row (through `extra`) and on the `TRANSACTION_STATUS_CHANGED` record, in
   * the same transaction as the move — and so does the answer, read from the
   * row the move wrote (see {@link answered}).
   *
   * `heldDispute`, when given, is the dispute the transaction must hold for
   * the move to happen — read under the same lock, so it cannot be replaced
   * between the check and the write (see {@link resolveDispute}).
   */
  private async move(
    transactionId: string,
    event: 'AUTHORISE_SETTLEMENT' | 'DISPUTE' | 'RESOLVE_DISPUTE' | 'CANCEL',
    actor: string,
    at: Date,
    extra: Prisma.TransactionUncheckedUpdateManyInput,
    answer?: IdempotentAnswer<TransactionDetail>,
    heldDispute?: string,
  ): Promise<TransactionDetail> {
    const { detail, authority } = await this.prisma.transaction(async (tx) => {
      const transaction = await this.repository.lockForUpdate(tx, transactionId);
      if (!transaction) throw RastaError.notFound('Transaction', transactionId);
      // Judged here, under the row lock and in the transaction that commits the
      // move, so the authority and the state it moves are read together; the
      // hierarchy question, when there is one, is asked here too (Q-136). No
      // lock is taken after the row's, so this answer is already the last
      // thing read before the write — nothing to ask again (docs/23 D-054).
      const authority = await this.authorizeAct(transaction, event);

      const target = nextStatus(transactionId, transaction.status, event);
      if (heldDispute !== undefined && transaction.disputeId !== heldDispute) {
        // Fixed words: the identities stay out of the envelope and the log.
        throw RastaError.invalidStateTransition(
          'Transaction',
          transaction.status,
          target,
          'The transaction no longer holds the dispute this decision is about',
        );
      }
      const moved = await this.repository.transition(
        tx,
        transactionId,
        transaction.status,
        target,
        extra,
      );
      if (moved === 0) throw RastaError.optimisticLockFailed('Transaction', transactionId);

      await this.announce(tx, transaction, {
        action: event,
        from: transaction.status,
        to: target,
        by: actor,
        at,
      });

      return { detail: await this.answered(tx, transactionId, answer), authority };
    });
    recordFinancialCommand(transactionId, authority);
    return detail;
  }

  /**
   * Who may make one of the five transaction commands on this transaction, and
   * on what authority: a refund by its own rule (docs/24 Q-62), the other four
   * by {@link canActFinanciallyFor} — and both, for acting from another
   * organization, by that one rule of docs/24 Q-136. A non-party learns
   * nothing — `NOT_FOUND` first, always.
   */
  private authorizeAct(
    transaction: RefundableTransaction,
    command: TransactionCommand,
  ): Promise<FinancialAuthority> {
    if (command === 'REFUND') {
      return assertMayRefund(
        transaction,
        { payeeMayRefund: this.env.ECONOMIC_REFUND_BY_PAYEE_ENABLED },
        this.hierarchy,
      );
    }
    assertTransactionVisible(transaction);
    return canActFinanciallyFor(command, transaction.organizationId, this.hierarchy);
  }

  /**
   * The checks of {@link authorizeAct}, against the transaction as it is now,
   * without the command — the replay guard of an idempotent command on it
   * (review of #287, finding 1). A caller who could not make the command now
   * is refused exactly as that command would refuse them: a stored answer
   * shows the transaction, so it goes only to whom the transaction would.
   */
  async assertMayReplay(transactionId: string, act: TransactionAct): Promise<void> {
    const transaction = await this.repository.findByIdForParty(transactionId);
    if (!transaction) throw RastaError.notFound('Transaction', transactionId);
    if (act === 'READ') assertTransactionVisible(transaction);
    else await this.authorizeAct(transaction, act);
  }

  /**
   * The transaction as the command that just changed it leaves it, read in
   * that command's own transaction `tx` — and, for an idempotent request,
   * stored there as its key's answer.
   *
   * It used to be read after the commit, and that read was a failure point
   * after the effect: inside the idempotency store's work, a read that failed
   * released the key of a state change that had happened, and the same-key
   * retry was refused `INVALID_STATE_TRANSITION` against the state it had
   * itself moved (review of #283, finding 2). Read here, a failure rolls the
   * change back with it; once this commits, the key is COMPLETED.
   */
  private async answered(
    tx: ExtendedPrismaClient,
    transactionId: string,
    answer: IdempotentAnswer<TransactionDetail> | undefined,
  ): Promise<TransactionDetail> {
    const detail = await this.get(transactionId, tx);
    await answer?.respond(tx, detail);
    return detail;
  }

  /**
   * The audit record of one lifecycle step (`TRANSACTION_STATUS_CHANGED`,
   * AGENTS.md S-06), written into the outbox by the transaction that makes
   * the step, so the step and its record commit together or not at all
   * (ADR-021).
   */
  private announce(
    tx: ExtendedPrismaClient,
    transaction: {
      id: string;
      organizationId: string;
      counterpartyOrganizationId: string | null;
      transactionType: string;
      grossAmountMinor: bigint;
      currency: string;
    },
    change: {
      action: StatusChangeAction;
      from: TransactionStatus | null;
      to: TransactionStatus;
      by: string;
      at: Date;
      causationId?: string;
    },
  ): Promise<void> {
    return this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.TRANSACTION_STATUS_CHANGED,
      aggregateId: transaction.id,
      organizationId: transaction.organizationId,
      ...(change.causationId ? { causationId: change.causationId } : {}),
      payload: {
        transactionId: transaction.id,
        organizationId: transaction.organizationId,
        counterpartyOrganizationId: transaction.counterpartyOrganizationId,
        transactionType: transaction.transactionType,
        action: change.action,
        fromStatus: change.from,
        toStatus: change.to,
        grossAmountMinor: formatMinor(transaction.grossAmountMinor),
        currency: transaction.currency,
        changedBy: change.by,
        changedAt: change.at.toISOString(),
      },
    });
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  /**
   * One transaction, visible to its payer and its payee.
   *
   * Read unscoped and then checked explicitly, because a row that names two
   * organizations cannot be authorised by a tenant filter alone — the guard
   * would hide it from the payee, who is legitimately a party to it. The
   * explicit check refuses everyone else with a 404 (docs/09).
   */
  async get(id: string, client?: ExtendedPrismaClient): Promise<TransactionDetail> {
    const transaction = await this.repository.findByIdForParty(id, client);
    // Not logged: a settlement passes the client's body text here, and one that
    // names nothing is just that text (S-09). A path id is in the logged path.
    if (!transaction) throw RastaError.notFound('Transaction');
    assertTransactionVisible(transaction);
    return transaction as unknown as TransactionDetail;
  }

  list(filter: TransactionFilter) {
    return this.repository.list(getOrganizationId(), filter);
  }
}

/**
 * A transaction without a payee — a top-up — attracts no commission and never
 * settles, so there is nothing to price.
 */
const UNPRICED = { pricingOutcome: null, pricingRuleId: null } as const;

/** What a caller asks to do to a transaction — see `TransactionService.authorizeAct`. */
export type TransactionAct = 'READ' | TransactionCommand;

/** The five financial commands made on `/v1/transactions/:id` (settlement is its own resource). */
export type TransactionCommand = Exclude<FinancialCommand, 'SETTLE'>;

type StatusChangeAction =
  | 'CREATE'
  | 'RECORD_AUTHORISED_OBLIGATION'
  | 'AUTHORISE_SETTLEMENT'
  | 'DISPUTE'
  | 'RESOLVE_DISPUTE'
  | 'CANCEL'
  | 'REFUND';

export interface TransactionDetail {
  id: string;
  organizationId: string;
  counterpartyOrganizationId: string | null;
  transactionType: string;
  status: string;
  grossAmountMinor: bigint;
  commissionAmountMinor: bigint;
  netAmountMinor: bigint;
  currency: string;
  occurredAt: Date;
  sourceType: string | null;
  sourceReference: string | null;
  disputedAt: Date | null;
  disputeReason: string | null;
  settledAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  createdBy: string;
  settlementAuthorisedAt: Date | null;
  settlementAuthorisedService: string | null;
  settlementAuthorisationKey: string | null;
  disputeId: string | null;
  legs: {
    id: string;
    organizationId: string;
    role: string;
    amountMinor: bigint;
    currency: string;
  }[];
  commission: { id: string; rateBasisPoints: number; amountMinor: bigint } | null;
  settlement: { id: string; journalId: string; settledAt: Date } | null;
}

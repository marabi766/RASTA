import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { TransactionRepository, type TransactionFilter } from './transaction.repository';
import { nextStatus } from './state-machine';
import { assertTransactionVisible, canCommitOrganization } from '../access/access';
import { parseMinor } from '../shared/money';
import { financialTransactionDuration, transactionsCreatedTotal } from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';
import type { Prisma, TransactionType } from '../generated/prisma';
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
  async create(dto: CreateTransactionDto): Promise<TransactionDetail> {
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

        await this.repository.create(
          tx,
          {
            id,
            organizationId,
            counterpartyOrganizationId: dto.counterpartyOrganizationId ?? null,
            transactionType: dto.transactionType,
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

        return id;
      });

      transactionsCreatedTotal.inc({
        service: SERVICE_NAME,
        type: dto.transactionType,
        source: 'api',
      });

      return this.get(created);
    } finally {
      stop();
    }
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
   * Idempotent on `(sourceType, sourceReference)` in addition to
   * `processed_event`, because a producer that re-emits the same approval
   * under a new event id would otherwise create a second obligation for one
   * repair.
   */
  async recordAuthorisedObligation(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      counterpartyOrganizationId: string;
      transactionType: TransactionType;
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
      input.sourceType,
      input.sourceReference,
    );
    if (existing) return { id: existing.id, created: false };

    const id = `${ID_PREFIXES.transaction}_${ulid()}`;

    await this.repository.create(
      tx,
      {
        id,
        organizationId: input.organizationId,
        counterpartyOrganizationId: input.counterpartyOrganizationId,
        transactionType: input.transactionType,
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
   * At creation both legs carry the gross: the commission split is not known
   * until settlement selects the rule in force, and writing a guess here would
   * be a number nobody computed. The settlement records the actual split on
   * the transaction and on the `commission` row.
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
   */
  async authoriseSettlement(transactionId: string): Promise<TransactionDetail> {
    return this.move(transactionId, 'AUTHORISE_SETTLEMENT', {});
  }

  /**
   * Registers an objection. **Settlement stops completely** (docs/10 § 10.5).
   *
   * There is no timeout that clears it and no automatic resolution: the state
   * machine has no edge from `DISPUTED` to `SETTLED`, only to
   * `PENDING_SETTLEMENT` by an explicit human decision, or to `REFUNDED`.
   */
  async dispute(transactionId: string, dto: DisputeTransactionDto): Promise<TransactionDetail> {
    const actor = getContext().userId ?? SERVICE_NAME;
    return this.move(transactionId, 'DISPUTE', {
      disputedAt: new Date(),
      disputedBy: actor,
      disputeReason: dto.reason,
    });
  }

  /**
   * Resolves a dispute back into the settlement queue.
   *
   * A human decision, recorded with who made it. It does not settle — it only
   * unblocks, so that releasing the money remains a separate, deliberate act.
   */
  async resolveDispute(transactionId: string, dto: ResolveDisputeDto): Promise<TransactionDetail> {
    const actor = getContext().userId ?? SERVICE_NAME;
    return this.move(transactionId, 'RESOLVE_DISPUTE', {
      disputeResolvedAt: new Date(),
      disputeResolvedBy: actor,
      disputeReason: dto.resolution,
    });
  }

  /**
   * Refunds a held transaction to the payer.
   *
   * Posts the refund journal and returns the escrowed funds, then moves the
   * transaction to `REFUNDED` — all in one transaction, so a refund that fails
   * halfway leaves the money exactly where it was.
   */
  async refund(transactionId: string, reason: string): Promise<TransactionDetail> {
    const actor = getContext().userId ?? SERVICE_NAME;
    const stop = financialTransactionDuration.startTimer({
      service: SERVICE_NAME,
      operation: 'refund',
    });

    try {
      await this.prisma.transaction(async (tx) => {
        const transaction = await this.repository.lockForUpdate(tx, transactionId);
        if (!transaction) throw RastaError.notFound('Transaction', transactionId);
        assertTransactionVisible(transaction);

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
        if (hold) {
          await this.wallets.refundHold(tx, {
            wallet: locked,
            holdId: hold.id,
            transactionId,
            note: reason,
            resolvedBy: actor,
          });
        }

        const moved = await this.repository.transition(
          tx,
          transactionId,
          transaction.status,
          target,
          { failureReason: reason },
        );
        if (moved === 0) throw RastaError.optimisticLockFailed('Transaction', transactionId);
      });

      return this.get(transactionId);
    } finally {
      stop();
    }
  }

  /** Cancels a transaction nothing has moved against yet. */
  async cancel(transactionId: string, reason: string): Promise<TransactionDetail> {
    return this.move(transactionId, 'CANCEL', { failureReason: reason });
  }

  /**
   * One guarded state change, with no money movement.
   *
   * Under the row lock so that the read of the current status and the write of
   * the next one are one decision — and with `assertTransactionVisible` so
   * that a caller who is neither payer nor payee gets a 404 rather than
   * discovering the transaction exists.
   */
  private async move(
    transactionId: string,
    event: Parameters<typeof nextStatus>[2],
    extra: Prisma.TransactionUncheckedUpdateManyInput,
  ): Promise<TransactionDetail> {
    await this.prisma.transaction(async (tx) => {
      const transaction = await this.repository.lockForUpdate(tx, transactionId);
      if (!transaction) throw RastaError.notFound('Transaction', transactionId);
      assertTransactionVisible(transaction);
      canCommitOrganization(transaction.organizationId);

      const target = nextStatus(transactionId, transaction.status, event);
      const moved = await this.repository.transition(
        tx,
        transactionId,
        transaction.status,
        target,
        extra,
      );
      if (moved === 0) throw RastaError.optimisticLockFailed('Transaction', transactionId);
    });

    return this.get(transactionId);
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
  async get(id: string): Promise<TransactionDetail> {
    const transaction = await this.repository.findByIdForParty(id);
    if (!transaction) throw RastaError.notFound('Transaction', id);
    assertTransactionVisible(transaction);
    return transaction as unknown as TransactionDetail;
  }

  list(filter: TransactionFilter) {
    return this.repository.list(getOrganizationId(), filter);
  }
}

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

import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { withFinancialSpan } from '@rasta/observability';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletRepository } from '../wallet/wallet.repository';
import {
  TransactionRepository,
  type LockedTransaction,
} from '../transaction/transaction.repository';
import { CommissionService } from '../commission/commission.service';
import { assertSufficient, balancesFrom } from '../wallet/balances';
import { nextStatus } from '../transaction/state-machine';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor } from '../shared/money';
import {
  financialTransactionDuration,
  settlementFailuresTotal,
  settlementsCompletedTotal,
} from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';
import type { DraftEntry } from '../ledger/journal';

/**
 * Settlement — the one operation this whole service is arranged around
 * (docs/10 § 10.10, ADR-031).
 *
 * ## It is one ACID transaction, not a saga
 *
 * docs/10 § 10.10 describes a six-step Temporal workflow and then adds the
 * constraint that changes its shape: **steps 3 and 4 are in one database
 * transaction, and after step 3 there is no automatic compensation.** A
 * process with an atomic core and no compensation is not a saga; orchestrating
 * it would add coordination to something that cannot be coordinated apart.
 *
 * So everything that must be consistent happens between one BEGIN and one
 * COMMIT:
 *
 * ```
 *   lock the transaction row                       ← one settlement, not two
 *   check the state machine                        ← never from DISPUTED
 *   lock both wallets, in ascending id order       ← no deadlock, ever
 *   compute commission at the transaction's date   ← not at today's rate
 *   post ONE balanced journal                      ← escrow → payee + revenue
 *   release the hold                               ← no second journal
 *   recompute both balances from the ledger        ← never incremented
 *   record the commission and the settlement
 *   move the transaction to SETTLED
 *   write SETTLEMENT_COMPLETED to the outbox
 * ```
 *
 * If any step throws, none of them happened. That is what makes "no automatic
 * compensation" safe rather than reckless: there is nothing to compensate.
 *
 * ## Failure leaves the money where it was
 *
 * A failed settlement does **not** refund the hold. docs/08 § 8.6 and docs/10
 * § 10.10 both say so, and the reasoning is that moving money automatically in
 * response to an unexplained failure is a larger risk than the failure. The
 * funds stay in escrow, `rasta_economic_settlement_failures_total` rises, and
 * a person decides.
 *
 * ## The reward step is deliberately outside
 *
 * docs/10 § 10.10: if the reward step fails, the settlement stays valid and
 * the reward is retried separately. Keeping it in a different transaction is
 * what makes that structural rather than aspirational.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
    private readonly walletRepository: WalletRepository,
    private readonly transactions: TransactionRepository,
    private readonly commissions: CommissionService,
  ) {}

  /**
   * Settles one transaction.
   *
   * `settledBy` is the acting user; the caller has already established that
   * they may commit this organization (`access.ts`).
   */
  async settle(transactionId: string, settledBy: string): Promise<SettlementResult> {
    const stop = financialTransactionDuration.startTimer({
      service: SERVICE_NAME,
      operation: 'settle',
    });

    try {
      const result = await withFinancialSpan('economic.settle', () =>
        this.prisma.transaction((tx) => this.settleWithin(tx, transactionId, settledBy)),
      );
      settlementsCompletedTotal.inc({ service: SERVICE_NAME, type: result.transactionType });
      return result;
    } catch (error) {
      settlementFailuresTotal.inc({ service: SERVICE_NAME, reason: reasonOf(error) });
      // No amounts, no counterparties — the correlation id is the handle, and
      // the detail is in the transaction row (AGENTS.md S-09).
      this.logger.warn(
        `Settlement of ${transactionId} failed (${reasonOf(error)}); funds remain held for review`,
      );
      throw error;
    } finally {
      stop();
    }
  }

  private async settleWithin(
    tx: ExtendedPrismaClient,
    transactionId: string,
    settledBy: string,
  ): Promise<SettlementResult> {
    const transaction = await this.transactions.lockForUpdate(tx, transactionId);
    if (!transaction) throw RastaError.notFound('Transaction', transactionId);

    // The state machine is the gate. `PENDING_SETTLEMENT` is only reachable
    // once the authorising fact arrived, and `DISPUTED` has no edge to
    // `SETTLED` at all (docs/10 § 10.5, § 10.12).
    const target = nextStatus(transactionId, transaction.status, 'SETTLE');

    // Hoisted to a local so the narrowing survives the awaits below. A
    // top-up has no counterparty and never reaches settlement; anything else
    // that got here without one is a defect, not a user error.
    const payeeOrganizationId = transaction.counterpartyOrganizationId;
    if (!payeeOrganizationId) {
      throw RastaError.businessRule('This transaction has no counterparty to settle to', {
        transactionId,
      });
    }

    const payerWallet = await this.requireWallet(
      tx,
      transaction.organizationId,
      transaction.currency,
    );
    const payeeWallet = await this.wallets.resolveCounterpartyWallet(
      tx,
      payeeOrganizationId,
      transaction.currency,
    );

    // Ascending id order — the deadlock control (ADR-031).
    const locked = await this.walletRepository.lock(tx, [payerWallet.id, payeeWallet.id]);
    const payer = locked.find((wallet) => wallet.id === payerWallet.id);
    const payee = locked.find((wallet) => wallet.id === payeeWallet.id);
    if (!payer || !payee) throw RastaError.internal('A wallet vanished while locking it');

    const hold = await this.walletRepository.findActiveHold(tx, payer.id, transaction.id);

    // With no escrow behind it — the maintenance obligation of ADR-032 — the
    // payer's spendable balance has to cover it now. Checked under the lock,
    // so the answer is still true when the journal posts.
    if (!hold) {
      assertSufficient(
        payer.id,
        balancesFrom(payer.availableBalanceMinor, payer.pendingBalanceMinor),
        transaction.grossAmountMinor,
      );
    } else if (hold.amountMinor !== transaction.grossAmountMinor) {
      throw RastaError.businessRule(
        'The held amount does not match the transaction amount; settle it manually',
        { transactionId, holdId: hold.id },
      );
    }

    const decision = await this.commissions.decide(tx, {
      organizationId: payeeOrganizationId,
      transactionType: transaction.transactionType,
      occurredAt: transaction.occurredAt,
      grossAmountMinor: transaction.grossAmountMinor,
      currency: transaction.currency,
    });

    const netAmountMinor = transaction.grossAmountMinor - decision.amountMinor;
    if (netAmountMinor < 0n) {
      throw RastaError.businessRule('Commission exceeds the transaction amount', { transactionId });
    }

    const settledAt = new Date();
    const journal = await this.postSettlementJournal(tx, {
      transaction,
      payeeOrganizationId,
      payerHasEscrow: hold !== null,
      commissionMinor: decision.amountMinor,
      netAmountMinor,
      settledBy,
      settledAt,
    });

    if (hold) {
      await this.wallets.markHoldReleased(tx, {
        hold: {
          id: hold.id,
          walletId: hold.walletId,
          organizationId: hold.organizationId,
          amountMinor: hold.amountMinor,
          currency: hold.currency,
          reference: hold.reference,
        },
        settlementJournalId: journal.id,
        transactionId: transaction.id,
        resolvedBy: settledBy,
      });
    }

    await this.walletRepository.recomputeFromLedger(tx, payer);
    await this.walletRepository.recomputeFromLedger(tx, payee);

    await this.commissions.record(tx, {
      transactionId: transaction.id,
      organizationId: payeeOrganizationId,
      decision,
      grossAmountMinor: transaction.grossAmountMinor,
      currency: transaction.currency,
      journalId: journal.id,
      appliedAt: settledAt,
    });

    const settlementId = `STL_${ulid()}`;
    await runUnscoped('a settlement names both counterparties by design', () =>
      tx.settlement.create({
        data: {
          id: settlementId,
          organizationId: transaction.organizationId,
          transactionId: transaction.id,
          journalId: journal.id,
          payerOrganizationId: transaction.organizationId,
          payeeOrganizationId,
          grossAmountMinor: transaction.grossAmountMinor,
          commissionAmountMinor: decision.amountMinor,
          netAmountMinor,
          currency: transaction.currency,
          settledAt,
          settledBy,
        },
      }),
    );

    const moved = await this.transactions.transition(
      tx,
      transaction.id,
      transaction.status,
      target,
      {
        commissionAmountMinor: decision.amountMinor,
        netAmountMinor,
        settledAt,
      },
    );
    if (moved === 0) {
      // Belt and braces under the row lock. If it ever fires, two settlements
      // reached the same transaction and rolling back is the only safe answer.
      throw RastaError.optimisticLockFailed('Transaction', transaction.id);
    }

    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.SETTLEMENT_COMPLETED,
      aggregateId: settlementId,
      organizationId: transaction.organizationId,
      partitionKey: transaction.id,
      payload: {
        settlementId,
        transactionId: transaction.id,
        organizationId: transaction.organizationId,
        payerOrganizationId: transaction.organizationId,
        payeeOrganizationId,
        journalId: journal.id,
        grossAmountMinor: formatMinor(transaction.grossAmountMinor),
        commissionAmountMinor: formatMinor(decision.amountMinor),
        netAmountMinor: formatMinor(netAmountMinor),
        currency: transaction.currency,
        settledAt: settledAt.toISOString(),
      },
    });

    return {
      settlementId,
      transactionId: transaction.id,
      transactionType: transaction.transactionType,
      journalId: journal.id,
      grossAmountMinor: transaction.grossAmountMinor,
      commissionAmountMinor: decision.amountMinor,
      netAmountMinor,
      currency: transaction.currency,
      commissionMatched: decision.matched,
      payeeOrganizationId,
      settledAt,
    };
  }

  /**
   * The settlement journal — one journal, two or three legs.
   *
   * ```
   *   DEBIT   payer ESCROW  (or payer WALLET, with no escrow)   gross
   *   CREDIT  payee WALLET                                      net
   *   CREDIT  platform COMMISSION_REVENUE                       commission
   * ```
   *
   * The commission leg is **omitted entirely when the commission is zero**,
   * rather than posted as a zero. A zero entry breaks
   * `ck_ledger_entry_amount_positive`, and it would assert nothing: "no rule
   * matched" is recorded on the `commission` row, which is where an auditor
   * looks for it.
   *
   * Debiting the wallet directly when there is no escrow is what lets an
   * approved maintenance obligation settle without ever having been held
   * (ADR-032) — the work was done and the amount is owed, so the payer pays it
   * from what they have.
   */
  private async postSettlementJournal(
    tx: ExtendedPrismaClient,
    input: {
      transaction: LockedTransaction;
      payeeOrganizationId: string;
      payerHasEscrow: boolean;
      commissionMinor: bigint;
      netAmountMinor: bigint;
      settledBy: string;
      settledAt: Date;
    },
  ) {
    const { transaction } = input;
    const currency = transaction.currency;

    const source = await this.ledger.resolveAccount(
      tx,
      input.payerHasEscrow ? 'ESCROW' : 'WALLET',
      transaction.organizationId,
      currency,
      input.settledBy,
    );
    const payeeAccount = await this.ledger.resolveAccount(
      tx,
      'WALLET',
      input.payeeOrganizationId,
      currency,
      input.settledBy,
    );

    const entries: DraftEntry[] = [
      {
        accountId: source.id,
        organizationId: source.organizationId,
        direction: 'DEBIT',
        amountMinor: transaction.grossAmountMinor,
        currency,
      },
    ];

    if (input.netAmountMinor > 0n) {
      entries.push({
        accountId: payeeAccount.id,
        organizationId: payeeAccount.organizationId,
        direction: 'CREDIT',
        amountMinor: input.netAmountMinor,
        currency,
      });
    }

    if (input.commissionMinor > 0n) {
      const revenue = await this.ledger.resolveAccount(
        tx,
        'COMMISSION_REVENUE',
        transaction.organizationId,
        currency,
        input.settledBy,
      );
      entries.push({
        accountId: revenue.id,
        organizationId: revenue.organizationId,
        direction: 'CREDIT',
        amountMinor: input.commissionMinor,
        currency,
      });
    }

    return this.ledger.post(
      tx,
      {
        journalType: 'SETTLEMENT',
        description: `Settlement of ${transaction.id}`,
        organizationId: transaction.organizationId,
        transactionId: transaction.id,
        entries,
        postedAt: input.settledAt,
      },
      input.settledBy,
    );
  }

  private async requireWallet(tx: ExtendedPrismaClient, organizationId: string, currency: string) {
    const wallet = await this.walletRepository.findByOrganizationUnscoped(
      tx,
      organizationId,
      currency,
    );
    if (!wallet) {
      throw RastaError.businessRule('The paying organization has no wallet in this currency', {
        organizationId,
        currency,
      });
    }
    return wallet;
  }
}

export interface SettlementResult {
  settlementId: string;
  transactionId: string;
  transactionType: string;
  journalId: string;
  grossAmountMinor: bigint;
  commissionAmountMinor: bigint;
  netAmountMinor: bigint;
  currency: string;
  commissionMatched: boolean;
  payeeOrganizationId: string;
  settledAt: Date;
}

/**
 * A small closed set of failure reasons, for the metric label.
 *
 * Bounded deliberately: a label taken from an error message would have
 * unbounded cardinality and would put amounts and identifiers into Prometheus.
 */
function reasonOf(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'INSUFFICIENT_BALANCE':
      return 'insufficient_balance';
    case 'INVALID_STATE_TRANSITION':
      return 'invalid_state';
    case 'NOT_FOUND':
      return 'not_found';
    case 'BUSINESS_RULE_VIOLATION':
      return 'business_rule';
    case 'LEDGER_UNBALANCED':
      return 'unbalanced';
    case 'OPTIMISTIC_LOCK_FAILED':
      return 'concurrent_settlement';
    default:
      return 'internal';
  }
}

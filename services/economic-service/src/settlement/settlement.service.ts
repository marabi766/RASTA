import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { BUSINESS_LINES, ERROR_CODES, type BusinessLine } from '@rasta/contracts';
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
import type { CommissionDecision, CommissionOutcome } from '../commission/rule-engine';
import { assertSufficient, balancesFrom } from '../wallet/balances';
import { nextStatus } from '../transaction/state-machine';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor } from '../shared/money';
import { after, resolveCursor } from '../shared/cursor';
import { databaseNow } from '../shared/database-clock';
import type { Prisma } from '../generated/prisma';
import {
  financialTransactionDuration,
  settlementFailuresTotal,
  settlementsCompletedTotal,
} from '../observability/metrics';
import { SERVICE_NAME, type EconomicEnv } from '../config/env';
import { ENV } from '../tokens';
import type { DraftEntry } from '../ledger/journal';
import type { IdempotentAnswer } from '../shared/idempotency';
import {
  recordFinancialCommand,
  reconfirmFinancialAuthority,
  settlementBooks,
  type FinancialAuthority,
  type SettlementBooks,
} from '../access/access';
import { OrganizationHierarchy } from '../organization/organization-hierarchy';

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
 *   charge the pricing recorded with the fact      ← not at today's rate
 *     (none recorded, and a line: the rule in force now, or refuse — Q-29)
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
 * ## No rule for the line: refused, not settled at zero (docs/24 Q-29)
 *
 * With `ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE` on — the default outside
 * development and test — a transaction whose business line no active rule
 * prices is not settled: `422 NO_ACTIVE_RULE`, nothing written, the funds where
 * they were, `rasta_economic_settlement_failures_total{reason="no_active_rule"}`
 * and a `SETTLEMENT_REFUSED` record of who tried and why — committed before
 * the 422 is answered, in the same transaction rolled back to its savepoint.
 * Settling it again once a rule for the line is in force succeeds at that
 * rule — a 0% rule included, which is how the pilot runs (Q-08). Every line
 * bears commission until docs/24 Q-130 says otherwise
 * ({@link COMMISSION_BEARING_LINES}). Off —
 * development and test unless turned on — it settles at zero, recorded
 * `NO_ACTIVE_RULE`, as it always has.
 *
 * ## The reward step is deliberately outside
 *
 * docs/10 § 10.10: if the reward step fails, the settlement stays valid.
 * Keeping it in a different transaction is what makes that structural rather
 * than aspirational. The controller runs it after this commits; it is not
 * retried there (see `SettlementController.grantSettlementRewards`).
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
    private readonly hierarchy: OrganizationHierarchy,
    @Inject(ENV) private readonly env: EconomicEnv,
  ) {}

  /**
   * Settles one transaction.
   *
   * `settledBy` is the acting user; the caller has already established that
   * they may commit this organization (`access.ts`). `answer`, for an
   * idempotent request, is stored as its key's answer in the settlement's own
   * transaction, so the money movement and the completed key commit together.
   */
  async settle(
    transactionId: string,
    settledBy: string,
    answer?: IdempotentAnswer<SettlementResult>,
  ): Promise<SettlementResult> {
    const stop = financialTransactionDuration.startTimer({
      service: SERVICE_NAME,
      operation: 'settle',
    });

    try {
      const { settled: result, authority } = await withFinancialSpan(
        'economic.settle',
        async () => {
          const outcome = await this.prisma.transaction(async (tx) => {
            let within: Awaited<ReturnType<SettlementService['settleWithin']>>;
            try {
              within = await this.settleWithin(tx, transactionId, settledBy);
            } catch (error) {
              if (!(error instanceof NoActiveRuleRefusal)) throw error;
              // Undo everything the settlement wrote before it was refused
              // (`settleWithin`'s savepoint), and commit the refusal's record
              // in its place (docs/24 Q-29; review of #364 round 1, F2).
              await tx.$executeRaw`ROLLBACK TO SAVEPOINT settlement_priced`;
              await this.recordRefusal(tx, error, settledBy);
              return { refused: error };
            }
            await answer?.respond(tx, within.settled);
            return within;
          });
          // Only once the refusal's record has committed: no 422 without it.
          if ('refused' in outcome) throw outcome.refused;
          return outcome;
        },
      );
      settlementsCompletedTotal.inc({ service: SERVICE_NAME, type: result.transactionType });
      recordFinancialCommand(transactionId, authority);
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
  ): Promise<{ settled: SettlementResult; authority: FinancialAuthority }> {
    // Until the commission is decided, a refusal for want of a rule
    // (`NoActiveRuleRefusal`, Q-29) rolls back to here and `settle` records it
    // in this same transaction; past it, the savepoint is released below.
    await tx.$executeRaw`SAVEPOINT settlement_priced`;
    const transaction = await this.transactions.lockForUpdate(tx, transactionId);
    if (!transaction) throw RastaError.notFound('Transaction', transactionId);

    // The state machine is the gate. `PENDING_SETTLEMENT` is only reachable
    // once the authorising fact arrived, and `DISPUTED` has no edge to
    // `SETTLED` at all (docs/10 § 10.5, § 10.12).
    const target = nextStatus(transactionId, transaction.status, 'SETTLE');

    // Whose books the journal goes on, when that is not the organization the
    // request acts for: a system administrator acting for another one, or a
    // union administrator for an organization of its union's subtree
    // (docs/23 D-054, docs/24 Q-136). Decided here, under the row lock — the
    // hierarchy question included — against the payer the journal will name;
    // anyone else is refused before anything is written.
    const { authority: lockedRowAuthority, books } = await settlementBooks(
      transaction.organizationId,
      this.hierarchy,
    );

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

    // What was decided when the source fact was recorded (docs/23 D-057);
    // decided now, at `occurredAt`, only for an obligation older than that —
    // and, failing closed where that found no rule, the rule in force now or a
    // refusal (`charge`, docs/24 Q-29).
    const decision = await this.charge(tx, transaction, payeeOrganizationId);
    // Priced: nothing below is refused and recorded, so the savepoint goes.
    // It has to — a journal must be opened by the transaction that posts its
    // entries, read from the journal row's xmin (`trg_journal_has_entries`),
    // and a row inserted under a savepoint carries the subtransaction's.
    await tx.$executeRaw`RELEASE SAVEPOINT settlement_priced`;

    const netAmountMinor = transaction.grossAmountMinor - decision.amountMinor;
    if (netAmountMinor < 0n) {
      throw RastaError.businessRule('Commission exceeds the transaction amount', { transactionId });
    }

    // Every lock this settlement takes is held, and nothing below waits on
    // another: ask the hierarchy again, so a union administrator's authority
    // is the one confirmed after the wallet wait above, immediately before the
    // journal posts (docs/23 D-054; Codex on #314 round 3, F2).
    const authority = await reconfirmFinancialAuthority(lockedRowAuthority, this.hierarchy);

    const settledAt = new Date();
    const journal = await this.postSettlementJournal(tx, {
      transaction,
      payeeOrganizationId,
      payerHasEscrow: hold !== null,
      commissionMinor: decision.amountMinor,
      netAmountMinor,
      settledBy,
      settledAt,
      books,
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
      transactionType: transaction.transactionType,
      businessLine: transaction.businessLine,
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
          // Who acted is `settledBy`; this is whom for. The payer itself, or
          // the organization a platform administrator acted for (D-054, Q-136).
          actingOrganizationId: authority.actingOrganizationId,
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
      settled: {
        settlementId,
        transactionId: transaction.id,
        transactionType: transaction.transactionType,
        journalId: journal.id,
        grossAmountMinor: transaction.grossAmountMinor,
        commissionAmountMinor: decision.amountMinor,
        netAmountMinor,
        currency: transaction.currency,
        commissionMatched: decision.matched,
        commissionOutcome: decision.outcome,
        businessLine: transaction.businessLine,
        payeeOrganizationId,
        settledAt,
      },
      authority,
    };
  }

  /**
   * The commission this settlement charges, or the fail-closed refusal
   * (docs/24 Q-29).
   *
   * The pricing recorded with the fact decides (docs/23 D-057). When it found
   * no rule, the transaction has a line and the policy is on, the rule in
   * force for the line now decides instead ({@link CommissionService.decideAtSettlement}),
   * in this transaction and under the pricing lock — and with none, nothing is
   * settled. A transaction recorded without a line is not refused: no rule can
   * be written for one any more (D-057), so it could never settle.
   */
  private async charge(
    tx: ExtendedPrismaClient,
    transaction: LockedTransaction,
    payeeOrganizationId: string,
  ): Promise<CommissionDecision> {
    const recorded = await this.commissions.chargeFor(tx, {
      organizationId: payeeOrganizationId,
      transactionType: transaction.transactionType,
      businessLine: transaction.businessLine,
      occurredAt: transaction.occurredAt,
      grossAmountMinor: transaction.grossAmountMinor,
      currency: transaction.currency,
      pricingOutcome: transaction.pricingOutcome,
      pricingRuleId: transaction.pricingRuleId,
    });
    const line = transaction.businessLine;
    if (recorded.matched || !this.requiresRule(line)) return recorded;

    const now = await this.commissions.decideAtSettlement(tx, {
      organizationId: payeeOrganizationId,
      transactionType: transaction.transactionType,
      businessLine: line,
      grossAmountMinor: transaction.grossAmountMinor,
      currency: transaction.currency,
    });
    if (now.matched) return now;
    throw new NoActiveRuleRefusal({
      transactionId: transaction.id,
      organizationId: transaction.organizationId,
      payeeOrganizationId,
      transactionType: transaction.transactionType,
      businessLine: line,
    });
  }

  /** Whether a settlement of this line must find a rule (Q-29): the policy is on and the line bears commission. */
  private requiresRule(line: BusinessLine | null): line is BusinessLine {
    return (
      this.env.ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE &&
      line !== null &&
      COMMISSION_BEARING_LINES.has(line)
    );
  }

  /**
   * The audit record of a refused settlement (`SETTLEMENT_REFUSED`), written
   * in the settlement's own transaction once everything the settlement wrote
   * has been rolled back to its savepoint — so the record and the refusal are
   * one commit. The 422 is answered only after that commit: a record that
   * cannot be written (the outbox, the connection, the process) fails the
   * whole request with a 5xx and nothing at all committed, and the settlement
   * can be retried under the same key — the refusal was never stored as its
   * answer. Each committed record is one refused attempt; nothing here
   * retries, so none is written twice (review of #364 round 1, F2).
   */
  private async recordRefusal(
    tx: ExtendedPrismaClient,
    refusal: NoActiveRuleRefusal,
    refusedBy: string,
  ): Promise<void> {
    const { subject } = refusal;
    const refusedAt = await databaseNow(tx);
    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.SETTLEMENT_REFUSED,
      aggregateId: subject.transactionId,
      organizationId: subject.organizationId,
      payload: {
        transactionId: subject.transactionId,
        organizationId: subject.organizationId,
        payerOrganizationId: subject.organizationId,
        payeeOrganizationId: subject.payeeOrganizationId,
        transactionType: subject.transactionType,
        businessLine: subject.businessLine,
        reason: 'NO_ACTIVE_RULE',
        refusedBy,
        refusedAt: refusedAt.toISOString(),
      },
    });
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
      books: SettlementBooks | undefined;
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
      input.books,
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

  /**
   * One page of the settlements this organization paid, or — `incoming` — was
   * paid, newest first.
   *
   * `settlement.organization_id` is the **payer**, so the tenant guard alone
   * answers only "what did I pay". The payee view has to cross it — ANDing
   * the guard's filter with a payee filter would ask for a settlement whose
   * payer and payee are the same organization, which
   * `ck_settlement_distinct_parties` makes impossible, so it would always
   * return nothing. The crossing is narrowed to exactly the caller's own id on
   * the payee column, so it can only ever return settlements the caller was
   * party to.
   *
   * The cursor is resolved with that **same** scope before the page is read
   * (`shared/cursor.ts`): a settlement of another organization, one that does
   * not exist, and the caller's own settlement from the other view are all
   * refused alike, rather than the first returning older rows and the second
   * none.
   */
  async list(
    organizationId: string,
    params: { incoming: boolean; limit: number; cursor?: string },
  ): Promise<SettlementRow[]> {
    const scope: Prisma.SettlementWhereInput = params.incoming
      ? { payeeOrganizationId: organizationId }
      : { organizationId };

    const read = async (): Promise<SettlementRow[]> => {
      const boundary = await resolveCursor(params.cursor, (id) =>
        this.prisma.client.settlement
          .findFirst({ where: { AND: [scope, { id }] }, select: { id: true, settledAt: true } })
          .then((row) => (row ? { at: row.settledAt, id: row.id } : null)),
      );
      return this.prisma.client.settlement.findMany({
        where: boundary ? { AND: [scope, after('settledAt', boundary)] } : scope,
        orderBy: [{ settledAt: 'desc' }, { id: 'desc' }],
        take: params.limit,
      });
    };

    return params.incoming
      ? runUnscoped(
          'a payee reads settlements where it is the counterparty, narrowed to its own id',
          read,
        )
      : read();
  }
}

export type SettlementRow = Prisma.SettlementGetPayload<Record<string, never>>;

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
  /** `RULE_APPLIED`, or `NO_ACTIVE_RULE` (ADR-045 § 2). */
  commissionOutcome: CommissionOutcome;
  businessLine: string | null;
  payeeOrganizationId: string;
  settledAt: Date;
}

/**
 * The business lines that bear commission, so that settling one without an
 * active rule is refused (docs/24 Q-29): **all of them**, until docs/24 Q-130
 * says which do not. Answering it is narrowing this set — and the docs/24 entry
 * of each line taken out.
 */
export const COMMISSION_BEARING_LINES: ReadonlySet<BusinessLine> = new Set(BUSINESS_LINES);

/** The fixed text of the refusal; nothing of the request is in it (S-09). */
export const NO_ACTIVE_RULE_MESSAGE =
  'No active commission rule covers this transaction’s business line, so it was not settled and nothing moved. ' +
  'Settle it again once a rule for the line — a 0% rule included — is in force';

/**
 * A settlement refused for want of a rule (docs/24 Q-29): `422 NO_ACTIVE_RULE`.
 * Carries whose transaction and which line, for the refusal's audit record;
 * the client sees the fixed message only.
 */
export class NoActiveRuleRefusal extends RastaError {
  constructor(
    readonly subject: {
      transactionId: string;
      organizationId: string;
      payeeOrganizationId: string;
      transactionType: string;
      businessLine: BusinessLine;
    },
  ) {
    super(ERROR_CODES.NO_ACTIVE_RULE, NO_ACTIVE_RULE_MESSAGE, {
      internalContext: {
        transactionId: subject.transactionId,
        businessLine: subject.businessLine,
        transactionType: subject.transactionType,
      },
    });
  }
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
    case 'NO_ACTIVE_RULE':
      return 'no_active_rule';
    case 'OPTIMISTIC_LOCK_FAILED':
      return 'concurrent_settlement';
    default:
      return 'internal';
  }
}

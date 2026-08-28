import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerRepository } from './ledger.repository';
import { accountCodeFor, isPlatformPurpose, naturalBalance, PURPOSE_TYPE } from './accounts';
import { assertBalanced, reverseEntries, singleCurrency, type DraftEntry } from './journal';
import { formatMinor } from '../shared/money';
import { ledgerEntriesTotal, journalsPostedTotal } from '../observability/metrics';
import { ENV, LOGGER } from '../tokens';
import { ECONOMIC_TOPIC, SERVICE_NAME, type EconomicEnv } from '../config/env';
import { ECONOMIC_EVENTS, validateEconomicPayload } from '../events/events';
import { buildOutboxRow } from '@rasta/nest-common';
import type { Logger as StructuredLogger } from '@rasta/logging';
import type { AccountPurpose, JournalType } from '../generated/prisma';

/**
 * The ledger — the platform's source of financial truth (ADR-013).
 *
 * Everything this service does reduces to one operation: **post a balanced
 * journal, atomically, inside somebody else's transaction**. It never opens a
 * transaction of its own on the posting path, because a journal is always part
 * of a larger act — a hold, a settlement, a reward — and the whole act is what
 * has to be atomic (ADR-031).
 *
 * ## Why `post` takes a `tx` and returns entries rather than writing an event
 *
 * `JOURNAL_POSTED` is written to the outbox inside the same transaction, so a
 * journal that rolls back cannot announce itself and a journal that commits
 * cannot fail to (ADR-021). Publishing after the fact would reintroduce
 * exactly the gap the outbox exists to close.
 *
 * ## Correction
 *
 * There is no update and no delete. A wrong journal is corrected by posting a
 * reversal — the same entries with opposite directions — and then, separately,
 * posting the right one. The database refuses anything else
 * (`trg_ledger_entry_immutable`), so this is not a convention that can erode.
 */
@Injectable()
export class LedgerService {
  private readonly nestLogger = new Logger(LedgerService.name);

  constructor(
    private readonly repository: LedgerRepository,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: EconomicEnv,
    @Inject(LOGGER) private readonly logger: StructuredLogger,
  ) {}

  // ==========================================================================
  // Accounts
  // ==========================================================================

  /**
   * The organization that owns a given account purpose.
   *
   * Wallet accounts belong to the tenant; everything else belongs to the
   * configured platform organization. Reading it from configuration rather
   * than from a constant is what keeps the platform organization-agnostic
   * (AGENTS.md A-05) — nothing here knows or cares that the operator happens
   * to be a union.
   */
  ownerOf(purpose: AccountPurpose, tenantOrganizationId: string): string {
    return isPlatformPurpose(purpose)
      ? this.env.ECONOMIC_PLATFORM_ORGANIZATION_ID
      : tenantOrganizationId;
  }

  /**
   * Resolves an account, creating it on first use.
   *
   * Accounts are created through this controlled path only — there is no
   * "create an arbitrary account" endpoint. A chart of accounts that anyone
   * can extend at runtime is a chart of accounts nobody can reconcile, and
   * every account this platform needs is implied by a purpose in the enum.
   */
  async resolveAccount(
    tx: ExtendedPrismaClient,
    purpose: AccountPurpose,
    tenantOrganizationId: string,
    currency: string,
    createdBy: string,
  ) {
    const organizationId = this.ownerOf(purpose, tenantOrganizationId);
    return this.repository.ensureAccount(tx, {
      id: `${ID_PREFIXES.ledgerAccount}_${ulid()}`,
      organizationId,
      accountType: PURPOSE_TYPE[purpose],
      accountCode: accountCodeFor(purpose, organizationId, currency),
      purpose,
      currency,
      createdBy,
    });
  }

  /**
   * Ensures the platform's own accounts exist.
   *
   * Called at boot so that the first top-up of the day is not also the first
   * time an escrow account has ever been needed. It is idempotent and cheap;
   * the lazy path in {@link resolveAccount} still covers a currency added
   * later.
   */
  async ensurePlatformAccounts(currency = 'IRR'): Promise<void> {
    const platform = this.env.ECONOMIC_PLATFORM_ORGANIZATION_ID;
    // `ESCROW` is deliberately absent: escrow accounts belong to the paying
    // organization, not to the platform (ADR-034), so they are created with
    // the wallet that will use them rather than here.
    const purposes: AccountPurpose[] = ['COMMISSION_REVENUE', 'REWARD_EXPENSE', 'PAYMENT_CLEARING'];

    for (const purpose of purposes) {
      await this.prisma.transaction((tx) =>
        this.repository.ensureAccount(tx, {
          id: `${ID_PREFIXES.ledgerAccount}_${ulid()}`,
          organizationId: platform,
          accountType: PURPOSE_TYPE[purpose],
          accountCode: accountCodeFor(purpose, platform, currency),
          purpose,
          currency,
          title: `platform ${purpose.toLowerCase().replace('_', ' ')}`,
          createdBy: SERVICE_NAME,
        }),
      );
    }

    this.nestLogger.log(`Platform ledger accounts ready for ${platform} (${currency})`);
  }

  // ==========================================================================
  // Posting
  // ==========================================================================

  /**
   * Posts a balanced journal inside the caller's transaction.
   *
   * The order of operations is deliberate:
   *
   *   1. refuse an unbalanced or single-legged journal here, so the caller
   *      gets `LEDGER_UNBALANCED` (422) rather than a driver error;
   *   2. write the journal header and its entries;
   *   3. write `JOURNAL_POSTED` to the outbox in the same transaction.
   *
   * The database re-checks the balance at COMMIT through
   * `trg_journal_balanced`. That is not redundancy for its own sake: step 1
   * protects the caller's experience, and the trigger protects the ledger from
   * any future code path that forgets to call this method.
   */
  async post(
    tx: ExtendedPrismaClient,
    draft: {
      journalType: JournalType;
      description: string;
      organizationId: string;
      transactionId?: string | null;
      entries: DraftEntry[];
      postedAt?: Date;
      reverses?: { journalId: string; reason: string };
    },
    postedBy: string,
  ): Promise<PostedJournal> {
    const journalId = `${ID_PREFIXES.journal}_${ulid()}`;
    const postedAt = draft.postedAt ?? new Date();

    assertBalanced(journalId, draft.entries);
    const currency = singleCurrency(journalId, draft.entries);

    const correlationId = getContext().correlationId;

    await this.repository.createJournal(tx, {
      id: journalId,
      organizationId: draft.organizationId,
      transactionId: draft.transactionId ?? null,
      journalType: draft.reverses ? 'REVERSAL' : draft.journalType,
      description: draft.description,
      postedAt,
      postedBy,
      reversesId: draft.reverses?.journalId ?? null,
      reversalReason: draft.reverses?.reason ?? null,
      correlationId,
    });

    const rows = draft.entries.map((entry) => ({
      id: `${ID_PREFIXES.ledgerEntry}_${ulid()}`,
      journalId,
      accountId: entry.accountId,
      organizationId: entry.organizationId,
      direction: entry.direction,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      postedAt,
    }));

    await this.repository.createEntries(tx, rows);

    await this.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.JOURNAL_POSTED,
      aggregateId: journalId,
      organizationId: draft.organizationId,
      payload: {
        journalId,
        organizationId: draft.organizationId,
        transactionId: draft.transactionId ?? null,
        journalType: draft.reverses ? 'REVERSAL' : draft.journalType,
        currency,
        postedAt: postedAt.toISOString(),
        reversesJournalId: draft.reverses?.journalId ?? null,
        entries: rows.map((row) => ({
          accountId: row.accountId,
          organizationId: row.organizationId,
          direction: row.direction,
          amountMinor: formatMinor(row.amountMinor),
          currency: row.currency,
        })),
      },
    });

    journalsPostedTotal.inc({
      service: SERVICE_NAME,
      type: draft.reverses ? 'REVERSAL' : draft.journalType,
    });
    ledgerEntriesTotal.inc({ service: SERVICE_NAME }, rows.length);

    return { id: journalId, postedAt, currency, entries: rows };
  }

  /**
   * Reverses a posted journal (AGENTS.md A-06).
   *
   * Mirrors every leg with the opposite direction, so the affected accounts
   * return to exactly the balances they had before the original — without a
   * single row of history changing. `reverses_id` is UNIQUE, so a second
   * concurrent attempt is refused by the database rather than by a check that
   * two requests can both pass.
   *
   * What it deliberately does **not** do is post the corrected journal. That is
   * a separate act by a caller who knows what the correct figures are; folding
   * the two together would produce one journal that both undoes and redoes,
   * and no reader could tell which half was the mistake.
   *
   * Nor does it touch wallet balances. A reversal is a ledger operation; the
   * caller that knows which wallets were affected recomputes them from the
   * ledger in the same transaction — see `WalletService.recomputeFromLedger`.
   */
  async reverse(
    tx: ExtendedPrismaClient,
    journalId: string,
    reason: string,
    postedBy: string,
  ): Promise<PostedJournal> {
    const original = await this.repository.findJournalForReversal(tx, journalId);
    if (!original) throw RastaError.notFound('Journal', journalId);

    if (original.journalType === 'REVERSAL') {
      throw RastaError.businessRule(
        'A reversal journal cannot itself be reversed; post the original entries again instead',
        { journalId },
      );
    }

    const already = await this.repository.findReversalOf(tx, journalId);
    if (already) {
      throw RastaError.alreadyExists('Reversal of this journal', already.id);
    }

    return this.post(
      tx,
      {
        journalType: 'REVERSAL',
        description: `Reversal of ${journalId}`,
        organizationId: original.organizationId,
        transactionId: original.transactionId,
        entries: reverseEntries(
          original.entries.map((entry) => ({
            accountId: entry.accountId,
            organizationId: entry.organizationId,
            direction: entry.direction,
            amountMinor: entry.amountMinor,
            currency: entry.currency,
          })),
        ),
        reverses: { journalId, reason },
      },
      postedBy,
    );
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  /**
   * One journal with its entries.
   *
   * Tenant-scoped, so a journal belonging to another organization is a 404 —
   * never a 403, which would confirm that it exists (docs/09).
   */
  async getJournal(id: string) {
    const journal = await this.repository.findJournal(id);
    if (!journal) throw RastaError.notFound('Journal', id);
    return journal;
  }

  async getAccount(id: string) {
    const account = await this.repository.findAccount(id);
    if (!account) throw RastaError.notFound('LedgerAccount', id);
    return account;
  }

  listAccounts() {
    return this.repository.listAccounts(getOrganizationId());
  }

  /** One account's statement. The account is resolved first, so a foreign
   *  account id is refused before any entry is read. */
  async listEntries(accountId: string, cursor: string | undefined, limit: number) {
    await this.getAccount(accountId);
    return this.repository.listEntries({ accountId, cursor, limit });
  }

  /**
   * The trial balance — every account, its balance, and the proof that debits
   * equal credits (docs/10 § 10.13).
   *
   * Platform-wide by design. A per-tenant "trial balance" would not balance
   * and would be actively misleading: a settlement's counterparty and
   * commission legs belong to other organizations, so one tenant's slice of
   * the ledger is genuinely lopsided. The caller must therefore hold a
   * platform role, which `ledger.controller.ts` and the gateway both enforce,
   * and `access.ts` states in one place.
   */
  async trialBalance(currency: string) {
    const totals = (await this.repository.accountTotals()).filter(
      (row) => row.currency === currency,
    );
    const accounts = await this.repository.accountsByIds(totals.map((row) => row.accountId));
    const byId = new Map(accounts.map((account) => [account.id, account]));

    let debitTotal = 0n;
    let creditTotal = 0n;

    const lines = totals
      .map((row) => {
        const account = byId.get(row.accountId);
        debitTotal += row.debitMinor;
        creditTotal += row.creditMinor;
        return {
          accountId: row.accountId,
          accountCode: account?.accountCode ?? '(unknown)',
          accountType: account?.accountType ?? 'ASSET',
          organizationId: account?.organizationId ?? '(unknown)',
          currency: row.currency,
          debitMinor: formatMinor(row.debitMinor),
          creditMinor: formatMinor(row.creditMinor),
          balanceMinor: formatMinor(
            naturalBalance(account?.accountType ?? 'ASSET', row.debitMinor, row.creditMinor),
          ),
        };
      })
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

    const balanced = debitTotal === creditTotal;

    if (!balanced) {
      // Loud, because this is the alarm docs/10 § 10.3 calls a critical alert.
      // No amounts in the message: the figures are in the response body, and
      // a log line is not the place for a tenant's balances (AGENTS.md S-09).
      this.logger.error(
        { currency, accounts: lines.length },
        'Trial balance does not balance — ledger integrity alarm',
      );
    }

    return {
      currency,
      totalDebitMinor: formatMinor(debitTotal),
      totalCreditMinor: formatMinor(creditTotal),
      balanced,
      accounts: lines,
    };
  }

  /**
   * Recomputes one account's balance directly from its entries.
   *
   * Used by the wallet/ledger reconciliation. It is the definition of
   * `wallet.ledgerBalanceMinor`, so the two can be compared meaningfully
   * (docs/10 § 10.3).
   */
  async balanceOf(accountId: string, accountType: Parameters<typeof naturalBalance>[0]) {
    const { debitMinor, creditMinor } = await this.repository.accountBalance(accountId);
    return naturalBalance(accountType, debitMinor, creditMinor);
  }

  // ==========================================================================
  // Outbox
  // ==========================================================================

  /**
   * Writes one event to the outbox inside the caller's transaction.
   *
   * Shared with the other modules through this method rather than duplicated,
   * so that publish-time validation happens exactly once for every event this
   * service emits (docs/07 § 7.8) — a malformed payload is refused before it
   * enters the log, rather than discovered in someone else's dead-letter topic.
   *
   * The partition key is the aggregate id, so events about one journal, one
   * wallet or one transaction stay in order (ADR-006).
   */
  async enqueue(
    tx: ExtendedPrismaClient,
    input: {
      eventName: (typeof ECONOMIC_EVENTS)[keyof typeof ECONOMIC_EVENTS];
      aggregateId: string;
      organizationId: string;
      payload: unknown;
      causationId?: string;
      partitionKey?: string;
    },
  ): Promise<void> {
    const payload = validateEconomicPayload(input.eventName, input.payload);

    const row = buildOutboxRow(
      {
        aggregateType: AGGREGATE_OF[input.eventName],
        aggregateId: input.aggregateId,
        eventName: input.eventName,
        topic: ECONOMIC_TOPIC,
        payload,
        organizationId: input.organizationId,
        partitionKey: input.partitionKey ?? input.aggregateId,
        ...(input.causationId ? { causationId: input.causationId } : {}),
      },
      { producer: SERVICE_NAME, producerVersion: this.env.SERVICE_VERSION },
    );

    await runUnscoped('the outbox is platform plumbing and carries its own tenant column', () =>
      tx.outboxMessage.create({
        data: {
          id: row.id,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          eventName: row.eventName,
          eventVersion: row.eventVersion,
          topic: row.topic,
          partitionKey: row.partitionKey,
          payload: row.payload as object,
          headers: row.headers,
          organizationId: row.organizationId,
          correlationId: row.correlationId,
          createdAt: row.createdAt,
        },
      }),
    );
  }
}

/**
 * The aggregate each event is *about*.
 *
 * Stated once here rather than at each call site, because the aggregate type
 * and the partition key together are what give a consumer ordering guarantees,
 * and getting them inconsistent across call sites is the kind of defect that
 * only shows up under load.
 */
const AGGREGATE_OF: Record<string, string> = {
  WALLET_OPENED: 'Wallet',
  FUNDS_HELD: 'WalletHold',
  FUNDS_RELEASED: 'WalletHold',
  PAYMENT_AUTHORIZED: 'PaymentIntent',
  PAYMENT_COMPLETED: 'PaymentIntent',
  PAYMENT_FAILED: 'PaymentIntent',
  COMMISSION_APPLIED: 'Commission',
  REWARD_GRANTED: 'Reward',
  REWARD_LEVEL_CHANGED: 'RewardBalance',
  SETTLEMENT_COMPLETED: 'Settlement',
  JOURNAL_POSTED: 'Journal',
};

export interface PostedJournal {
  id: string;
  postedAt: Date;
  currency: string;
  entries: {
    id: string;
    accountId: string;
    organizationId: string;
    direction: 'DEBIT' | 'CREDIT';
    amountMinor: bigint;
    currency: string;
  }[];
}

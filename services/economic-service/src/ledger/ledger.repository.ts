import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { AccountPurpose, Prisma } from '../generated/prisma';

/**
 * Ledger persistence.
 *
 * Two things here are worth reading before changing anything.
 *
 * **Every write takes an explicit `tx`.** Nothing in this file opens its own
 * transaction, because a journal is never the whole of what a caller is doing:
 * it is posted alongside a wallet update, a hold, a commission row and an
 * outbox message, and all of those either happen together or not at all
 * (ADR-031). A method that quietly opened its own transaction would break that
 * atomicity in a way no test of this file alone would notice.
 *
 * **Cross-organization writes go through `runUnscoped`.** A settlement journal
 * has legs belonging to the payer, the payee and the platform. The tenant
 * guard *throws* when a create names an organization other than the request's
 * (`applyTenant`), which is the right default — so the one place that
 * legitimately spans tenants says so, with a written reason, and is greppable.
 * The database still refuses a leg whose organization does not match its
 * account, through `fk_ledger_entry_account_identity`.
 */
@Injectable()
export class LedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client(): ExtendedPrismaClient {
    return this.prisma.client;
  }

  // ==========================================================================
  // Accounts
  // ==========================================================================

  /**
   * Finds an account by its purpose, creating it if it does not exist.
   *
   * Runs unscoped because platform accounts — escrow, commission revenue,
   * reward expense, payment clearing — belong to the configured platform
   * organization rather than to whichever tenant's request triggered the
   * posting. A wallet account goes through the same path so there is one
   * implementation of "find or create an account" rather than two that can
   * drift.
   *
   * Concurrency: two requests can both find nothing and both attempt the
   * insert. The loser gets a unique violation on
   * `(organization_id, purpose, currency)` and re-reads, rather than the
   * platform ending up with two escrow accounts — which would make the trial
   * balance correct and the escrow balance meaningless.
   */
  async ensureAccount(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      accountType: Prisma.LedgerAccountCreateInput['accountType'];
      accountCode: string;
      purpose: AccountPurpose;
      currency: string;
      title?: string | null;
      createdBy: string;
    },
  ): Promise<{ id: string; organizationId: string; currency: string; accountType: string }> {
    const reason = 'ledger accounts span the platform organization and every tenant it serves';

    const existing = await runUnscoped(reason, () =>
      tx.ledgerAccount.findUnique({
        where: {
          organizationId_purpose_currency: {
            organizationId: input.organizationId,
            purpose: input.purpose,
            currency: input.currency,
          },
        },
        select: { id: true, organizationId: true, currency: true, accountType: true },
      }),
    );
    if (existing) return existing;

    try {
      return await runUnscoped(reason, () =>
        tx.ledgerAccount.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            accountType: input.accountType,
            accountCode: input.accountCode,
            purpose: input.purpose,
            currency: input.currency,
            title: input.title ?? null,
            createdBy: input.createdBy,
          },
          select: { id: true, organizationId: true, currency: true, accountType: true },
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Someone else created it between the read and the write. Their row is
      // as good as ours would have been.
      const raced = await runUnscoped(reason, () =>
        tx.ledgerAccount.findUniqueOrThrow({
          where: {
            organizationId_purpose_currency: {
              organizationId: input.organizationId,
              purpose: input.purpose,
              currency: input.currency,
            },
          },
          select: { id: true, organizationId: true, currency: true, accountType: true },
        }),
      );
      return raced;
    }
  }

  /** The caller's own accounts. Tenant-scoped by the guard. */
  listAccounts(organizationId: string) {
    return this.client.ledgerAccount.findMany({
      where: { organizationId },
      orderBy: [{ accountType: 'asc' }, { accountCode: 'asc' }],
    });
  }

  findAccount(id: string) {
    return this.client.ledgerAccount.findUnique({ where: { id } });
  }

  // ==========================================================================
  // Journals and entries
  // ==========================================================================

  createJournal(
    tx: ExtendedPrismaClient,
    data: {
      id: string;
      organizationId: string;
      transactionId?: string | null;
      journalType: Prisma.JournalCreateInput['journalType'];
      description: string;
      postedAt: Date;
      postedBy: string;
      reversesId?: string | null;
      reversalReason?: string | null;
      correlationId: string;
    },
  ) {
    // The journal header carries the initiating tenant, so this one is scoped
    // normally — the guard will inject the same value the caller passed.
    return tx.journal.create({ data });
  }

  createEntries(
    tx: ExtendedPrismaClient,
    entries: readonly {
      id: string;
      journalId: string;
      accountId: string;
      organizationId: string;
      direction: Prisma.LedgerEntryCreateManyInput['direction'];
      amountMinor: bigint;
      currency: string;
      postedAt: Date;
    }[],
  ) {
    return runUnscoped('a journal legitimately spans payer, payee and platform organizations', () =>
      tx.ledgerEntry.createMany({ data: [...entries] }),
    );
  }

  findJournal(id: string) {
    return this.client.journal.findUnique({
      where: { id },
      include: { entries: { orderBy: { id: 'asc' } } },
    });
  }

  /**
   * The journal that reverses this one, if any.
   *
   * `reverses_id` is UNIQUE, so this is at most one row — and that uniqueness
   * is what makes "reverse it twice" a database refusal rather than an
   * application race.
   */
  findReversalOf(tx: ExtendedPrismaClient, journalId: string) {
    return runUnscoped(
      'a reversal may be posted by the platform on behalf of either counterparty',
      () => tx.journal.findUnique({ where: { reversesId: journalId }, select: { id: true } }),
    );
  }

  /** The journal, with its entries, for reversal. Unscoped for the same reason. */
  findJournalForReversal(tx: ExtendedPrismaClient, id: string) {
    return runUnscoped('a reversal must mirror every leg, including counterparty legs', () =>
      tx.journal.findUnique({ where: { id }, include: { entries: true } }),
    );
  }

  /**
   * One account's statement, newest first, cursor-paginated.
   *
   * Reads `ledger_entry` rather than joining through `journal`, because the
   * index that exists for it — `(account_id, posted_at DESC)` — is the one
   * docs/05 § 5.5 justifies with this exact query.
   */
  async listEntries(params: {
    accountId: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: LedgerEntryRow[]; nextCursor: string | null; hasMore: boolean }> {
    const rows = await this.client.ledgerEntry.findMany({
      where: { accountId: params.accountId },
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      include: {
        journal: { select: { journalType: true, description: true, transactionId: true } },
      },
    });

    const hasMore = rows.length > params.limit;
    const items = hasMore ? rows.slice(0, params.limit) : rows;
    return {
      items: items as LedgerEntryRow[],
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  /**
   * Debit and credit totals per account.
   *
   * `organizationId` narrows it to one tenant; omitting it is the platform-wide
   * trial balance and requires the caller to have already established that the
   * requester may see it (`ledger.service.ts`). The unscoped reason names that
   * check so the two cannot be read apart.
   */
  async accountTotals(organizationId?: string): Promise<AccountTotals[]> {
    const run = () =>
      this.client.ledgerEntry.groupBy({
        by: ['accountId', 'direction', 'currency'],
        ...(organizationId ? { where: { organizationId } } : {}),
        _sum: { amountMinor: true },
      });

    const grouped = organizationId
      ? await run()
      : await runUnscoped(
          'the platform trial balance is a cross-tenant report, restricted to platform roles',
          run,
        );

    const totals = new Map<string, AccountTotals>();
    for (const row of grouped) {
      const key = `${row.accountId}|${row.currency}`;
      const entry = totals.get(key) ?? {
        accountId: row.accountId,
        currency: row.currency,
        debitMinor: 0n,
        creditMinor: 0n,
      };
      const sum = row._sum.amountMinor ?? 0n;
      if (row.direction === 'DEBIT') entry.debitMinor += sum;
      else entry.creditMinor += sum;
      totals.set(key, entry);
    }
    return [...totals.values()];
  }

  /** Account metadata for a set of ids, for rendering a trial balance. */
  accountsByIds(ids: readonly string[], organizationId?: string) {
    const run = () =>
      this.client.ledgerAccount.findMany({
        where: { id: { in: [...ids] }, ...(organizationId ? { organizationId } : {}) },
      });

    return organizationId
      ? run()
      : runUnscoped(
          'the platform trial balance is a cross-tenant report, restricted to platform roles',
          run,
        );
  }

  /**
   * Sum of ledger entries on one account, in its natural direction.
   *
   * The figure `wallet.ledger_balance_minor` must equal, and the one the daily
   * reconciliation recomputes (docs/10 § 10.3). Unscoped because the audit runs
   * on a timer with no request context.
   */
  async accountBalance(accountId: string): Promise<{ debitMinor: bigint; creditMinor: bigint }> {
    const grouped = await runUnscoped(
      'the ledger/wallet reconciliation runs on a timer with no request context',
      () =>
        this.client.ledgerEntry.groupBy({
          by: ['direction'],
          where: { accountId },
          _sum: { amountMinor: true },
        }),
    );

    let debitMinor = 0n;
    let creditMinor = 0n;
    for (const row of grouped) {
      if (row.direction === 'DEBIT') debitMinor += row._sum.amountMinor ?? 0n;
      else creditMinor += row._sum.amountMinor ?? 0n;
    }
    return { debitMinor, creditMinor };
  }
}

export interface AccountTotals {
  accountId: string;
  currency: string;
  debitMinor: bigint;
  creditMinor: bigint;
}

export interface LedgerEntryRow {
  id: string;
  journalId: string;
  accountId: string;
  organizationId: string;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: bigint;
  currency: string;
  postedAt: Date;
  journal: { journalType: string; description: string; transactionId: string | null };
}

/**
 * Whether an error is a Prisma unique-constraint violation.
 *
 * Structural rather than `instanceof PrismaClientKnownRequestError`: each
 * service generates its own client (ADR-005), and an `instanceof` check against
 * one of them fails silently when the error crosses a package boundary — which
 * is exactly when a caller most needs it to work.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

/** The constraint a unique violation names, when the driver reports one. */
export function violatedConstraint(error: unknown): string | undefined {
  const meta = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (typeof meta === 'string') return meta;
  if (Array.isArray(meta)) return meta.join(',');
  return undefined;
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { balancesFrom, type Balances } from './balances';

/**
 * Wallet persistence, and the concurrency control the whole domain rests on.
 *
 * Two methods here are the reason this file exists rather than the queries
 * living in the service: {@link lock} and {@link recomputeFromLedger}. Both are
 * raw SQL, and both are raw SQL for reasons that are not about performance.
 */
@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client(): ExtendedPrismaClient {
    return this.prisma.client;
  }

  // ==========================================================================
  // Locking
  // ==========================================================================

  /**
   * Takes a row lock on each wallet, in ascending id order.
   *
   * **Ascending id order is the deadlock control** (ADR-031). A settlement
   * locks the payer's wallet and the payee's; two settlements in opposite
   * directions between the same pair would, if each locked "mine first", each
   * hold what the other needs. Sorting by id means every transaction in the
   * system requests the same pair in the same sequence, which makes that cycle
   * *structurally impossible* rather than merely unlikely.
   *
   * Raw SQL because Prisma has no expression for `FOR UPDATE`, and the
   * correctness of every balance change rests on it: without the lock, two
   * concurrent holds both read the same available balance, both find it
   * sufficient, and both succeed — which is the overspend the mandatory
   * concurrency test in docs/10 § 10.12 exists to catch.
   *
   * Runs unscoped because a settlement legitimately locks two organizations'
   * wallets, and the ids were resolved under tenant checks before this point.
   */
  async lock(tx: ExtendedPrismaClient, walletIds: readonly string[]): Promise<LockedWallet[]> {
    if (walletIds.length === 0) return [];
    const ordered = [...new Set(walletIds)].sort();

    return runUnscoped(
      'a settlement locks the payer and payee wallets, which belong to two organizations',
      () =>
        tx.$queryRaw<LockedWallet[]>`
          SELECT id,
                 organization_id       AS "organizationId",
                 currency,
                 ledger_account_id     AS "ledgerAccountId",
                 status,
                 ledger_balance_minor    AS "ledgerBalanceMinor",
                 pending_balance_minor   AS "pendingBalanceMinor",
                 available_balance_minor AS "availableBalanceMinor"
          FROM wallet
          WHERE id = ANY(${ordered})
          ORDER BY id
          FOR UPDATE
        `,
    );
  }

  // ==========================================================================
  // Balances
  // ==========================================================================

  /**
   * Recomputes the three balances from the ledger and stores them.
   *
   * **Recomputed, never incremented** (ADR-034). `balance = balance + amount`
   * is a read-modify-write: two concurrent writers read the same value and one
   * update is lost. The row lock above prevents that for callers that take it,
   * but recomputation removes the failure mode instead of guarding it — the
   * stored figure is a function of the ledger and nothing else, so it cannot
   * drift from the ledger no matter how it was reached.
   *
   * One statement rather than read-then-write, so there is no window between
   * the two, and it deliberately reads `ledger_entry` rather than trusting any
   * previous value.
   *
   * The `available` figure it computes is what `ck_wallet_balances` then
   * validates. A negative result — a wallet that somehow spent more than it
   * had — fails the constraint and rolls the whole transaction back rather
   * than being stored.
   */
  async recomputeFromLedger(
    tx: ExtendedPrismaClient,
    wallet: { id: string; organizationId: string; currency: string },
  ): Promise<Balances> {
    const rows = await runUnscoped(
      'a settlement recomputes both counterparties balances inside one transaction',
      () =>
        tx.$queryRaw<RawBalances[]>`
          UPDATE wallet w
             SET available_balance_minor = b.wallet_balance,
                 pending_balance_minor   = b.escrow_balance,
                 ledger_balance_minor    = b.wallet_balance + b.escrow_balance,
                 updated_at              = now()
            FROM (
              SELECT
                COALESCE(SUM(CASE WHEN a.purpose = 'WALLET' THEN s.balance ELSE 0 END), 0)
                  AS wallet_balance,
                COALESCE(SUM(CASE WHEN a.purpose = 'ESCROW' THEN s.balance ELSE 0 END), 0)
                  AS escrow_balance
              FROM ledger_account a
              LEFT JOIN LATERAL (
                SELECT COALESCE(SUM(
                         CASE WHEN e.direction = 'CREDIT' THEN e.amount_minor
                              ELSE -e.amount_minor END), 0) AS balance
                  FROM ledger_entry e
                 WHERE e.account_id = a.id
              ) s ON TRUE
             WHERE a.organization_id = ${wallet.organizationId}
               AND a.currency        = ${wallet.currency}
               AND a.purpose IN ('WALLET', 'ESCROW')
            ) b
           WHERE w.id = ${wallet.id}
        RETURNING w.available_balance_minor AS "availableBalanceMinor",
                  w.pending_balance_minor   AS "pendingBalanceMinor",
                  w.ledger_balance_minor    AS "ledgerBalanceMinor"
        `,
    );

    const row = rows[0];
    if (!row) {
      throw new Error(`Wallet ${wallet.id} disappeared while recomputing its balances`);
    }
    return balancesFrom(BigInt(row.availableBalanceMinor), BigInt(row.pendingBalanceMinor));
  }

  // ==========================================================================
  // Wallets
  // ==========================================================================

  findByOrganization(organizationId: string, currency: string) {
    return this.client.wallet.findUnique({
      where: { organizationId_currency: { organizationId, currency } },
    });
  }

  /**
   * Finds a counterparty's wallet without a tenant scope.
   *
   * A settlement credits the payee, who is by definition another organization.
   * The reason is written out because this is one of the few places on the
   * platform where reading another tenant's row is correct — and the *only*
   * thing done with it is to credit it.
   */
  findByOrganizationUnscoped(tx: ExtendedPrismaClient, organizationId: string, currency: string) {
    return runUnscoped(
      'a settlement must credit the payee wallet, which belongs to the counterparty organization',
      () =>
        tx.wallet.findUnique({
          where: { organizationId_currency: { organizationId, currency } },
        }),
    );
  }

  findById(id: string) {
    return this.client.wallet.findUnique({ where: { id } });
  }

  create(
    tx: ExtendedPrismaClient,
    data: {
      id: string;
      organizationId: string;
      currency: string;
      ledgerAccountId: string;
    },
  ) {
    return runUnscoped(
      'a wallet may be opened for a counterparty organization during settlement',
      () => tx.wallet.create({ data }),
    );
  }

  countActive() {
    return runUnscoped('operational gauge spanning tenants; no tenant ever sees it', () =>
      this.client.wallet.count({ where: { status: 'ACTIVE' } }),
    );
  }

  /** A page of wallets for the reconciliation to check. */
  pageForAudit(skip: number, take: number) {
    return runUnscoped('the wallet/ledger reconciliation is a platform-wide integrity check', () =>
      this.client.wallet.findMany({
        orderBy: { id: 'asc' },
        skip,
        take,
        select: {
          id: true,
          organizationId: true,
          currency: true,
          ledgerAccountId: true,
          ledgerBalanceMinor: true,
          pendingBalanceMinor: true,
          availableBalanceMinor: true,
        },
      }),
    );
  }

  // ==========================================================================
  // Holds
  // ==========================================================================

  createHold(
    tx: ExtendedPrismaClient,
    data: {
      id: string;
      organizationId: string;
      walletId: string;
      amountMinor: bigint;
      currency: string;
      reference: string;
      referenceType: string;
      placedJournalId: string;
      placedAt: Date;
      placedBy: string;
    },
  ) {
    return runUnscoped(
      'a hold is placed on the payer wallet during a cross-tenant settlement',
      () => tx.walletHold.create({ data }),
    );
  }

  /**
   * Resolves a hold, but only while it is still ACTIVE.
   *
   * The `status: 'ACTIVE'` in the filter is the whole point: `updateMany`
   * reports how many rows it changed, so two concurrent attempts to release the
   * same hold produce one success and one zero-row result. Without it, both
   * would "succeed" and the second would post a second journal releasing money
   * that had already moved.
   */
  async resolveHold(
    tx: ExtendedPrismaClient,
    holdId: string,
    data: {
      status: 'RELEASED' | 'REFUNDED';
      resolvedJournalId: string;
      resolvedAt: Date;
      resolvedBy: string;
      resolutionNote?: string | null;
    },
  ): Promise<number> {
    const result = await runUnscoped(
      'a hold is resolved during a settlement that spans two organizations',
      () =>
        tx.walletHold.updateMany({
          where: { id: holdId, status: 'ACTIVE' },
          data,
        }),
    );
    return result.count;
  }

  findActiveHold(tx: ExtendedPrismaClient, walletId: string, reference: string) {
    return runUnscoped('a hold lookup happens inside a cross-tenant settlement', () =>
      tx.walletHold.findFirst({ where: { walletId, reference, status: 'ACTIVE' } }),
    );
  }

  findHoldById(tx: ExtendedPrismaClient, id: string) {
    return runUnscoped('a hold lookup happens inside a cross-tenant settlement', () =>
      tx.walletHold.findUnique({ where: { id } }),
    );
  }

  listHolds(walletId: string, status?: Prisma.WalletHoldWhereInput['status']) {
    return this.client.walletHold.findMany({
      where: { walletId, ...(status ? { status } : {}) },
      orderBy: { placedAt: 'desc' },
      take: 100,
    });
  }

  /** Σ of active holds on a wallet — the cross-check for `pendingBalance`. */
  async activeHoldTotal(walletId: string): Promise<bigint> {
    const result = await runUnscoped(
      'the wallet/ledger reconciliation is a platform-wide integrity check',
      () =>
        this.client.walletHold.aggregate({
          where: { walletId, status: 'ACTIVE' },
          _sum: { amountMinor: true },
        }),
    );
    return result._sum.amountMinor ?? 0n;
  }

  countActiveHolds() {
    return runUnscoped('operational gauge spanning tenants; no tenant ever sees it', () =>
      this.client.walletHold.count({ where: { status: 'ACTIVE' } }),
    );
  }
}

export interface LockedWallet {
  id: string;
  organizationId: string;
  currency: string;
  ledgerAccountId: string;
  status: string;
  ledgerBalanceMinor: bigint;
  pendingBalanceMinor: bigint;
  availableBalanceMinor: bigint;
}

interface RawBalances {
  availableBalanceMinor: bigint;
  pendingBalanceMinor: bigint;
  ledgerBalanceMinor: bigint;
}

import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { Prisma, TransactionStatus, TransactionType } from '../generated/prisma';

/** How a transaction list may be narrowed. */
export interface TransactionFilter {
  status?: TransactionStatus;
  transactionType?: TransactionType;
  sourceReference?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
  /**
   * Include transactions where this organization is the *payee* rather than
   * the payer.
   *
   * A supplier's own view of what it is owed. It requires an unscoped read —
   * `organization_id` on the row is the payer — so it is a deliberate,
   * separately-authorized path rather than the default (`access.ts`).
   */
  includeIncoming?: boolean;
}

@Injectable()
export class TransactionRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client(): ExtendedPrismaClient {
    return this.prisma.client;
  }

  create(
    tx: ExtendedPrismaClient,
    data: Prisma.TransactionUncheckedCreateInput,
    legs: Prisma.TransactionLegCreateManyInput[],
  ) {
    return runUnscoped(
      'a transaction records a payer and a payee that belong to two organizations',
      async () => {
        const created = await tx.transaction.create({ data });
        if (legs.length > 0) await tx.transactionLeg.createMany({ data: legs });
        return created;
      },
    );
  }

  /**
   * Loads a transaction and locks its row.
   *
   * Every state change goes through here. The lock is what makes the status
   * check and the status write one atomic decision: without it, two concurrent
   * settlements of the same transaction both read `PENDING_SETTLEMENT`, both
   * pass the state machine, and both post a journal.
   *
   * Locked *before* the wallets, and released with them at commit. The
   * ordering matters only in that it is consistent — every path in this
   * service takes the transaction first, so two settlements of different
   * transactions on the same wallet cannot cross.
   */
  async lockForUpdate(
    tx: ExtendedPrismaClient,
    id: string,
  ): Promise<LockedTransaction | undefined> {
    const rows = await runUnscoped(
      'a settlement locks the transaction it discharges, on behalf of either counterparty',
      () =>
        tx.$queryRaw<LockedTransaction[]>`
          SELECT id,
                 organization_id                 AS "organizationId",
                 counterparty_organization_id    AS "counterpartyOrganizationId",
                 transaction_type                AS "transactionType",
                 status,
                 gross_amount_minor              AS "grossAmountMinor",
                 commission_amount_minor         AS "commissionAmountMinor",
                 net_amount_minor                AS "netAmountMinor",
                 currency,
                 occurred_at                     AS "occurredAt",
                 source_type                     AS "sourceType",
                 source_reference                AS "sourceReference",
                 correlation_id                  AS "correlationId"
            FROM "transaction"
           WHERE id = ${id}
             FOR UPDATE
        `,
    );
    return rows[0];
  }

  /**
   * Applies a status change, but only from the state it was read in.
   *
   * `status: from` in the filter makes this a compare-and-set. Under the row
   * lock it is belt and braces; without the lock — a path someone adds later —
   * it is the difference between one settlement and two, and `updateMany`
   * reporting zero rows is a refusal rather than a silent no-op.
   */
  async transition(
    tx: ExtendedPrismaClient,
    id: string,
    from: TransactionStatus,
    to: TransactionStatus,
    extra: Prisma.TransactionUncheckedUpdateManyInput = {},
  ): Promise<number> {
    const result = await runUnscoped(
      'a transaction changes state on behalf of either counterparty',
      () =>
        tx.transaction.updateMany({ where: { id, status: from }, data: { ...extra, status: to } }),
    );
    return result.count;
  }

  findById(id: string) {
    return this.client.transaction.findUnique({
      where: { id },
      include: { legs: true, commission: true, settlement: true },
    });
  }

  /**
   * A transaction visible to the caller as payer *or* payee.
   *
   * Unscoped, and then filtered in the caller against the two organizations it
   * is allowed to match — `access.ts` does that check, and does it explicitly,
   * because "the tenant guard let it through" is not an authorization decision
   * for a row that names two tenants.
   */
  findByIdForParty(id: string) {
    return runUnscoped('a transaction is visible to both its payer and its payee', () =>
      this.client.transaction.findUnique({
        where: { id },
        include: { legs: true, commission: true, settlement: true },
      }),
    );
  }

  findByIdempotencyKey(organizationId: string, idempotencyKey: string) {
    return this.client.transaction.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    });
  }

  /** An obligation already recorded for this source fact — the consumer's
   *  idempotency check, complementing `processed_event`. */
  findBySource(tx: ExtendedPrismaClient, sourceType: string, sourceReference: string) {
    return runUnscoped('an inbound event names its own organization, not the reader', () =>
      tx.transaction.findFirst({ where: { sourceType, sourceReference } }),
    );
  }

  async list(
    organizationId: string,
    filter: TransactionFilter,
  ): Promise<{ items: TransactionRow[]; nextCursor: string | null; hasMore: boolean }> {
    const window: Prisma.TransactionWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.transactionType ? { transactionType: filter.transactionType } : {}),
      ...(filter.sourceReference ? { sourceReference: filter.sourceReference } : {}),
      ...(filter.from || filter.to
        ? {
            occurredAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    };

    const query = (where: Prisma.TransactionWhereInput) =>
      this.client.transaction.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: filter.limit + 1,
        ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      });

    // The payee view has to cross the tenant guard, because `organization_id`
    // on the row is the payer. It is narrowed to exactly the caller's own id on
    // the counterparty column, so it can only ever return rows the caller is a
    // party to.
    const rows = filter.includeIncoming
      ? await runUnscoped(
          'a payee reads transactions where it is the counterparty, narrowed to its own id',
          () =>
            query({
              ...window,
              OR: [{ organizationId }, { counterpartyOrganizationId: organizationId }],
            }),
        )
      : await query(window);

    const hasMore = rows.length > filter.limit;
    const items = hasMore ? rows.slice(0, filter.limit) : rows;
    return {
      items: items as TransactionRow[],
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  countByStatus(status: TransactionStatus) {
    return runUnscoped('operational gauge spanning tenants; no tenant ever sees it', () =>
      this.client.transaction.count({ where: { status } }),
    );
  }
}

export interface LockedTransaction {
  id: string;
  organizationId: string;
  counterpartyOrganizationId: string | null;
  transactionType: TransactionType;
  status: TransactionStatus;
  grossAmountMinor: bigint;
  commissionAmountMinor: bigint;
  netAmountMinor: bigint;
  currency: string;
  occurredAt: Date;
  sourceType: string | null;
  sourceReference: string | null;
  correlationId: string;
}

export interface TransactionRow {
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
}

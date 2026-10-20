import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type {
  BusinessLine,
  CommissionOutcome,
  Prisma,
  TransactionStatus,
  TransactionType,
} from '../generated/prisma';
import { after, resolveCursor } from '../shared/cursor';
import { STATEMENT_SOURCE_TYPE } from './dto';

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
   * Records an obligation for a source fact, unless this payer already has one.
   *
   * `ON CONFLICT DO NOTHING` against `ux_transaction_source_fact`, never
   * create-and-catch: this runs inside the caller's interactive transaction,
   * and a unique violation there aborts the whole transaction (25P02), so the
   * read that should recover the winner's row would itself be refused — the
   * trap `LedgerRepository.ensureAccount` documents. Under READ COMMITTED the
   * losing insert waits for the winner to commit and then does nothing, so a
   * read afterwards finds the winner's row.
   *
   * Returns whether this call wrote the row. Legs are written only by the
   * winner, so a lost race leaves no orphaned legs behind.
   */
  createForSource(
    tx: ExtendedPrismaClient,
    data: Prisma.TransactionCreateManyInput,
    legs: Prisma.TransactionLegCreateManyInput[],
  ): Promise<boolean> {
    return runUnscoped(
      'a transaction records a payer and a payee that belong to two organizations',
      async () => {
        const { count } = await tx.transaction.createMany({ data: [data], skipDuplicates: true });
        if (count === 0) return false;
        if (legs.length > 0) await tx.transactionLeg.createMany({ data: legs });
        return true;
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
                 business_line                   AS "businessLine",
                 pricing_outcome                 AS "pricingOutcome",
                 pricing_rule_id                 AS "pricingRuleId",
                 status,
                 gross_amount_minor              AS "grossAmountMinor",
                 commission_amount_minor         AS "commissionAmountMinor",
                 net_amount_minor                AS "netAmountMinor",
                 currency,
                 occurred_at                     AS "occurredAt",
                 source_type                     AS "sourceType",
                 source_reference                AS "sourceReference",
                 correlation_id                  AS "correlationId",
                 dispute_id                      AS "disputeId"
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
  /** `client` is the caller's transaction when the read answers for what it just wrote. */
  findByIdForParty(id: string, client: ExtendedPrismaClient = this.client) {
    return runUnscoped('a transaction is visible to both its payer and its payee', () =>
      client.transaction.findUnique({
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

  /**
   * The obligation this payer already has for this source fact, if any.
   *
   * Scoped to the payer, like `ux_transaction_source_fact`: a platform-wide
   * lookup would let one tenant's row — written through the HTTP API with a
   * source reference of its own choosing — stand in for another tenant's
   * real approval, which would then never be recorded.
   */
  findBySource(
    tx: ExtendedPrismaClient,
    organizationId: string,
    sourceType: string,
    sourceReference: string,
  ) {
    return runUnscoped('an inbound event names its own organization, not the reader', () =>
      tx.transaction.findFirst({ where: { organizationId, sourceType, sourceReference } }),
    );
  }

  /**
   * One contract statement's obligation, as its payer holds it, with its
   * settlement (ADR-068 § 6 (3)).
   *
   * Scoped, never `runUnscoped`: `organizationId` is the tenant signed into the
   * caller's token, and the tenant guard injects the same one, so the
   * predicate is stated where the query is read and enforced again below it.
   * `ux_transaction_source_fact` makes this at most one row. Another payer's
   * statement — the beneficiary asking about what it is owed included — is
   * simply not found.
   *
   * ## One snapshot (review of #340 r1)
   *
   * The obligation and its settlement are two reads — Prisma loads an
   * `include` with a query of its own, and this schema has no `relationJoins`
   * — and under READ COMMITTED each would see its own moment. A settlement
   * commits its row and the obligation's `SETTLED` together
   * (`SettlementService`); landing between the two reads it would show a
   * `PENDING_SETTLEMENT` obligation beside its settlement, a row that
   * `fullySettledOf` rightly refuses as a defect — a 500 for a database that
   * was consistent at every instant. REPEATABLE READ fixes the snapshot at the
   * first read, so both see the same commit: before the settlement, or after
   * it. READ ONLY because the read writes nothing, and it takes no row lock,
   * so a settlement never waits on it. The two reads are written out rather
   * than as an `include` so the second is a query of this service's own,
   * scoped like the first (`settlement.organization_id` is the payer's), and
   * `statement-obligation-read.int-spec.ts` can commit a settlement between
   * them.
   */
  findStatementObligation(organizationId: string, statementId: string) {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const obligation = await tx.transaction.findFirst({
          where: {
            organizationId,
            sourceType: STATEMENT_SOURCE_TYPE,
            sourceReference: statementId,
          },
        });
        if (!obligation) return null;
        const settlement = await tx.settlement.findFirst({
          where: { organizationId, transactionId: obligation.id },
        });
        return { ...obligation, settlement };
      },
      { isolationLevel: 'RepeatableRead' },
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

    // The payee view has to cross the tenant guard, because `organization_id`
    // on the row is the payer. It is narrowed to exactly the caller's own id on
    // the counterparty column, so it can only ever return rows the caller is a
    // party to.
    const scope: Prisma.TransactionWhereInput = filter.includeIncoming
      ? { OR: [{ organizationId }, { counterpartyOrganizationId: organizationId }] }
      : { organizationId };

    const read = async () => {
      // The cursor is resolved in the list's party scope, not in its filter
      // window: a transaction's status moves while a client pages, so a row
      // that matched `status=HELD` on page one may not on page two, and
      // refusing it then would break paging rather than protect anything.
      // The window narrows rows the caller can already see; the scope is what
      // decides which rows those are (shared/cursor.ts).
      const boundary = await resolveCursor(filter.cursor, (id) =>
        this.client.transaction
          .findFirst({ where: { AND: [scope, { id }] }, select: { id: true, occurredAt: true } })
          .then((row) => (row ? { at: row.occurredAt, id: row.id } : null)),
      );
      return this.client.transaction.findMany({
        where: { AND: [scope, window, ...(boundary ? [after('occurredAt', boundary)] : [])] },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: filter.limit + 1,
      });
    };

    const rows = filter.includeIncoming
      ? await runUnscoped(
          'a payee reads transactions where it is the counterparty, narrowed to its own id',
          read,
        )
      : await read();

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
  businessLine: BusinessLine | null;
  /** Recorded with the source fact; null on rows from before that (docs/23 D-057). */
  pricingOutcome: CommissionOutcome | null;
  pricingRuleId: string | null;
  status: TransactionStatus;
  grossAmountMinor: bigint;
  commissionAmountMinor: bigint;
  netAmountMinor: bigint;
  currency: string;
  occurredAt: Date;
  sourceType: string | null;
  sourceReference: string | null;
  correlationId: string;
  /** The dispute it holds, or held last; null if never disputed. */
  disputeId: string | null;
}

export interface TransactionRow {
  id: string;
  organizationId: string;
  counterpartyOrganizationId: string | null;
  transactionType: string;
  businessLine: string | null;
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

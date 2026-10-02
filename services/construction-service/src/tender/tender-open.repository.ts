import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { Bid, BidAccessLog, BidReceipt, TenderKey } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { TenderStateName } from './tender.state-machine';

/**
 * What opening a tender's bids, and reading them afterwards, reads and writes
 * (ADR-065 § 1, ADR-066 § 2-5).
 *
 * This is the **owner's** side: every statement runs in the tender owner's tenant
 * through the ordinary guard, and the raw locks name the organization in their
 * predicate. The one lookup by id alone (`findOwnership`) is a reasoned `runUnscoped`.
 * (The bidder's side, which crosses tenants, is `BidRepository`.)
 */

/** The tender row under the opening lock: enough to decide, nothing more. */
export interface TenderForOpening {
  id: string;
  organizationId: string;
  projectId: string;
  status: TenderStateName;
  version: number;
  bidClosingAt: Date | null;
  closedAt: Date | null;
  openedAt: Date | null;
  openedBy: string | null;
  openingProposedBy: string | null;
}

/** Who owns a tender and how far it has got, found by id alone. */
export interface TenderOwnership {
  id: string;
  organizationId: string;
  status: TenderStateName;
  openedAt: Date | null;
  openingProposedBy: string | null;
}

interface LockRow {
  id: string;
  organization_id: string;
  project_id: string;
  status: TenderStateName;
  version: number;
  bid_closing_at: Date | null;
  closed_at: Date | null;
  opened_at: Date | null;
  opened_by: string | null;
  opening_proposed_by: string | null;
}

const toLocked = (row: LockRow): TenderForOpening => ({
  id: row.id,
  organizationId: row.organization_id,
  projectId: row.project_id,
  status: row.status,
  version: row.version,
  bidClosingAt: row.bid_closing_at,
  closedAt: row.closed_at,
  openedAt: row.opened_at,
  openedBy: row.opened_by,
  openingProposedBy: row.opening_proposed_by,
});

@Injectable()
export class TenderOpenRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds a tender by id in any tenant, so a request for **another** organization's
   * tender can be told from one that does not exist: the first is answered 404 like the
   * second, and the attempt is logged under the owner (ADR-066 § 5). Nothing but who
   * owns it and how far it has got is read.
   */
  findOwnership(tenderId: string): Promise<TenderOwnership | null> {
    return runUnscoped(
      'a refused read of a bid is logged under the tender owner; the tender is found by id (ADR-066 § 5)',
      async () => {
        const row = await this.prisma.client.tender.findFirst({
          where: { id: tenderId },
          select: {
            id: true,
            organizationId: true,
            status: true,
            openedAt: true,
            openingProposedBy: true,
          },
        });
        return row ? { ...row, status: row.status as TenderStateName } : null;
      },
    );
  }

  /**
   * Locks the tender row `FOR UPDATE` for the rest of the transaction — the lock `close`
   * and every owner command take, which bids share `FOR SHARE` — so a bid, the close and
   * an opening queue behind one another and each order has one outcome.
   */
  async lockForOpening(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<TenderForOpening | null> {
    const rows = await tx.$queryRaw<LockRow[]>`
      SELECT "id", "organization_id", "project_id", "status"::text AS "status", "version",
             "bid_closing_at", "closed_at", "opened_at", "opened_by", "opening_proposed_by"
        FROM "tender"
       WHERE "organization_id" = ${organizationId} AND "id" = ${tenderId}
       FOR UPDATE`;
    return rows[0] ? toLocked(rows[0]) : null;
  }

  /**
   * The same row `FOR SHARE`, for the owner's reads: they queue behind an opening in
   * progress and see it whole or not at all, and do not queue behind each other.
   */
  async lockSharedForRead(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<TenderForOpening | null> {
    const rows = await tx.$queryRaw<LockRow[]>`
      SELECT "id", "organization_id", "project_id", "status"::text AS "status", "version",
             "bid_closing_at", "closed_at", "opened_at", "opened_by", "opening_proposed_by"
        FROM "tender"
       WHERE "organization_id" = ${organizationId} AND "id" = ${tenderId}
       FOR SHARE`;
    return rows[0] ? toLocked(rows[0]) : null;
  }

  /**
   * Records the proposal to open (four-eyes, Q-91) on a CLOSED tender, in the lock the
   * caller holds: the first proposal stands. Returns the rows matched: 0 or 1.
   */
  async proposeOpening(
    tx: ExtendedPrismaClient,
    input: { tenderId: string; actor: string; at: Date },
  ): Promise<number> {
    const result = await tx.tender.updateMany({
      where: { id: input.tenderId, status: 'CLOSED', openedAt: null, openingProposedBy: null },
      data: { openingProposedAt: input.at, openingProposedBy: input.actor },
    });
    return result.count;
  }

  /** The tender's key row, wrapped: the private half is useless without the KEK. */
  findKey(tx: ExtendedPrismaClient, tenderId: string): Promise<TenderKey | null> {
    return tx.tenderKey.findFirst({ where: { tenderId } });
  }

  /** Every bid of the tender — withdrawn ones too — in a stable order. */
  listBids(tx: ExtendedPrismaClient, tenderId: string): Promise<Bid[]> {
    return tx.bid.findMany({ where: { tenderId }, orderBy: { id: 'asc' } });
  }

  /** Every organization that bid on the tender, withdrawn bids included: for the conflict of interest. */
  async listBidderOrganizationIds(tx: ExtendedPrismaClient, tenderId: string): Promise<string[]> {
    const rows = await tx.bid.findMany({
      where: { tenderId },
      distinct: ['bidderOrganizationId'],
      select: { bidderOrganizationId: true },
    });
    return rows.map((row) => row.bidderOrganizationId);
  }

  /** This service's own copy of the chain, in the order issued. Compared with the evidence, never trusted. */
  listReceipts(tx: ExtendedPrismaClient, tenderId: string): Promise<BidReceipt[]> {
    return tx.bidReceipt.findMany({ where: { tenderId }, orderBy: { seq: 'asc' } });
  }

  /**
   * SUBMITTED → OPENED for every standing bid of the tender, in the lock the caller
   * holds. Returns how many were opened.
   */
  async markBidsOpened(
    tx: ExtendedPrismaClient,
    input: { tenderId: string; actor: string; at: Date },
  ): Promise<number> {
    const result = await tx.bid.updateMany({
      where: { tenderId: input.tenderId, status: 'SUBMITTED' },
      data: { status: 'OPENED', updatedAt: input.at, updatedBy: input.actor },
    });
    return result.count;
  }

  /**
   * CLOSED → EVALUATING: compare-and-set on status and version, who and when. Returns
   * the rows matched: 0 or 1.
   */
  async openTender(
    tx: ExtendedPrismaClient,
    input: { tenderId: string; expectedVersion: number; actor: string; at: Date },
  ): Promise<number> {
    const result = await tx.tender.updateMany({
      where: { id: input.tenderId, status: 'CLOSED', version: input.expectedVersion },
      data: {
        status: 'EVALUATING',
        openedAt: input.at,
        openedBy: input.actor,
        statusChangedAt: input.at,
        statusChangedBy: input.actor,
        updatedAt: input.at,
        updatedBy: input.actor,
        version: { increment: 1 },
      },
    });
    return result.count;
  }

  /** The access log of one tender, newest first, a page at a time (cursor = the id of the last row). */
  listAccessLog(
    tx: ExtendedPrismaClient,
    tenderId: string,
    query: { cursor?: string; limit: number },
  ): Promise<BidAccessLog[]> {
    return tx.bidAccessLog.findMany({
      where: { tenderId, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
  }

  /** Whether the tender exists in the caller's own tenant (the guard scopes it). */
  async ownsTender(tx: ExtendedPrismaClient, tenderId: string): Promise<boolean> {
    return (await tx.tender.count({ where: { id: tenderId } })) > 0;
  }
}

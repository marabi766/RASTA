import { Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import type { DemandAggregation, DemandRequest } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ShortfallPolicy } from '../config/env';
import type {
  AggregationStateName,
  DemandStateName,
  SettingSnapshot,
  WindowSnapshot,
} from './demand.state-machine';

/** A page of rows, newest first by id (a ULID), with one more fetched to tell whether there is more. */
export interface PageFilter<S extends string> {
  readonly status?: S;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * The demand and aggregation tables (ADR-070 § 2).
 *
 * Every write runs inside the caller's transaction, after the aggregation's row lock: a lock is
 * taken with raw SQL (`SELECT … FOR UPDATE`, the organization in the predicate), and every change
 * is a compare-and-set naming the organization, the id, the status and the version it read — so a
 * row that moved under the command is a conflict, never a lost update (ADR-063 § 1). Reads go
 * through the tenant guard (`TENANT_SCOPED_MODELS`). The lock order is fixed: the aggregation, then
 * its demands.
 */
@Injectable()
export class DemandRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The OPEN window of (organization, product), locked, or null when there is none. */
  async lockOpenWindow(
    tx: ExtendedPrismaClient,
    organizationId: string,
    productId: string,
  ): Promise<DemandAggregation | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM demand_aggregation
      WHERE organization_id = ${organizationId} AND product_id = ${productId} AND status = 'OPEN'
      FOR UPDATE`;
    const id = locked[0]?.id;
    if (!id) return null;
    return tx.demandAggregation.findFirst({ where: { organizationId, id } });
  }

  /** One aggregation, locked (the first lock of a withdrawal), or null when it is not the caller's. */
  async lockWindow(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<DemandAggregation | null> {
    await tx.$queryRaw`
      SELECT 1 FROM demand_aggregation WHERE organization_id = ${organizationId} AND id = ${id}
      FOR UPDATE`;
    return tx.demandAggregation.findFirst({ where: { organizationId, id } });
  }

  /**
   * Opens a window, unless another transaction holds or has just committed an OPEN one for the same
   * (organization, product): then nothing is written and `false` is answered, and the caller locks
   * that one instead. The partial unique index decides; a racing insert waits for the other
   * transaction's end.
   */
  async openWindow(
    tx: ExtendedPrismaClient,
    window: {
      id: string;
      organizationId: string;
      productId: string;
      openedAt: Date;
      closesAt: Date;
      snapshot: SettingSnapshot;
    },
  ): Promise<boolean> {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO demand_aggregation
        (id, organization_id, product_id, status, opened_at, closes_at, window_hours, min_quantity,
         shortfall_policy, setting_version, total_quantity, demand_count, extension_count,
         created_at, updated_at, version)
      VALUES (${window.id}, ${window.organizationId}, ${window.productId}, 'OPEN',
              ${window.openedAt}, ${window.closesAt}, ${window.snapshot.windowHours},
              ${window.snapshot.minQuantity}, ${window.snapshot.shortfallPolicy},
              ${window.snapshot.settingVersion},
              0, 0, 0, ${window.openedAt}, ${window.openedAt}, 1)
      ON CONFLICT (organization_id, product_id) WHERE status = 'OPEN' DO NOTHING
      RETURNING id`;
    return inserted.length === 1;
  }

  /** A demand joins the window it holds the lock of: the total and the count move with it. */
  async join(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    quantity: number,
    at: Date,
  ): Promise<void> {
    await this.moveWindow(tx, window, 'OPEN', {
      totalQuantity: window.totalQuantity + BigInt(quantity),
      demandCount: window.demandCount + 1,
      updatedAt: at,
    });
  }

  /** A withdrawn demand leaves the open window it holds the lock of. */
  async leave(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    quantity: number,
    at: Date,
  ): Promise<void> {
    await this.moveWindow(tx, window, 'OPEN', {
      totalQuantity: window.totalQuantity - BigInt(quantity),
      demandCount: window.demandCount - 1,
      updatedAt: at,
    });
  }

  /**
   * The end of a window that leaves OPEN: READY, REFERRED or LAPSED, at `at`. `demandsToFollow` is
   * how many of its live demands are still to move to its status (all of a REFERRED or LAPSED
   * window's; 0 for READY), `digestState` the empty digest of the demands it ended with: both are
   * carried on in bounded batches (`WindowEnd.carryOn`). The digest starts from nothing, whatever
   * the row held: no id taken, no cursor (PR-338 r2 F1; the guard refuses any other start).
   */
  async endWindow(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    to: Extract<AggregationStateName, 'READY' | 'REFERRED' | 'LAPSED'>,
    at: Date,
    end: { demandsToFollow: number; digestState: Uint8Array<ArrayBuffer> },
  ): Promise<void> {
    await this.moveWindow(tx, window, to, {
      closedAt: at,
      updatedAt: at,
      demandsToFollow: end.demandsToFollow,
      endDigestState: end.digestState,
      endDigestCursor: null,
      endDigestCounted: 0,
    });
  }

  /** READY → CANCELLED with who, when and why (ADR-070 § 2). */
  async cancelWindow(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    cancellation: { by: string; reason: string; at: Date },
  ): Promise<void> {
    await this.moveWindow(tx, window, 'CANCELLED', {
      cancelledAt: cancellation.at,
      cancelledBy: cancellation.by,
      cancelReason: cancellation.reason,
      updatedAt: cancellation.at,
    });
  }

  /** The end of a window under EXTEND: it moves on by `windows` of its own length; it stays OPEN. */
  async extendWindow(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    closesAt: Date,
    windows: number,
    at: Date,
  ): Promise<void> {
    await this.moveWindow(tx, window, 'OPEN', {
      closesAt,
      extensionCount: window.extensionCount + windows,
      updatedAt: at,
    });
  }

  /**
   * The next ids, at most `limit`, of the demands an ended window holds — every one not withdrawn,
   * whether it still reads SUBMITTED or already followed the window — after the last one its
   * digest took, in byte order (`COLLATE "C"`, as JavaScript's default sort orders these ASCII
   * ids, so the digest is `demandIdsDigest`'s). One range of `ix_demand_request_window_ids`: the
   * cost is the batch's, whatever the window holds.
   *
   * Sorting is off for this one statement, so that range is the only plan. On a table it has no
   * statistics for yet, the planner believed a 1,000,000-demand window held one row, scanned
   * `ix_demand_request_aggregation` instead and sorted the whole window for every batch: 1.3 s a
   * batch on rasta-dev, against 3.7 ms for the range (2000 ids). The setting is put back as it
   * was before the next statement of the transaction.
   */
  async nextDemandIds(
    tx: ExtendedPrismaClient,
    window: { organizationId: string; id: string; endDigestCursor: string | null },
    limit: number,
  ): Promise<string[]> {
    const cursor = window.endDigestCursor;
    const before = await tx.$queryRaw<{ was: string }[]>`
      SELECT current_setting('enable_sort') AS was`;
    const was = before[0]?.was ?? 'on';
    await tx.$queryRaw`SELECT set_config('enable_sort', 'off', true) AS now`;
    try {
      const rows =
        cursor === null
          ? await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM demand_request
               WHERE organization_id = ${window.organizationId} AND aggregation_id = ${window.id}
                 AND status <> 'WITHDRAWN'
               ORDER BY id COLLATE "C" LIMIT ${limit}`
          : await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM demand_request
               WHERE organization_id = ${window.organizationId} AND aggregation_id = ${window.id}
                 AND status <> 'WITHDRAWN' AND id COLLATE "C" > ${cursor}
               ORDER BY id COLLATE "C" LIMIT ${limit}`;
      return rows.map((row) => row.id);
    } finally {
      await tx.$queryRaw`SELECT set_config('enable_sort', ${was}, true) AS now`;
    }
  }

  /**
   * A batch of the digest was taken: its state, the last id taken and how many, by compare-and-set
   * on what was read under the lock (bookkeeping: no version).
   */
  async digestTaken(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    taken: { state: Uint8Array; cursor: string; counted: number },
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE demand_aggregation
         SET end_digest_state = ${Buffer.from(taken.state)}, end_digest_cursor = ${taken.cursor},
             end_digest_counted = ${taken.counted}
       WHERE organization_id = ${window.organizationId} AND id = ${window.id}
         AND status = ${window.status} AND end_digest_state IS NOT NULL
         AND end_digest_counted = ${window.endDigestCounted}`;
    if (changed !== 1) throw RastaError.optimisticLockFailed('DemandAggregation', window.id);
  }

  /**
   * The digest is complete: written once with how many ids it took, the state cleared
   * (bookkeeping: no version). The guard checks that count is the window's and that the ids after
   * the last one stored are exactly the ones this batch took.
   */
  async digestWritten(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    written: { digest: string; counted: number },
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE demand_aggregation
         SET demand_ids_sha256 = ${written.digest}, end_digest_state = NULL,
             end_digest_cursor = NULL, end_digest_counted = ${written.counted}
       WHERE organization_id = ${window.organizationId} AND id = ${window.id}
         AND status = ${window.status} AND end_digest_state IS NOT NULL
         AND end_digest_counted = ${window.endDigestCounted}`;
    if (changed !== 1) throw RastaError.optimisticLockFailed('DemandAggregation', window.id);
  }

  /**
   * Up to `limit` live demands of a window that ended under REFER or CLOSE follow it — after the
   * window's own row moved, which the demand guard requires. Under the window's lock nobody else
   * moves them, so a count other than `limit` is a defect, never a race to report as a conflict.
   *
   * The rows are picked once (`ARRAY(…)`, an init plan) and updated by their physical address — a
   * TID scan, whatever the planner believes about the table. Both id-based forms let it, on a table
   * it has no statistics for yet, scan the window's index and test every one of its demands against
   * the whole batch: `id IN (SELECT … LIMIT n)` took minutes for one batch of a 200,000-demand
   * window, `id = ANY(ARRAY(…))` 23 s, and so did this form with the organization repeated outside
   * (any indexed predicate there brings the index path back). So the organization, the window and
   * the status are the picking subquery's, in the statement's own snapshot, and the addresses cannot
   * move in between: the window's lock keeps every other writer off these rows. The demand guard
   * still checks each row follows its own window, and the count is checked below.
   */
  async followWindow(
    tx: ExtendedPrismaClient,
    window: { organizationId: string; id: string },
    to: Extract<DemandStateName, 'REFERRED' | 'LAPSED'>,
    limit: number,
    at: Date,
  ): Promise<void> {
    if (limit === 0) return;
    const moved = await tx.$executeRaw`
      UPDATE demand_request
         SET status = ${to}, closed_at = ${at}, updated_at = ${at}, version = version + 1
       WHERE ctid = ANY(ARRAY(SELECT ctid FROM demand_request
                               WHERE organization_id = ${window.organizationId}
                                 AND aggregation_id = ${window.id} AND status = 'SUBMITTED'
                               LIMIT ${limit}))`;
    if (moved !== limit) {
      throw new Error(`window ${window.id}: ${moved} demands moved to ${to}, ${limit} expected`);
    }
  }

  /**
   * After a batch followed an ended window: the count of those still to follow comes down, by
   * compare-and-set on the count read under the lock (bookkeeping: no version). When it reaches 0
   * no demand of the window may still be SUBMITTED.
   */
  async followed(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    remaining: number,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE demand_aggregation SET demands_to_follow = ${remaining}
       WHERE organization_id = ${window.organizationId} AND id = ${window.id}
         AND status = ${window.status} AND demands_to_follow = ${window.demandsToFollow}`;
    if (changed !== 1) throw RastaError.optimisticLockFailed('DemandAggregation', window.id);
    if (remaining === 0) {
      const left = await tx.$queryRaw<{ left: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM demand_request
                        WHERE organization_id = ${window.organizationId}
                          AND aggregation_id = ${window.id} AND status = 'SUBMITTED') AS left`;
      if (left[0]?.left) {
        throw new Error(`window ${window.id} has followed in full but still holds a live demand`);
      }
    }
  }

  async insertDemand(
    tx: ExtendedPrismaClient,
    demand: {
      id: string;
      organizationId: string;
      aggregationId: string;
      productId: string;
      quantity: number;
      note: string | null;
      submittedAt: Date;
      submittedBy: string;
      submittedCorrelationId: string;
    },
  ): Promise<DemandRequest> {
    return tx.demandRequest.create({
      data: {
        ...demand,
        status: 'SUBMITTED',
        createdAt: demand.submittedAt,
        updatedAt: demand.submittedAt,
        version: 1,
      },
    });
  }

  /** One demand of the caller's organization, or null — another organization's is null too. */
  findDemand(
    id: string,
    tx: ExtendedPrismaClient = this.prisma.client,
  ): Promise<DemandRequest | null> {
    return tx.demandRequest.findFirst({ where: { id } });
  }

  /** One demand, locked — after its window's lock, never before. */
  async lockDemand(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<DemandRequest | null> {
    await tx.$queryRaw`
      SELECT 1 FROM demand_request WHERE organization_id = ${organizationId} AND id = ${id}
      FOR UPDATE`;
    return tx.demandRequest.findFirst({ where: { organizationId, id } });
  }

  /** SUBMITTED → WITHDRAWN, by compare-and-set on the version the caller read. */
  async withdraw(
    tx: ExtendedPrismaClient,
    demand: DemandRequest,
    withdrawal: { by: string; reason: string; at: Date },
  ): Promise<DemandRequest> {
    const moved = await tx.$executeRaw`
      UPDATE demand_request
         SET status = 'WITHDRAWN', withdrawn_at = ${withdrawal.at}, withdrawn_by = ${withdrawal.by},
             withdraw_reason = ${withdrawal.reason}, updated_at = ${withdrawal.at},
             version = version + 1
       WHERE organization_id = ${demand.organizationId} AND id = ${demand.id}
         AND status = 'SUBMITTED' AND version = ${demand.version}`;
    if (moved !== 1) throw RastaError.optimisticLockFailed('DemandRequest', demand.id);
    const after = await tx.demandRequest.findFirst({
      where: { organizationId: demand.organizationId, id: demand.id },
    });
    if (!after) throw new Error(`demand ${demand.id} vanished inside its own transaction`);
    return after;
  }

  findAggregation(
    id: string,
    tx: ExtendedPrismaClient = this.prisma.client,
  ): Promise<DemandAggregation | null> {
    return tx.demandAggregation.findFirst({ where: { id } });
  }

  async aggregationAfter(tx: ExtendedPrismaClient, window: DemandAggregation) {
    const after = await tx.demandAggregation.findFirst({
      where: { organizationId: window.organizationId, id: window.id },
    });
    if (!after) throw new Error(`aggregation ${window.id} vanished inside its own transaction`);
    return after;
  }

  /** The caller organization's demands, newest first. */
  listDemands(filter: PageFilter<DemandStateName>): Promise<DemandRequest[]> {
    return this.prisma.client.demandRequest.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }

  /** The caller organization's aggregations, newest first. */
  listAggregations(filter: PageFilter<AggregationStateName>): Promise<DemandAggregation[]> {
    return this.prisma.client.demandAggregation.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }

  /**
   * The one compare-and-set every window change goes through: the organization, the id, the status
   * and the version it read in the predicate, the version moved by one.
   */
  private async moveWindow(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    to: AggregationStateName,
    change: {
      totalQuantity?: bigint;
      demandCount?: number;
      closesAt?: Date;
      extensionCount?: number;
      closedAt?: Date;
      demandsToFollow?: number;
      endDigestState?: Uint8Array<ArrayBuffer>;
      endDigestCursor?: null;
      endDigestCounted?: 0;
      cancelledAt?: Date;
      cancelledBy?: string;
      cancelReason?: string;
      updatedAt: Date;
    },
  ): Promise<void> {
    const { count } = await tx.demandAggregation.updateMany({
      where: {
        organizationId: window.organizationId,
        id: window.id,
        status: window.status,
        version: window.version,
      },
      data: { ...change, status: to, version: window.version + 1 },
    });
    if (count !== 1) throw RastaError.optimisticLockFailed('DemandAggregation', window.id);
  }
}

/** The environment defaults (Q-10): what a window takes in an organization with no setting version. */
export function snapshotOf(env: {
  PROCUREMENT_AGGREGATION_WINDOW_HOURS: number;
  PROCUREMENT_AGGREGATION_MIN_QUANTITY: number;
  PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: ShortfallPolicy;
}): WindowSnapshot {
  return {
    windowHours: env.PROCUREMENT_AGGREGATION_WINDOW_HOURS,
    minQuantity: env.PROCUREMENT_AGGREGATION_MIN_QUANTITY,
    shortfallPolicy: env.PROCUREMENT_AGGREGATION_SHORTFALL_POLICY,
  };
}

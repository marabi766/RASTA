import { Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import type { DemandAggregation, DemandRequest } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ShortfallPolicy } from '../config/env';
import type { AggregationStateName, DemandStateName, WindowSnapshot } from './demand.state-machine';

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
      snapshot: WindowSnapshot;
    },
  ): Promise<boolean> {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO demand_aggregation
        (id, organization_id, product_id, status, opened_at, closes_at, window_hours, min_quantity,
         shortfall_policy, setting_version, total_quantity, demand_count, extension_count,
         created_at, updated_at, version)
      VALUES (${window.id}, ${window.organizationId}, ${window.productId}, 'OPEN',
              ${window.openedAt}, ${window.closesAt}, ${window.snapshot.windowHours},
              ${window.snapshot.minQuantity}, ${window.snapshot.shortfallPolicy}, NULL,
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

  /** The end of a window that leaves OPEN: READY, REFERRED or LAPSED, at `at`. */
  async endWindow(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    to: Extract<AggregationStateName, 'READY' | 'REFERRED' | 'LAPSED'>,
    at: Date,
  ): Promise<void> {
    await this.moveWindow(tx, window, to, { closedAt: at, updatedAt: at });
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

  /** The demands still SUBMITTED in a window, in id order. */
  async liveDemandIds(tx: ExtendedPrismaClient, window: DemandAggregation): Promise<string[]> {
    const rows = await tx.demandRequest.findMany({
      where: {
        organizationId: window.organizationId,
        aggregationId: window.id,
        status: 'SUBMITTED',
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  /** The live demands of a window that ended under REFER or CLOSE follow it. */
  async closeDemands(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    to: Extract<DemandStateName, 'REFERRED' | 'LAPSED'>,
    expected: number,
    at: Date,
  ): Promise<void> {
    const moved = await tx.$executeRaw`
      UPDATE demand_request
         SET status = ${to}, closed_at = ${at}, updated_at = ${at}, version = version + 1
       WHERE organization_id = ${window.organizationId} AND aggregation_id = ${window.id}
         AND status = 'SUBMITTED'`;
    if (moved !== expected) {
      // Every demand of the window is changed under the window's lock, so a different count is
      // a defect, never a race to report as a conflict.
      throw new Error(
        `closing window ${window.id}: ${moved} demands moved to ${to}, ${expected} expected`,
      );
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

/** The snapshot a new window takes: the environment defaults today (Q-10; PR 3 adds the per-organization row). */
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

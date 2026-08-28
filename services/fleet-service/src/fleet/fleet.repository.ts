import { Injectable } from '@nestjs/common';
import { buildOutboxRow, runUnscoped, type OutboxMessageInput } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import type {
  AvailabilityQuery,
  ListAssignmentsQuery,
  ListDriversQuery,
  ListUsageQuery,
  UtilizationQuery,
} from './dto';

/**
 * Data access for fleet.
 *
 * Tenant scoping is applied automatically by the Prisma extension, so the
 * queries here read as if they were single-tenant. The handful of places that
 * legitimately cross the boundary go through `runUnscoped` with a written
 * reason, which makes every one of them greppable — and in this service there
 * are exactly two, both on `AssetRef`, the platform-wide replica that no
 * authorization decision ever consults.
 */
@Injectable()
export class FleetRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client(): ExtendedPrismaClient {
    return this.prisma.client;
  }

  transaction<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.prisma.transaction(fn);
  }

  async enqueueEvent(tx: ExtendedPrismaClient, input: OutboxMessageInput): Promise<string> {
    const row = buildOutboxRow(input, {
      producer: SERVICE_NAME,
      producerVersion: process.env.SERVICE_VERSION ?? '0.1.0',
    });

    await tx.outboxMessage.create({
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
    });

    return row.id;
  }

  // -------------------------------------------------------------------------
  // Drivers
  // -------------------------------------------------------------------------

  async findDriverById(id: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).driver.findFirst({ where: { id } });
  }

  async findDriverByUserId(userId: string) {
    return this.client.driver.findFirst({ where: { userId } });
  }

  async listDrivers(query: ListDriversQuery) {
    const rows = await this.client.driver.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
        ...(query.q
          ? {
              OR: [
                { employeeNo: { contains: query.q, mode: 'insensitive' as const } },
                { licenceNumber: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });

    return page(rows, query.limit, (row) => row.id);
  }

  // -------------------------------------------------------------------------
  // Assignments
  // -------------------------------------------------------------------------

  async findAssignmentById(id: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).assignment.findFirst({ where: { id } });
  }

  async findActiveAssignmentForAsset(assetId: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).assignment.findFirst({ where: { assetId, endedAt: null } });
  }

  async findActiveAssignmentForDriver(driverId: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).assignment.findFirst({ where: { driverId, endedAt: null } });
  }

  /**
   * How many assignments are open across the whole deployment.
   *
   * Feeds a Prometheus gauge, so it deliberately spans tenants — no tenant
   * ever sees the number. It goes through `runUnscoped` and the Prisma model
   * API rather than raw SQL for one reason: raw SQL is not intercepted by the
   * tenant extension, so a crossing written that way is invisible both to
   * `grep -r runUnscoped` and to the unscoped-query audit log. The audit story
   * only works if every crossing is enumerable, including the harmless ones.
   */
  async countActiveAssignmentsAcrossTenants(): Promise<number> {
    return runUnscoped('operational gauge across the deployment; never returned to a tenant', () =>
      this.client.assignment.count({ where: { endedAt: null } }),
    );
  }

  /** Every active assignment in the tenant, keyed by asset. Feeds availability. */
  async findActiveAssignments(assetIds?: readonly string[]) {
    return this.client.assignment.findMany({
      where: {
        endedAt: null,
        ...(assetIds ? { assetId: { in: [...assetIds] } } : {}),
      },
      select: { id: true, assetId: true, driverId: true, startedAt: true },
    });
  }

  async listAssignments(query: ListAssignmentsQuery) {
    const constraints: object[] = [];
    if (query.cursor) constraints.push({ id: { lt: query.cursor } });
    if (query.from) constraints.push({ startedAt: { gte: new Date(query.from) } });
    if (query.to) constraints.push({ startedAt: { lte: new Date(query.to) } });

    const rows = await this.client.assignment.findMany({
      where: {
        ...(query.driverId ? { driverId: query.driverId } : {}),
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.active === undefined
          ? {}
          : query.active
            ? { endedAt: null }
            : { endedAt: { not: null } }),
        ...(constraints.length > 0 ? { AND: constraints } : {}),
      },
      // Newest first: assignment history is read backwards from the current
      // one. `id` is a ULID, so ordering by it is ordering by creation time
      // and gives a stable cursor without a second column.
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    return page(rows, query.limit, (row) => row.id);
  }

  /** Ends every active assignment for a driver. Used when a driver is barred. */
  async endActiveAssignmentsForDriver(
    tx: ExtendedPrismaClient,
    driverId: string,
    endedAt: Date,
    endedBy: string,
    reason: 'DRIVER_UNAVAILABLE',
    notes: string,
  ) {
    const active = await tx.assignment.findMany({ where: { driverId, endedAt: null } });

    for (const assignment of active) {
      await tx.assignment.updateMany({
        where: { id: assignment.id, endedAt: null },
        data: { endedAt, endedBy, endReason: reason, endNotes: notes },
      });
    }

    return active;
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  async findUsageById(id: string) {
    return this.client.usageRecord.findFirst({ where: { id } });
  }

  async findUsageByClientReference(clientReference: string) {
    return this.client.usageRecord.findFirst({ where: { clientReference } });
  }

  async listUsage(query: ListUsageQuery) {
    const constraints: object[] = [];
    if (query.cursor) constraints.push({ id: { lt: query.cursor } });
    if (query.from) constraints.push({ periodEnd: { gte: new Date(query.from) } });
    if (query.to) constraints.push({ periodEnd: { lte: new Date(query.to) } });

    const rows = await this.client.usageRecord.findMany({
      where: {
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.driverId ? { driverId: query.driverId } : {}),
        ...(query.source ? { source: query.source } : {}),
        ...(constraints.length > 0 ? { AND: constraints } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    return page(rows, query.limit, (row) => row.id);
  }

  /**
   * Usage totals per asset over a window.
   *
   * Aggregated in the database rather than by loading every row: a machine
   * with two years of readings would otherwise pull thousands of rows into
   * memory to add up two numbers.
   *
   * `organizationId` is filtered explicitly because the Prisma extension
   * cannot reach into raw SQL, and omitting it here would total another
   * organization's fleet into this one's report.
   */
  async usageTotals(
    organizationId: string,
    from: Date,
    to: Date,
    query: UtilizationQuery,
  ): Promise<UsageTotalRow[]> {
    return this.client.$queryRaw<UsageTotalRow[]>`
      SELECT asset_id,
             COALESCE(SUM(hours), 0)::text      AS total_hours,
             COALESCE(SUM(kilometres), 0)::text AS total_kilometres,
             COUNT(*)::int                      AS record_count
      FROM usage_record
      WHERE organization_id = ${organizationId}
        AND period_end >= ${from}
        AND period_end <= ${to}
        AND (${query.assetId ?? null}::text IS NULL OR asset_id = ${query.assetId ?? null}::text)
      GROUP BY asset_id
      ORDER BY SUM(hours) DESC NULLS LAST
      LIMIT ${query.limit}
    `;
  }

  /** How many assignments touched each asset in the window. */
  async assignmentCounts(
    organizationId: string,
    from: Date,
    to: Date,
    assetIds: readonly string[],
  ): Promise<{ asset_id: string; assignment_count: number }[]> {
    if (assetIds.length === 0) return [];

    return this.client.$queryRaw<{ asset_id: string; assignment_count: number }[]>`
      SELECT asset_id, COUNT(*)::int AS assignment_count
      FROM assignment
      WHERE organization_id = ${organizationId}
        AND asset_id = ANY(${[...assetIds]}::text[])
        AND started_at <= ${to}
        AND (ended_at IS NULL OR ended_at >= ${from})
      GROUP BY asset_id
    `;
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  async findAvailabilityWindowById(id: string) {
    return this.client.availabilityWindow.findFirst({ where: { id } });
  }

  /**
   * Declared windows in force at `at`, for the given assets.
   *
   * "In force" means started, not yet finished, and not revoked. A revoked
   * window is kept rather than deleted, because "why was this machine
   * unavailable last March?" is a question a fleet manager will be asked.
   */
  async findWindowsInForce(at: Date, assetIds?: readonly string[]) {
    return this.client.availabilityWindow.findMany({
      where: {
        revokedAt: null,
        fromAt: { lte: at },
        OR: [{ toAt: null }, { toAt: { gte: at } }],
        ...(assetIds ? { assetId: { in: [...assetIds] } } : {}),
      },
      orderBy: { fromAt: 'desc' },
    });
  }

  async listAssetRefs(organizationId: string, query: AvailabilityQuery) {
    // AssetRef is platform-wide replica data: it has no request context when
    // written by the consumer, and it is not in TENANT_SCOPED_MODELS. The
    // organization filter is therefore applied here, explicitly, from the
    // verified request context — never from the replica's own contents.
    const rows = await runUnscoped(
      'asset reference replica is platform-wide; the tenant filter is applied explicitly below',
      () =>
        this.client.assetRef.findMany({
          where: {
            organizationId,
            ...(query.assetId ? { id: query.assetId } : {}),
            ...(query.cursor ? { id: { gt: query.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: query.limit + 1,
        }),
    );

    return page(rows, query.limit, (row) => row.id);
  }

  // -------------------------------------------------------------------------
  // Asset reference replica
  // -------------------------------------------------------------------------

  async findAssetRef(id: string, tx?: ExtendedPrismaClient) {
    return runUnscoped('asset reference replica is platform-wide, not tenant data', () =>
      (tx ?? this.client).assetRef.findFirst({ where: { id } }),
    );
  }

  /**
   * Several replica rows in one query.
   *
   * Exists so the utilization report does not call {@link findAssetRef} once
   * per asset. That version issued up to `limit` (200) round trips to decorate
   * a report with names — the textbook N+1, and the one query on this service
   * that grows with the size of the fleet rather than with the page.
   */
  async findAssetRefs(ids: readonly string[]) {
    if (ids.length === 0) return [];
    return runUnscoped('asset reference replica is platform-wide, not tenant data', () =>
      this.client.assetRef.findMany({ where: { id: { in: [...ids] } } }),
    );
  }

  async upsertAssetRef(
    tx: ExtendedPrismaClient,
    data: {
      id: string;
      organizationId: string;
      name?: string | null;
      assetType?: string | null;
      assetTag?: string | null;
      status?: string;
      inMaintenance?: boolean;
      dispatchBlockedReason?: string | null;
      dispatchBlockedAt?: Date | null;
      sourceEvent: string;
    },
  ) {
    const { id, sourceEvent, ...rest } = data;
    // Undefined keys are dropped rather than written, so an event that carries
    // only a status change cannot blank out a name recorded by an earlier one.
    const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));

    return runUnscoped('asset reference replica is platform-wide, written from events', () =>
      tx.assetRef.upsert({
        where: { id },
        create: {
          id,
          organizationId: data.organizationId,
          status: data.status ?? 'REGISTERED',
          ...patch,
          sourceEvent,
          syncedAt: new Date(),
        },
        update: { ...patch, sourceEvent, syncedAt: new Date() },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Consumer idempotency
  // -------------------------------------------------------------------------

  /**
   * Records that an event has been handled.
   *
   * Returns false when it was already recorded, which is the signal to skip.
   * Called inside the handler's transaction so the marker and the effect
   * commit together — a crash between them cannot leave the event marked
   * handled with nothing to show for it (docs/07 § 7.5).
   */
  async markEventProcessed(
    tx: ExtendedPrismaClient,
    eventId: string,
    consumerName: string,
  ): Promise<boolean> {
    try {
      await tx.processedEvent.create({ data: { eventId, consumerName } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

/** The constraint a unique violation hit, when Prisma reports one. */
export function violatedConstraint(error: unknown): string | undefined {
  if (!isUniqueViolation(error)) return undefined;
  const meta = (error as { meta?: { target?: unknown } }).meta;
  const target = meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(',');
  return undefined;
}

export interface UsageTotalRow {
  asset_id: string;
  total_hours: string;
  total_kilometres: string;
  record_count: number;
}

/**
 * Trims the over-fetched row and derives the cursor.
 *
 * Every list query asks for `limit + 1` rows: the extra row is how `hasMore`
 * is known without a second `COUNT(*)` over the same predicate.
 */
function page<T>(rows: T[], limit: number, cursorOf: (row: T) => string) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? cursorOf(last) : null,
    hasMore: rows.length > limit,
  };
}

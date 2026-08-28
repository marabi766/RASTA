import { Injectable } from '@nestjs/common';
import { buildOutboxRow, runUnscoped, type OutboxMessageInput } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import { OPEN_REQUEST_STATUSES } from './lifecycle';
import type { ListRepairOrdersQuery, ListRequestsQuery, ListSchedulesQuery } from './dto';

/**
 * Data access for maintenance.
 *
 * Tenant scoping is applied automatically by the Prisma extension, so the
 * queries here read as if they were single-tenant. The handful of places that
 * legitimately cross the boundary go through `runUnscoped` with a written
 * reason, which makes every one of them greppable — and in this service they
 * are exactly two kinds: the two reference replicas, which no authorization
 * decision consults, and the operational gauges, which no tenant ever sees.
 *
 * Raw SQL appears three times, each with `organization_id` filtered
 * explicitly. The Prisma extension cannot reach inside raw SQL, so a crossing
 * written that way would be invisible both to `grep -r runUnscoped` and to the
 * unscoped-query audit log — the finding fleet-service's release gate turned
 * up. Every raw query below either names the tenant in its `WHERE` or is
 * wrapped in `runUnscoped` with a reason.
 */
@Injectable()
export class MaintenanceRepository {
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
  // Schedules
  // -------------------------------------------------------------------------

  async findScheduleById(id: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).maintenanceSchedule.findFirst({ where: { id } });
  }

  async listSchedules(query: ListSchedulesQuery) {
    const rows = await this.client.maintenanceSchedule.findMany({
      where: {
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.maintenanceType ? { maintenanceType: query.maintenanceType } : {}),
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });

    return page(rows, query.limit, (row) => row.id);
  }

  /** Every schedule that is still evaluated, for the due listing. */
  async listActiveSchedules(assetId: string | undefined, cursor: string | undefined, take: number) {
    const rows = await this.client.maintenanceSchedule.findMany({
      where: {
        status: 'ACTIVE',
        ...(assetId ? { assetId } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: take + 1,
    });

    return page(rows, take, (row) => row.id);
  }

  /**
   * Schedules the announcement scan should look at, across every tenant.
   *
   * Deliberately unscoped: the scan is a background sweep with no request
   * context and no tenant of its own, and it publishes one event per schedule
   * back into that schedule's own organization. Narrowed to `ACTIVE` schedules
   * that have not already announced their current cycle, so a stable fleet
   * costs one bounded query per pass rather than growing with history
   * (ADR-027).
   */
  async claimUnannouncedSchedules(limit: number) {
    return runUnscoped(
      'the due-announcement scan is a background sweep across every tenant; it publishes into each schedule own organization',
      () =>
        this.client.maintenanceSchedule.findMany({
          where: { status: 'ACTIVE', dueAnnouncedAt: null },
          orderBy: { id: 'asc' },
          take: limit,
        }),
    );
  }

  /**
   * Active schedules for one machine.
   *
   * Tenant-scoped, and the caller is expected to already be inside the right
   * organization — the usage consumer enters the event's tenant before it gets
   * here. That is deliberate: a lookup by asset id alone would return another
   * organization's schedules if an asset id were ever reused, and relying on
   * "asset ids are globally unique" for a security property is relying on a
   * different service's invariant.
   */
  async findActiveSchedulesForAsset(assetId: string) {
    return this.client.maintenanceSchedule.findMany({
      where: { assetId, status: 'ACTIVE' },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Records that a schedule's current cycle has been announced.
   *
   * Guarded on the column still being null, and the affected-row count is what
   * the caller acts on. That single guard is what makes the scan safe to run
   * on every replica: two instances that both decide a schedule is due will
   * both attempt this, exactly one will update a row, and only that one
   * publishes. No lock, no leader election, no coordination (ADR-027).
   */
  async claimDueAnnouncement(
    tx: ExtendedPrismaClient,
    scheduleId: string,
    announcedAt: Date,
  ): Promise<boolean> {
    // Deliberately tenant-scoped, with no `runUnscoped` in sight. The scanner
    // enters each schedule's own organization before it gets here, so this
    // write is guarded by the same tenant extension as a write made through
    // the API — one fewer place where a background job is trusted more than a
    // request is.
    const result = await tx.maintenanceSchedule.updateMany({
      where: { id: scheduleId, dueAnnouncedAt: null },
      data: { dueAnnouncedAt: announcedAt },
    });

    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  async findRequestById(id: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).maintenanceRequest.findFirst({ where: { id } });
  }

  async findRequestWithDetail(id: string) {
    return this.client.maintenanceRequest.findFirst({
      where: { id },
      include: {
        repairOrders: { orderBy: { assignedAt: 'desc' } },
      },
    });
  }

  /** The live request for a schedule, so a due schedule is not raised twice. */
  async findOpenRequestForSchedule(scheduleId: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).maintenanceRequest.findFirst({
      where: { scheduleId, status: { in: [...OPEN_REQUEST_STATUSES] } },
    });
  }

  /** Open requests for a set of schedules, in one query rather than per row. */
  async findOpenRequestsForSchedules(scheduleIds: readonly string[]) {
    if (scheduleIds.length === 0) return [];
    return this.client.maintenanceRequest.findMany({
      where: {
        scheduleId: { in: [...scheduleIds] },
        status: { in: [...OPEN_REQUEST_STATUSES] },
      },
      select: { id: true, scheduleId: true },
    });
  }

  async listRequests(query: ListRequestsQuery, reportedBy?: string) {
    const constraints: object[] = [];
    if (query.cursor) constraints.push({ id: { lt: query.cursor } });
    if (query.from) constraints.push({ reportedAt: { gte: new Date(query.from) } });
    if (query.to) constraints.push({ reportedAt: { lte: new Date(query.to) } });

    const rows = await this.client.maintenanceRequest.findMany({
      where: {
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.scheduleId ? { scheduleId: query.scheduleId } : {}),
        ...(query.openOnly ? { status: { in: [...OPEN_REQUEST_STATUSES] } } : {}),
        ...(reportedBy ? { reportedBy } : {}),
        ...(constraints.length > 0 ? { AND: constraints } : {}),
      },
      // Newest first: a maintenance list is read backwards from what is
      // happening now. `id` is a ULID, so ordering by it is ordering by
      // creation time and gives a stable cursor without a second column.
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    return page(rows, query.limit, (row) => row.id);
  }

  // -------------------------------------------------------------------------
  // Repair orders
  // -------------------------------------------------------------------------

  async findRepairOrderById(id: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).repairOrder.findFirst({ where: { id } });
  }

  async findRepairOrderWithDetail(id: string) {
    return this.client.repairOrder.findFirst({
      where: { id },
      include: {
        parts: { orderBy: { recordedAt: 'asc' } },
        labour: { orderBy: { performedAt: 'asc' } },
        costs: { orderBy: { recordedAt: 'asc' } },
      },
    });
  }

  async listRepairOrders(query: ListRepairOrdersQuery) {
    const rows = await this.client.repairOrder.findMany({
      where: {
        ...(query.maintenanceRequestId ? { maintenanceRequestId: query.maintenanceRequestId } : {}),
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.workshopOrganizationId
          ? { workshopOrganizationId: query.workshopOrganizationId }
          : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    return page(rows, query.limit, (row) => row.id);
  }

  /**
   * Takes the row lock that serialises cost entry on one repair order.
   *
   * Every cost write recomputes the order's totals from its lines, and a
   * recompute is a read-modify-write: two concurrent part entries that both
   * read the same starting sum would each write a total missing the other's
   * line. Locking the parent row first makes the second transaction wait, and
   * — because PostgreSQL takes a fresh snapshot per statement under READ
   * COMMITTED — the sum it then reads includes the row the first one
   * committed.
   *
   * `organization_id` is in the predicate explicitly: the tenant extension
   * cannot rewrite raw SQL, so a lock taken without it would be a silent
   * cross-tenant reach even though it returns no data.
   */
  async lockRepairOrder(
    tx: ExtendedPrismaClient,
    id: string,
    organizationId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM repair_order
      WHERE id = ${id} AND organization_id = ${organizationId}
      FOR UPDATE
    `;
    return rows.length === 1;
  }

  /**
   * Sums a repair order's cost lines by category.
   *
   * Aggregated in the database rather than by loading every line: a long
   * repair can carry dozens of parts, and adding them up in JavaScript would
   * pull all of them across to produce four numbers. Cast to `text` so the
   * amounts arrive as exact decimal strings — a `bigint` column read through a
   * JSON number would be the one place in this service where money passes
   * through a float.
   */
  async sumCostsByCategory(
    tx: ExtendedPrismaClient,
    organizationId: string,
    where: { repairOrderId?: string; maintenanceRequestId?: string },
  ): Promise<{ category: string; total: bigint }[]> {
    const rows = where.repairOrderId
      ? await tx.$queryRaw<{ category: string; total: string }[]>`
          SELECT category::text AS category, COALESCE(SUM(amount_minor), 0)::text AS total
          FROM maintenance_cost
          WHERE organization_id = ${organizationId}
            AND repair_order_id = ${where.repairOrderId}
          GROUP BY category
        `
      : await tx.$queryRaw<{ category: string; total: string }[]>`
          SELECT category::text AS category, COALESCE(SUM(amount_minor), 0)::text AS total
          FROM maintenance_cost
          WHERE organization_id = ${organizationId}
            AND maintenance_request_id = ${where.maintenanceRequestId ?? ''}
          GROUP BY category
        `;

    return rows.map((row) => ({ category: row.category, total: BigInt(row.total) }));
  }

  // -------------------------------------------------------------------------
  // Reference replicas
  // -------------------------------------------------------------------------

  async findAssetRef(id: string, tx?: ExtendedPrismaClient) {
    return runUnscoped('asset reference replica is platform-wide, not tenant data', () =>
      (tx ?? this.client).assetRef.findFirst({ where: { id } }),
    );
  }

  /**
   * Several replica rows in one query.
   *
   * Exists so a schedule listing does not call {@link findAssetRef} once per
   * row to decorate it with a machine's name — the N+1 fleet-service's release
   * gate found in its utilization report, avoided here from the start.
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
      sourceEvent: string;
    },
  ) {
    const { id, sourceEvent, ...rest } = data;
    // Undefined keys are dropped rather than written, so an event that carries
    // only a status change cannot blank out a name recorded by an earlier one.
    // The bug this prevents was real in fleet-service: a `patch` key present
    // with an `undefined` value overwrote the resolved organization, and an
    // ASSET_CREATED whose tenant was only on the envelope wrote a row with no
    // organization at all.
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

  async findMeter(assetId: string, tx?: ExtendedPrismaClient) {
    return runUnscoped('usage meter is a read model keyed by asset, written from events', () =>
      (tx ?? this.client).assetUsageMeter.findFirst({ where: { assetId } }),
    );
  }

  async findMeters(assetIds: readonly string[]) {
    if (assetIds.length === 0) return [];
    return runUnscoped('usage meter is a read model keyed by asset, written from events', () =>
      this.client.assetUsageMeter.findMany({ where: { assetId: { in: [...assetIds] } } }),
    );
  }

  /**
   * Folds one usage reading into a machine's meter.
   *
   * The counters only ever move forward, and the SQL says so rather than the
   * caller: `GREATEST` of what the instrument reported and what we had plus
   * the period's delta. Doing it in the statement rather than in JavaScript
   * means a concurrent second reading cannot read the old value, compute from
   * it, and overwrite the first — the update is atomic against the row.
   *
   * Idempotency is *not* provided here. It comes from `processed_event`, in
   * the same transaction: this statement is not idempotent on its own and must
   * never be called without that marker, or a redelivered event would add its
   * hours a second time and defer a service that is due.
   */
  async foldUsageIntoMeter(
    tx: ExtendedPrismaClient,
    input: {
      assetId: string;
      organizationId: string;
      hoursDelta: string;
      kilometresDelta: string;
      reportedHourMeter: string | null;
      reportedOdometer: string | null;
      usageRecordId: string;
      periodEnd: Date | null;
      now: Date;
    },
  ): Promise<void> {
    await runUnscoped(
      'usage meter is a read model keyed by asset; the event tenant is written explicitly',
      async () => {
        await tx.$executeRaw`
          INSERT INTO asset_usage_meter (
            asset_id, organization_id, hour_meter, odometer,
            last_usage_record_id, last_period_end, record_count, updated_at
          )
          VALUES (
            ${input.assetId},
            ${input.organizationId},
            GREATEST(${input.hoursDelta}::numeric, COALESCE(${input.reportedHourMeter}::numeric, 0)),
            GREATEST(${input.kilometresDelta}::numeric, COALESCE(${input.reportedOdometer}::numeric, 0)),
            ${input.usageRecordId},
            ${input.periodEnd},
            1,
            ${input.now}
          )
          ON CONFLICT (asset_id) DO UPDATE SET
            hour_meter = GREATEST(
              asset_usage_meter.hour_meter + ${input.hoursDelta}::numeric,
              COALESCE(${input.reportedHourMeter}::numeric, 0)
            ),
            odometer = GREATEST(
              asset_usage_meter.odometer + ${input.kilometresDelta}::numeric,
              COALESCE(${input.reportedOdometer}::numeric, 0)
            ),
            last_usage_record_id = ${input.usageRecordId},
            last_period_end = ${input.periodEnd},
            record_count = asset_usage_meter.record_count + 1,
            updated_at = ${input.now}
        `;
      },
    );
  }

  // -------------------------------------------------------------------------
  // Operational gauges
  // -------------------------------------------------------------------------

  /**
   * How many requests are open across the whole deployment.
   *
   * Feeds a Prometheus gauge, so it deliberately spans tenants — no tenant
   * ever sees the number. It goes through `runUnscoped` and the Prisma model
   * API rather than raw SQL for one reason: raw SQL is not intercepted by the
   * tenant extension, so a crossing written that way is invisible both to
   * `grep -r runUnscoped` and to the unscoped-query audit log. The audit story
   * only works if every crossing is enumerable, including the harmless ones.
   */
  async countOpenRequestsAcrossTenants(): Promise<number> {
    return runUnscoped('operational gauge across the deployment; never returned to a tenant', () =>
      this.client.maintenanceRequest.count({
        where: { status: { in: [...OPEN_REQUEST_STATUSES] } },
      }),
    );
  }

  /** How many requests are awaiting the owner's approval, deployment-wide. */
  async countAwaitingApprovalAcrossTenants(): Promise<number> {
    return runUnscoped('operational gauge across the deployment; never returned to a tenant', () =>
      this.client.maintenanceRequest.count({ where: { status: 'COMPLETED' } }),
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

/**
 * The constraint a unique violation hit, when Prisma reports one.
 *
 * Prisma does **not** report the index name: for a `P2002` it puts the indexed
 * *columns* in `meta.target`, and the index name appears nowhere. Code that
 * translates a violation into a business error must therefore match on the
 * column — matching on the index name silently never matches, which is exactly
 * the bug that lived undetected in fleet-service until its first real
 * integration run.
 */
export function violatedConstraint(error: unknown): string | undefined {
  if (!isUniqueViolation(error)) return undefined;
  const meta = (error as { meta?: { target?: unknown } }).meta;
  const target = meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(',');
  return undefined;
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

import { Injectable } from '@nestjs/common';
import {
  allocateStreamSeqSql,
  buildOutboxRow,
  runUnscoped,
  type OutboxMessageInput,
} from '@rasta/nest-common';
import { resolvePartitionKey } from './routing';
import type { FleetEventName } from './events';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import type { InsuranceCover } from './dispatch-blocks';
import type {
  AvailabilityQuery,
  ListAssignmentsQuery,
  ListAvailabilityWindowsQuery,
  ListDriversQuery,
  ListUsageQuery,
  UtilizationQuery,
} from './dto';

/** Expired release tombstones removed per release or clearance (ADR-062 § 2). */
const RELEASE_PURGE_BATCH = 100;

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

  transaction<T>(
    fn: (tx: ExtendedPrismaClient) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    return this.prisma.transaction(fn, options);
  }

  async enqueueEvent(tx: ExtendedPrismaClient, input: OutboxMessageInput): Promise<string> {
    // ADR-051 B3, in the order the ADR requires: routing is final *first*, the
    // sequence is allocated against that exact `(topic, partitionKey)` pair
    // *second*, and only then is the row built and inserted. All three happen
    // inside the caller's transaction, so the counter row lock is held to its
    // commit — which is what makes allocation order equal commit order, and is
    // this service's only serialisation point on the stream boundary.
    const partition = resolvePartitionKey(input.eventName as FleetEventName, input.payload);
    const streamSeq = await allocateStreamSeqSql(tx, input.topic, partition.key);

    const row = buildOutboxRow(
      { ...input, partitionKey: partition.key, streamSeq, streamKey: partition.key },
      {
        producer: SERVICE_NAME,
        producerVersion: process.env.SERVICE_VERSION ?? '0.1.0',
      },
    );

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
        streamSeq: row.streamSeq,
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

  /**
   * Ends every active assignment on a machine that has left its organization.
   * Used by the asset-sync consumer on `ASSET_TRANSFERRED`.
   *
   * Unscoped, keyed by asset. The consumer's context carries the transfer
   * event's tenant, not necessarily the organization that holds the
   * assignment, and the whole point is that no assignment survives the
   * transfer, whoever holds it. Each ended row keeps its own
   * `organizationId`; the caller publishes the release under that tenant.
   *
   * An assignment is ended at `at`, or at its own start if it began later.
   * That happens when it started in the window before asset-service saw the
   * transfer, and an end before the start is not a period.
   *
   * Guarded on `ended_at IS NULL` like {@link AssignmentService.end}: a row
   * that a person ended in the meantime is left alone and is not returned, so
   * its release is not published twice. Must be called after
   * {@link lockAssetRef} in the same transaction, which keeps a new
   * assignment from being created between this and the replica update.
   */
  async endActiveAssignmentsForAsset(
    tx: ExtendedPrismaClient,
    assetId: string,
    at: Date,
    endedBy: string,
    reason: 'ASSET_UNAVAILABLE',
    notes: string,
  ) {
    return runUnscoped(
      "a transferred machine leaves its owner's dispatch; its active assignments end whoever holds them",
      async () => {
        const active = await tx.assignment.findMany({
          where: { assetId, endedAt: null },
          orderBy: { id: 'asc' },
        });

        const ended: ((typeof active)[number] & { endedAt: Date })[] = [];
        for (const assignment of active) {
          const endedAt = assignment.startedAt > at ? assignment.startedAt : at;
          const result = await tx.assignment.updateMany({
            where: { id: assignment.id, endedAt: null },
            data: { endedAt, endedBy, endReason: reason, endNotes: notes },
          });
          if (result.count === 1) ended.push({ ...assignment, endedAt });
        }
        return ended;
      },
    );
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  /** Whether an assignment is open on the machine, in the caller's organization. Scoped. */
  async hasActiveAssignment(assetId: string): Promise<boolean> {
    return (await this.client.assignment.count({ where: { assetId, endedAt: null } })) > 0;
  }

  async findUsageById(id: string) {
    return this.client.usageRecord.findFirst({ where: { id } });
  }

  async findUsageByClientReference(clientReference: string) {
    return this.client.usageRecord.findFirst({ where: { clientReference } });
  }

  /**
   * Serialises every writer for one asset until the transaction ends. Three
   * callers: usage submission, so two concurrent submissions for the same
   * machine cannot both pass the overlap check before either has inserted
   * (L3-05); assignment, so a dispatch block that commits a moment earlier is
   * seen before the insert; and the asset-sync consumer, so two safety events
   * for one machine cannot each build on a copy of the row that lacks the
   * other's change (L3-02).
   *
   * A transaction-scoped advisory lock keyed by the asset id, not only a row
   * lock. `FOR UPDATE` on a row that does not exist yet locks nothing, so two
   * events that are the first sighting of a machine would both read "no row"
   * and the second upsert would overwrite the first. The advisory lock exists
   * whether or not the row does. The row lock is still taken, so a writer
   * that locks only the row is ordered too.
   *
   * Raw SQL because Prisma has no expression for either lock. Unscoped
   * because the replica is platform-wide, not tenant data. Callers that act
   * for a tenant re-read the row after this and check its organization.
   */
  async lockAssetRef(tx: ExtendedPrismaClient, assetId: string): Promise<void> {
    await runUnscoped(
      'serializes concurrent writers for one asset; the replica row is the only per-asset row this service owns',
      async () => {
        // `SELECT 1 FROM`, because Prisma cannot read back the `void` the
        // function returns.
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`asset_ref:${assetId}`}, 0))`;
        await tx.$queryRaw`SELECT id FROM asset_ref WHERE id = ${assetId} FOR UPDATE`;
      },
    );
  }

  // -------------------------------------------------------------------------
  // Transfer fence (ADR-062)
  //
  // Raw SQL, all of it: the expiry is compared with the database's clock, the
  // same one that set it, and never with this process's. The table is keyed by
  // the asset, not scoped by tenant, because the check that reads it must see
  // a fence whichever organization's work is asking. Every caller holds
  // `lockAssetRef` first.
  // -------------------------------------------------------------------------

  /** Active assignments on one machine in the caller's organization. Scoped. */
  async countActiveAssignmentsForAsset(tx: ExtendedPrismaClient, assetId: string) {
    return tx.assignment.count({ where: { assetId, endedAt: null } });
  }

  /**
   * Places the fence, or renews it for the same transfer. Returns its expiry,
   * or `null` when any other fence stands on the machine — live or expired.
   *
   * An expired fence is never taken over here (review #127 #2): whether its
   * transfer landed is asked of asset-service first
   * ({@link settleExpiredFence}), and only a NOT_RECORDED answer removes it.
   */
  async placeTransferFence(
    tx: ExtendedPrismaClient,
    assetId: string,
    organizationId: string,
    fenceId: string,
    ttlSeconds: number,
  ): Promise<Date | null> {
    const rows = await tx.$queryRaw<{ expires_at: Date }[]>`
      INSERT INTO asset_transfer_fence (asset_id, organization_id, fence_id, expires_at, created_at)
      VALUES (${assetId}, ${organizationId}, ${fenceId},
              now() + make_interval(secs => ${ttlSeconds}::int), now())
      ON CONFLICT (asset_id) DO UPDATE
        SET expires_at = EXCLUDED.expires_at,
            created_at = EXCLUDED.created_at
        WHERE asset_transfer_fence.fence_id = EXCLUDED.fence_id
          AND asset_transfer_fence.organization_id = EXCLUDED.organization_id
      RETURNING expires_at`;
    return rows[0]?.expires_at ?? null;
  }

  /**
   * Whether any fence stands on the machine, live or expired. An expired one
   * still refuses an assignment: expiry is not an answer (ADR-062 § 3b).
   */
  async hasTransferFence(tx: ExtendedPrismaClient, assetId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ fence_id: string }[]>`
      SELECT fence_id FROM asset_transfer_fence WHERE asset_id = ${assetId}`;
    return rows.length > 0;
  }

  /** The machine's fence, if any, and whether it has expired by the database's clock. */
  async findTransferFence(
    assetId: string,
    tx?: ExtendedPrismaClient,
  ): Promise<{ fenceId: string; organizationId: string; expired: boolean } | null> {
    // A caller inside a transaction passes it: reading through the pool from
    // there needs a second connection, which a one-connection or saturated
    // pool never grants while the transaction is open.
    const rows = await (tx ?? this.client).$queryRaw<
      { fence_id: string; organization_id: string; expired: boolean }[]
    >`
      SELECT fence_id, organization_id, expires_at <= now() AS expired
      FROM asset_transfer_fence WHERE asset_id = ${assetId}`;
    const row = rows[0];
    return row
      ? { fenceId: row.fence_id, organizationId: row.organization_id, expired: row.expired }
      : null;
  }

  /**
   * Removes one expired fence whose transfer asset-service says was not
   * recorded, under {@link lockAssetRef}. Only that fence, and only while
   * expired: a fence renewed or replaced in between is left alone.
   */
  async clearExpiredFence(assetId: string, fenceId: string): Promise<void> {
    await this.transaction(async (tx) => {
      await this.lockAssetRef(tx, assetId);
      await tx.$executeRaw`
        DELETE FROM asset_transfer_fence
        WHERE asset_id = ${assetId} AND fence_id = ${fenceId} AND expires_at <= now()`;
    });
  }

  /**
   * Lifts one transfer's fence and remembers that the transfer was released.
   * Only the organization that placed it can.
   *
   * Under the per-asset lock the clearance holds while it counts and fences
   * (review #127 #4): a release that arrives while that clearance is still
   * running waits for its fence and removes it. And one that arrives before
   * the clearance has taken the lock at all leaves a tombstone the clearance
   * then finds, so it fences nothing (review #127 round 2, #2). The
   * tombstone outlives the longest fence. Expired ones are removed after the
   * commit, never in here ({@link purgeExpiredReleases}).
   */
  async releaseTransferFence(
    assetId: string,
    organizationId: string,
    fenceId: string,
    keepSeconds: number,
  ): Promise<number> {
    return this.transaction(async (tx) => {
      await this.lockAssetRef(tx, assetId);
      await tx.$executeRaw`
        INSERT INTO asset_transfer_release
          (asset_id, fence_id, organization_id, released_at, expires_at)
        VALUES (${assetId}, ${fenceId}, ${organizationId}, now(),
                now() + make_interval(secs => ${keepSeconds}::int))
        ON CONFLICT (asset_id, fence_id) DO NOTHING`;
      return tx.$executeRaw`
        DELETE FROM asset_transfer_fence
        WHERE asset_id = ${assetId} AND organization_id = ${organizationId} AND fence_id = ${fenceId}`;
    });
  }

  /**
   * Removes one fence, in the caller's transaction and under its
   * {@link lockAssetRef}. The caller has established that asset-service records
   * the transfer the fence was placed for (D-039).
   */
  async deleteTransferFence(
    tx: ExtendedPrismaClient,
    assetId: string,
    fenceId: string,
  ): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM asset_transfer_fence WHERE asset_id = ${assetId} AND fence_id = ${fenceId}`;
  }

  /** The transfer landed: whatever the previous owner fenced is moot. */
  async dropTransferFences(
    tx: ExtendedPrismaClient,
    assetId: string,
    organizationId: string,
  ): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM asset_transfer_fence
      WHERE asset_id = ${assetId} AND organization_id = ${organizationId}`;
  }

  /**
   * Removes a bounded batch of expired release tombstones, of any machine,
   * oldest first (review #127 round 3, #1), so the table stays as small as
   * the releases of the last hour. A clearance cannot outlive a tombstone
   * (ADR-062 § 2), so an expired one protects nothing.
   *
   * Its own short transaction, run after a release or clearance has
   * committed — never inside one (review #127 round 4, #2). Inside the
   * per-asset lock, a DELETE of other machines' rows could wait on a row
   * locked elsewhere: stalling this machine, letting a release time out and
   * roll back without its tombstone, and ordering locks across machines.
   * `SKIP LOCKED` leaves a row someone else holds for a later purge, so this
   * never waits on one either.
   */
  async purgeExpiredReleases(): Promise<number> {
    return this.transaction(
      (tx) => tx.$executeRaw`
        DELETE FROM asset_transfer_release
        WHERE (asset_id, fence_id) IN (
          SELECT asset_id, fence_id FROM asset_transfer_release
          WHERE expires_at < now()
          ORDER BY expires_at
          LIMIT ${RELEASE_PURGE_BATCH}
          FOR UPDATE SKIP LOCKED
        )`,
    );
  }

  /** Whether this organization released this transfer on this machine, and the tombstone is live. Under the lock. */
  async isTransferReleased(
    tx: ExtendedPrismaClient,
    assetId: string,
    organizationId: string,
    fenceId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ fence_id: string }[]>`
      SELECT fence_id FROM asset_transfer_release
      WHERE asset_id = ${assetId} AND organization_id = ${organizationId} AND fence_id = ${fenceId}
        AND expires_at > now()`;
    return rows.length > 0;
  }

  /**
   * Any existing record for this asset whose period overlaps the given one.
   *
   * The standard interval-overlap test: two periods overlap exactly when each
   * starts before the other ends. Scoped by asset only, not by driver — two
   * different drivers cannot both have been operating the same machine at
   * once either, and the audit's own reproduction uses two different
   * `clientReference`s on the same asset.
   *
   * Not by tenant either. A machine transferred mid-shift has records under
   * two organizations, and maintenance-service adds every accepted period to
   * one meter per asset, so an overlap across the transfer would count the
   * same hour twice. Unscoped for that reason; the caller must not show a
   * conflicting record that belongs to another organization.
   *
   * Must be called after {@link lockAssetRef} in the same transaction, or two
   * concurrent calls can both see no overlap and both insert.
   */
  async findOverlappingUsage(
    tx: ExtendedPrismaClient,
    assetId: string,
    periodStart: Date,
    periodEnd: Date,
  ) {
    return runUnscoped(
      'usage periods of one machine must not overlap across owners; the maintenance meter is per asset',
      () =>
        tx.usageRecord.findFirst({
          where: {
            assetId,
            periodStart: { lt: periodEnd },
            periodEnd: { gt: periodStart },
          },
          select: { id: true, organizationId: true },
        }),
    );
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
   * A machine's windows, newest first. Ids are `AVW_<ULID>`: they sort by
   * creation, so the id is the cursor and no second sort key is needed.
   */
  async listAvailabilityWindows(query: ListAvailabilityWindowsQuery) {
    const rows = await this.client.availabilityWindow.findMany({
      where: {
        assetId: query.assetId,
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    return page(rows, query.limit, (row) => row.id);
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
      inspectionBlockedReason?: string | null;
      inspectionBlockedAt?: Date | null;
      inspectionResolvedAt?: Date | null;
      insuranceLapsedCoverages?: string[];
      insuranceLapsedAt?: Date | null;
      insuranceCover?: InsuranceCover;
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

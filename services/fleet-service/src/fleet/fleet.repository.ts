import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import {
  allocateStreamSeqSql,
  buildOutboxRow,
  createSystemContext,
  runUnscoped,
  runWithContext,
  type OutboxMessageInput,
} from '@rasta/nest-common';
import { resolvePartitionKey } from './routing';
import type { FleetEventName } from './events';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import { Prisma } from '../generated/prisma';
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
    options?: { timeoutMs?: number; maxWaitMs?: number },
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

  /**
   * Enqueues a dead letter in the caller's transaction (#240 r9, ADR-021): the
   * outbox relay publishes it to its topic once that transaction commits, and
   * never if it rolls back. The row carries the original envelope, key and
   * headers as they are to be published; its id is fresh, never the event's —
   * a replayed event can be dead-lettered again. No stream sequence: a dead
   * letter is in no fleet stream.
   */
  async enqueueDeadLetter(
    tx: ExtendedPrismaClient,
    letter: DeadLetterOutboxInput,
  ): Promise<string> {
    const id = ulid();
    await tx.outboxMessage.create({
      data: {
        id,
        aggregateType: letter.envelope.aggregateType,
        aggregateId: letter.envelope.aggregateId,
        eventName: letter.envelope.eventName,
        eventVersion: letter.envelope.eventVersion,
        topic: letter.topic,
        partitionKey: letter.key,
        payload: letter.envelope as unknown as Prisma.InputJsonValue,
        headers: letter.headers,
        organizationId: letter.organizationId,
        correlationId: letter.envelope.correlationId,
      },
    });
    return id;
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

  /**
   * Scoped: a reference is the tenant's. With `tx`, read inside the usage
   * transaction — after the asset lock, so a twin request that held the lock
   * and committed is seen.
   */
  async findUsageByClientReference(clientReference: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).usageRecord.findFirst({ where: { clientReference } });
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

  /**
   * Which of these machines have a transfer fence standing, live or expired —
   * the same test assignment applies (ADR-062 § 3b), for a listing.
   */
  async findFencedAssetIds(assetIds: readonly string[]): Promise<Set<string>> {
    if (assetIds.length === 0) return new Set();
    const rows = await this.client.$queryRaw<{ asset_id: string }[]>`
      SELECT asset_id FROM asset_transfer_fence WHERE asset_id = ANY(${[...assetIds]}::text[])`;
    return new Set(rows.map((row) => row.asset_id));
  }

  /**
   * The database's clock *now*. `clock_timestamp()`, not `now()`: `now()` is
   * the transaction's start, so an assignment whose transaction began before a
   * policy ended but got the asset's lock after it would still pass. Read after
   * {@link lockAssetRef}, as the last check before the insert. Application
   * hosts with skewed clocks do not decide who is insured either.
   */
  async databaseNow(tx: ExtendedPrismaClient): Promise<Date> {
    const [row] = await tx.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
    return row.now;
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

  /**
   * Revokes every live window an organization declared on a machine that has
   * since left it (review #225 round 1 finding 4, round 2), and returns what it
   * revoked so the caller can publish each withdrawal. A window declared before
   * the transfer is revoked too, so it cannot block the machine again if it
   * returns to that organization.
   *
   * Unscoped, keyed by asset and the previous owner: the consumer's context
   * carries the new owner's tenant, and the rows belong to the old one. Guarded
   * on `revoked_at IS NULL` so a person's concurrent revoke is left alone and
   * not returned. Must be called after {@link lockAssetRef} in the same
   * transaction.
   */
  async revokeWindowsAfterTransfer(
    tx: ExtendedPrismaClient,
    assetId: string,
    previousOrganizationId: string,
    revokedAt: Date,
    revokedBy: string,
    reason: 'ASSET_TRANSFERRED',
  ) {
    return runUnscoped(
      "windows declared by the previous owner after a transfer are revoked whoever's context runs the consumer",
      async () => {
        const live = await tx.availabilityWindow.findMany({
          where: {
            assetId,
            organizationId: previousOrganizationId,
            revokedAt: null,
          },
          orderBy: { id: 'asc' },
        });

        const revoked: typeof live = [];
        for (const window of live) {
          const result = await tx.availabilityWindow.updateMany({
            where: { id: window.id, revokedAt: null },
            data: { revokedAt, revokedBy, revokeReason: reason },
          });
          if (result.count === 1)
            revoked.push({ ...window, revokedAt, revokedBy, revokeReason: reason });
        }
        return revoked;
      },
    );
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

  /**
   * The replica row of a machine **of that organization**; absent and another
   * tenant's are the same `null`. The read every request path uses (AGENTS.md
   * A-04): the organization is part of the query, so a row of another tenant
   * is never loaded into this one's request, whatever the caller then does
   * with it.
   */
  async findAssetRef(organizationId: string, id: string, tx?: ExtendedPrismaClient) {
    return runUnscoped(
      'asset reference replica is platform-wide; the tenant filter is applied explicitly below',
      () => (tx ?? this.client).assetRef.findFirst({ where: { id, organizationId } }),
    );
  }

  /**
   * The replica row of a machine whoever owns it. Not for a request that acts
   * for a tenant: only the event consumer, which writes the replica for every
   * tenant and must see a row it may not own, and the transfer clearance,
   * which has to tell a machine that is elsewhere from one never seen.
   */
  async findAssetRefUnscoped(id: string, tx?: ExtendedPrismaClient) {
    return runUnscoped(
      'asset reference replica is platform-wide; the caller decides about ownership itself',
      () => (tx ?? this.client).assetRef.findFirst({ where: { id } }),
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
  async findAssetRefs(organizationId: string, ids: readonly string[]) {
    if (ids.length === 0) return [];
    return runUnscoped(
      'asset reference replica is platform-wide; the tenant filter is applied explicitly below',
      () => this.client.assetRef.findMany({ where: { organizationId, id: { in: [...ids] } } }),
    );
  }

  /**
   * One keyset page of the transferred replica rows `insurance:clear-transferred`
   * targets, by id after `after` — those with nothing left to empty included
   * (#240 r11): each has its invalidation epoch moved. Candidates only:
   * {@link clearInsuranceCover} decides each under the asset's lock.
   */
  async listClearableInsuranceRefs(
    options: ClearableInsuranceOptions & { after: string; limit: number },
  ): Promise<ClearableInsuranceRef[]> {
    return runUnscoped(
      'operator command over the platform-wide replica; the organization filter is applied in the predicate',
      () =>
        this.client.$queryRaw<ClearableInsuranceRef[]>`
          SELECT r.id, r.organization_id AS "organizationId", ${holdsInsurance} AS "holdsInsurance"
            FROM asset_ref r
           WHERE r.id > ${options.after} AND ${transferredPredicate(options)}
           ORDER BY r.id
           LIMIT ${options.limit}`,
    );
  }

  /**
   * Empties one transferred replica row's insurance windows and increments its
   * invalidation epoch, if it is still targeted. Under {@link lockAssetRef} in
   * the caller's transaction, so a transfer or an event committed since the page
   * was read is seen. The retained-coverage list is emptied in the same update:
   * a delayed old-owner event for a coverage that followed at transfer time
   * would otherwise still be exempted from the owner check and restore a window
   * for the new owner. Lapses and the generation are left as they are.
   *
   * The epoch moves on EVERY row, also one whose windows and retained list were
   * already empty (#240 r11): there the update changes no value the
   * `insurance_revision` trigger counts, and an answer asset-service gave under
   * the previous rule would otherwise still match the row. With the epoch moved,
   * a verification that read the row before this commit cannot apply after it.
   *
   * Returns the row's owner and whether it held anything to empty, or null when
   * it no longer qualifies.
   */
  async clearInsuranceCover(
    tx: ExtendedPrismaClient,
    assetId: string,
    options: ClearableInsuranceOptions,
  ): Promise<{ organizationId: string; holdsInsurance: boolean } | null> {
    // `before` is read in the statement's snapshot, so it shows the row as it
    // was before this update; the caller holds the asset's lock.
    const rows = await runUnscoped(
      'operator command over the platform-wide replica; the organization filter is applied in the predicate',
      () =>
        tx.$queryRaw<{ organizationId: string; holdsInsurance: boolean }[]>`
          WITH before AS (
            SELECT r.id, ${holdsInsurance} AS holds FROM asset_ref r
             WHERE r.id = ${assetId} AND ${transferredPredicate(options)}
          )
          UPDATE asset_ref a
             SET insurance_cover = '{}'::jsonb, retained_coverages = '{}',
                 insurance_epoch = a.insurance_epoch + 1, synced_at = now()
            FROM before
           WHERE a.id = before.id
          RETURNING a.organization_id AS "organizationId", before.holds AS "holdsInsurance"`,
    );
    return rows[0] ?? null;
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
      ownershipGeneration?: number | null;
      retainedCoverages?: string[];
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
  // Parked insurance events (#240 r8)
  //
  // Written under the envelope's tenant; read and removed by machine or by age,
  // whichever tenant parked them, under `runUnscoped`. Every mutation of a row
  // happens under `lockAssetRef` for its machine, so the transfer's handler and
  // the sweep (on any instance) never change the same row at once.
  // -------------------------------------------------------------------------

  /**
   * Parks an event, in the caller's transaction and under the envelope's tenant
   * (the tenant guard writes `organization_id` from that context). Called after
   * the event's `processed_event` marker in the same transaction, so a
   * redelivery stops at the marker and never parks it twice.
   */
  async parkInsuranceEvent(tx: ExtendedPrismaClient, row: ParkedInsuranceInput): Promise<void> {
    const context = createSystemContext({
      correlationId: row.correlationId,
      organizationId: row.organizationId,
      callerService: SERVICE_NAME,
    });
    // Awaited inside the context: a Prisma query is lazy and would otherwise run
    // after the context closed (test/helpers.ts `asActor`).
    await runWithContext(context, async () => {
      await tx.insurancePendingVerification.create({
        data: {
          eventId: row.eventId,
          assetId: row.assetId,
          // Stated, and held by the guard to the context's tenant: the same one.
          organizationId: row.organizationId,
          envelope: row.envelope as Prisma.InputJsonValue,
          messageKey: row.messageKey,
          sourceTopic: row.sourceTopic,
          sourcePartition: row.sourcePartition,
          sourceOffset: row.sourceOffset,
          reason: row.reason,
        },
      });
    });
  }

  /**
   * One parked event, read under {@link lockAssetRef}. `due` says whether the
   * sweep may try it now: made due by its machine's transfer, or parked and last
   * tried at least `minAgeSeconds` ago, by the database's clock — so a second
   * instance's sweep that listed it before this one tried it leaves it alone.
   */
  async findParkedInsurance(
    tx: ExtendedPrismaClient,
    eventId: string,
    minAgeSeconds: number,
  ): Promise<ParkedInsurance | null> {
    const rows = await runUnscoped(
      'a parked insurance event is decided by machine, whichever tenant parked it',
      () =>
        tx.$queryRaw<RawParkedInsurance[]>`
          SELECT event_id, asset_id, organization_id, envelope, message_key, source_topic,
                 source_partition, source_offset, reason, attempts,
                 (COALESCE(next_attempt_at <= now(), false)
                  OR (first_seen_at <= now() - make_interval(secs => ${minAgeSeconds}::int)
                      AND (last_attempt_at IS NULL
                           OR last_attempt_at <= now() - make_interval(secs => ${minAgeSeconds}::int)))) AS due
            FROM insurance_pending_verification
           WHERE event_id = ${eventId}`,
    );
    const row = rows[0];
    return row
      ? {
          eventId: row.event_id,
          assetId: row.asset_id,
          organizationId: row.organization_id,
          envelope: row.envelope,
          messageKey: row.message_key,
          sourceTopic: row.source_topic,
          sourcePartition: row.source_partition,
          sourceOffset: row.source_offset,
          reason: row.reason,
          attempts: row.attempts,
          due: row.due,
        }
      : null;
  }

  /**
   * Makes every parked event of one machine due now, whichever tenant parked it
   * (#240 r10): its transfer committed, so the sweep decides them on its next
   * run. In the transfer's transaction, under {@link lockAssetRef}; one
   * statement, asking nobody. Returns how many.
   */
  async markParkedInsuranceDue(tx: ExtendedPrismaClient, assetId: string): Promise<number> {
    return runUnscoped(
      'a transfer makes every parked insurance event of the machine due, whichever tenant parked it',
      () =>
        tx.$executeRaw`
          UPDATE insurance_pending_verification SET next_attempt_at = now()
           WHERE asset_id = ${assetId}`,
    );
  }

  /**
   * The sweep's batch: made due by a transfer, or parked and last tried at least
   * `minAgeSeconds` ago, by the database's clock. Those a transfer made due
   * first, then the oldest.
   */
  async listDueParkedInsurance(
    minAgeSeconds: number,
    limit: number,
  ): Promise<{ eventId: string; assetId: string }[]> {
    const rows = await runUnscoped(
      'the parked-insurance sweep spans every tenant; each row is decided under its machine’s lock',
      () =>
        this.client.$queryRaw<{ event_id: string; asset_id: string }[]>`
          SELECT event_id, asset_id FROM insurance_pending_verification
           WHERE next_attempt_at <= now()
              OR (first_seen_at <= now() - make_interval(secs => ${minAgeSeconds}::int)
                  AND (last_attempt_at IS NULL
                       OR last_attempt_at <= now() - make_interval(secs => ${minAgeSeconds}::int)))
           ORDER BY next_attempt_at IS NULL, first_seen_at, event_id
           LIMIT ${limit}`,
    );
    return rows.map((row) => ({ eventId: row.event_id, assetId: row.asset_id }));
  }

  /**
   * Counts one more attempt that left the event parked, and why; a mark made by
   * a transfer is spent, and the age rule applies again. Returns the attempts so far.
   */
  async recordParkedAttempt(
    tx: ExtendedPrismaClient,
    eventId: string,
    reason: string,
  ): Promise<number> {
    const rows = await runUnscoped(
      'a parked insurance event is decided by machine, whichever tenant parked it',
      () =>
        tx.$queryRaw<{ attempts: number }[]>`
          UPDATE insurance_pending_verification
             SET attempts = attempts + 1, last_attempt_at = now(), next_attempt_at = NULL,
                 reason = ${reason}
           WHERE event_id = ${eventId}
          RETURNING attempts`,
    );
    return rows[0]?.attempts ?? 0;
  }

  /** Removes a parked event: applied, definitively rejected, or dead-lettered. */
  async deleteParkedInsurance(tx: ExtendedPrismaClient, eventId: string): Promise<boolean> {
    const result = await runUnscoped(
      'a parked insurance event is decided by machine, whichever tenant parked it',
      () => tx.insurancePendingVerification.deleteMany({ where: { eventId } }),
    );
    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // Consumer idempotency
  // -------------------------------------------------------------------------

  /**
   * Forgets that an event was handled, so a replay of it is applied. Only for
   * an event this consumer acknowledged without applying and has now
   * dead-lettered (a parked insurance event whose attempts ran out).
   */
  async unmarkEventProcessed(
    tx: ExtendedPrismaClient,
    eventId: string,
    consumerName: string,
  ): Promise<void> {
    await tx.processedEvent.deleteMany({ where: { eventId, consumerName } });
  }

  /**
   * Whether an event is already marked handled, read outside any transaction.
   * Only to skip work that would be wasted (asking asset-service about a
   * redelivered event); the marker itself is still written, and decides, in the
   * handler's transaction.
   */
  async isEventProcessed(eventId: string, consumerName: string): Promise<boolean> {
    return (await this.client.processedEvent.count({ where: { eventId, consumerName } })) > 0;
  }

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

/** A dead letter for the outbox (#240 r9): published as `key`, `envelope` and `headers` to `topic`. */
export interface DeadLetterOutboxInput {
  topic: string;
  key: string;
  envelope: EventEnvelope;
  headers: Record<string, string>;
  /** The original envelope's tenant. */
  organizationId: string;
}

/** What parking an `INSURANCE_RECORDED` stores (#240 r8). */
export interface ParkedInsuranceInput {
  eventId: string;
  assetId: string;
  /** The envelope's tenant. */
  organizationId: string;
  correlationId: string;
  envelope: unknown;
  messageKey: string | null;
  sourceTopic: string;
  sourcePartition: number | null;
  sourceOffset: string | null;
  reason: string;
}

export interface ParkedInsurance {
  eventId: string;
  assetId: string;
  organizationId: string;
  envelope: unknown;
  messageKey: string | null;
  sourceTopic: string;
  sourcePartition: number | null;
  sourceOffset: string | null;
  reason: string;
  attempts: number;
  /** Whether the sweep may try it now (see `findParkedInsurance`). */
  due: boolean;
}

interface RawParkedInsurance {
  event_id: string;
  asset_id: string;
  organization_id: string;
  envelope: unknown;
  message_key: string | null;
  source_topic: string;
  source_partition: number | null;
  source_offset: string | null;
  reason: string;
  attempts: number;
  due: boolean;
}

export interface ClearableInsuranceOptions {
  /** Also the rows whose ownership generation is NULL (after a rollback of the generation migration). */
  includeUnknownGeneration: boolean;
  /** Only machines this organization owns **now**. */
  organizationId?: string;
}

/** A replica row `insurance:clear-transferred` targets, as a page names it. */
export interface ClearableInsuranceRef {
  id: string;
  organizationId: string;
  /** Whether it holds a window or a retained coverage to empty. */
  holdsInsurance: boolean;
}

/** Whether replica row `r` holds a window or a retained coverage. */
const holdsInsurance = Prisma.sql`(r.insurance_cover <> '{}'::jsonb OR cardinality(r.retained_coverages) > 0)`;

/**
 * Which replica rows `insurance:clear-transferred` targets: those that have
 * ever been transferred, whether or not they still hold a window (#240 r11:
 * every one has its invalidation epoch moved). A stated ownership generation
 * above zero, a latest event that was a transfer, or a window revoked by one
 * (all a transfer without a generation leaves), and optionally every row whose
 * generation is unknown.
 */
function transferredPredicate(options: ClearableInsuranceOptions): Prisma.Sql {
  return Prisma.sql`
    (${options.organizationId ?? null}::text IS NULL OR r.organization_id = ${options.organizationId ?? null})
    AND (
      r.ownership_generation > 0
      OR r.source_event = 'ASSET_TRANSFERRED'
      OR EXISTS (SELECT 1 FROM availability_window w
                  WHERE w.asset_id = r.id AND w.revoke_reason = 'ASSET_TRANSFERRED')
      OR (${options.includeUnknownGeneration}::boolean AND r.ownership_generation IS NULL)
    )`;
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

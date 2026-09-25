import { Injectable } from '@nestjs/common';
import {
  allocateStreamSeqSql,
  buildOutboxRow,
  runUnscoped,
  type OutboxMessageInput,
} from '@rasta/nest-common';
import { resolvePartitionKey } from './routing';
import type { AssetEventName, InsuranceEventName } from './events';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import type { ListAssetsQuery, NearbyQuery, TimelineQuery } from './dto';
import { TERMINAL_CLAIM_STATUSES } from '../insurance/claim-lifecycle';

/**
 * Data access for assets.
 *
 * Tenant scoping is applied automatically by the Prisma extension, so the
 * queries here read as if they were single-tenant. The handful of places that
 * legitimately cross the boundary go through `runUnscoped` with a written
 * reason, which makes every one of them greppable.
 *
 * Raw SQL appears only where Prisma has no expression for what is needed:
 * PostGIS geography and the `Unsupported` point column.
 */
@Injectable()
export class AssetRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client(): ExtendedPrismaClient {
    return this.prisma.client;
  }

  transaction<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.prisma.transaction(fn);
  }

  async enqueueEvent(tx: ExtendedPrismaClient, input: OutboxMessageInput): Promise<string> {
    // ADR-051 B3, in the order the ADR requires: routing is final *first*, the
    // sequence is allocated against that exact `(topic, partitionKey)` pair
    // *second*, and only then is the row built and inserted. All three happen
    // inside the caller's transaction, so the counter row lock is held to its
    // commit — which is what makes allocation order equal commit order, and is
    // this service's only serialisation point on the stream boundary.
    const partition = resolvePartitionKey(
      input.eventName as AssetEventName | InsuranceEventName,
      input.aggregateId,
    );
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
  // Assets
  // -------------------------------------------------------------------------

  async findById(id: string, tx?: ExtendedPrismaClient) {
    return (tx ?? this.client).asset.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * Looks up by manufacturer serial across every tenant.
   *
   * Unscoped deliberately: a serial number identifies one physical machine
   * worldwide, so the uniqueness check has to see rows the caller cannot
   * otherwise read. Only the existence of a match is ever exposed — never the
   * owning organization, which would leak another tenant's fleet.
   */
  async findBySerialNumber(serialNumber: string) {
    return runUnscoped(
      'serial number identifies one physical machine globally, so uniqueness spans tenants',
      () => this.client.asset.findFirst({ where: { serialNumber, deletedAt: null } }),
    );
  }

  async findByAssetTag(organizationId: string, assetTag: string) {
    return this.client.asset.findFirst({
      where: { organizationId, assetTag, deletedAt: null },
    });
  }

  async list(query: ListAssetsQuery) {
    // Cursor and expiry both constrain `id`, so they are combined under AND
    // rather than merged — two `id` keys in one `where` would silently drop
    // the cursor and break pagination past page one.
    const constraints: object[] = [];
    if (query.cursor) constraints.push({ id: { gt: query.cursor } });

    if (query.expiringWithinDays !== undefined) {
      const cutoff = new Date(Date.now() + query.expiringWithinDays * 86_400_000);
      constraints.push({
        OR: [
          { policies: { some: { status: 'ACTIVE', validTo: { lte: cutoff }, deletedAt: null } } },
          { inspections: { some: { validTo: { lte: cutoff } } } },
        ],
      });
    }

    const rows = await this.client.asset.findMany({
      where: {
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' as const } },
                { assetTag: { contains: query.q, mode: 'insensitive' as const } },
                { serialNumber: { contains: query.q, mode: 'insensitive' as const } },
                { manufacturer: { contains: query.q, mode: 'insensitive' as const } },
                { model: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(constraints.length > 0 ? { AND: constraints } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });

    const items = rows.slice(0, query.limit);
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
      hasMore: rows.length > query.limit,
    };
  }

  // -------------------------------------------------------------------------
  // Compliance — insurance and inspection
  // -------------------------------------------------------------------------

  /**
   * The policy currently in force, if any.
   *
   * "Currently" is checked against the clock rather than trusting the stored
   * status: the expiry sweep runs periodically, so a policy can be `ACTIVE`
   * in the row and already lapsed in reality. Compliance must not depend on a
   * background job having run recently.
   *
   * `recordedSince` limits the answer to policies recorded under the current
   * ownership. Since a transfer moves the whole dossier to the new owner
   * (audit L3-08), the previous owner's policies are now in view. They stay
   * history, and do not count as the new owner's cover. Before that fix they
   * were invisible to the new owner, so this keeps the rule that already
   * held. Whether a policy should follow the vehicle to its new owner is a
   * product question, not a code decision.
   */
  async findActivePolicy(
    assetId: string,
    at: Date = new Date(),
    recordedSince: Date | null = null,
  ) {
    return this.client.insurancePolicy.findFirst({
      where: {
        assetId,
        deletedAt: null,
        status: { not: 'CANCELLED' },
        validFrom: { lte: at },
        validTo: { gt: at },
        ...(recordedSince ? { createdAt: { gte: recordedSince } } : {}),
      },
      orderBy: { validTo: 'desc' },
    });
  }

  async findLatestInspection(assetId: string) {
    return this.client.technicalInspection.findFirst({
      where: { assetId },
      orderBy: { inspectedAt: 'desc' },
    });
  }

  async findPoliciesExpiringWithin(days: number) {
    const cutoff = new Date(Date.now() + days * 86_400_000);
    return this.client.insurancePolicy.findMany({
      where: { status: 'ACTIVE', deletedAt: null, validTo: { lte: cutoff, gt: new Date() } },
      orderBy: { validTo: 'asc' },
    });
  }

  async findInspectionsExpiringWithin(days: number) {
    const cutoff = new Date(Date.now() + days * 86_400_000);
    return this.client.technicalInspection.findMany({
      where: { validTo: { lte: cutoff, gt: new Date() }, result: { not: 'FAILED' } },
      orderBy: { validTo: 'asc' },
    });
  }

  /**
   * Marks lapsed policies EXPIRED and returns them.
   *
   * Runs unscoped because it is a platform-wide sweep with no request context —
   * there is no single tenant it belongs to.
   */
  async expireLapsedPolicies(): Promise<
    { id: string; assetId: string; organizationId: string; validTo: Date }[]
  > {
    return runUnscoped(
      'scheduled platform-wide sweep; runs outside any request context',
      async () => {
        const lapsed = await this.client.insurancePolicy.findMany({
          where: { status: 'ACTIVE', validTo: { lt: new Date() }, deletedAt: null },
          select: { id: true, assetId: true, organizationId: true, validTo: true },
        });

        if (lapsed.length > 0) {
          await this.client.insurancePolicy.updateMany({
            where: { id: { in: lapsed.map((p) => p.id) } },
            data: { status: 'EXPIRED' },
          });
        }

        return lapsed;
      },
    );
  }

  // -------------------------------------------------------------------------
  // Location — PostGIS
  // -------------------------------------------------------------------------

  /**
   * Writes the point column.
   *
   * Prisma cannot write an `Unsupported` column, so the row is inserted
   * without a point and the geometry set immediately afterwards in the same
   * transaction.
   *
   * ST_MakePoint takes longitude first. Reversing the pair is the classic
   * PostGIS mistake and would place Yazd in the Indian Ocean.
   */
  async setLocationPoint(
    tx: ExtendedPrismaClient,
    locationId: string,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE asset_location
      SET point = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
      WHERE id = ${locationId}
    `;
  }

  async readCoordinate(
    locationId: string,
  ): Promise<{ latitude: number; longitude: number } | null> {
    const rows = await this.client.$queryRaw<
      { latitude: number | null; longitude: number | null }[]
    >`
      SELECT ST_Y(point::geometry)::float8 AS latitude,
             ST_X(point::geometry)::float8 AS longitude
      FROM asset_location WHERE id = ${locationId}
    `;
    const row = rows[0];
    if (!row || row.latitude === null || row.longitude === null) return null;
    return { latitude: row.latitude, longitude: row.longitude };
  }

  /**
   * Assets within a radius, nearest first.
   *
   * This is the query behind the product document's fleet-versus-outsourcing
   * decision (ch. 5.14.9): which machines are near this project and free to
   * dispatch.
   *
   * Tenant scoping is applied explicitly here because the extension cannot
   * reach into raw SQL — the caller's organization is passed in and filtered
   * on, and omitting it would expose another dehyari's fleet.
   */
  async findNearby(organizationId: string, query: NearbyQuery) {
    const availableStatuses = query.availableOnly
      ? ['ACTIVE', 'IDLE']
      : ['ACTIVE', 'IDLE', 'ASSIGNED', 'IN_MAINTENANCE', 'OUT_OF_SERVICE', 'REGISTERED'];

    return this.client.$queryRaw<NearbyAssetRow[]>`
      SELECT a.id, a.name, a.type::text AS type, a.status::text AS status,
             a.asset_tag,
             ST_Distance(
               l.point,
               ST_SetSRID(ST_MakePoint(${query.longitude}, ${query.latitude}), 4326)::geography
             )::float8 AS distance_meters
      FROM asset_location l
      JOIN asset a ON a.id = l.asset_id
      WHERE a.deleted_at IS NULL
        AND a.organization_id = ${organizationId}
        AND l.is_current = true
        AND l.point IS NOT NULL
        AND a.status::text = ANY(${availableStatuses}::text[])
        AND (${query.type ?? null}::text IS NULL OR a.type::text = ${query.type ?? null}::text)
        AND ST_DWithin(
              l.point,
              ST_SetSRID(ST_MakePoint(${query.longitude}, ${query.latitude}), 4326)::geography,
              ${query.radiusMeters}
            )
      ORDER BY distance_meters
      LIMIT ${query.limit}
    `;
  }

  // -------------------------------------------------------------------------
  // Timeline — the electronic dossier
  // -------------------------------------------------------------------------

  async listTimeline(assetId: string, query: TimelineQuery) {
    const rows = await this.client.assetTimelineEntry.findMany({
      where: {
        assetId,
        ...(query.category ? { category: query.category } : {}),
        ...(query.from || query.to
          ? {
              occurredAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      // Newest first: a dossier is read from the most recent event backwards.
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const items = rows.slice(0, query.limit);
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
      hasMore: rows.length > query.limit,
    };
  }

  /**
   * Cost totals for the dossier.
   *
   * Aggregated in the database rather than by loading every row: an asset with
   * a decade of history would otherwise pull thousands of entries into memory
   * to add up a handful of numbers.
   */
  async costSummary(assetId: string): Promise<CostSummaryRow[]> {
    return this.client.$queryRaw<CostSummaryRow[]>`
      SELECT category::text AS category,
             COALESCE(SUM(amount_minor), 0)::text AS total_minor,
             COUNT(*)::int AS entry_count
      FROM asset_timeline_entry
      WHERE asset_id = ${assetId}
      GROUP BY category
    `;
  }

  async countTransfers(assetId: string): Promise<number> {
    return this.client.assetTransfer.count({ where: { assetId } });
  }

  /** When the asset last changed hands, or null if it never has. */
  async latestTransferAt(assetId: string): Promise<Date | null> {
    const latest = await this.client.assetTransfer.findFirst({
      where: { assetId },
      orderBy: { transferredAt: 'desc' },
      select: { transferredAt: true },
    });
    return latest?.transferredAt ?? null;
  }

  // -------------------------------------------------------------------------
  // Concurrency — compare-and-set and row locks
  // -------------------------------------------------------------------------

  /**
   * Compare-and-set on one asset's status.
   *
   * Matches on the status the caller decided from. A write computed from a
   * stale read then updates nothing instead of overwriting a newer state, and
   * in particular it can never turn a DECOMMISSIONED row back into anything
   * else (audit L3-07). Returns the number of rows changed, 0 or 1.
   *
   * `where` narrows the match further. A transfer, which runs unscoped, passes
   * the owning organization here so a concurrent transfer also counts as a
   * conflict.
   */
  async compareAndSetStatus(
    tx: ExtendedPrismaClient,
    id: string,
    expected: string,
    data: Record<string, unknown>,
    where: { organizationId?: string } = {},
  ): Promise<number> {
    const result = await tx.asset.updateMany({
      where: { id, status: expected as never, deletedAt: null, ...where },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count;
  }

  /**
   * Locks the asset row for a write that hangs a record off it.
   *
   * A location, document or claim is written under the asset's organization,
   * read a moment earlier. A transfer that commits in between would leave the
   * new record with the previous owner. The transfer's compare-and-set takes
   * the row lock, so holding a lock here orders the two: either this write
   * lands first and the transfer moves it, or the transfer lands first and
   * this lookup finds no asset for the caller's organization.
   *
   * `SHARE` lets independent writes run side by side. `EXCLUSIVE` (`FOR NO KEY
   * UPDATE`) serialises writers on the same asset, which the current-location
   * swap needs: two concurrent swaps would both see the old row as current.
   *
   * Raw SQL, so outside the tenant extension. The organization is therefore
   * part of the predicate.
   */
  async lockAsset(
    tx: ExtendedPrismaClient,
    id: string,
    organizationId: string,
    mode: 'SHARE' | 'EXCLUSIVE',
  ): Promise<{ status: string } | null> {
    const rows =
      mode === 'SHARE'
        ? await tx.$queryRaw<{ status: string }[]>`
            SELECT status::text AS status FROM asset
            WHERE id = ${id} AND organization_id = ${organizationId} AND deleted_at IS NULL
            FOR SHARE`
        : await tx.$queryRaw<{ status: string }[]>`
            SELECT status::text AS status FROM asset
            WHERE id = ${id} AND organization_id = ${organizationId} AND deleted_at IS NULL
            FOR NO KEY UPDATE`;
    return rows[0] ?? null;
  }

  /** Whether any claim on the asset is still open, meaning not REJECTED and not SETTLED. */
  async hasOpenClaims(tx: ExtendedPrismaClient, assetId: string): Promise<boolean> {
    const open = await tx.insuranceClaim.findFirst({
      where: { assetId, status: { notIn: [...TERMINAL_CLAIM_STATUSES] } },
      select: { id: true },
    });
    return open !== null;
  }

  async findOrganizationRef(id: string) {
    return runUnscoped('organization reference data is platform-wide, not tenant data', () =>
      this.client.organizationRef.findFirst({ where: { id } }),
    );
  }

  async upsertOrganizationRef(data: {
    id: string;
    name: string;
    type: string;
    status: string;
    sourceEvent: string;
  }) {
    return runUnscoped('organization reference replica is platform-wide', () =>
      this.client.organizationRef.upsert({
        where: { id: data.id },
        create: { ...data, syncedAt: new Date() },
        update: { ...data, syncedAt: new Date() },
      }),
    );
  }

  /**
   * Records that an event has been handled.
   *
   * Returns false when it was already recorded, which is the signal to skip.
   * Called inside the handler's transaction so the marker and the effect
   * commit together.
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

export interface NearbyAssetRow {
  id: string;
  name: string;
  type: string;
  status: string;
  asset_tag: string | null;
  distance_meters: number;
}

export interface CostSummaryRow {
  category: string;
  total_minor: string;
  entry_count: number;
}

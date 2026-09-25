import { Injectable } from '@nestjs/common';
import { allocateStreamSeqSql, buildOutboxRow, type OutboxMessageInput } from '@rasta/nest-common';
import { resolvePartitionKey } from './routing';
import type { OrganizationEventName } from './events';
import { PrismaService, type PrismaTransactionClient } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import type { ListOrganizationsQuery, NearbyQuery } from './dto';

/**
 * Data access for organizations.
 *
 * Two things here need explaining, because both look odd until you know why.
 *
 * **1. ltree labels are not identifiers.**
 * An ltree label may only contain `[A-Za-z0-9_]`. Our identifiers legitimately
 * contain hyphens (`ORG-DEH-0001` in seed data), which ltree rejects outright.
 * So the path stores a *sanitised* label per node, and `parentId` remains the
 * single source of truth for ancestry. The path is a derived index structure
 * used for subtree filtering — never parsed back into identifiers.
 *
 * **2. Raw SQL for path work.**
 * Prisma has no representation for ltree operators or PostGIS. Rewriting an
 * entire subtree's path is one statement in SQL and N round trips in an ORM,
 * and the correctness of the hierarchy depends on it being atomic.
 */
@Injectable()
export class OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client() {
    return this.prisma.client;
  }

  transaction<T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.transaction(fn);
  }

  async enqueueEvent(tx: PrismaTransactionClient, input: OutboxMessageInput): Promise<string> {
    // ADR-051 B3, in the order the ADR requires: routing is final *first*, the
    // sequence is allocated against that exact `(topic, partitionKey)` pair
    // *second*, and only then is the row built and inserted. All three happen
    // inside the caller's transaction, so the counter row lock is held to its
    // commit — which is what makes allocation order equal commit order, and is
    // this service's only serialisation point on the stream boundary.
    const partition = resolvePartitionKey(
      input.eventName as OrganizationEventName,
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
  // Reads
  // -------------------------------------------------------------------------

  async findById(id: string) {
    return this.client.organization.findFirst({ where: { id, deletedAt: null } });
  }

  async findDetailById(id: string) {
    const [organization, childCount] = await Promise.all([
      this.client.organization.findFirst({
        where: { id, deletedAt: null },
        include: {
          locations: { orderBy: { createdAt: 'asc' } },
          contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
        },
      }),
      this.client.organization.count({ where: { parentId: id, deletedAt: null } }),
    ]);

    if (!organization) return null;
    return { ...organization, childCount };
  }

  async findByExternalCode(externalCode: string) {
    return this.client.organization.findFirst({ where: { externalCode, deletedAt: null } });
  }

  /**
   * One page of organizations, restricted to `viewerOrganizationId`'s subtree
   * (null only for a platform operator).
   *
   * One statement, so one snapshot: the subtree is resolved from the viewer's
   * path in the same query that returns the page. Computing the permitted ids
   * first and filtering by them second returned an organization that moved
   * out of the subtree in between, and paid for every id in the subtree on
   * every page. The restriction sits before `LIMIT`, so a page holds `limit`
   * rows the caller may see rather than fewer after a filter.
   *
   * `q` matches as a plain case-insensitive substring (`strpos` over
   * `lower`), so `%` and `_` in the search text are literal characters.
   */
  async list(query: ListOrganizationsQuery, viewerOrganizationId: string | null) {
    const q = query.q ? query.q.toLowerCase() : null;
    const rows = await this.client.$queryRaw<OrganizationRow[]>`
      SELECT o.* FROM organization o
      WHERE o.deleted_at IS NULL
        AND (${viewerOrganizationId}::text IS NULL
             OR o.path <@ (SELECT v.path FROM organization v WHERE v.id = ${viewerOrganizationId}))
        AND (${query.type ?? null}::text IS NULL OR o.type::text = ${query.type ?? null}::text)
        AND (${query.status ?? null}::text IS NULL OR o.status::text = ${query.status ?? null}::text)
        AND (${query.parentId ?? null}::text IS NULL OR o.parent_id = ${query.parentId ?? null}::text)
        AND (${q}::text IS NULL
             OR strpos(lower(o.name), ${q}::text) > 0
             OR strpos(lower(coalesce(o.short_name, '')), ${q}::text) > 0
             OR strpos(lower(coalesce(o.external_code, '')), ${q}::text) > 0)
        AND (${query.cursor ?? null}::text IS NULL OR o.id > ${query.cursor ?? null}::text)
      ORDER BY o.id
      LIMIT ${query.limit + 1}
    `;

    const items = rows.slice(0, query.limit);
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
      hasMore: rows.length > query.limit,
    };
  }

  /** Direct children only. */
  async findChildren(id: string) {
    return this.client.organization.findMany({
      where: { parentId: id, deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Ancestors, root first.
   *
   * `@>` reads as "is an ancestor of", so this is a single index scan rather
   * than a loop that walks parentId upwards one query at a time.
   *
   * `viewerOrganizationId` cuts the chain at the top of the viewer's visible
   * subtree: an ancestor above it is outside what the viewer may read, and is
   * left out rather than returned as a breadcrumb (Q-67). Null — the whole
   * chain — is for a platform operator and for internal reads such as policy
   * inheritance, which need every ancestor.
   */
  async findAncestors(id: string, viewerOrganizationId: string | null = null) {
    return this.client.$queryRaw<OrganizationRow[]>`
      SELECT o.* FROM organization o
      WHERE o.deleted_at IS NULL
        AND o.path @> (SELECT path FROM organization WHERE id = ${id})
        AND o.id <> ${id}
        AND (${viewerOrganizationId}::text IS NULL
             OR o.path <@ (SELECT v.path FROM organization v WHERE v.id = ${viewerOrganizationId}))
      ORDER BY nlevel(o.path)
    `;
  }

  /** Whole subtree, inclusive of the root. */
  async findSubtree(id: string, maxDepth?: number) {
    if (maxDepth === undefined) {
      return this.client.$queryRaw<OrganizationRow[]>`
        SELECT o.* FROM organization o
        WHERE o.deleted_at IS NULL
          AND o.path <@ (SELECT path FROM organization WHERE id = ${id})
        ORDER BY o.path
      `;
    }
    return this.client.$queryRaw<OrganizationRow[]>`
      SELECT o.* FROM organization o
      WHERE o.deleted_at IS NULL
        AND o.path <@ (SELECT path FROM organization WHERE id = ${id})
        AND nlevel(o.path) <= (SELECT nlevel(path) FROM organization WHERE id = ${id}) + ${maxDepth}
      ORDER BY o.path
    `;
  }

  /** True when `ancestorId` is at or above `descendantId`. */
  async isAncestorOf(
    ancestorId: string,
    descendantId: string,
    tx?: PrismaTransactionClient,
  ): Promise<boolean> {
    const rows = await (tx ?? this.client).$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM organization a, organization d
        WHERE a.id = ${ancestorId} AND d.id = ${descendantId} AND d.path <@ a.path
      ) AS ok
    `;
    return rows[0]?.ok ?? false;
  }

  async getPath(id: string, tx?: PrismaTransactionClient): Promise<string | null> {
    const rows = await (tx ?? this.client).$queryRaw<{ path: string | null }[]>`
      SELECT path::text AS path FROM organization WHERE id = ${id}
    `;
    return rows[0]?.path ?? null;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Sets the ltree path on a freshly inserted row.
   *
   * Prisma cannot write an `Unsupported` column, so the row is created without
   * a path and the path is set immediately afterwards inside the same
   * transaction.
   */
  async setPath(
    tx: PrismaTransactionClient,
    id: string,
    parentPath: string | null,
  ): Promise<{ path: string; depth: number }> {
    const label = toLabel(id);
    const path = parentPath ? `${parentPath}.${label}` : label;
    const depth = path.split('.').length - 1;

    await tx.$executeRaw`
      UPDATE organization SET path = ${path}::ltree, depth = ${depth} WHERE id = ${id}
    `;

    return { path, depth };
  }

  /**
   * Re-parents a subtree.
   *
   * One statement rewrites every descendant: strip the old ancestry prefix,
   * graft on the new one. Doing it row by row would leave the tree
   * inconsistent if it failed partway.
   */
  async rewriteSubtreePath(
    tx: PrismaTransactionClient,
    oldPath: string,
    newPath: string,
  ): Promise<number> {
    // The moved root is special-cased: `subpath(path, nlevel(path))` asks for
    // an offset equal to the path's own length, which ltree rejects with
    // "invalid positions" — so the one-expression form failed every move
    // against a real database. CASE is evaluated lazily, so the root row
    // never reaches `subpath`.
    const affected = await tx.$executeRaw`
      UPDATE organization
      SET path  = CASE WHEN path = ${oldPath}::ltree THEN ${newPath}::ltree
                       ELSE ${newPath}::ltree || subpath(path, nlevel(${oldPath}::ltree)) END,
          depth = nlevel(${newPath}::ltree) - 1 + (nlevel(path) - nlevel(${oldPath}::ltree))
      WHERE path <@ ${oldPath}::ltree
    `;
    return affected;
  }

  // -------------------------------------------------------------------------
  // Concurrency — locks taken inside the caller's transaction
  // -------------------------------------------------------------------------

  /**
   * Serialises every write that changes the shape of the tree: create and move.
   *
   * A cycle is a property of two moves together, not of either one: moving A
   * beneath a descendant of B while B moves beneath a descendant of A passes
   * both checks and leaves a detached ring. Row locks would have to cover the
   * whole ancestor chain of both new parents to prevent that, and a chain read
   * before its lock can already be stale. Structural writes are rare and
   * operator-driven, so one transaction-scoped advisory lock is the simpler
   * guarantee: whoever holds it reads paths nobody else can be rewriting.
   * Advisory locks are scoped to this service's own database.
   */
  async lockHierarchy(tx: PrismaTransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HIERARCHY_LOCK_KEY}::bigint)`;
  }

  /**
   * Serialises writes to one governance key of one organization.
   *
   * Replacing a policy reads the key's timeline, closes what is in force and
   * inserts the new value. Two replacements interleaving that read would each
   * close only what they saw and leave two open-ended values.
   * Transaction-scoped, and keyed on the pair, so unrelated keys
   * never wait on each other; a hash collision only makes two keys queue.
   * The two-argument form lives in a different lock space from
   * `HIERARCHY_LOCK_KEY`'s single-bigint form, so the two never collide.
   */
  async lockPolicyKey(tx: PrismaTransactionClient, organizationId: string, key: string) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`policy:${organizationId}`}), hashtext(${key}))
    `;
  }

  /**
   * Serialises primary-contact changes for one (organization, kind).
   *
   * Adding a primary contact demotes the incumbent. Two concurrent adds each
   * saw no incumbent but the other's row, and both committed as primary.
   * `ux_contact_primary_per_kind` refuses that outright; this lock makes the
   * second add wait and demote the first instead of failing.
   */
  async lockContactKind(tx: PrismaTransactionClient, organizationId: string, kind: string) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`contact:${organizationId}`}), hashtext(${kind}))
    `;
  }

  /**
   * `id` and every ancestor, root first, share-locked until commit.
   *
   * A share lock blocks a concurrent status change on any of these rows (its
   * compare-and-set is an UPDATE) but not another reader, so two creates under
   * the same parent do not queue on each other. Rows are locked in root-first
   * order, the same order a cascade takes them in, so the two cannot deadlock.
   */
  async lockAncestorChain(
    tx: PrismaTransactionClient,
    id: string,
    options: { includeSelf: boolean },
  ): Promise<ChainRow[]> {
    // `includeSelf: false` exists for a caller that will UPDATE `id` next.
    // Share-locking it first and upgrading later is how two concurrent
    // requests on the same row deadlock: each holds a share the other's
    // upgrade waits on.
    return tx.$queryRaw<ChainRow[]>`
      SELECT o.id, o.status::text AS status, o.depth, o.path::text AS path
      FROM organization o
      WHERE o.deleted_at IS NULL
        AND o.path @> (SELECT path FROM organization WHERE id = ${id})
        AND (${options.includeSelf} OR o.id <> ${id})
      ORDER BY nlevel(o.path)
      FOR SHARE OF o
    `;
  }

  /** One row, exclusively locked, read after the lock is granted. */
  async lockForUpdate(tx: PrismaTransactionClient, id: string): Promise<LockedRow | null> {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT id, status::text AS status, depth, parent_id, path::text AS path
      FROM organization
      WHERE id = ${id} AND deleted_at IS NULL
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /** Depth of the deepest node in the subtree rooted at `path`, inclusive. */
  async deepestDepthUnder(tx: PrismaTransactionClient, path: string): Promise<number> {
    const rows = await tx.$queryRaw<{ deepest: number | null }[]>`
      SELECT max(depth)::int AS deepest
      FROM organization
      WHERE deleted_at IS NULL AND path <@ ${path}::ltree
    `;
    return rows[0]?.deepest ?? 0;
  }

  /** Statuses present in the subtree rooted at `path`, inclusive. */
  async statusesUnder(tx: PrismaTransactionClient, path: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT DISTINCT status::text AS status
      FROM organization
      WHERE deleted_at IS NULL AND path <@ ${path}::ltree
    `;
    return rows.map((row) => row.status);
  }

  /**
   * Compare-and-set on one organization's status.
   *
   * Matches on the status the caller decided from, so a write computed from a
   * stale read updates nothing instead of overwriting a newer state — in
   * particular it can never turn a DEACTIVATED row back into anything else.
   */
  async compareAndSetStatus(
    tx: PrismaTransactionClient,
    id: string,
    expected: string,
    next: string,
    actor: string,
  ): Promise<number> {
    const result = await tx.organization.updateMany({
      where: { id, status: expected as never, deletedAt: null },
      data: { status: next as never, updatedBy: actor, version: { increment: 1 } },
    });
    return result.count;
  }

  /**
   * Cascades a status to every descendant of `rootPath` (the root excluded)
   * and returns the identifiers actually changed.
   *
   * DEACTIVATED is terminal, so a later suspension of an ancestor must not
   * rewrite it; rows already at the target status are left alone so the event
   * lists only real changes. Rows are locked root-first before the update, the
   * same order `lockAncestorChain` uses, so two overlapping cascades wait on
   * each other rather than deadlock.
   */
  async cascadeStatus(
    tx: PrismaTransactionClient,
    rootId: string,
    rootPath: string,
    next: string,
    actor: string,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      WITH target AS (
        SELECT id FROM organization
        WHERE deleted_at IS NULL
          AND path <@ ${rootPath}::ltree
          AND id <> ${rootId}
          AND status NOT IN ('DEACTIVATED', ${next}::"OrganizationStatus")
        ORDER BY path
        FOR UPDATE
      )
      UPDATE organization o
      SET status = ${next}::"OrganizationStatus",
          updated_by = ${actor},
          updated_at = now(),
          version = o.version + 1
      FROM target
      WHERE o.id = target.id
      RETURNING o.id
    `;
    return rows.map((row) => row.id);
  }

  // -------------------------------------------------------------------------
  // Geospatial
  // -------------------------------------------------------------------------

  async setLocationPoint(
    tx: PrismaTransactionClient,
    locationId: string,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    // ST_MakePoint takes longitude first. Getting this backwards is the single
    // most common PostGIS bug and puts Yazd in the Indian Ocean.
    await tx.$executeRaw`
      UPDATE organization_location
      SET point = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
      WHERE id = ${locationId}
    `;
  }

  async readLocationPoints(
    organizationId: string,
  ): Promise<Map<string, { latitude: number; longitude: number }>> {
    const rows = await this.client.$queryRaw<
      { id: string; latitude: number | null; longitude: number | null }[]
    >`
      SELECT id,
             ST_Y(point::geometry)::float8 AS latitude,
             ST_X(point::geometry)::float8 AS longitude
      FROM organization_location
      WHERE organization_id = ${organizationId}
    `;

    const result = new Map<string, { latitude: number; longitude: number }>();
    for (const row of rows) {
      if (row.latitude !== null && row.longitude !== null) {
        result.set(row.id, { latitude: row.latitude, longitude: row.longitude });
      }
    }
    return result;
  }

  /**
   * Organizations within `radiusMeters`, nearest first.
   *
   * `viewerOrganizationId` is the root of the caller's visible subtree,
   * exactly as `list` takes it: null means "the whole tree" and is only ever
   * passed for a platform operator. Its path is resolved inside this
   * statement, so the restriction and the rows come from one snapshot. The
   * restriction sits before `LIMIT`, so a page holds `limit` rows the caller
   * may see rather than fewer after a filter.
   */
  async findNearby(query: NearbyQuery, viewerOrganizationId: string | null) {
    return this.client.$queryRaw<NearbyRow[]>`
      SELECT o.id, o.name, o.type, o.status,
             ST_Distance(
               l.point,
               ST_SetSRID(ST_MakePoint(${query.longitude}, ${query.latitude}), 4326)::geography
             )::float8 AS distance_meters
      FROM organization_location l
      JOIN organization o ON o.id = l.organization_id
      WHERE o.deleted_at IS NULL
        AND l.point IS NOT NULL
        AND (${viewerOrganizationId}::text IS NULL
             OR o.path <@ (SELECT v.path FROM organization v WHERE v.id = ${viewerOrganizationId}))
        -- Parenthesised deliberately: AND x OR y binds as (AND x) OR y, which
        -- would return every organization in the country and quietly ignore
        -- the radius entirely.
        AND (${query.type ?? null}::text IS NULL OR o.type::text = ${query.type ?? null}::text)
        AND ST_DWithin(
              l.point,
              ST_SetSRID(ST_MakePoint(${query.longitude}, ${query.latitude}), 4326)::geography,
              ${query.radiusMeters}
            )
      ORDER BY distance_meters
      LIMIT ${query.limit}
    `;
  }
}

/**
 * Converts an identifier into a legal ltree label.
 *
 * ltree permits only `[A-Za-z0-9_]`, and our identifiers may contain hyphens.
 * The mapping is one-way by design: `parentId` is the source of truth for
 * ancestry, and the path is only ever used for subtree filtering.
 */
export function toLabel(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

export interface OrganizationRow {
  id: string;
  external_code: string | null;
  name: string;
  short_name: string | null;
  type: string;
  status: string;
  parent_id: string | null;
  depth: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Key of the advisory lock that serialises structural writes. An arbitrary
 * constant; named so the one place that takes it is greppable.
 */
export const HIERARCHY_LOCK_KEY = 7_214_300_001n;

export interface ChainRow {
  id: string;
  status: string;
  depth: number;
  path: string;
}

export interface LockedRow {
  id: string;
  status: string;
  depth: number;
  parent_id: string | null;
  path: string | null;
}

export interface NearbyRow {
  id: string;
  name: string;
  type: string;
  status: string;
  distance_meters: number;
}

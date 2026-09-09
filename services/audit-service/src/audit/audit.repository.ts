import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import type { AuditEventRecord } from './audit.mapper';
import {
  ORGANIZATION_DOMAIN_STATUSES,
  STATUS_CASCADE_CHUNK,
  type OrganizationDomainStatus,
  type OrganizationProjection,
} from './organization-projection';
import type { AuditEventRow } from './audit.view';
import type { AuditCursor } from './audit.cursor';

/** What one ingestion attempt did. */
export type IngestOutcome = 'WRITTEN' | 'DUPLICATE';

/**
 * The organization status that removes a node from every `UNION_ADMIN` subtree.
 *
 * Deactivation is terminal upstream ("records elsewhere still reference this
 * organization"), so a deactivated organization is no longer a tenant a union
 * administrator holds authority over. `SUSPENDED` deliberately does **not**
 * appear here: a suspended organization is still theirs, and it is exactly when
 * an organization is suspended that somebody needs to read its audit trail.
 */
const EXCLUDED_RELATION_STATUS: OrganizationDomainStatus = 'DEACTIVATED';

/**
 * The statuses a node may hold and still conduct authority — an allow-list.
 *
 * Derived rather than written out, so the two facts it depends on stay linked:
 * the owning service's domain vocabulary, and the one status that leaves a
 * subtree. Adding a member upstream therefore shows up here as a decision to
 * make rather than as a value that silently starts conducting authority.
 *
 * An allow-list and not `status <> 'DEACTIVATED'`, and that is the whole point.
 * `status` is a free-text projection of another service's vocabulary, so it can
 * hold a value this service has never heard of, a blank, or a value a bad
 * producer chose. Under an inequality every one of those reads as "not
 * deactivated, therefore fine" and conducts authority down a subtree. Under an
 * allow-list every one of them matches nothing and denies, which is the
 * fail-closed direction ADR-053 § 10 requires.
 */
const AUTHORITY_CONDUCTING_STATUSES: readonly OrganizationDomainStatus[] =
  ORGANIZATION_DOMAIN_STATUSES.filter((status) => status !== EXCLUDED_RELATION_STATUS);

/**
 * How far the upward walk from a target to a claimed root may go.
 *
 * A bound rather than a trust: the walk terminates on this even if the
 * projection somehow held a cycle, and hitting it yields no root, which denies.
 * Deep enough for any hierarchy the product describes (`docs/03` § 3.6 models
 * province → union → member, three levels) with an order of magnitude spare.
 */
export const MAX_SUBTREE_DEPTH = 32;

/** The columns every audit read selects. Listed once so no read drifts. */
const AUDIT_EVENT_SELECT = {
  id: true,
  occurredAt: true,
  recordedAt: true,
  actorType: true,
  actorId: true,
  actorRoles: true,
  organizationId: true,
  action: true,
  resourceType: true,
  resourceId: true,
  outcome: true,
  errorCode: true,
  reason: true,
  changes: true,
  occurrenceCount: true,
  sourceService: true,
  sourceServiceVersion: true,
  sourceEventId: true,
  sourceEventName: true,
  sourceTopic: true,
  sourceIp: true,
  sourceUserAgent: true,
  correlationId: true,
  causationId: true,
  traceparent: true,
  sourceStreamSeq: true,
  sequenceNo: true,
  // recordHash, previousHash and correctionOf are deliberately absent: they are
  // never written in this phase and no read publishes them (`audit.view.ts`).
} as const;

/**
 * The tenant bound of one already-authorised read.
 *
 * `PLATFORM` is the only shape that omits an organization filter, and it is
 * reachable only by `SYSTEM_ADMIN`. Every other caller arrives with
 * `organizationId` set to exactly one value — never a list, never a pattern and
 * never `OR organization_id IS NULL`, which ADR-053 § 10 names as the specific
 * mistake that leaks a platform row into a tenant's result.
 */
export type AuditReadScope =
  | { readonly kind: 'PLATFORM'; readonly organizationId?: string }
  | { readonly kind: 'ORGANIZATION'; readonly organizationId: string };

/** The filters a search may narrow an already-scoped range with. */
export interface AuditSearchFilters {
  readonly from: Date;
  readonly to: Date;
  readonly actorId?: string;
  readonly actorType?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly correlationId?: string;
  readonly outcome?: string;
  readonly limit: number;
  readonly cursor?: AuditCursor;
}

/** One page of evidence, plus whether another one exists. */
export interface AuditSearchPage {
  readonly rows: AuditEventRow[];
  readonly hasMore: boolean;
}

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes the audit row and its idempotency marker in one transaction.
   *
   * The ordering matters and is asserted by a test: the audit row goes in
   * first, then `processed_event`. Both are in the same transaction, so the
   * outcome is all-or-nothing — but if that ever changed, an event marked
   * processed without its evidence is the failure that loses records silently,
   * while evidence without the marker merely produces a duplicate attempt that
   * the unique index refuses. One direction is recoverable; the other is not
   * (AGENTS.md A-09, ADR-053 § 8).
   *
   * `organization_ref` is upserted in the same transaction so a query in
   * AUD-002 can list the tenants it may scope to without a cross-service call.
   * It is a projection of an identifier this service already holds — never a
   * copy of organization-service's rows (A-01).
   *
   * Duplicate delivery is a no-op rather than an error. Kafka is at-least-once
   * and `fromBeginning: true` means a rebalance can replay the whole log, so a
   * second delivery is normal operation, not a fault.
   */
  async ingest(
    record: AuditEventRecord,
    consumerName: string,
    projection: OrganizationProjection | null = null,
  ): Promise<IngestOutcome> {
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        // Checked inside the transaction, not before it. A check outside would
        // be a race: two workers rebalancing onto the same partition could both
        // see "not processed" and both proceed, and only the unique index would
        // stop them.
        const already = await tx.processedEvent.findUnique({
          where: {
            eventId_consumerName: { eventId: record.sourceEventId, consumerName },
          },
          select: { eventId: true },
        });
        if (already) return 'DUPLICATE';

        await tx.auditEvent.create({
          data: {
            id: record.id,
            occurredAt: record.occurredAt,
            actorType: record.actorType,
            actorId: record.actorId,
            actorRoles: record.actorRoles,
            organizationId: record.organizationId,
            action: record.action,
            resourceType: record.resourceType,
            resourceId: record.resourceId,
            outcome: record.outcome,
            occurrenceCount: record.occurrenceCount,
            sourceService: record.sourceService,
            sourceServiceVersion: record.sourceServiceVersion,
            sourceEventId: record.sourceEventId,
            sourceEventName: record.sourceEventName,
            sourceTopic: record.sourceTopic,
            correlationId: record.correlationId,
            causationId: record.causationId,
            traceparent: record.traceparent,
            sourceStreamSeq: record.sourceStreamSeq,
            // recordedAt is left to the database default on purpose: the gap
            // between it and occurredAt is consumer lag, and a value chosen
            // here would measure this process's clock instead.
          },
        });

        await tx.processedEvent.create({
          data: { eventId: record.sourceEventId, consumerName },
        });

        if (record.organizationId !== null) {
          await tx.organizationRef.upsert({
            where: { organizationId: record.organizationId },
            create: { organizationId: record.organizationId },
            update: { lastSeenAt: new Date() },
          });
        }

        // In the same transaction as the evidence, and after the marker, so a
        // hierarchy fact is never applied for an event that was not recorded.
        // The reverse order would let a crash leave the authorization
        // projection ahead of the audit trail that explains it (AUD-002).
        if (projection !== null) await applyOrganizationProjection(tx, projection);

        return 'WRITTEN';
      });
    } catch (error) {
      // P2002 is the unique index doing its job: the same event arriving on the
      // same topic twice, close enough together that both transactions passed
      // the check above. The row that exists is the row we would have written,
      // so this is a duplicate, not a failure.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return 'DUPLICATE';
      }
      throw error;
    }
  }

  /**
   * Approximate rows per partition, for the capacity gauge.
   *
   * `reltuples` from the catalogue rather than `count(*)`: an exact count over
   * a growing append-only table is a sequential scan per partition per scrape,
   * which would make the metric the most expensive query this service runs.
   * Capacity planning does not need the last thousand rows.
   */
  async partitionRowCounts(): Promise<{ partition: string; rows: number }[]> {
    const rows = await this.prisma.client.$queryRaw<{ partition: string; rows: number }[]>`
      SELECT c.relname AS partition,
             GREATEST(c.reltuples, 0)::float8 AS rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'audit_event'
         AND n.nspname = current_schema()
    `;
    return rows.map((row) => ({ partition: row.partition, rows: Number(row.rows) }));
  }

  // -------------------------------------------------------------------------
  // AUD-002 — the read side
  // -------------------------------------------------------------------------

  /**
   * Whether `targetOrganizationId` sits strictly beneath `rootOrganizationId`
   * in the hierarchy this service has projected.
   *
   * ## Upwards, not downwards
   *
   * The walk starts at the target and climbs to its ancestors, which bounds it
   * by the depth of one chain rather than by the size of a subtree, uses the
   * primary key at every step, and — the reason that matters — makes the
   * failure mode *exclusion*. A downward enumeration that hit a row limit would
   * return a truncated subtree and silently deny; an upward walk that runs out
   * of projected ancestors simply never reaches the root, which is the same
   * answer as "not a descendant".
   *
   * ## Only projected nodes in an allowed status conduct authority
   *
   * Every node on the chain, the root included, must be `PROJECTED` and must
   * hold a status on `AUTHORITY_CONDUCTING_STATUSES` — an allow-list, so a
   * null, blank or unrecognised status denies rather than passing an
   * inequality. A row this service knows only as the tenant of an audit event
   * is `UNKNOWN` and has a null parent, so it would otherwise read as a
   * hierarchy root — which would make every unknown organization the root of
   * everything. That is the fail-closed hinge ADR-053 § 10 asks for: a missing,
   * unknown or broken relation yields no answer, never a wider one.
   *
   * ## Cycles and depth
   *
   * `organization_ref_parent_not_self` refuses the one-node cycle in the
   * database; `MAX_SUBTREE_DEPTH` bounds every longer one here. A chain that
   * exceeds the bound is not resolved, which denies.
   */
  async isWithinProjectedSubtree(
    rootOrganizationId: string,
    targetOrganizationId: string,
  ): Promise<boolean> {
    // Equality is answered by the caller from the verified token, never from
    // this projection: a caller's authority over their own organization must
    // not depend on whether an event for it has been consumed yet.
    if (rootOrganizationId === targetOrganizationId) return false;

    // An allow-list of statuses rather than "not DEACTIVATED", so an unknown or
    // blank status conducts no authority. Bound once and used on both sides of
    // the recursion, so the step condition and the root condition cannot drift.
    const conducting = Prisma.join(
      AUTHORITY_CONDUCTING_STATUSES.map((status) => Prisma.sql`${status}`),
    );

    const rows = await this.prisma.client.$queryRaw<{ found: number }[]>`
      WITH RECURSIVE ancestry AS (
        SELECT organization_id,
               parent_organization_id,
               relation_state,
               status,
               0 AS steps
          FROM organization_ref
         WHERE organization_id = ${targetOrganizationId}
        UNION ALL
        SELECT parent.organization_id,
               parent.parent_organization_id,
               parent.relation_state,
               parent.status,
               child.steps + 1
          FROM organization_ref parent
          JOIN ancestry child ON parent.organization_id = child.parent_organization_id
         WHERE child.steps < ${MAX_SUBTREE_DEPTH}
           AND child.relation_state = 'PROJECTED'
           AND child.status IN (${conducting})
      )
      SELECT 1 AS found
        FROM ancestry
       WHERE organization_id = ${rootOrganizationId}
         AND steps > 0
         AND relation_state = 'PROJECTED'
         AND status IN (${conducting})
       LIMIT 1
    `;

    return rows.length > 0;
  }

  /**
   * One page of evidence within an already-authorised scope.
   *
   * The scope is applied here and cannot be widened by any filter: the caller
   * resolved it from the token before this method was reachable, and a subtree
   * caller always arrives as exactly one organization.
   *
   * Ordered `occurredAt DESC, id DESC`. The tie-breaker is not decoration —
   * `occurredAt` is not unique (two events in the same millisecond are
   * ordinary), and keyset pagination over a non-unique sort key either repeats
   * rows or skips them. `id` is a ULID, so the pair is total and stable.
   *
   * `limit + 1` rows are read so `hasMore` is a fact rather than a guess; the
   * extra row is dropped before anything is mapped.
   */
  async search(scope: AuditReadScope, filters: AuditSearchFilters): Promise<AuditSearchPage> {
    const where: Prisma.AuditEventWhereInput = {
      occurredAt: { gte: filters.from, lte: filters.to },
    };

    // ADR-053 § 10: `organization_id = $1`, never
    // `organization_id = $1 OR organization_id IS NULL`. An unscoped platform
    // row reaching a tenant's result is a cross-tenant disclosure.
    if (scope.kind === 'ORGANIZATION' || scope.organizationId !== undefined) {
      where.organizationId = scope.organizationId;
    }

    if (filters.actorId !== undefined) where.actorId = filters.actorId;
    if (filters.actorType !== undefined) {
      where.actorType = filters.actorType as Prisma.AuditEventWhereInput['actorType'];
    }
    if (filters.action !== undefined) where.action = filters.action;
    if (filters.resourceType !== undefined) where.resourceType = filters.resourceType;
    if (filters.resourceId !== undefined) where.resourceId = filters.resourceId;
    if (filters.correlationId !== undefined) where.correlationId = filters.correlationId;
    if (filters.outcome !== undefined) {
      where.outcome = filters.outcome as Prisma.AuditEventWhereInput['outcome'];
    }

    if (filters.cursor) {
      // The keyset predicate, spelled out because Prisma has no row-value
      // comparison: strictly older, or the same instant with a smaller id.
      where.AND = [
        {
          OR: [
            { occurredAt: { lt: filters.cursor.occurredAt } },
            { occurredAt: filters.cursor.occurredAt, id: { lt: filters.cursor.id } },
          ],
        },
      ];
    }

    const rows = await this.prisma.client.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: filters.limit + 1,
      select: AUDIT_EVENT_SELECT,
    });

    const hasMore = rows.length > filters.limit;
    return { rows: (hasMore ? rows.slice(0, filters.limit) : rows) as AuditEventRow[], hasMore };
  }

  /**
   * One record by id, inside a bounded window and an authorised scope.
   *
   * The window is required rather than convenient. `audit_event`'s identity is
   * `(occurred_at, id)` — PostgreSQL demands the partition key in every unique
   * index on a partitioned table — so a lookup by `id` alone is a scan of every
   * partition, nineteen today and one more every month. Passing the range lets
   * the planner prune to the partitions that can hold the row, which is the
   * same reason ADR-053 § 10 makes the window mandatory for search.
   *
   * Returns `null` for a row that does not exist **and** for one that exists
   * outside the scope. The caller turns both into the same `404`, because a
   * `403` here would confirm the record exists and belongs to somebody else
   * (`docs/06` § 6.7).
   */
  async findById(
    scope: AuditReadScope,
    id: string,
    window: { from: Date; to: Date },
  ): Promise<AuditEventRow | null> {
    const where: Prisma.AuditEventWhereInput = {
      id,
      occurredAt: { gte: window.from, lte: window.to },
    };

    if (scope.kind === 'ORGANIZATION' || scope.organizationId !== undefined) {
      where.organizationId = scope.organizationId;
    }

    const row = await this.prisma.client.auditEvent.findFirst({
      where,
      // The identity is composite, so `id` alone is not unique across
      // partitions in principle. Ordering makes the answer deterministic rather
      // than whichever partition the planner reached first.
      orderBy: [{ occurredAt: 'desc' }],
      select: AUDIT_EVENT_SELECT,
    });

    return (row as AuditEventRow | null) ?? null;
  }
}

/**
 * Applies one organization event to the hierarchy projection, monotonically.
 *
 * ## Every write is guarded by `relation_observed_at`
 *
 * The consumer replays from the beginning of whatever the broker holds, and a
 * rebalance can redeliver. Without the guard, replaying an old
 * `ORGANIZATION_MOVED` after a newer one would wind the hierarchy back to a
 * parent the organization has already left — and winding a hierarchy backwards
 * is exactly the broadening failure the fail-closed design exists to prevent.
 * With it, an older event is a no-op.
 *
 * ## One statement, because a caught error is not a no-op inside a transaction
 *
 * Prisma's `upsert` cannot carry a condition on its update branch, so the guard
 * cannot be expressed through it. The obvious substitute — `updateMany` with
 * the guard, then `create`, catching `P2002` when the row turned out to exist
 * and be newer — is wrong here in a way that costs evidence: PostgreSQL aborts
 * the whole transaction on a failed statement, so catching the error in
 * JavaScript leaves the enclosing transaction in `25P02` and its `COMMIT`
 * silently behaves as `ROLLBACK`. The audit row written moments earlier would
 * vanish while `ingest` reported `WRITTEN` and the consumer committed the
 * offset — an event lost with nothing to notice, which is precisely the silent
 * gap ADR-053 § 9 calls worse than an outage.
 *
 * So the write is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE` statement.
 * It is atomic, it never raises on the "already newer" path — the `WHERE` on
 * the update branch simply matches nothing — and the guard lives in the same
 * statement as the write, so there is no window between deciding and writing.
 */
async function applyOrganizationProjection(
  tx: Prisma.TransactionClient,
  projection: OrganizationProjection,
): Promise<void> {
  if (projection.kind === 'STATUS_CHANGED') {
    // Insert-or-update, **not** update-only, and this is a security fix rather
    // than a tidiness one.
    //
    // `ORGANIZATION_STATUS_CHANGED` is keyed by the organization whose status
    // changed, but it names its whole subtree in `affectedIds` — descendants
    // that live on other Kafka partitions and therefore carry no ordering
    // relationship to this message. So a descendant's DEACTIVATED cascade can
    // legitimately be consumed *before* that descendant's own, older,
    // `ORGANIZATION_CREATED`.
    //
    // An update-only cascade drops the deactivation on the floor in exactly
    // that case — there is no row yet to update, so nothing is retained. The
    // older CREATED then arrives against a row with a null
    // `relation_observed_at`, passes the monotonicity guard, and writes
    // `PROJECTED` with the stale `ACTIVE` status. The descendant is
    // re-authorized into its union's subtree by an event that predates its
    // deactivation, and nothing errors.
    //
    // Retaining the marker for every affected identifier closes that: the row
    // exists, it carries the newer `relation_observed_at`, and the older
    // CREATED's guard now matches nothing. The cost is a row for an
    // organization this service has not otherwise heard of, and that row is
    // `UNKNOWN` — no parent link, so it conducts no authority in either
    // direction and only remembers "a status at least this new was seen".
    //
    // The conflict branch deliberately writes neither `relation_state` nor any
    // hierarchy column: a status change says nothing about parentage, and
    // demoting a `PROJECTED` row to `UNKNOWN` here would evict a legitimate
    // descendant from its own union's subtree.
    const affected = projection.affectedOrganizationIds;
    for (let index = 0; index < affected.length; index += STATUS_CASCADE_CHUNK) {
      const chunk = affected.slice(index, index + STATUS_CASCADE_CHUNK);
      // The identifiers are de-duplicated upstream, which `ON CONFLICT DO
      // UPDATE` requires: naming the same row twice in one statement raises
      // `21000` rather than applying the second value.
      const rows = Prisma.join(
        chunk.map(
          (organizationId) =>
            Prisma.sql`(${organizationId}::varchar(128), ${projection.status}::varchar(64), ${projection.observedAt}::timestamptz(6))`,
        ),
      );
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO organization_ref (
          organization_id, status, relation_state, relation_observed_at
        )
        SELECT cascade.organization_id, cascade.status, 'UNKNOWN', cascade.observed_at
          FROM (VALUES ${rows}) AS cascade (organization_id, status, observed_at)
        ON CONFLICT (organization_id) DO UPDATE
           SET status               = EXCLUDED.status,
               relation_observed_at = EXCLUDED.relation_observed_at
         WHERE organization_ref.relation_observed_at IS NULL
            OR organization_ref.relation_observed_at <= EXCLUDED.relation_observed_at
      `);
    }
    return;
  }

  if (projection.kind === 'CREATED') {
    await tx.$executeRaw`
      INSERT INTO organization_ref (
        organization_id, parent_organization_id, hierarchy_path,
        hierarchy_depth, status, relation_state, relation_observed_at
      ) VALUES (
        ${projection.organizationId}, ${projection.parentOrganizationId},
        ${projection.hierarchyPath}, ${projection.hierarchyDepth},
        ${projection.status}, 'PROJECTED', ${projection.observedAt}
      )
      ON CONFLICT (organization_id) DO UPDATE
         SET parent_organization_id = EXCLUDED.parent_organization_id,
             hierarchy_path         = EXCLUDED.hierarchy_path,
             hierarchy_depth        = EXCLUDED.hierarchy_depth,
             status                 = EXCLUDED.status,
             relation_state         = 'PROJECTED',
             relation_observed_at   = EXCLUDED.relation_observed_at
       WHERE organization_ref.relation_observed_at IS NULL
          OR organization_ref.relation_observed_at <= EXCLUDED.relation_observed_at
    `;
    return;
  }

  // A move says nothing about status or depth, so neither is written on the
  // conflict branch. Writing a null over a known status would remove the
  // organization from its own union's subtree — a denial nobody asked for.
  //
  // On the insert branch there is no known status to keep, so the new row
  // carries none; `isWithinProjectedSubtree` requires a status, so an
  // organization first heard of through a move stays outside every subtree
  // until its `ORGANIZATION_CREATED` or a status change arrives. Missing, never
  // extra.
  await tx.$executeRaw`
    INSERT INTO organization_ref (
      organization_id, parent_organization_id, hierarchy_path,
      relation_state, relation_observed_at
    ) VALUES (
      ${projection.organizationId}, ${projection.parentOrganizationId},
      ${projection.hierarchyPath}, 'PROJECTED', ${projection.observedAt}
    )
    ON CONFLICT (organization_id) DO UPDATE
       SET parent_organization_id = EXCLUDED.parent_organization_id,
           hierarchy_path         = EXCLUDED.hierarchy_path,
           relation_state         = 'PROJECTED',
           relation_observed_at   = EXCLUDED.relation_observed_at
     WHERE organization_ref.relation_observed_at IS NULL
        OR organization_ref.relation_observed_at <= EXCLUDED.relation_observed_at
  `;
}

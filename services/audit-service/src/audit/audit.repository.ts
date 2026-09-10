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
import type { HashableAuditRecord } from './audit.canonical';
import {
  chainKeyOf,
  computeRecordHash,
  monthBounds,
  toStorableHash,
  type AuditChainKey,
  type AuditChainScope,
} from './audit.chain';

/** What one ingestion attempt did. */
export type IngestOutcome = 'WRITTEN' | 'DUPLICATE';

/**
 * The bounds on one ingestion transaction, stated rather than inherited.
 *
 * Prisma's defaults are two seconds to acquire a connection and five seconds to
 * run the transaction. Five seconds is a sensible default for a transaction
 * that contends with nobody, and AUD-003 made this one contend by design:
 * `ingest` takes the chain head's row lock **inside** the transaction, so every
 * concurrent writer on the same `(organization, month)` spends its wait on the
 * clock the ceiling is measured against. The queue is the feature — it is what
 * makes `previous_hash` unforkable — and the default ceiling turns a deep
 * enough queue into a driver-level `Transaction already closed`, which is a
 * failure the design predicts and does not want.
 *
 * Measured on this workstation (PostgreSQL 16 in Docker Desktop): a write
 * transaction costs ~85ms, nearly all of it the commit's WAL flush, and the
 * cost does not fall with concurrency because one chain's writers are
 * serialised on purpose. Twelve writers meeting at one head therefore queue for
 * roughly a second — comfortably inside five, until the database is also
 * checkpointing, at which point `test/concurrency.int-spec.ts` measured 5047ms
 * against a 5000ms ceiling and the whole storm failed.
 *
 * So the bound is stated at a value the queue can actually use, and it is still
 * a bound: thirty seconds is far below the consumer's `max.poll.interval.ms`,
 * so a genuinely stuck writer fails its poll and is retried by Kafka's
 * at-least-once delivery rather than holding a connection indefinitely. Raising
 * it does not weaken any guarantee — the lock, the trigger and the unique index
 * are what refuse a fork, and none of them is a timeout.
 */
const INGEST_TRANSACTION = { maxWait: 5_000, timeout: 30_000 } as const;

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
  // Selected since AUD-003 so the view can state an honest integrity flag.
  // `recordHash` is what `integrity` is derived from; `previousHash` comes with
  // it so the internal row type describes the whole link rather than half of
  // it. Neither is serialised — `audit.view.ts` publishes the flag, not the
  // digest.
  recordHash: true,
  previousHash: true,
  // `correctionOf` stays absent: it is never written (corrections need path B,
  // which is AUD-004), and publishing a permanently null correction link would
  // read as "not corrected", which is a claim this phase cannot make.
} as const;

/**
 * The columns the chain covers, which is every column except the two hash
 * columns themselves plus the two hash columns so a walk can compare.
 *
 * Listed separately from `AUDIT_EVENT_SELECT` rather than reusing it, because
 * the two answer different questions and must be free to diverge: this one is
 * the *input to a hash* and is therefore tied to `CANONICAL_FIELDS`, while that
 * one is the input to a public view. A column added to the view must not
 * silently change what the chain covers, and vice versa.
 */
const AUDIT_CHAIN_SELECT = {
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
  correctionOf: true,
  recordHash: true,
  previousHash: true,
} as const;

/**
 * One record as the chain walk sees it: everything the hash covers, plus the
 * stored link it is checked against.
 */
export interface AuditChainRow extends HashableAuditRecord {
  readonly recordHash: Uint8Array | null;
  readonly previousHash: Uint8Array | null;
}

/** The tip of one chain, or `null` when no record has ever opened it. */
export interface AuditChainHeadRow {
  readonly chainLength: bigint;
  readonly headHash: Uint8Array | null;
  readonly headEventId: string | null;
  readonly headSequenceNo: bigint | null;
  /**
   * Where this chain's verifiable segment begins. Null only on a head that has
   * never carried a record. Immutable once written, enforced by the database.
   */
  readonly firstSequenceNo: bigint | null;
}

/**
 * Where one month's requested slice starts and ends in chain order, and what
 * each of the two counts it implies actually costs.
 *
 * The two numbers are genuinely different and both are needed:
 *
 *   `recordsInRange`  how many records the caller asked about — rows whose
 *                     `occurredAt` falls inside the window. This is the
 *                     truthful figure the response reports.
 *   `walkLength`      how many records the verification will actually read —
 *                     every row in the contiguous `sequence_no` interval
 *                     between the first and last of those, including any that
 *                     arrived out of order and fall outside the window. This is
 *                     the figure the ceiling has to be checked against, because
 *                     it is the work.
 *
 * A sparse out-of-order window makes them differ by orders of magnitude: two
 * records an hour apart in `occurredAt` can sit at opposite ends of a month's
 * chain. Preflighting the smaller number would let exactly that request past
 * the control and then pay for the whole month.
 */
export interface AuditChainSegment {
  readonly firstSequenceNo: bigint;
  readonly lastSequenceNo: bigint;
  readonly recordsInRange: number;
  readonly walkLength: number;
}

/** One record named by position, for the bounded head and tail checks. */
export interface AuditChainMarker {
  readonly id: string;
  readonly sequenceNo: bigint;
  readonly recordHash: Uint8Array | null;
  readonly previousHash: Uint8Array | null;
}

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
   * Writes the audit row, its chain link and its idempotency marker in one
   * transaction.
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
   * second delivery is normal operation, not a fault. The duplicate check runs
   * **before** the chain is touched, so a replay neither takes a chain lock nor
   * advances a head — a chain that grew on redelivery would report a length no
   * set of records could reproduce.
   *
   * ## The chain assignment is inside this transaction, and has to be
   *
   * ADR-053 § 6 links each record to the previous one in its
   * `(organizationId, UTC month)` chain. Reading the tip outside the
   * transaction and inserting inside it is a race: two workers would read the
   * same tip and write two records claiming the same predecessor, forking the
   * chain with nothing raising. So the tip is read with `SELECT … FOR UPDATE`
   * *in this transaction*, and the row lock is held until commit. Rolling back
   * therefore leaves neither an advanced head, nor a processed marker, nor a
   * row: PostgreSQL releases the lock and the next writer reads the same tip it
   * would have read had this attempt never started.
   *
   * Only one `(organization, month)` head is held at a time. Two tenants, or
   * one tenant in two months, are separate rows and block none of each other's
   * writes — which is why ADR-053 scopes the chain per tenant-month rather than
   * globally.
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

        const key = chainKeyOf(record.organizationId, record.occurredAt);

        // Opens the chain if this is its first record. `ON CONFLICT DO NOTHING`
        // is idempotent and, under PostgreSQL's speculative-insertion protocol,
        // waits for a concurrent creator to commit or abort before returning —
        // so the row the next statement locks is guaranteed to be there.
        // Nothing ever deletes a head, so it stays there.
        await tx.$executeRaw`
          INSERT INTO audit_chain_head (chain_scope, organization_id, chain_month)
          VALUES (
            ${key.scope}::audit_chain_scope,
            ${key.organizationKey},
            ${key.chainMonth}::date
          )
          ON CONFLICT (chain_scope, organization_id, chain_month) DO NOTHING
        `;

        // The lock. Everything after this line is serialised per chain.
        //
        // `recorded_at` and `sequence_no` are drawn here rather than left to
        // their column defaults, for one reason: the record hash covers them,
        // and a value the hash does not cover is a value somebody can change
        // without the chain noticing. `now()` is `transaction_timestamp()`, so
        // it is the identical value `DEFAULT now()` would have produced — the
        // database's clock, never this process's. `nextval` is drawn under the
        // lock, which is what makes `sequence_no` ascending equal to chain
        // order within one chain.
        const locked = await tx.$queryRaw<
          { head_hash: Uint8Array | null; recorded_at: Date; sequence_no: bigint }[]
        >`
          SELECT head_hash,
                 now() AS recorded_at,
                 nextval('audit_event_sequence_no_seq') AS sequence_no
            FROM audit_chain_head
           WHERE chain_scope = ${key.scope}::audit_chain_scope
             AND organization_id = ${key.organizationKey}
             AND chain_month = ${key.chainMonth}::date
             FOR UPDATE
        `;

        const tip = locked[0];
        if (!tip) {
          // Unreachable while the head table keeps its no-DELETE grant and its
          // trigger. Thrown rather than defaulted to "start a new chain",
          // because silently restarting a chain is the outcome the chain exists
          // to make impossible.
          throw new Error('audit chain head vanished between insert and lock');
        }

        // Copied out of the driver's buffer once, here, rather than at each
        // of the two places it is used. `toStorableHash` returns a
        // `ChainHash` — a view over an `ArrayBuffer` this process owns — which
        // is what both `computeRecordHash` and the Prisma `Bytes` input
        // require, and which guarantees the bytes hashed and the bytes stored
        // are the same bytes rather than two reads of a pooled buffer.
        const previousHash = tip.head_hash === null ? null : toStorableHash(tip.head_hash);

        // One object, used for the hash *and* for the insert, so the two can
        // never describe different rows. The columns path A does not populate
        // are written as explicit nulls here rather than omitted: the hash
        // covers them, and "absent" and "null" must not be able to mean two
        // different things.
        const stored: HashableAuditRecord = {
          id: record.id,
          occurredAt: record.occurredAt,
          recordedAt: tip.recorded_at,
          actorType: record.actorType,
          actorId: record.actorId,
          actorRoles: record.actorRoles,
          organizationId: record.organizationId,
          action: record.action,
          resourceType: record.resourceType,
          resourceId: record.resourceId,
          outcome: record.outcome,
          errorCode: null,
          reason: null,
          changes: null,
          occurrenceCount: record.occurrenceCount,
          sourceService: record.sourceService,
          sourceServiceVersion: record.sourceServiceVersion,
          sourceEventId: record.sourceEventId,
          sourceEventName: record.sourceEventName,
          sourceTopic: record.sourceTopic,
          sourceIp: null,
          sourceUserAgent: null,
          correlationId: record.correlationId,
          causationId: record.causationId,
          traceparent: record.traceparent,
          sourceStreamSeq: record.sourceStreamSeq,
          sequenceNo: tip.sequence_no,
          correctionOf: null,
        };

        const recordHash = computeRecordHash(stored, previousHash);

        await tx.auditEvent.create({
          data: {
            id: stored.id,
            occurredAt: stored.occurredAt,
            recordedAt: stored.recordedAt,
            actorType: record.actorType,
            actorId: stored.actorId,
            actorRoles: [...stored.actorRoles],
            organizationId: stored.organizationId,
            action: stored.action,
            resourceType: stored.resourceType,
            resourceId: stored.resourceId,
            outcome: record.outcome,
            errorCode: stored.errorCode,
            reason: stored.reason,
            occurrenceCount: stored.occurrenceCount,
            sourceService: stored.sourceService,
            sourceServiceVersion: stored.sourceServiceVersion,
            sourceEventId: stored.sourceEventId,
            sourceEventName: stored.sourceEventName,
            sourceTopic: stored.sourceTopic,
            sourceIp: stored.sourceIp,
            sourceUserAgent: stored.sourceUserAgent,
            correlationId: stored.correlationId,
            causationId: stored.causationId,
            traceparent: stored.traceparent,
            sourceStreamSeq: stored.sourceStreamSeq,
            sequenceNo: stored.sequenceNo,
            correctionOf: stored.correctionOf,
            recordHash,
            previousHash,
          },
        });

        // Advances the tip the lock was taken on. The trigger refuses any
        // update that does not move `chain_length` forward by exactly one, so a
        // rewind is refused by the database rather than by this line staying
        // correct.
        //
        // `first_sequence_no` is written with `COALESCE`, which is the whole
        // set-once rule in one expression: on the first record of a chain the
        // column is null and takes this record's position, and on every later
        // record it already holds a value and keeps it. The trigger refuses
        // any other outcome, so a future edit that dropped the `COALESCE`
        // fails in the database rather than silently moving the boundary
        // between "legacy" and "damaged" forward.
        await tx.$executeRaw`
          UPDATE audit_chain_head
             SET chain_length      = chain_length + 1,
                 head_hash         = ${recordHash},
                 head_event_id     = ${stored.id},
                 head_occurred_at  = ${stored.occurredAt},
                 head_sequence_no  = ${stored.sequenceNo},
                 first_sequence_no = COALESCE(first_sequence_no, ${stored.sequenceNo}),
                 updated_at        = now()
           WHERE chain_scope = ${key.scope}::audit_chain_scope
             AND organization_id = ${key.organizationKey}
             AND chain_month = ${key.chainMonth}::date
        `;

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
      }, INGEST_TRANSACTION);
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

  // -------------------------------------------------------------------------
  // AUD-003 — the chain read side
  //
  // Every method below takes an `AuditChainKey`, which is resolved from the
  // caller's authority before the verification service reaches this class. A
  // chain is always exactly one tenant-month or exactly the platform month, so
  // there is no shape here that can widen: the platform chain is
  // `organization_id IS NULL` and a tenant chain is `organization_id = $1`, and
  // the two are separate branches rather than one predicate with an `OR`
  // (ADR-053 § 10).
  // -------------------------------------------------------------------------

  /** The month-and-tenant bound every chain read shares. */
  private chainWhere(key: AuditChainKey): Prisma.AuditEventWhereInput {
    const { start, end } = monthBounds(key.chainMonth);
    return {
      // `null` is Prisma's `IS NULL`, and it is reachable only from a
      // `PLATFORM` key, which only a platform-authority caller can produce.
      organizationId: key.scope === 'PLATFORM' ? null : key.organizationKey,
      occurredAt: { gte: start, lt: end },
    };
  }

  /** The stored tip of one chain, or `null` if no record ever opened it. */
  async chainHead(key: AuditChainKey): Promise<AuditChainHeadRow | null> {
    const row = await this.prisma.client.auditChainHead.findUnique({
      where: {
        chainScope_organizationId_chainMonth: {
          chainScope: key.scope as AuditChainScope,
          organizationId: key.organizationKey,
          chainMonth: new Date(`${key.chainMonth}T00:00:00.000Z`),
        },
      },
      select: {
        chainLength: true,
        headHash: true,
        headEventId: true,
        headSequenceNo: true,
        firstSequenceNo: true,
      },
    });

    return row === null
      ? null
      : {
          chainLength: row.chainLength,
          headHash: row.headHash,
          headEventId: row.headEventId,
          headSequenceNo: row.headSequenceNo,
          firstSequenceNo: row.firstSequenceNo,
        };
  }

  /**
   * Where the requested window lands in one month's chain, in chain order.
   *
   * Returns the first and last chain positions the window touches — not the
   * rows. A window is expressed in `occurredAt` and a chain is ordered by
   * `sequenceNo`, and the two orders are genuinely different: an event that
   * occurred earlier can be consumed later, which ADR-053 § 8 designs for
   * rather than prevents. So the walk covers the **contiguous** chain segment
   * between the two extremes, which necessarily includes any record that landed
   * between them out of order. Verifying a non-contiguous subsequence would be
   * verifying links that do not exist.
   */
  async chainSegment(key: AuditChainKey, from: Date, to: Date): Promise<AuditChainSegment | null> {
    const { start } = monthBounds(key.chainMonth);
    const where = this.chainWhere(key);
    const lower = from.getTime() > start.getTime() ? from : start;

    const aggregate = await this.prisma.client.auditEvent.aggregate({
      where: {
        ...where,
        occurredAt: { ...(where.occurredAt as Prisma.DateTimeFilter), gte: lower, lte: to },
      },
      _min: { sequenceNo: true },
      _max: { sequenceNo: true },
      _count: { _all: true },
    });

    const first = aggregate._min.sequenceNo;
    const last = aggregate._max.sequenceNo;
    if (first === null || last === null) return null;

    // The second count, and the reason this method returns two. `_count` above
    // counts what the caller asked about; this counts what verifying it costs.
    // They are equal only when the window's records happen to be contiguous in
    // chain order, and ADR-053 § 8 explicitly tolerates arrival out of order,
    // so the difference is a designed-for case rather than a pathological one.
    //
    // Still one index range scan over one tenant-month — `audit_event_chain_idx`
    // is `(organization_id, sequence_no)` and the month partition is already
    // pruned — so the preflight costs a count, never a read of the rows.
    const walkLength = await this.prisma.client.auditEvent.count({
      where: { ...where, sequenceNo: { gte: first, lte: last } },
    });

    return {
      firstSequenceNo: first,
      lastSequenceNo: last,
      recordsInRange: aggregate._count._all,
      walkLength,
    };
  }

  /**
   * The record immediately before a chain position — the seed a mid-range
   * verification recomputes from.
   *
   * Without it a window that starts mid-chain could only ever say "these links
   * agree with each other", which a forger who rewrote a whole run of records
   * would also satisfy. With it, the first record in the window is checked
   * against a hash that was written by a transaction the window does not
   * contain.
   */
  async chainPredecessor(
    key: AuditChainKey,
    firstSequenceNo: bigint,
  ): Promise<{ sequenceNo: bigint; recordHash: Uint8Array | null } | null> {
    const row = await this.prisma.client.auditEvent.findFirst({
      where: { ...this.chainWhere(key), sequenceNo: { lt: firstSequenceNo } },
      orderBy: { sequenceNo: 'desc' },
      select: { sequenceNo: true, recordHash: true },
    });

    return row ?? null;
  }

  /**
   * One page of a chain, in chain order.
   *
   * Paged rather than read whole. A month of a busy tenant is an unbounded
   * result set, and materialising it to verify it would make the verification
   * endpoint the most expensive thing this service does — and the easiest way
   * to take it down (ADR-053 § 10 makes the same argument for the query
   * window).
   */
  async chainPage(
    key: AuditChainKey,
    bounds: { firstSequenceNo: bigint; lastSequenceNo: bigint },
    afterSequenceNo: bigint | null,
    limit: number,
  ): Promise<AuditChainRow[]> {
    const lower = afterSequenceNo === null ? bounds.firstSequenceNo : afterSequenceNo + 1n;

    const rows = await this.prisma.client.auditEvent.findMany({
      where: {
        ...this.chainWhere(key),
        sequenceNo: { gte: lower, lte: bounds.lastSequenceNo },
      },
      orderBy: { sequenceNo: 'asc' },
      take: limit,
      select: AUDIT_CHAIN_SELECT,
    });

    return rows;
  }

  /**
   * The record a chain head claims to be its tip, read by position.
   *
   * One row, by the same `(organization_id, sequence_no)` index the walk uses.
   * It exists so a verification can ask whether the head names something real:
   * the head is the only row in this service the runtime may `UPDATE`, so it is
   * the cheapest thing to point at a record that was deleted — and a head
   * naming a row that is gone would otherwise read as "the chain simply
   * continues past your window".
   */
  async chainRecordAt(key: AuditChainKey, sequenceNo: bigint): Promise<AuditChainMarker | null> {
    const row = await this.prisma.client.auditEvent.findFirst({
      where: { ...this.chainWhere(key), sequenceNo },
      select: { id: true, sequenceNo: true, recordHash: true, previousHash: true },
    });

    return row ?? null;
  }

  /**
   * The next record in a chain after a position — the window's tail check.
   *
   * `take: 1` on the chain index, so it is a single index seek regardless of
   * how far the chain runs past the window. A head that names a position beyond
   * the verified window is only legitimate if a record actually stands between
   * the two; without this the verifier would accept "the head is ahead of you"
   * as an explanation for a tail that had been deleted.
   *
   * `previousHash` comes back with it so the successor's link to the window's
   * last record can be checked in the same read — which is what proves nothing
   * was removed immediately after the window rather than merely that *something*
   * exists later.
   */
  async chainSuccessor(
    key: AuditChainKey,
    afterSequenceNo: bigint,
  ): Promise<AuditChainMarker | null> {
    const row = await this.prisma.client.auditEvent.findFirst({
      where: { ...this.chainWhere(key), sequenceNo: { gt: afterSequenceNo } },
      orderBy: { sequenceNo: 'asc' },
      select: { id: true, sequenceNo: true, recordHash: true, previousHash: true },
    });

    return row ?? null;
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

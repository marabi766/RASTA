import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ErrorCode } from '@rasta/contracts';
import type {
  ClaimRequest,
  OutboxClaim,
  OutboxRow,
  OutboxStore,
  RetryBackoff,
} from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { toSecurityEventOutboxRow, type SecurityEventRecord } from './audit-trail-envelope';
import {
  aggregationIdentityOf,
  assertAggregationWindowSeconds,
  MAX_OCCURRENCE_COUNT,
  type CapturedOccurrence,
} from './refusal-aggregation';

/**
 * `security_event_outbox` persistence — the capture write and the ADR-050 claim
 * protocol over this service's own table (ADR-053 § 4, AUD-004 Phases C1–C2).
 *
 * ## Why these statements are here and not in `@rasta/nest-common`
 *
 * The shared outbox SQL names `outbox_message`, and parameterising a table name
 * would put string interpolation into SQL that eight services run. This table
 * belongs to one service, so its statements stay with it (A-01), and the shared
 * package keeps only what it already had: the relay, which is transport and
 * claim mechanics with no audit or identity knowledge (A-03).
 *
 * ## The same protocol, deliberately
 *
 * Every mutation is fenced on `claim_token` and on nothing else; expiry only
 * decides whether somebody else may take a row back; retry delay is computed
 * from the database clock. Those are ADR-050's three rules, and a second queue
 * with different ones would be a second protocol to reason about.
 *
 * The claim is one statement with the lock taken inside the limited selection,
 * which is what stops two claimants starving each other. The shared statement's
 * four-stream decomposition is a planner workaround for `outbox_message` at six
 * figures of rows; this table holds refusals awaiting a one-second flush, and
 * published rows leave the partial index the query uses.
 *
 * ## Windowed aggregation (Phase C2)
 *
 * Two rules, one on each side of the table, and the database enforces both:
 *
 *   capture  counts a refusal into the one row that is unpublished, never
 *            claimed, below the INTEGER ceiling and has the same identity and
 *            window — or inserts a new row if there is none. One
 *            `INSERT … ON CONFLICT DO UPDATE` over the partial unique index
 *            `ux_security_event_outbox_open_bucket`, so concurrent matching
 *            refusals cannot produce two rows and cannot lose a count.
 *   claim    takes only rows whose window has closed on the database clock.
 *            Claiming sets `claim_count` above zero, which removes the row
 *            from the capture's index; a refusal racing the claim waits on the
 *            row lock and then either counted before the claim committed or
 *            inserts a successor row. The row the relay publishes has stopped
 *            changing — and the table's trigger refuses any later change.
 */

/** Slack between `statement_timeout` and Prisma's transaction ceiling. */
const TRANSACTION_MARGIN_MS = 1_000;
/** `last_error VARCHAR(1000)`. */
const LAST_ERROR_MAX_LENGTH = 1000;

/**
 * The database's current instant in UTC at the columns' millisecond precision.
 * The single definition of "now" for every window decision: which window a
 * refusal falls in, whether a window has closed, and the backlog gauges. A
 * code constant — never built from data.
 */
const DATABASE_NOW_UTC = `(statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)`;

/**
 * The partial unique index's predicate, verbatim: `ON CONFLICT` infers the
 * arbiter only when its `WHERE` implies the index's.
 */
const OPEN_BUCKET_PREDICATE = `
       published_at IS NULL
   AND claim_count = 0
   AND occurrence_count < ${MAX_OCCURRENCE_COUNT}
   AND window_ends_at - window_started_at >= interval '1 second'`;

/**
 * Count one refusal. Parameters, in order: id, organization_id, actor_type,
 * actor_id, actor_roles, action, resource_type, resource_id, error_code,
 * reason, source_ip, source_user_agent, correlation_id, traceparent,
 * producer_version, window seconds.
 *
 * On insert every column is this refusal's. On conflict only the count moves:
 * the first occurrence's sample (ip, user agent, correlation, trace, roles,
 * version) stays, and `$1` — this refusal's own ULID — is simply not used.
 */
const CAPTURE_SQL = `
  WITH clock AS (
    SELECT ${DATABASE_NOW_UTC} AS ts
  ), bucket AS (
    SELECT ts,
           date_bin(make_interval(secs => $16::double precision), ts, TIMESTAMP '1970-01-01') AS started
      FROM clock
  )
  INSERT INTO security_event_outbox (
    id, organization_id, actor_type, actor_id, actor_roles, action,
    resource_type, resource_id, error_code, reason, source_ip, source_user_agent,
    correlation_id, traceparent, producer_version, occurred_at, created_at,
    occurrence_count, window_started_at, window_ends_at
  )
  SELECT $1::text, $2::text, $3::text, $4::text, $5::text[], $6::text,
         $7::text, $8::text, $9::text, $10::text, $11::text, $12::text,
         $13::text, $14::text, $15::text, b.ts, b.ts,
         1, b.started, b.started + make_interval(secs => $16::double precision)
    FROM bucket b
  ON CONFLICT (
    organization_id, actor_type, actor_id, action,
    resource_type, resource_id, error_code,
    window_started_at, window_ends_at
  ) WHERE ${OPEN_BUCKET_PREDICATE}
  DO UPDATE SET occurrence_count = security_event_outbox.occurrence_count + 1
  RETURNING id, occurrence_count, (xmax = 0) AS created`;

const RETURNED_COLUMNS = `
  o.id, o.organization_id, o.actor_type, o.actor_id, o.actor_roles, o.action,
  o.resource_type, o.resource_id, o.error_code, o.reason, o.source_ip,
  o.source_user_agent, o.correlation_id, o.traceparent, o.producer_version,
  o.occurred_at, o.occurrence_count, o.window_ends_at, o.created_at,
  o.published_at, o.attempts, o.last_error`;

interface RawSecurityEventRow {
  id: string;
  organization_id: string | null;
  actor_type: SecurityEventRecord['actorType'];
  actor_id: string;
  actor_roles: string[];
  action: string;
  resource_type: string;
  resource_id: string | null;
  error_code: string;
  reason: string | null;
  source_ip: string | null;
  source_user_agent: string | null;
  correlation_id: string;
  traceparent: string | null;
  producer_version: string;
  occurred_at: Date;
  occurrence_count: number;
  window_ends_at: Date;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
}

interface ClaimedRow extends RawSecurityEventRow {
  claim_token: string;
  reclaimed: boolean;
}

function toRow(raw: RawSecurityEventRow): OutboxRow {
  return toSecurityEventOutboxRow({
    id: raw.id,
    organizationId: raw.organization_id,
    actorType: raw.actor_type,
    actorId: raw.actor_id,
    actorRoles: raw.actor_roles ?? [],
    action: raw.action,
    resourceType: raw.resource_type,
    resourceId: raw.resource_id,
    // The CHECK-free column is re-validated against the contract enum before
    // publish (`assertPublishableAuditTrailRow`); a wrong value never leaves.
    errorCode: raw.error_code as ErrorCode,
    reason: raw.reason,
    sourceIp: raw.source_ip,
    sourceUserAgent: raw.source_user_agent,
    correlationId: raw.correlation_id,
    traceparent: raw.traceparent,
    producerVersion: raw.producer_version,
    occurredAt: raw.occurred_at,
    occurrenceCount: raw.occurrence_count,
    createdAt: raw.created_at,
    publishedAt: raw.published_at,
    attempts: raw.attempts,
    lastError: raw.last_error,
  });
}

/**
 * A positive safe integer for `SET LOCAL statement_timeout`, which accepts no
 * bind parameter. Derived from validated configuration, never request input,
 * and coerced so nothing but digits reaches the statement (S-05).
 */
function statementTimeoutOf(timeoutMs: number): number {
  const bound = Math.max(1, Math.floor(timeoutMs));
  if (!Number.isSafeInteger(bound)) {
    throw new Error('security event outbox: refusing a non-integer statement timeout');
  }
  return bound;
}

export interface CaptureWriteOptions {
  /** `SECURITY_EVENT_CAPTURE_TIMEOUT_MS`. */
  timeoutMs: number;
  /** `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS`. */
  windowSeconds: number;
}

/** Sampled from the database for the gauges; never kept in memory. */
export interface AggregationBacklog {
  /** Unpublished rows whose window is still open — counting, not claimable. */
  openWindows: number;
  /** Unpublished rows whose window has closed — claimable now. */
  closedBacklog: number;
  /** Seconds since the oldest closed, unpublished window ended; 0 when none. */
  closedBacklogAgeSeconds: number;
}

@Injectable()
export class SecurityEventOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Counts one refusal into its aggregation window, in its own short
   * transaction.
   *
   * One batched transaction — `SET LOCAL statement_timeout` and the upsert
   * sent to the engine together — rather than an interactive one. Every
   * matching refusal of a probe contends for the same row lock, and an
   * interactive transaction would hold it across a client round trip per
   * statement; batched, the lock is held for the upsert and its commit only.
   * Measured, not assumed: forty concurrent writers on one row pushed
   * interactive captures past a five-second `statement_timeout`
   * (`test/security-event-aggregation.int-spec.ts`).
   *
   * `statement_timeout` bounds the database work, including any lock it waits
   * on — a concurrent claim of the same row, for instance. The recorder's hard
   * deadline bounds the HTTP response whatever the driver does, including a
   * wait for a pooled connection.
   */
  async capture(
    draft: SecurityEventRecord,
    options: CaptureWriteOptions,
  ): Promise<CapturedOccurrence> {
    const bound = statementTimeoutOf(options.timeoutMs);
    const windowSeconds = assertAggregationWindowSeconds(options.windowSeconds);
    const key = aggregationIdentityOf(draft);
    const client = this.prisma.client;

    const [, rows] = await client.$transaction([
      client.$executeRawUnsafe(`SET LOCAL statement_timeout = ${bound}`),
      client.$queryRawUnsafe<{ id: string; occurrence_count: number; created: boolean }[]>(
        CAPTURE_SQL,
        draft.id,
        key.organizationId,
        key.actorType,
        key.actorId,
        [...draft.actorRoles],
        key.action,
        key.resourceType,
        key.resourceId,
        key.errorCode,
        draft.reason,
        draft.sourceIp,
        draft.sourceUserAgent,
        draft.correlationId,
        draft.traceparent,
        draft.producerVersion,
        windowSeconds,
      ),
    ]);

    // Without a `DO UPDATE … WHERE`, an upsert always yields its row. Zero
    // would mean the refusal was not counted, and must not look recorded.
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) {
      throw new Error('security event outbox capture: the upsert did not return its row');
    }
    return {
      id: row.id,
      occurrenceCount: Number(row.occurrence_count),
      created: row.created,
    };
  }

  async claimPending(request: ClaimRequest): Promise<OutboxClaim> {
    // A fresh token per attempt: a process claiming twice must not be able to
    // acknowledge its first claim with its second token (ADR-050).
    const token = randomUUID();
    const rows = await this.prisma.client.$queryRawUnsafe<ClaimedRow[]>(
      `WITH due AS (
         SELECT id, claim_expires_at AS prev_expires_at
           FROM security_event_outbox
          WHERE published_at IS NULL
            -- An open window is still counting. Never publish it (Phase C2).
            AND window_ends_at <= ${DATABASE_NOW_UTC}
            AND (claim_expires_at IS NULL OR claim_expires_at <= now())
            AND (next_attempt_at  IS NULL OR next_attempt_at  <= now())
          ORDER BY window_ends_at, id
          LIMIT $4
            FOR UPDATE SKIP LOCKED
       )
       UPDATE security_event_outbox AS o
          SET claim_token      = $1,
              claim_owner      = $2,
              claim_expires_at = now() + make_interval(secs => $3::double precision),
              claim_count      = o.claim_count + 1
         FROM due
        WHERE o.id = due.id
       RETURNING ${RETURNED_COLUMNS}, o.claim_token,
                 (due.prev_expires_at IS NOT NULL) AS reclaimed`,
      token,
      request.owner,
      request.leaseSeconds,
      request.limit,
    );

    if (rows.length === 0) return { token: null, rows: [], reclaimed: 0 };

    // Trust what the database wrote, not what was sent.
    if (rows.some((row) => row.claim_token !== token)) {
      throw new Error(
        'security event outbox claim: the database returned a token other than the one written',
      );
    }

    return {
      token,
      // `UPDATE ... RETURNING` does not preserve the selection order.
      rows: rows
        .sort(
          (a, b) =>
            a.window_ends_at.getTime() - b.window_ends_at.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .map(toRow),
      reclaimed: rows.filter((row) => row.reclaimed).length,
    };
  }

  /** Fenced on the token only — never on expiry (ADR-050). Returns rows acknowledged. */
  async markPublished(ids: readonly string[], token: string): Promise<number> {
    if (ids.length === 0) return 0;
    return this.prisma.client.$executeRawUnsafe(
      `UPDATE security_event_outbox
          SET published_at     = now(),
              claim_token      = NULL,
              claim_owner      = NULL,
              claim_expires_at = NULL,
              next_attempt_at  = NULL
        WHERE id = ANY($1::text[])
          AND claim_token = $2
          AND published_at IS NULL`,
      [...ids],
      token,
    );
  }

  /**
   * Records a failure, releases the claim and schedules the retry with the
   * database clock: `min(2^min(attempts, 10) × base, max)`, `attempts` being
   * the pre-update value.
   */
  async markFailed(
    id: string,
    token: string,
    error: string,
    backoff: RetryBackoff,
  ): Promise<number> {
    return this.prisma.client.$executeRawUnsafe(
      `UPDATE security_event_outbox
          SET attempts         = attempts + 1,
              last_error       = $3,
              next_attempt_at  = now() + make_interval(secs => least(
                power(2, least(attempts, 10)) * $4::double precision,
                $5::double precision
              )),
              claim_token      = NULL,
              claim_owner      = NULL,
              claim_expires_at = NULL
        WHERE id = $1
          AND claim_token = $2`,
      id,
      token,
      error.slice(0, LAST_ERROR_MAX_LENGTH),
      backoff.baseSeconds,
      backoff.maxSeconds,
    );
  }

  /** Gives rows back without counting a failure. */
  async release(ids: readonly string[], token: string): Promise<number> {
    if (ids.length === 0) return 0;
    return this.prisma.client.$executeRawUnsafe(
      `UPDATE security_event_outbox
          SET claim_token      = NULL,
              claim_owner      = NULL,
              claim_expires_at = NULL
        WHERE id = ANY($1::text[])
          AND claim_token = $2`,
      [...ids],
      token,
    );
  }

  /** Extends the lease and returns the ids still owned. */
  async renew(
    ids: readonly string[],
    token: string,
    leaseSeconds: number,
    deadlineMs: number,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const bound = statementTimeoutOf(deadlineMs);
    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${bound}`);
        const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
          `UPDATE security_event_outbox
              SET claim_expires_at = now() + make_interval(secs => $3::double precision)
            WHERE id = ANY($1::text[])
              AND claim_token = $2
              AND published_at IS NULL
          RETURNING id`,
          [...ids],
          token,
          leaseSeconds,
        );
        return rows.map((row) => row.id);
      },
      { maxWait: bound, timeout: bound + TRANSACTION_MARGIN_MS },
    );
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    const result = await this.prisma.client.$queryRawUnsafe<{ age: number | null }[]>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::float8 AS age
         FROM security_event_outbox
        WHERE published_at IS NULL`,
    );
    return result[0]?.age ?? 0;
  }

  async pendingCount(): Promise<number> {
    return this.prisma.client.securityEventOutbox.count({ where: { publishedAt: null } });
  }

  async activeLeaseCount(): Promise<number> {
    const result = await this.prisma.client.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count
         FROM security_event_outbox
        WHERE published_at IS NULL
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at > now()`,
    );
    return Number(result[0]?.count ?? 0);
  }

  /** Open windows against the closed backlog the relay should be draining. */
  async aggregationBacklog(): Promise<AggregationBacklog> {
    const result = await this.prisma.client.$queryRawUnsafe<
      { open_windows: bigint; closed_backlog: bigint; closed_age: number | null }[]
    >(
      `WITH clock AS (SELECT ${DATABASE_NOW_UTC} AS ts)
       SELECT count(*) FILTER (WHERE o.window_ends_at >  clock.ts)::bigint AS open_windows,
              count(*) FILTER (WHERE o.window_ends_at <= clock.ts)::bigint AS closed_backlog,
              EXTRACT(EPOCH FROM (
                clock.ts - MIN(o.window_ends_at) FILTER (WHERE o.window_ends_at <= clock.ts)
              ))::float8 AS closed_age
         FROM clock
         LEFT JOIN security_event_outbox o ON o.published_at IS NULL
        GROUP BY clock.ts`,
    );
    const row = result[0];
    return {
      openWindows: Number(row?.open_windows ?? 0),
      closedBacklog: Number(row?.closed_backlog ?? 0),
      closedBacklogAgeSeconds: Math.max(0, row?.closed_age ?? 0),
    };
  }
}

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

/**
 * `security_event_outbox` persistence — the capture write and the ADR-050 claim
 * protocol over this service's own table (ADR-053 § 4, AUD-004 Phase C1).
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
 */

/** Slack between `statement_timeout` and Prisma's transaction ceiling. */
const TRANSACTION_MARGIN_MS = 1_000;
/** `last_error VARCHAR(1000)`. */
const LAST_ERROR_MAX_LENGTH = 1000;

const RETURNED_COLUMNS = `
  o.id, o.organization_id, o.actor_type, o.actor_id, o.actor_roles, o.action,
  o.resource_type, o.resource_id, o.error_code, o.reason, o.source_ip,
  o.source_user_agent, o.correlation_id, o.traceparent, o.producer_version,
  o.occurred_at, o.created_at, o.published_at, o.attempts, o.last_error`;

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

@Injectable()
export class SecurityEventOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes one refusal in its own short transaction.
   *
   * Bounded twice on the database side: `maxWait` for acquiring a connection
   * and `statement_timeout` for the insert, including any lock it waits on.
   * The recorder adds a hard deadline around the whole call, so the HTTP
   * response is never held past the configured bound whatever the driver does.
   */
  async insert(draft: SecurityEventRecord, timeoutMs: number): Promise<void> {
    const bound = statementTimeoutOf(timeoutMs);
    await this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${bound}`);
        await tx.securityEventOutbox.create({
          data: {
            id: draft.id,
            organizationId: draft.organizationId,
            actorType: draft.actorType,
            actorId: draft.actorId,
            actorRoles: [...draft.actorRoles],
            action: draft.action,
            resourceType: draft.resourceType,
            resourceId: draft.resourceId,
            errorCode: draft.errorCode,
            reason: draft.reason,
            sourceIp: draft.sourceIp,
            sourceUserAgent: draft.sourceUserAgent,
            correlationId: draft.correlationId,
            traceparent: draft.traceparent,
            producerVersion: draft.producerVersion,
            occurredAt: draft.occurredAt,
          },
        });
      },
      { maxWait: bound, timeout: bound + TRANSACTION_MARGIN_MS },
    );
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
            AND (claim_expires_at IS NULL OR claim_expires_at <= now())
            AND (next_attempt_at  IS NULL OR next_attempt_at  <= now())
          ORDER BY created_at, id
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
            a.created_at.getTime() - b.created_at.getTime() ||
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
}

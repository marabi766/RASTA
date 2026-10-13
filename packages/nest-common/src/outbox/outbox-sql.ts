import { OUTBOX_PURGE_TRANSACTION_MARGIN_MS } from '@rasta/config';
import { toStreamSeq } from '@rasta/contracts';

import { orderForPublish, type OutboxRow } from './outbox';

/**
 * The SQL behind every service's outbox store.
 *
 * All eight implemented services had a byte-identical `outbox.store.ts`, so a
 * correctness fix had to be applied — correctly — eight times. This module
 * holds the statements once.
 *
 * It stays inside A-03: there is no business rule here and no service reaches
 * another service's database (A-01). The caller supplies its **own** client,
 * and the statements name only `outbox_message`, a table every service owns a
 * private copy of. What lives here is the wire format of the claim protocol —
 * a contract, in the same sense as an event schema.
 *
 * Every value is bound as a parameter. Nothing is interpolated into SQL (S-05),
 * with one guarded exception noted on {@link renewSql}.
 *
 * **The token is the only fence.** Every mutation below matches on
 * `claim_token` exactly, and not one of them conditions on `claim_expires_at`.
 * Expiry decides only whether a row may be *taken back* by somebody else.
 * ADR-050 explains why the two must not be confused; in short, an owner whose
 * lease lapsed while nobody reclaimed the row has published the event and must
 * still be able to say so.
 */

/**
 * The subset of a Prisma client these statements need.
 *
 * Deliberately structural rather than an import of `PrismaClient`: this package
 * must not depend on any one service's generated client, and eight different
 * generated clients have to satisfy it.
 */
export interface OutboxSqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Runs `fn` inside one transaction that lives at least `timeoutMs`.
 *
 * Only {@link renewSql} needs it, and it is a callback rather than a method on
 * {@link OutboxSqlClient} for a concrete reason: Prisma's `$transaction` is an
 * overload set whose first signature takes an array, so a structural interface
 * requiring it never matches a real `PrismaClient`. Supplying the call from the
 * service side sidesteps the overload entirely.
 */
export type OutboxTxRunner = <T>(
  fn: (tx: OutboxSqlClient) => Promise<T>,
  timeoutMs: number,
) => Promise<T>;

export interface RawOutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_name: string;
  event_version: number;
  topic: string;
  partition_key: string;
  payload: unknown;
  headers: unknown;
  organization_id: string | null;
  correlation_id: string;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
  /** `BIGINT`, so Prisma's raw query returns a `bigint`; NULL before B3. */
  stream_seq: bigint | number | null;
}

export function toOutboxRow(row: RawOutboxRow): OutboxRow {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventName: row.event_name,
    eventVersion: row.event_version,
    topic: row.topic,
    partitionKey: row.partition_key,
    payload: row.payload,
    headers: (row.headers ?? {}) as Record<string, string>,
    organizationId: row.organization_id,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    attempts: row.attempts,
    lastError: row.last_error,
    // Converted at the one boundary that checks it (see `toStreamSeq`).
    streamSeq:
      row.stream_seq === null || row.stream_seq === undefined ? null : toStreamSeq(row.stream_seq),
  };
}

// ---------------------------------------------------------------------------
// ADR-051 Phase B3 — per-stream sequence allocation
// ---------------------------------------------------------------------------

/** The service-local counter table B1 created. One row per ordered stream. */
export const STREAM_SEQUENCE_TABLE = 'outbox_stream_sequence';

/**
 * Allocates this event's position in its stream, inside the caller's
 * transaction.
 *
 * ADR-051 § D-2, implemented exactly as the ADR specifies:
 *
 * ```sql
 * INSERT INTO outbox_stream_sequence AS s (topic, partition_key, next_seq)
 * VALUES ($1, $2, 2)
 * ON CONFLICT (topic, partition_key)
 * DO UPDATE SET next_seq = s.next_seq + 1
 * RETURNING next_seq - 1 AS allocated;
 * ```
 *
 * A fresh stream inserts `next_seq = 2` and is handed **1**; an existing one
 * increments and is handed the value it had. Both branches leave
 * `next_seq = allocated + 1`, so B2's initialisation — `next_seq =
 * max(stream_seq) + 1` — continues seamlessly and the first event after a
 * backfill gets the number immediately after the last backfilled row.
 *
 * `published_seq` is never touched here. It moves in `markPublished`, which is
 * B4's work and is not part of B3.
 *
 * ## Three properties this shape has and a `BIGSERIAL` does not
 *
 * 1. **No gap on rollback.** `nextval()` is not transactional: a rolled-back
 *    transaction burns the number permanently and leaves a hole a consumer
 *    cannot distinguish from a lost event. This is an ordinary row, so it
 *    rolls back with the transaction and the next successful event receives
 *    the same number.
 * 2. **Allocation order equals commit order.** `ON CONFLICT DO UPDATE` takes a
 *    row lock and PostgreSQL holds it until the transaction ends. A second
 *    transaction on the same stream blocks on that lock rather than racing
 *    ahead. **This is the only mechanism that closes the divergence measured
 *    in ADR-051 § R4**, where the relay published the later event first
 *    because `created_at` is taken in JavaScript before COMMIT — and it is the
 *    serialisation point for `fleet` and `maintenance`, which § R4 measured as
 *    having no domain lock on the `assetId` boundary at all.
 * 3. **The right boundary.** `(topic, partition_key)`, not the aggregate
 *    (§ C-7): under ADR-036 several aggregates deliberately share one key, and
 *    a counter keyed by aggregate would not cover the streams ADR-036 built.
 *
 * ## Contract for the caller
 *
 * `tx` **must** be the caller's already-open domain transaction. Allocation,
 * the domain write and the `outbox_message` insert commit together or roll
 * back together; there is no partial outcome in which a number is consumed
 * and no row exists, and none in which a row exists without a number.
 *
 * The returned value is a `number`, converted at this boundary and checked:
 * the column is `BIGINT`, and a value beyond the safe integer range is refused
 * rather than silently rounded (see `toStreamSeq`).
 *
 * Service-local by construction (A-01): the statement names only this
 * service's own table, through the client the caller supplied. This package
 * imports no service Prisma client and opens no transaction of its own.
 */
export async function allocateStreamSeqSql(
  tx: OutboxSqlClient,
  topic: string,
  partitionKey: string,
): Promise<number> {
  if (!topic) throw new Error('allocateStreamSeqSql: topic must not be empty');
  if (!partitionKey) throw new Error('allocateStreamSeqSql: partitionKey must not be empty');

  const rows = await tx.$queryRawUnsafe<{ allocated: bigint | number }[]>(
    `INSERT INTO "${STREAM_SEQUENCE_TABLE}" AS s ("topic", "partition_key", "next_seq")
     VALUES ($1, $2, 2)
     ON CONFLICT ("topic", "partition_key")
     DO UPDATE SET "next_seq" = s."next_seq" + 1
     RETURNING s."next_seq" - 1 AS allocated`,
    topic,
    partitionKey,
  );

  const allocated = rows[0]?.allocated;
  if (allocated === undefined) {
    // An upsert with RETURNING always yields a row. No row means the statement
    // did not do what it says, and continuing would insert an outbox row with
    // no position in its stream.
    throw new Error(
      `allocateStreamSeqSql: no sequence returned for topic="${topic}". ` +
        'Refusing to write an unsequenced event.',
    );
  }
  return toStreamSeq(allocated);
}

/** What a claim attempt got: the fence the database wrote, and the rows it covers. */
export interface OutboxClaimResult {
  /** The fencing token, read back from `RETURNING` rather than assumed. */
  token: string | null;
  rows: OutboxRow[];
  /** How many of these were taken back from a lease that had already expired. */
  reclaimed: number;
}

export interface ClaimOptions {
  limit: number;
  /** UUIDv4. The only thing that establishes ownership. */
  token: string;
  /** Diagnostic metadata only — which process. No decision reads it. */
  owner: string;
  leaseSeconds: number;
}

interface ClaimedExtras {
  claim_token: string;
  reclaimed: boolean;
}

/**
 * Claims up to `limit` rows in one statement, fencing each on `token`.
 *
 * Selection and reservation happen together, so there is no window between
 * them for a second relay to slip into — which is exactly the window the old
 * standalone `SELECT ... FOR UPDATE SKIP LOCKED` left open (D-026, measured at
 * 10 of 10 rows overlapping).
 *
 * `FOR UPDATE SKIP LOCKED` stays, but not as the reservation: it only stops two
 * simultaneous claimers serialising on the same row. The reservation is the
 * token.
 *
 * Eligibility is: unpublished, and no live lease, and no pending retry. Expiry
 * makes a row *eligible to be taken back*. It is not what grants or removes
 * anybody's right to acknowledge.
 *
 * ## Why four streams rather than one predicate
 *
 * The obvious form — `(claim_expires_at IS NULL OR claim_expires_at <= now())
 * AND (next_attempt_at IS NULL OR next_attempt_at <= now())` with
 * `ORDER BY created_at, id` — is correct but cannot be executed efficiently,
 * and the reason is not a missing index.
 *
 * `now()` is **stable, not immutable**: its value is unknown at planning time,
 * so PostgreSQL cannot consult a histogram for `<= now()` and falls back to the
 * 33% default selectivity. Measured, not assumed: an expression index on
 * `GREATEST(COALESCE(...), COALESCE(...))` does collect statistics
 * (`n_distinct = 2` in `pg_stats`), and the planner *still* estimated 66,667 of
 * 200,000 rows. With `LIMIT 100` an early exit from the ordering index then
 * always looks cheapest, so the plan walks `(created_at, id)` and filters —
 * removing 190,000 rows when most rows carry a live lease or a pending retry.
 * That is 190× the ADR's ceiling of `10 × LIMIT`.
 *
 * So the fix is to remove the estimate from the decision. Every unpublished row
 * falls into exactly one of four cases by which timestamps are present, and in
 * each case eligibility is either **statically true** or a **range on that
 * stream's own leading index column** — never a trailing filter:
 *
 * | stream   | which rows                     | eligible when              |
 * | -------- | ------------------------------ | -------------------------- |
 * | `fresh`  | no lease, no retry             | always                     |
 * | `lease`  | lease only                     | `claim_expires_at <= now()`|
 * | `retry`  | retry only                     | `next_attempt_at <= now()` |
 * | `paired` | both present                   | `GREATEST(both) <= now()`  |
 *
 * The four are mutually exclusive and exhaustive, so their union is exactly the
 * original predicate — asserted row-for-row by the equivalence tests, including
 * the boundary where a timestamp equals the database's own `now()`.
 *
 * Taking each stream's oldest `limit` and then re-ordering the union globally
 * still yields the true global oldest `limit`: if a row were among the global
 * oldest but outside its own stream's top `limit`, that stream would hold
 * `limit` older eligible rows, so the row could not have been in the global set
 * at all.
 *
 * ## Where the locking happens, and why it is inside each stream
 *
 * Each stream takes `FOR UPDATE SKIP LOCKED` **before** its own `LIMIT`, not
 * after the candidate merge. Locking only at the end looks equivalent and is
 * not: two claimants build the *same* pre-limited candidate window from
 * unlocked reads, and whichever locks second finds every candidate taken and
 * returns an empty batch while thousands of eligible rows sit just past the
 * window. Measured before the fix — 300 eligible rows, oldest 100 held by
 * another session, `claimPending(100)` returned **0**.
 *
 * With the lock inside the stream, PostgreSQL plans `Limit -> LockRows ->
 * Index Scan`: the scan locks as it goes, skips what another transaction
 * holds, and stops once `limit` unlocked rows are in hand. So each stream
 * locks exactly the rows it returns, and a full batch is produced whenever
 * `limit` unlocked eligible rows exist anywhere past the contended prefix.
 *
 * The cost is lock amplification: four streams can each lock up to `limit`,
 * so up to `4 x limit` rows are locked while only `limit` are claimed —
 * measured at 400 locked / 100 claimed with every stream populated. Those
 * locks are held only for this one statement, so they clear in milliseconds,
 * and the alternative is the starvation above.
 *
 * The merged candidate set is then re-checked against the original predicate
 * before the reservation, so the rewrite cannot widen what gets claimed, and
 * the same statement performs the update — atomicity, the fence, the
 * skip-locked behaviour and the total order all unchanged.
 *
 * Measured across all six ADR fixtures: **0 rows removed by filter**,
 * in-memory quicksort, no temporary disk, warm medians 0.108–5.1 ms.
 *
 * `ORDER BY created_at, id` is a total order. `created_at` alone is not:
 * it is `timestamp(3)`, and ULIDs minted inside one millisecond sort randomly
 * (12 same-millisecond ULIDs, 6 inversions, measured), so ties used to break
 * arbitrarily. This buys deterministic *selection* (G6). It does not buy
 * semantic per-aggregate ordering, which is D-027 and stays open.
 *
 * The one thing done about it here: the rows of a claimed batch are handed
 * back with each stream's sequenced rows in `stream_seq` order
 * ({@link orderForPublish}), because `created_at` may be a transaction *start*
 * and so disagree with commit order. That is a re-order of what was already
 * selected — the selection, the four streams and the plan are untouched — and
 * it covers one batch only. A stream whose earlier row is held by another
 * relay or in backoff is ADR-051 B4's head-of-line claim, not this.
 */
export async function claimPendingSql(
  client: OutboxSqlClient,
  options: ClaimOptions,
): Promise<OutboxClaimResult> {
  const rows = await client.$queryRawUnsafe<(RawOutboxRow & ClaimedExtras)[]>(
    `WITH
     fresh AS (
       SELECT id, created_at FROM outbox_message
        WHERE published_at IS NULL
          AND claim_expires_at IS NULL AND next_attempt_at IS NULL
        ORDER BY created_at, id LIMIT $4
          FOR UPDATE SKIP LOCKED
     ),
     lease AS (
       SELECT id, created_at FROM outbox_message
        WHERE published_at IS NULL AND next_attempt_at IS NULL
          AND claim_expires_at IS NOT NULL AND claim_expires_at <= now()
        ORDER BY created_at, id LIMIT $4
          FOR UPDATE SKIP LOCKED
     ),
     retry AS (
       SELECT id, created_at FROM outbox_message
        WHERE published_at IS NULL AND claim_expires_at IS NULL
          AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()
        ORDER BY created_at, id LIMIT $4
          FOR UPDATE SKIP LOCKED
     ),
     paired AS (
       SELECT id, created_at FROM outbox_message
        WHERE published_at IS NULL
          AND claim_expires_at IS NOT NULL AND next_attempt_at IS NOT NULL
          AND GREATEST(claim_expires_at, next_attempt_at) <= now()
        ORDER BY created_at, id LIMIT $4
          FOR UPDATE SKIP LOCKED
     ),
     candidates AS (
       SELECT id FROM (
         SELECT * FROM fresh
         UNION ALL SELECT * FROM lease
         UNION ALL SELECT * FROM retry
         UNION ALL SELECT * FROM paired
       ) merged
       ORDER BY created_at, id LIMIT $4
     ),
     due AS (
       SELECT o.id, o.claim_expires_at AS prev_expires_at
         FROM outbox_message o
        WHERE o.id IN (SELECT id FROM candidates)
          AND o.published_at IS NULL
          AND (o.claim_expires_at IS NULL OR o.claim_expires_at <= now())
          AND (o.next_attempt_at  IS NULL OR o.next_attempt_at  <= now())
        ORDER BY o.created_at, o.id
          FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox_message AS o
        SET claim_token      = $1,
            claim_owner      = $2,
            claim_expires_at = now() + make_interval(secs => $3::double precision),
            claim_count      = o.claim_count + 1
       FROM due
      WHERE o.id = due.id
     RETURNING o.id, o.aggregate_type, o.aggregate_id, o.event_name, o.event_version,
               o.topic, o.partition_key, o.payload, o.headers, o.organization_id,
               o.correlation_id, o.created_at, o.published_at, o.attempts, o.last_error,
               o.stream_seq,
               o.claim_token,
               (due.prev_expires_at IS NOT NULL) AS reclaimed`,
    options.token,
    options.owner,
    options.leaseSeconds,
    options.limit,
  );

  if (rows.length === 0) return { token: null, rows: [], reclaimed: 0 };

  // Trust what the database wrote, not what we sent. If the two ever diverged,
  // every later mutation would be fenced against a token nobody holds, and the
  // batch would look silently un-ownable rather than loudly wrong.
  const written = rows[0].claim_token;
  if (written !== options.token || rows.some((row) => row.claim_token !== written)) {
    throw new Error('outbox claim: the database returned a token other than the one written');
  }

  return {
    token: written,
    // Re-sorted, because `UPDATE ... RETURNING` does not preserve the ordering
    // of the CTE it selected from. The `ORDER BY` inside `due` decides *which*
    // rows are claimed — that part is deterministic — but PostgreSQL is free to
    // emit the updated rows in any order, and it does. Without this the relay
    // would hand Kafka a batch in an arbitrary order on every poll, which is
    // the ordering guarantee G6 exists to provide.
    //
    // Then `stream_seq` overrules `created_at` *within one stream*: created_at is
    // the transaction's start, stream_seq is its commit order (ADR-051 § R4).
    rows: orderForPublish(rows.map(toOutboxRow).sort(byCreatedAtThenId)),
    reclaimed: rows.filter((row) => row.reclaimed).length,
  };
}

/** The same total order the claim query selects with. */
function byCreatedAtThenId(a: OutboxRow, b: OutboxRow): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Acknowledges publication.
 *
 * Fenced on the token, and on nothing else. Deliberately not conditioned on
 * `claim_expires_at`: an owner whose lease lapsed while nobody took the row
 * back is still the legitimate owner, and refusing its acknowledgement would
 * republish an event that had already been delivered. The instant somebody
 * does take the row back the token changes, and this touches zero rows.
 *
 * Clears every piece of claim and retry metadata, which is what
 * `ck_outbox_published_is_clean` requires of a published row.
 *
 * Returns rows actually updated. The shortfall against `ids.length` is how
 * many were fenced.
 */
export async function markPublishedSql(
  client: OutboxSqlClient,
  ids: readonly string[],
  token: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  return client.$executeRawUnsafe(
    `UPDATE outbox_message
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
 * Records a failure, releases the claim, and schedules the retry.
 *
 * The delay is computed entirely in SQL from `now()`. No JavaScript clock
 * enters the decision, so skew between replicas cannot pull a row forward or
 * push it back. `attempts` on the right-hand side is the pre-update value —
 * PostgreSQL evaluates every SET expression against the old row — so a first
 * failure waits `base`, not `2 x base`.
 *
 * The exponent is capped at 10 so it cannot run away, and the product again at
 * `maxSeconds` so even a poisoned row is retried eventually rather than parked
 * for a geological interval.
 */
export async function markFailedSql(
  client: OutboxSqlClient,
  id: string,
  token: string,
  error: string,
  backoff: { baseSeconds: number; maxSeconds: number },
): Promise<number> {
  return client.$executeRawUnsafe(
    `UPDATE outbox_message
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
    error.slice(0, 1000),
    backoff.baseSeconds,
    backoff.maxSeconds,
  );
}

/**
 * Gives rows back without counting a failure — a clean shutdown before
 * anything was sent.
 *
 * Leaves `attempts` and `next_attempt_at` alone: nothing failed, so the row
 * should be claimable immediately rather than parked behind a backoff.
 */
export async function releaseSql(
  client: OutboxSqlClient,
  ids: readonly string[],
  token: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  return client.$executeRawUnsafe(
    `UPDATE outbox_message
        SET claim_token      = NULL,
            claim_owner      = NULL,
            claim_expires_at = NULL
      WHERE id = ANY($1::text[])
        AND claim_token = $2`,
    [...ids],
    token,
  );
}

/**
 * Extends the lease, and reports **which** rows are still owned.
 *
 * Returning ids rather than a count is the whole point. If ninety of a hundred
 * rows renew, those ninety are still legitimately ours and must still be
 * acknowledged once published; abandoning all hundred because ten were lost
 * would guarantee a replay of ninety events that were delivered perfectly
 * well. Fencing in SQL prevents corruption; this prevents wasted work, and the
 * two are not the same thing.
 *
 * The call bounds itself with `statement_timeout` rather than an application
 * timer: a renewal that hangs would otherwise eat the safety margin in silence
 * while the relay still believed a renewal was in flight.
 */
export async function renewSql(
  runTransaction: OutboxTxRunner,
  ids: readonly string[],
  token: string,
  leaseSeconds: number,
  deadlineMs: number,
): Promise<string[]> {
  if (ids.length === 0) return [];

  // Interpolated because `SET LOCAL` accepts no bind parameters. Not user
  // input — it is derived from validated configuration — and coerced to a safe
  // positive integer here so nothing but digits can reach the statement (S-05).
  const timeoutMs = Math.max(1, Math.floor(deadlineMs));
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new Error(`outbox renew: refusing a non-integer statement timeout: ${deadlineMs}`);
  }

  return runTransaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE outbox_message
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
    // The transaction has to outlive the statement it wraps, or Prisma aborts
    // the renewal before `statement_timeout` ever fires and the bound that
    // actually applied would be the wrong one.
  }, timeoutMs + 5_000);
}

export async function oldestPendingAgeSecondsSql(client: OutboxSqlClient): Promise<number> {
  const result = await client.$queryRawUnsafe<{ age: number | null }[]>(
    `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::float8 AS age
       FROM outbox_message
      WHERE published_at IS NULL`,
  );
  return result[0]?.age ?? 0;
}

// ---------------------------------------------------------------------------
// D-052 — purge of published rows
// ---------------------------------------------------------------------------

/**
 * The `last_error` prefix `docs/runbooks/outbox-stuck.md` writes when it
 * marks an undeliverable event published by hand. The purge keeps such rows.
 */
export const MANUALLY_SKIPPED_PREFIX = 'MANUALLY SKIPPED';

export interface PurgePublishedOptions {
  /** Delete rows published longer ago than this, by the database clock. */
  retentionSeconds: number;
  /** Most rows this one statement may delete. */
  limit: number;
  /** `statement_timeout` for the batch, in milliseconds. */
  statementTimeoutMs: number;
  /** Longest wait for a pooled connection before the transaction starts. */
  maxWaitMs: number;
}

/**
 * Runs one purge batch in a transaction with both of its bounds: `maxWaitMs`
 * to obtain a connection (Prisma's `maxWait`) and `timeoutMs` for the
 * transaction once it has one (Prisma's `timeout`). Separate from
 * {@link OutboxTxRunner}, whose single number a store used for both — so a
 * batch could wait as long for a connection as it was allowed to run, and
 * neither wait was in the shutdown budget (Codex r1 on #247).
 */
export type OutboxPurgeTxRunner = <T>(
  fn: (tx: OutboxSqlClient) => Promise<T>,
  bounds: { timeoutMs: number; maxWaitMs: number },
) => Promise<T>;

export interface PurgePublishedBatch {
  /** Rows deleted. */
  deleted: number;
  /** Another session held the purge lock, so nothing was attempted. */
  busy: boolean;
}

/**
 * Deletes at most `limit` published rows older than the retention, in one
 * short transaction.
 *
 * ## Which rows, and why only those
 *
 * `published_at IS NOT NULL AND published_at < now() - retention`, and the
 * DELETE re-checks `published_at IS NOT NULL AND claim_token IS NULL` on the
 * locked row. An unpublished row is an event nobody has received yet; it is
 * never selected, however old. A published row holds no claim
 * (`ck_outbox_published_is_clean`), the relay never reads one again, and
 * `stream_seq` allocation reads `outbox_stream_sequence`, never this table —
 * so deleting it changes neither delivery, nor ordering, nor any sequence a
 * consumer checks for gaps.
 *
 * The one published row that was never delivered is kept: `outbox-stuck.md`
 * (cause C) unblocks a queue by setting `published_at` on a poisoned
 * non-financial event with `last_error = 'MANUALLY SKIPPED — incident …'`,
 * and promises the data is kept for the incident. Those rows are never
 * purged; an operator removes them by hand once the incident is closed.
 *
 * `created_at < cutoff` is redundant as a rule — a row is created before it is
 * published — and is there as an access path: every service's table carries a
 * B-tree on `created_at` (or, in document, on `(published_at, created_at)`),
 * so the scan visits rows older than the cutoff only and stops at `limit`. A
 * row whose `created_at` is later than its `published_at` (a producer clock
 * ahead of the database's) is merely kept until it passes the cutoff too.
 *
 * ## Why it cannot hurt the relay or another replica
 *
 * - **Bounded.** `LIMIT` caps the rows, `statement_timeout` caps the time, and
 *   each batch commits on its own, so no lock outlives one batch.
 * - **`FOR UPDATE SKIP LOCKED`.** A row another session has locked is passed
 *   over, never waited for.
 * - **One purger per schema at a time.** `pg_try_advisory_xact_lock` on a key
 *   derived from the schema: a second replica's batch gets `busy` at once and
 *   stops its run, instead of scanning the same rows to skip them. The lock is
 *   transaction-scoped, so it can never be left behind by a crashed process
 *   or a pooled connection.
 *
 * ## Interpolation
 *
 * The retention, the limit and the timeout are written into the statement,
 * the one guarded exception {@link renewSql} also makes: `SET LOCAL` takes no
 * bind parameter, and a literal cutoff lets the planner estimate it, which a
 * parameter in a generic plan would not. All three come from validated
 * configuration and are refused here unless they are positive safe integers,
 * so nothing but digits reaches the SQL (S-05).
 */
export async function purgePublishedSql(
  runTransaction: OutboxPurgeTxRunner,
  options: PurgePublishedOptions,
): Promise<PurgePublishedBatch> {
  const retentionSeconds = positiveInteger(options.retentionSeconds, 'retentionSeconds');
  const limit = positiveInteger(options.limit, 'limit');
  const timeoutMs = positiveInteger(options.statementTimeoutMs, 'statementTimeoutMs');
  const maxWaitMs = positiveInteger(options.maxWaitMs, 'maxWaitMs');

  return runTransaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);

      const lock = await tx.$queryRawUnsafe<{ acquired: boolean }[]>(
        `SELECT pg_try_advisory_xact_lock(hashtext('rasta.outbox_purge'), hashtext(current_schema()))
              AS acquired`,
      );
      if (lock[0]?.acquired !== true) return { deleted: 0, busy: true };

      const deleted = await tx.$executeRawUnsafe(
        `WITH doomed AS (
         SELECT id FROM outbox_message
          WHERE published_at IS NOT NULL
            AND published_at < now() - make_interval(secs => ${retentionSeconds})
            AND created_at   < now() - make_interval(secs => ${retentionSeconds})
            AND (last_error IS NULL OR last_error NOT LIKE '${MANUALLY_SKIPPED_PREFIX}%')
          LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
       )
       DELETE FROM outbox_message o
        USING doomed
        WHERE o.id = doomed.id
          AND o.published_at IS NOT NULL
          AND o.claim_token IS NULL`,
      );
      return { deleted, busy: false };
      // The transaction outlives the statement by the margin, so the bound that
      // ends a slow DELETE is `statement_timeout` rather than Prisma abandoning
      // the transaction first. Wait + timeout is `outboxPurgeBatchBoundMs`,
      // which `loadEnv` holds under SHUTDOWN_TIMEOUT_MS.
    },
    { timeoutMs: timeoutMs + OUTBOX_PURGE_TRANSACTION_MARGIN_MS, maxWaitMs },
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`outbox purge: ${name} must be a positive integer, received ${value}`);
  }
  return value;
}

/** Rows held under a live lease right now. Sampled for the gauge, never inferred. */
export async function activeLeaseCountSql(client: OutboxSqlClient): Promise<number> {
  const result = await client.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count
       FROM outbox_message
      WHERE published_at IS NULL
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at > now()`,
  );
  return Number(result[0]?.count ?? 0);
}

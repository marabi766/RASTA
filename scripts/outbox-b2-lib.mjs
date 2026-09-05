// -----------------------------------------------------------------------------
// ADR-051 Phase B2 — the backfill itself, as pure option handling, pure SQL and
// one orchestration function over an injected database port.
//
// Why a library beside the CLI, the same reason `verify-outbox-b1-lib.mjs`
// exists: a CLI does its work at import time, so nothing in it can be tested in
// place. Everything here is either a pure function or a function of the port,
// the CLI is a thin adapter, and the PostgreSQL tests drive *this* code with a
// real connection — not a copy of the SQL and not a mock of the database.
//
// ## What B2 is, and what it deliberately is not
//
// B1 (2026-09-05) added `outbox_message.stream_seq`, `is_stream_head` and the
// `outbox_stream_sequence` counter table, and left every one of them inert. B2
// is the first phase that touches *data*, and it touches it only when an
// operator explicitly asks:
//
//   * it is never run by app startup, a Prisma migration, CI, `pnpm verify` or
//     a deployment hook;
//   * it plans by default and mutates only under `--apply`;
//   * it refuses `NODE_ENV=production` and refuses an unknown service.
//
// **B2 still creates no runtime ordering guarantee.** Nothing reads `stream_seq`
// and nothing reads `is_stream_head`: `claimPending`, `markPublished`, the
// relay, the publisher, the envelope, the Kafka headers, routing and the
// consumers are all untouched. Allocation is B3, head-of-line claiming is B4,
// gap detection is B5. Delivery stays at-least-once, A-09 stays mandatory, and
// D-027 stays open.
//
// ## The algorithm, in one place
//
// Sequencing (per batch, one short transaction):
//
//   1. Take at most `batchSize` rows that are **unpublished** and have
//      `stream_seq IS NULL`, ordered by `(created_at, id)` — the exact
//      ADR-050 claim ordering, so B2 numbers rows in the order the relay
//      would have published them. `FOR UPDATE` holds them for the batch;
//      the relay's `SKIP LOCKED` claim steps around them instead of blocking.
//   2. For each stream in the batch, find its anchor: the row with the highest
//      `stream_seq`. `base_seq` is that sequence (0 if the stream has none).
//   3. Assign `base_seq + row_number() OVER (PARTITION BY topic, partition_key
//      ORDER BY created_at, id)`. The window is computed by PostgreSQL from
//      column values; no JavaScript clock or array order decides a sequence.
//
// Counters (once, after the last batch):
//
//   `next_seq`      = max(stream_seq) + 1 — the position B3 will hand out next,
//                     matching D-2's `RETURNING next_seq - 1 AS allocated`.
//   `published_seq` = min(stream_seq among unpublished) - 1, or max(stream_seq)
//                     when every sequenced row is published. D-4 defines the
//                     head as `stream_seq = published_seq + 1`, so this is the
//                     value — not a guess — that makes the head B2 marks and
//                     the head B4 will compute the same row.
//
//   Both are written with GREATEST, so a counter can never move backwards and
//   B3 can never re-issue a position B2 already used.
//
// Heads (once, after the counters):
//
//   `is_stream_head` is true for exactly the lowest `stream_seq` among the
//   **currently unpublished** sequenced rows of a stream, false everywhere
//   else — including every row of a stream that is now fully published. The
//   final `IS DISTINCT FROM` makes a second run write zero rows.
//
// ## The batch-boundary invariant
//
// A stream may span batches, and the thing that must never happen is a row
// getting a sequence that contradicts `(created_at, id)` order.
//
// Batches are a *global prefix* of the unsequenced pending rows in
// `(created_at, id)` order. So for any stream, every row taken in batch N
// sorts before every row of that stream taken in batch N+1. Sequences are
// assigned in that same order, which makes the anchor's `(created_at, id)`
// the stream's high-water mark — and continuing from `base_seq` therefore
// appends rather than interleaves. No duplicate is possible either way: the
// partial unique index `ux_outbox_stream_seq` would reject one.
//
// The invariant has one enemy, and B2 does not pretend otherwise. `created_at`
// is taken from the JavaScript clock before COMMIT (ADR-051 § R4), so a row
// inserted *during* the backfill can carry a `created_at` earlier than a row
// already sequenced. Appending would then place it after a row it precedes.
// `assignBatchSql` therefore counts exactly that condition against each
// batch's own streams and, when it is non-zero, assigns nothing and reports
// it. B2 does not claim to be safe against live producers; it detects the one
// state in which it would not be, and refuses. See the runbook for the
// quiescence this implies.
// -----------------------------------------------------------------------------

import { assertB1Definitions } from './verify-outbox-b1-lib.mjs';

/** The eight service-owned databases that have the B1 schema. */
export const SERVICES = [
  'identity',
  'organization',
  'asset',
  'fleet',
  'maintenance',
  'economic',
  'marketplace',
  'document',
];

/**
 * The hard ceiling from ADR-051 § B2, not a tuning knob.
 *
 * § R7 measured a single in-place `UPDATE` of the whole table at roughly 2x
 * table growth; the acceptance threshold in the implementation plan § 6 is a
 * backfill peak below 1.3x. Batching is what buys that, so the ceiling is
 * enforced rather than documented.
 */
export const MAX_BATCH_SIZE = 5000;

/** The table B2 reads and writes. Never another service's, never a shared one. */
export const OUTBOX_TABLE = 'outbox_message';
export const SEQUENCE_TABLE = 'outbox_stream_sequence';

/**
 * Environments this tool will run in.
 *
 * Anything else — `production`, `staging`, a typo — fails closed. A backfill
 * that guesses which database it is pointed at is the failure mode this list
 * exists to prevent.
 */
export const ALLOWED_ENVIRONMENTS = ['development', 'test', 'ci'];

/** Raised for every refusal, so the CLI can print a reason instead of a stack. */
export class B2RefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'B2RefusalError';
  }
}

const refuse = (message) => {
  throw new B2RefusalError(message);
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Parse argv into a fully explicit plan.
 *
 * Three deliberate absences of a default:
 *
 *   * no target default — `--service` or `--all` must be given, because a tool
 *     whose no-argument form touches eight databases is one keystroke from an
 *     accident;
 *   * no write default — `--apply` must be given, and `--dry-run` is only ever
 *     the name of what already happens;
 *   * no environment default beyond "unset means development" — an
 *     unrecognised `NODE_ENV` is refused rather than assumed to be safe.
 */
export function parseOptions(argv, env = {}) {
  const options = {
    services: [],
    apply: false,
    batchSize: MAX_BATCH_SIZE,
    maxBatches: Infinity,
    vacuumEvery: 1,
  };
  let all = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) refuse(`${arg} needs a value.`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--service':
        options.services.push(value());
        break;
      case '--all':
        all = true;
        break;
      case '--apply':
        options.apply = true;
        break;
      case '--dry-run':
        // Accepted so an operator can be explicit about the default. It never
        // turns `--apply` off: two contradictory flags must not silently pick
        // one, so the combination is refused below.
        options.dryRun = true;
        break;
      case '--batch-size':
        options.batchSize = parsePositiveInt(arg, value());
        break;
      case '--max-batches':
        options.maxBatches = parsePositiveInt(arg, value());
        break;
      case '--vacuum-every':
        options.vacuumEvery = parsePositiveInt(arg, value());
        break;
      default:
        refuse(`Unknown option "${arg}". Known: ${KNOWN_OPTIONS.join(', ')}.`);
    }
  }

  if (options.dryRun && options.apply) {
    refuse('--dry-run and --apply contradict each other; pass exactly one.');
  }
  if (all && options.services.length > 0) {
    refuse('--all and --service contradict each other; pass exactly one.');
  }
  if (all) options.services = [...SERVICES];
  if (options.services.length === 0) {
    refuse(
      'No target selected. Pass --service <name> (repeatable) or --all. ' +
        `Known services: ${SERVICES.join(', ')}.`,
    );
  }

  const unknown = options.services.filter((service) => !SERVICES.includes(service));
  if (unknown.length > 0) {
    refuse(`Unknown service(s): ${unknown.join(', ')}. Known: ${SERVICES.join(', ')}.`);
  }
  const duplicates = options.services.filter((s, i) => options.services.indexOf(s) !== i);
  if (duplicates.length > 0) {
    refuse(`Service(s) named more than once: ${[...new Set(duplicates)].join(', ')}.`);
  }

  if (options.batchSize > MAX_BATCH_SIZE) {
    refuse(
      `--batch-size ${options.batchSize} exceeds the ADR-051 § B2 ceiling of ${MAX_BATCH_SIZE}.`,
    );
  }

  assertEnvironment(env);
  return options;
}

const KNOWN_OPTIONS = [
  '--service',
  '--all',
  '--apply',
  '--dry-run',
  '--batch-size',
  '--max-batches',
  '--vacuum-every',
];

function parsePositiveInt(flag, raw) {
  if (!/^\d+$/.test(raw)) refuse(`${flag} must be a positive integer, received "${raw}".`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    refuse(`${flag} must be a positive integer, received "${raw}".`);
  }
  return parsed;
}

/**
 * The production interlock.
 *
 * Separate from the URL: a database can be production while `NODE_ENV` says
 * nothing, so this refuses on both the known-bad value and the unrecognised
 * one. It cannot make the tool safe on its own, which is why the runbook still
 * requires the operator to name the target explicitly.
 */
export function assertEnvironment(env = {}) {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv === undefined || nodeEnv === '') return 'development';
  if (nodeEnv === 'production') {
    refuse(
      'Refusing to run with NODE_ENV=production. The B2 backfill is an operational ' +
        'tool for development and CI databases; a production backfill is a separately ' +
        'reviewed procedure (see the ADR-051 B2 runbook).',
    );
  }
  if (!ALLOWED_ENVIRONMENTS.includes(nodeEnv)) {
    refuse(
      `Refusing to run with an unrecognised NODE_ENV="${nodeEnv}". ` +
        `Known: ${ALLOWED_ENVIRONMENTS.join(', ')}.`,
    );
  }
  return nodeEnv;
}

/** `DATABASE_URL_<SERVICE>` and nothing else — never a shared connection (A-01). */
export function databaseUrlKey(service) {
  if (!SERVICES.includes(service)) refuse(`Unknown service "${service}".`);
  return `DATABASE_URL_${service.toUpperCase()}`;
}

/**
 * Resolve one service's database URL.
 *
 * Deliberately does **not** fall back to a bare `DATABASE_URL`: that variable
 * names whichever database the last command happened to use, and a backfill
 * that follows it would write one service's sequences into another service's
 * table. The error names the variable rather than printing any URL.
 */
export function resolveDatabaseUrl(service, env = {}) {
  const key = databaseUrlKey(service);
  const url = env[key];
  if (!url) {
    refuse(
      `${key} is not set. The B2 backfill resolves each service through its own ` +
        'DATABASE_URL_<SERVICE> and never through a shared DATABASE_URL.',
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * The B1 preconditions, by definition rather than by name.
 *
 * Delegated to the B1 verifier's own assertions so there is exactly one
 * description of the B1 shape in the repository. All three B1 migrations use
 * `IF NOT EXISTS`, so an object of the wrong shape passes an existence test —
 * a `stream_seq` that is NOT NULL, or a unique index that lost its
 * `WHERE stream_seq IS NOT NULL` predicate, would both let this tool run and
 * both would corrupt or stall it.
 */
export { assertB1Definitions as b1PreconditionSql };

/**
 * What a run would do, without doing it. Every column is a count; nothing here
 * can mutate, which is what makes `--dry-run` provable rather than promised.
 */
export function planSql() {
  return `
SELECT
  (SELECT count(*) FROM "${OUTBOX_TABLE}"
    WHERE "published_at" IS NULL AND "stream_seq" IS NULL)::bigint            AS pending_unsequenced,
  (SELECT count(DISTINCT ("topic", "partition_key")) FROM "${OUTBOX_TABLE}"
    WHERE "published_at" IS NULL AND "stream_seq" IS NULL)::bigint            AS streams_pending,
  (SELECT count(*) FROM "${OUTBOX_TABLE}" WHERE "stream_seq" IS NOT NULL)::bigint AS already_sequenced,
  (SELECT count(*) FROM "${OUTBOX_TABLE}"
    WHERE "published_at" IS NOT NULL AND "stream_seq" IS NULL)::bigint        AS published_untouched,
  (SELECT count(*) FROM "${OUTBOX_TABLE}" WHERE "is_stream_head")::bigint     AS heads,
  (SELECT count(*) FROM "${SEQUENCE_TABLE}")::bigint                          AS counter_rows`;
}

/**
 * One batch: select, guard, number, update — one statement, one snapshot.
 *
 * `$1` is the batch size. The whole thing is a single statement on purpose: the
 * guard and the assignment must see the same rows, and splitting them would
 * open a window in which a producer's insert lands between the check and the
 * write.
 *
 * `numbered` is gated on `violations = 0`, so a batch that trips the guard
 * updates nothing at all rather than partially. The caller rolls the (empty)
 * transaction back and reports.
 */
export function assignBatchSql() {
  return `
WITH batch AS (
  SELECT "id", "topic", "partition_key", "created_at"
    FROM "${OUTBOX_TABLE}"
   WHERE "published_at" IS NULL
     AND "stream_seq" IS NULL
   ORDER BY "created_at", "id"
   LIMIT $1
     FOR UPDATE
),
streams AS (
  SELECT DISTINCT "topic", "partition_key" FROM batch
),
-- The stream's high-water mark: the row holding its largest sequence. Because
-- sequences are only ever assigned in (created_at, id) order, that row is also
-- the latest sequenced row, which is what makes it a usable ordering anchor.
anchor AS (
  SELECT s."topic",
         s."partition_key",
         COALESCE(a."stream_seq", 0) AS base_seq,
         a."created_at"              AS anchor_created_at,
         a."id"                      AS anchor_id
    FROM streams s
    LEFT JOIN LATERAL (
      SELECT m."stream_seq", m."created_at", m."id"
        FROM "${OUTBOX_TABLE}" m
       WHERE m."topic" = s."topic"
         AND m."partition_key" = s."partition_key"
         AND m."stream_seq" IS NOT NULL
       ORDER BY m."stream_seq" DESC
       LIMIT 1
    ) a ON TRUE
),
-- A pending row that sorts *before* its stream's anchor cannot be appended
-- without contradicting (created_at, id). It means rows were written while the
-- backfill was running. Detected, never worked around.
guard AS (
  SELECT count(*)::bigint AS violations
    FROM batch b
    JOIN anchor a
      ON a."topic" = b."topic" AND a."partition_key" = b."partition_key"
   WHERE a.anchor_id IS NOT NULL
     AND (b."created_at", b."id") < (a.anchor_created_at, a.anchor_id)
),
numbered AS (
  SELECT b."id",
         a.base_seq + row_number() OVER (
           PARTITION BY b."topic", b."partition_key"
           ORDER BY b."created_at", b."id"
         ) AS seq
    FROM batch b
    JOIN anchor a
      ON a."topic" = b."topic" AND a."partition_key" = b."partition_key"
   WHERE (SELECT violations FROM guard) = 0
),
updated AS (
  UPDATE "${OUTBOX_TABLE}" o
     SET "stream_seq" = n.seq
    FROM numbered n
   WHERE o."id" = n."id"
  RETURNING o."id"
)
SELECT (SELECT violations FROM guard)   AS violations,
       (SELECT count(*) FROM batch)::bigint   AS selected,
       (SELECT count(*) FROM updated)::bigint AS updated,
       (SELECT count(*) FROM streams)::bigint AS streams`;
}

/**
 * The counter table, established from the state the assignment created.
 *
 * `next_seq` is the *next* position, matching D-2's allocation
 * (`RETURNING next_seq - 1`), so a fresh stream numbered 1..N ends at N+1.
 *
 * `published_seq` is `head - 1`, because D-4 defines the head as
 * `stream_seq = published_seq + 1`. A stream whose sequenced rows are all
 * published has no head and its `published_seq` is its maximum — which is
 * `next_seq - 1`, exactly the state B3 would have left behind.
 *
 * GREATEST on both: a counter that moved backwards would let B3 re-issue a
 * position already on a row, and the partial unique index would then reject
 * the insert. Monotonic also makes a re-run a no-op.
 */
export function counterUpsertSql() {
  return `
WITH per_stream AS (
  SELECT "topic",
         "partition_key",
         max("stream_seq")                                                AS max_seq,
         min("stream_seq") FILTER (WHERE "published_at" IS NULL)          AS head_seq
    FROM "${OUTBOX_TABLE}"
   WHERE "stream_seq" IS NOT NULL
   GROUP BY "topic", "partition_key"
),
upserted AS (
  INSERT INTO "${SEQUENCE_TABLE}" AS s ("topic", "partition_key", "next_seq", "published_seq")
  SELECT "topic",
         "partition_key",
         max_seq + 1,
         COALESCE(head_seq - 1, max_seq)
    FROM per_stream
  ON CONFLICT ("topic", "partition_key") DO UPDATE
     SET "next_seq"      = GREATEST(s."next_seq", EXCLUDED."next_seq"),
         "published_seq" = GREATEST(s."published_seq", EXCLUDED."published_seq")
   WHERE s."next_seq"      IS DISTINCT FROM GREATEST(s."next_seq", EXCLUDED."next_seq")
      OR s."published_seq" IS DISTINCT FROM GREATEST(s."published_seq", EXCLUDED."published_seq")
  RETURNING 1
)
SELECT (SELECT count(*) FROM per_stream)::bigint AS streams,
       (SELECT count(*) FROM upserted)::bigint   AS written`;
}

/**
 * The head flag, recomputed from the rows rather than remembered.
 *
 * True for exactly the lowest sequenced unpublished row of each stream; false
 * for every other sequenced row and for a fully published stream. The trailing
 * `IS DISTINCT FROM` is what makes a second run write zero rows instead of
 * rewriting the same value — which is also how the idempotence test proves it.
 *
 * Scoped to rows that are sequenced or already flagged, so the published
 * history B2 never touches is not rewritten either.
 */
export function headMaintenanceSql() {
  return `
WITH head AS (
  SELECT "topic", "partition_key", min("stream_seq") AS head_seq
    FROM "${OUTBOX_TABLE}"
   WHERE "stream_seq" IS NOT NULL
     AND "published_at" IS NULL
   GROUP BY "topic", "partition_key"
),
want AS (
  SELECT m."id",
         (m."stream_seq" IS NOT NULL
          AND m."published_at" IS NULL
          AND m."stream_seq" = h.head_seq) AS is_head
    FROM "${OUTBOX_TABLE}" m
    LEFT JOIN head h
      ON h."topic" = m."topic" AND h."partition_key" = m."partition_key"
   WHERE m."stream_seq" IS NOT NULL OR m."is_stream_head"
),
changed AS (
  UPDATE "${OUTBOX_TABLE}" o
     SET "is_stream_head" = w.is_head
    FROM want w
   WHERE o."id" = w."id"
     AND o."is_stream_head" IS DISTINCT FROM w.is_head
  RETURNING 1
)
SELECT (SELECT count(*) FROM changed)::bigint AS changed,
       (SELECT count(*) FROM head)::bigint    AS heads`;
}

/**
 * The post-conditions, read back from the database rather than assumed.
 *
 * Every column must be zero except `heads`, `sequenced` and `counter_rows`.
 * The three inconsistency counts are the ones a silent bug would show up in:
 * a stream with the wrong `next_seq`, a stream whose `published_seq` does not
 * point at its head, and a row flagged head that is not its stream's lowest
 * unpublished sequence.
 */
export function verifySql() {
  return `
WITH per_stream AS (
  SELECT "topic",
         "partition_key",
         max("stream_seq")                                       AS max_seq,
         min("stream_seq") FILTER (WHERE "published_at" IS NULL)  AS head_seq
    FROM "${OUTBOX_TABLE}"
   WHERE "stream_seq" IS NOT NULL
   GROUP BY "topic", "partition_key"
)
SELECT
  (SELECT count(*) FROM "${OUTBOX_TABLE}"
    WHERE "published_at" IS NULL AND "stream_seq" IS NULL)::bigint       AS remaining,
  (SELECT count(*) FROM "${OUTBOX_TABLE}" WHERE "stream_seq" IS NOT NULL)::bigint AS sequenced,
  (SELECT count(*) FROM "${OUTBOX_TABLE}" WHERE "is_stream_head")::bigint AS heads,
  (SELECT count(*) FROM per_stream)::bigint                              AS streams,
  (SELECT count(*) FROM "${SEQUENCE_TABLE}")::bigint                     AS counter_rows,
  (SELECT count(*) FROM per_stream p
     LEFT JOIN "${SEQUENCE_TABLE}" s
       ON s."topic" = p."topic" AND s."partition_key" = p."partition_key"
    WHERE s."topic" IS NULL OR s."next_seq" <> p.max_seq + 1)::bigint    AS counter_next_mismatch,
  (SELECT count(*) FROM per_stream p
     LEFT JOIN "${SEQUENCE_TABLE}" s
       ON s."topic" = p."topic" AND s."partition_key" = p."partition_key"
    WHERE s."topic" IS NULL
       OR s."published_seq" <> COALESCE(p.head_seq - 1, p.max_seq))::bigint AS counter_published_mismatch,
  (SELECT count(*) FROM "${OUTBOX_TABLE}" m
     LEFT JOIN per_stream p
       ON p."topic" = m."topic" AND p."partition_key" = m."partition_key"
    WHERE m."is_stream_head" IS DISTINCT FROM (
            m."stream_seq" IS NOT NULL
        AND m."published_at" IS NULL
        AND m."stream_seq" = p.head_seq))::bigint                        AS head_mismatch`;
}

/**
 * `VACUUM (ANALYZE)` on the outbox table.
 *
 * ADR-051 § R7 measured a single in-place `UPDATE` at roughly 2x table growth:
 * every updated row is a new tuple, and without the intervening vacuum the
 * dead ones accumulate for the whole run. ANALYZE comes with it because the
 * statistics on `stream_seq` change from "all NULL" to a real distribution,
 * and B3/B4 plan against them.
 *
 * Cannot run inside a transaction block, which is why the caller runs it
 * *between* batches and never inside one.
 */
export function vacuumSql() {
  return `VACUUM (ANALYZE) "${OUTBOX_TABLE}"`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Numbers come back from PostgreSQL as BigInt (every count is cast to
 * `bigint`), which `JSON.stringify` refuses. Counts here are row counts of one
 * service's outbox; they are far inside `Number.MAX_SAFE_INTEGER`, and the
 * conversion throws rather than truncates if that ever stops being true.
 */
function toNumber(value) {
  if (typeof value === 'number') return value;
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`count ${value} is outside the safe integer range`);
  }
  return asNumber;
}

const mapRow = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toNumber(v)]));

/**
 * Run B2 against one service database.
 *
 * `db` is the port — `query`, `transaction`, `execute` — so this function is
 * the same code whether the caller wired it to Prisma in the CLI or to a
 * scratch schema in a test. `emit` receives one plain object per event; the
 * CLI turns them into NDJSON.
 *
 * Nothing here logs a payload, a credential or a connection string: the events
 * carry the service name and counts, and that is all they can carry.
 */
export async function runServiceBackfill({ service, db, options, emit, now = () => Date.now() }) {
  const startedAt = now();
  const event = (type, fields) => emit({ type, service, ...fields });

  // Preconditions first, and against the catalog rather than against a name.
  // A missing or reshaped B1 object is a refusal, not a partial run.
  try {
    await db.query(assertB1Definitions());
  } catch (error) {
    throw new B2RefusalError(
      `B1 schema precondition failed for ${service}: ${error.message}. ` +
        'Deploy the three ADR-051 B1 migrations before running the B2 backfill.',
    );
  }

  const [plan] = (await db.query(planSql())).map(mapRow);
  event('plan', {
    ...plan,
    mode: options.apply ? 'apply' : 'dry-run',
    batchSize: options.batchSize,
    batchesRequired: Math.ceil(plan.pending_unsequenced / options.batchSize),
  });

  if (!options.apply) {
    event('done', {
      mode: 'dry-run',
      mutated: false,
      elapsedMs: now() - startedAt,
    });
    return { plan, batches: [], applied: false, mutated: false };
  }

  const batches = [];
  let batchNumber = 0;
  let remaining = plan.pending_unsequenced;
  // Observed writes, counted as they are committed. `mutated` is derived from
  // these three and from nothing else — not from `options.apply`, not from the
  // rows a batch selected, not from elapsed time. An operator reading the
  // evidence needs "the database changed", and the mode was never that.
  let assigned = 0;
  let counterWrites = 0;
  let headWrites = 0;

  while (remaining > 0 && batchNumber < options.maxBatches) {
    batchNumber += 1;
    const batchStartedAt = now();
    const result = await db.transaction(async (tx) => {
      const [row] = (await tx.query(assignBatchSql(), [options.batchSize])).map(mapRow);
      if (row.violations > 0) {
        throw new B2RefusalError(
          `${service}: ${row.violations} row(s) in batch ${batchNumber} sort before an ` +
            'already-sequenced row of the same stream. Rows were written while the ' +
            'backfill was running, and appending them would contradict (created_at, id). ' +
            'Nothing was assigned in this batch. Quiesce the producers for this service ' +
            'and re-run; see the ADR-051 B2 runbook.',
        );
      }
      return row;
    });

    batches.push(result);
    assigned += result.updated;
    remaining -= result.updated;
    event('batch', {
      batch: batchNumber,
      selected: result.selected,
      updated: result.updated,
      streams: result.streams,
      remaining,
      elapsedMs: now() - batchStartedAt,
    });

    // A batch that selected rows and updated none would loop forever. It can
    // only happen if the guard were bypassed, so it is an invariant failure,
    // not a retry.
    if (result.selected > 0 && result.updated === 0) {
      throw new B2RefusalError(
        `${service}: batch ${batchNumber} selected ${result.selected} rows and assigned ` +
          'none. Refusing to loop.',
      );
    }
    if (result.selected === 0) break;

    // Between batches, never inside one: VACUUM cannot run in a transaction
    // block. A failure here is an operational failure and stops the run — the
    // table bloat this prevents is the reason batching exists at all.
    if (batchNumber % options.vacuumEvery === 0) {
      try {
        await db.execute(vacuumSql());
        event('vacuum', { batch: batchNumber, ok: true });
      } catch (error) {
        throw new B2RefusalError(
          `${service}: VACUUM (ANALYZE) failed after batch ${batchNumber}: ${error.message}. ` +
            'The maintenance ADR-051 § R7 requires did not happen; stopping rather than ' +
            'continuing to bloat the table. Assigned sequences are already committed and ' +
            'a re-run resumes from them.',
        );
      }
    }
  }

  const truncated = remaining > 0;

  // Counters and heads describe the state the assignment produced, so they run
  // once at the end. A truncated run leaves them for the next invocation:
  // both fields are still inert in B2, so the intermediate state is safe.
  if (!truncated) {
    const [counters] = (await db.query(counterUpsertSql())).map(mapRow);
    counterWrites = counters.written;
    event('counters', counters);

    const [heads] = (await db.query(headMaintenanceSql())).map(mapRow);
    headWrites = heads.changed;
    event('heads', heads);
  }

  // Three ways an apply can write, and all three count. A run that assigns no
  // sequence can still be a real mutation: finalisation repairs a counter or
  // moves a head when an earlier run was interrupted or the relay published
  // the previous head. Reading only `assigned` would report that as untouched.
  const mutated = assigned > 0 || counterWrites > 0 || headWrites > 0;

  const [verified] = (await db.query(verifySql())).map(mapRow);
  event('verify', verified);
  event('done', {
    mode: 'apply',
    mutated,
    batches: batchNumber,
    truncated,
    converged: !truncated && verified.remaining === 0,
    elapsedMs: now() - startedAt,
  });

  return { plan, batches, verified, applied: true, truncated, mutated };
}

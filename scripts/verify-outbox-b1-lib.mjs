// -----------------------------------------------------------------------------
// ADR-051 Phase B1 — the catalog assertions, as pure SQL builders.
//
// Extracted from `verify-outbox-claim-migration.mjs` for the same reason
// `ci-image-matrix-lib.mjs` exists: the verifier is a CLI that runs work at
// import time, so its assertions cannot be unit-tested in place. Everything
// here is a pure function of constants, the verifier imports it, and the tests
// exercise the same code the verifier runs — not a copy of it.
//
// Why these assertions are by **definition** rather than by name:
//
// All three B1 migrations use `IF NOT EXISTS`. That makes them re-runnable,
// and it also makes them blind: an object that already exists with the wrong
// shape is stepped straight over, and a name-only check then reports success.
// The two shapes that matter most are a `stream_seq` that is NOT NULL (which
// would demand a backfill B1 deliberately defers to B2) and a unique index
// that has lost its `WHERE stream_seq IS NOT NULL` predicate (which would
// reject every second row whose sequence is still NULL — a total write
// outage). Both pass an existence test. Neither passes this one.
// -----------------------------------------------------------------------------

/** The service-local counter table. One row per ordered stream. */
export const B1_SEQUENCE_TABLE = 'outbox_stream_sequence';

/**
 * Expected `information_schema.columns` shape of the counter table:
 * `[column, data_type, is_nullable, column_default]`. A `null` default means
 * the column must have none.
 *
 * The bigint defaults are `'1'` and `'0'` — PostgreSQL renders an integer
 * literal default bare, not as `'1'::bigint`. Read back from the catalog
 * rather than assumed.
 */
export const B1_SEQUENCE_COLUMNS = [
  ['topic', 'text', 'NO', null],
  ['partition_key', 'text', 'NO', null],
  ['next_seq', 'bigint', 'NO', '1'],
  ['published_seq', 'bigint', 'NO', '0'],
];

/**
 * The two new `outbox_message` columns.
 *
 * `stream_seq` must stay NULLABLE: rows written before sequencing exist and
 * must stay valid. `is_stream_head` must default to false, because B1's whole
 * claim is that it sets no head.
 */
export const B1_OUTBOX_COLUMNS = [
  ['stream_seq', 'bigint', 'YES', null],
  ['is_stream_head', 'boolean', 'NO', 'false'],
];

/** The counter table's primary key — the stream identity itself. */
export const B1_SEQUENCE_PRIMARY_KEY = 'topic,partition_key';

/**
 * Every B1 index, by full normalised definition.
 *
 * The four head indexes are their ADR-050 eligibility counterparts with
 * `AND is_stream_head` appended and the key order preserved, so B4 narrows to
 * stream heads without changing the plan shape.
 */
export const B1_INDEXDEFS = {
  ux_outbox_stream_seq:
    'CREATE UNIQUE INDEX ux_outbox_stream_seq ON public.outbox_message ' +
    'USING btree (topic, partition_key, stream_seq) WHERE (stream_seq IS NOT NULL)',
  ix_outbox_head_fresh:
    'CREATE INDEX ix_outbox_head_fresh ON public.outbox_message ' +
    'USING btree (created_at, id) WHERE ((published_at IS NULL) AND ' +
    '(claim_expires_at IS NULL) AND (next_attempt_at IS NULL) AND is_stream_head)',
  ix_outbox_head_lease:
    'CREATE INDEX ix_outbox_head_lease ON public.outbox_message ' +
    'USING btree (claim_expires_at, created_at, id) WHERE ((published_at IS NULL) AND ' +
    '(next_attempt_at IS NULL) AND (claim_expires_at IS NOT NULL) AND is_stream_head)',
  ix_outbox_head_retry:
    'CREATE INDEX ix_outbox_head_retry ON public.outbox_message ' +
    'USING btree (next_attempt_at, created_at, id) WHERE ((published_at IS NULL) AND ' +
    '(claim_expires_at IS NULL) AND (next_attempt_at IS NOT NULL) AND is_stream_head)',
  ix_outbox_head_both:
    'CREATE INDEX ix_outbox_head_both ON public.outbox_message ' +
    'USING btree (GREATEST(claim_expires_at, next_attempt_at), created_at, id) ' +
    'WHERE ((published_at IS NULL) AND (claim_expires_at IS NOT NULL) AND ' +
    '(next_attempt_at IS NOT NULL) AND is_stream_head)',
};

export const B1_INDEXES = Object.keys(B1_INDEXDEFS);

/**
 * Presence (or absence) of every B1 object: the counter table, the two outbox
 * columns, and the five indexes.
 *
 * Separate from the ADR-050 equivalent so a failure names which ADR regressed —
 * one rolls back three migrations, the other five.
 */
export function assertB1Objects(present) {
  const want = present ? 'must exist' : 'must be gone';
  return `
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = current_schema()
     AND table_name = '${B1_SEQUENCE_TABLE}';
  IF n <> ${present ? 1 : 0} THEN
    RAISE EXCEPTION 'B1: ${B1_SEQUENCE_TABLE} ${want}: found %', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'outbox_message'
     AND column_name IN (${B1_OUTBOX_COLUMNS.map(([c]) => `'${c}'`).join(', ')});
  IF n <> ${present ? B1_OUTBOX_COLUMNS.length : 0} THEN
    RAISE EXCEPTION 'B1: outbox columns ${want}: found % of ${B1_OUTBOX_COLUMNS.length}', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema()
     AND tablename = 'outbox_message'
     AND indexname IN (${B1_INDEXES.map((i) => `'${i}'`).join(', ')});
  IF n <> ${present ? B1_INDEXES.length : 0} THEN
    RAISE EXCEPTION 'B1: stream indexes ${want}: found % of ${B1_INDEXES.length}', n;
  END IF;
END
$$;`;
}

/** Every B1 object asserted by its definition — see the header for why. */
export function assertB1Definitions() {
  const columns = [
    ...B1_SEQUENCE_COLUMNS.map((c) => [B1_SEQUENCE_TABLE, ...c]),
    ...B1_OUTBOX_COLUMNS.map((c) => ['outbox_message', ...c]),
  ];

  const columnChecks = columns
    .map(
      ([table, col, type, nullable, def]) => `
  SELECT data_type, is_nullable, column_default
    INTO t, nl, dflt
    FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = '${table}' AND column_name = '${col}';
  IF t IS NULL THEN
    RAISE EXCEPTION 'B1: ${table}.${col} is missing';
  END IF;
  IF t <> '${type}' THEN
    RAISE EXCEPTION 'B1: ${table}.${col} is %, expected ${type}', t;
  END IF;
  IF nl <> '${nullable}' THEN
    RAISE EXCEPTION 'B1: ${table}.${col} is_nullable is %, expected ${nullable}', nl;
  END IF;
  ${
    def === null
      ? `IF dflt IS NOT NULL THEN
    RAISE EXCEPTION 'B1: ${table}.${col} must have no default, found %', dflt;
  END IF;`
      : `IF dflt IS DISTINCT FROM '${def}' THEN
    RAISE EXCEPTION 'B1: ${table}.${col} default is %, expected ${def}', dflt;
  END IF;`
  }`,
    )
    .join('\n');

  const indexChecks = Object.entries(B1_INDEXDEFS)
    .map(
      ([name, want]) => `
  SELECT regexp_replace(indexdef, '\\s+', ' ', 'g') INTO actual
    FROM pg_indexes
   WHERE schemaname = current_schema()
     AND tablename = 'outbox_message' AND indexname = '${name}';
  IF actual IS NULL THEN
    RAISE EXCEPTION 'B1: ${name} is missing';
  END IF;
  IF replace(actual, current_schema() || '.', 'public.') <> '${want}' THEN
    RAISE EXCEPTION 'B1: ${name} has the wrong definition: %', actual;
  END IF;`,
    )
    .join('\n');

  return `
DO $$
DECLARE
  t TEXT; nl TEXT; dflt TEXT; actual TEXT; pk TEXT;
BEGIN
${columnChecks}

  -- The primary key IS the stream identity. Without it two rows could describe
  -- one stream and B3's allocation would hand out duplicate positions.
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO pk
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conrelid = (current_schema() || '.${B1_SEQUENCE_TABLE}')::regclass
     AND c.contype = 'p';
  IF pk IS DISTINCT FROM '${B1_SEQUENCE_PRIMARY_KEY}' THEN
    RAISE EXCEPTION 'B1: ${B1_SEQUENCE_TABLE} primary key is %, expected ${B1_SEQUENCE_PRIMARY_KEY}', pk;
  END IF;

${indexChecks}
END
$$;`;
}

/**
 * B1 is inert, asserted rather than assumed.
 *
 * "Additive and behaviour-neutral" is the entire claim this phase makes, and a
 * migration that quietly backfilled would still satisfy every structural check
 * above. This is the one that would catch it.
 */
export function assertB1Inert() {
  return `
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM "outbox_message" WHERE "is_stream_head";
  IF n <> 0 THEN
    RAISE EXCEPTION 'B1 must set no stream head, found % rows with is_stream_head', n;
  END IF;

  SELECT count(*) INTO n FROM "outbox_message" WHERE "stream_seq" IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'B1 must allocate no sequence, found % rows with stream_seq', n;
  END IF;

  SELECT count(*) INTO n FROM "${B1_SEQUENCE_TABLE}";
  IF n <> 0 THEN
    RAISE EXCEPTION 'B1 must write no counter rows, found %', n;
  END IF;
END
$$;`;
}

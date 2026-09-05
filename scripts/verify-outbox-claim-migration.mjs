#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Proves the outbox migrations are reversible on all eight service-owned
// databases, by actually reversing them.
//
// Covers two ADRs, and keeps their evidence distinguishable in the output:
//
//   ADR-050  the durable claim protocol — 5 columns, 5 CHECK constraints,
//            7 indexes. Constraints are exercised against rows, not just
//            asserted to exist.
//   ADR-051  Phase B1, the additive stream-ordering schema — the
//            `outbox_stream_sequence` counter table, 2 inert `outbox_message`
//            columns, and 5 indexes. Every one is asserted by **definition**,
//            because all three B1 migrations use `IF NOT EXISTS` and would
//            pass silently over an object of the wrong shape. B1 is also
//            asserted to be inert: it must set no head, allocate no sequence
//            and write no counter row.
//
// Why this exists beside `verify-migration-reversible.mjs`:
//
// That script reverses a service's **whole** migration chain, which needs a
// `down.sql` for every migration in it. Only three services have one for their
// init migration (economic, marketplace, document); the other five have never
// had one. Writing five init rollbacks — dropping every table those services
// own — is a different change from this one, and doing it here would put a
// schema-wide rewrite inside an outbox commit.
//
// So this verifies what ADR-050 actually adds: deploy the full chain, reverse
// **only** `20260902120000_outbox_durable_claim`, prove all thirteen objects
// are gone, deploy again, prove they are back. That is the up → down → up the
// ADR requires, for every one of the eight databases.
//
// It also exercises each CHECK constraint against rows rather than only
// asserting the constraint exists. A CHECK that is present and vacuous passes
// an existence test and stops nothing.
//
// Two modes:
//
//   default      a throwaway schema, replaying the service's whole chain.
//                Nothing it does can reach the real schema. Six of the eight
//                support it; asset and organization cannot, for the PostGIS
//                reason documented on `inPlace` below.
//   --in-place   the service's real database. Covers all eight, and is what
//                CI runs. Development and CI databases only.
//
// Usage:
//
//   node scripts/verify-outbox-claim-migration.mjs --in-place  # all eight
//   node scripts/verify-outbox-claim-migration.mjs document    # one, scratch
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  assertB1Definitions,
  assertB1Inert,
  assertB1Objects,
  B1_INDEXES,
  B1_OUTBOX_COLUMNS,
} from './verify-outbox-b1-lib.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
/**
 * Every reversible outbox migration, oldest first — two from ADR-050, three
 * from ADR-051 Phase B1.
 *
 * The order matters twice. Forward, B1's columns depend on the table ADR-050
 * created. Backward, this list is walked in reverse, so B1 unwinds before
 * ADR-050 does: reversing an older migration first would drop columns whose
 * indexes belong to a newer migration, cascading them away while leaving that
 * migration's `_prisma_migrations` row behind — a re-deploy then skips it and
 * reports success having restored only part of the schema.
 */
const MIGRATIONS = [
  '20260902120000_outbox_durable_claim',
  '20260902130000_outbox_claim_stream_indexes',
  '20260905090000_outbox_stream_sequence',
  '20260905090100_outbox_stream_seq_columns',
  '20260905090200_outbox_stream_head_indexes',
];
const MIGRATION = MIGRATIONS[0];

const SERVICES = [
  'identity',
  'organization',
  'asset',
  'fleet',
  'maintenance',
  'economic',
  'marketplace',
  'document',
];

const COLUMNS = [
  'claim_token',
  'claim_owner',
  'claim_expires_at',
  'claim_count',
  'next_attempt_at',
];

const CONSTRAINTS = [
  'ck_outbox_claim_triple',
  'ck_outbox_claim_count_nonneg',
  'ck_outbox_attempts_nonneg',
  'ck_outbox_published_is_clean',
  'ck_outbox_next_attempt_requires_failure',
];

const INDEXES = [
  'ix_outbox_claimable',
  'ix_outbox_claim_expiry',
  'ix_outbox_next_attempt',
  // The four eligibility streams (20260902130000). Each carries the whole
  // eligibility test on its own leading column, which is what keeps the claim
  // query off a trailing filter.
  'ix_outbox_due_fresh',
  'ix_outbox_due_lease',
  'ix_outbox_due_retry',
  'ix_outbox_due_both',
];

/**
 * The claim query's index, asserted by definition rather than by name.
 *
 * An index with the right name and the wrong columns or predicate is worse
 * than a missing one: the migration's `IF NOT EXISTS` passes straight over it
 * and the hot query silently keeps sequential-scanning. Normalised whitespace,
 * because PostgreSQL's own rendering is not byte-stable across versions.
 */
const CLAIMABLE_INDEXDEF =
  'CREATE INDEX ix_outbox_claimable ON public.outbox_message ' +
  'USING btree (created_at, id) WHERE (published_at IS NULL)';

/** A minimal, valid unpublished row. Every NOT NULL column the table has. */
const insertRow = (id, extra = '') => `
INSERT INTO "outbox_message" (
  "id", "aggregate_type", "aggregate_id", "event_name", "event_version",
  "topic", "partition_key", "payload", "headers", "correlation_id",
  "created_at", "attempts"${extra ? ', ' + extra.split('=')[0].trim() : ''}
) VALUES (
  '${id}', 'Probe', '${id}', 'PROBE', 1,
  't.probe', '${id}', '{}'::jsonb, '{}'::jsonb, 'COR-${id}',
  now(), 0${extra ? ', ' + extra.split('=').slice(1).join('=').trim() : ''}
);`;

/** Probe rows this script writes, removed before and after the constraint checks. */
const PROBE_CLEANUP = `DELETE FROM "outbox_message" WHERE id LIKE 'OBXCHK%';`;

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));
const targets = only ? [only] : SERVICES;
if (only && !SERVICES.includes(only)) {
  console.error(`Unknown service "${only}". Known: ${SERVICES.join(', ')}`);
  process.exit(1);
}

/**
 * `--in-place` reverses the migration on the service's real database instead
 * of a throwaway schema.
 *
 * The scratch-schema mode replays the service's whole migration chain, which
 * asset and organization cannot do here: both declare PostGIS `geography`
 * columns, the extension's types live in `public`, and Prisma pins the
 * connection's search_path to the scratch schema alone — so their *init*
 * migration fails on a type that plainly exists. That is an artefact of
 * replaying unrelated migrations, not a property of ADR-050's, which mentions
 * no PostGIS type at all.
 *
 * In-place mode tests exactly the claim that matters and tests it on all
 * eight: the objects are there, `down.sql` removes every one of them, and
 * `migrate deploy` puts them all back. It mutates the real database, so it is
 * for development and CI databases — never a production one.
 */
const inPlace = args.includes('--in-place');

const schemaFlag = args.indexOf('--schema');
const scratchSchema = schemaFlag >= 0 ? args[schemaFlag + 1] : 'outbox_claim_check';
if (!/^[a-z_][a-z0-9_]*$/.test(scratchSchema)) {
  console.error(`--schema must be a plain lowercase identifier, received "${scratchSchema}".`);
  process.exit(1);
}

let failures = 0;
const startedAt = Date.now();

for (const service of targets) {
  try {
    verify(service);
  } catch (error) {
    failures += 1;
    console.error(`\n✗ ${service}: ${error.message}\n`);
  }
}

console.log(
  failures === 0
    ? `\n✓ ${targets.length}/${targets.length} databases: ${MIGRATION} is reversible ` +
        `(up → down → up) in ${Date.now() - startedAt}ms`
    : `\n✗ ${failures} of ${targets.length} databases failed`,
);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------------------

function verify(service) {
  const serviceDir = join(REPO_ROOT, 'services', `${service}-service`);
  if (!existsSync(serviceDir)) throw new Error(`no such service directory: ${serviceDir}`);

  const migrationDirs = MIGRATIONS.map((name) => join(serviceDir, 'prisma', 'migrations', name));
  for (const [i, dir] of migrationDirs.entries()) {
    if (!existsSync(join(dir, 'migration.sql'))) {
      throw new Error(`${MIGRATIONS[i]}/migration.sql is missing`);
    }
    if (!existsSync(join(dir, 'down.sql'))) {
      throw new Error(`${MIGRATIONS[i]}/down.sql is missing — the migration is not reversible`);
    }
  }
  const migrationDir = migrationDirs[0];

  const envKey = `DATABASE_URL_${service.toUpperCase()}`;
  const baseUrl = process.env[envKey] ?? process.env.DATABASE_URL;
  if (!baseUrl) throw new Error(`${envKey} is not set`);

  const url = new URL(baseUrl);
  if (!inPlace) url.searchParams.set('schema', scratchSchema);
  const scratchUrl = url.toString();

  const require = createRequire(join(serviceDir, 'package.json'));
  const prismaCli = join(require.resolve('prisma/package.json'), '..', 'build', 'index.js');

  const run = (argv, stdin) => {
    const result = spawnSync(process.execPath, [prismaCli, ...argv], {
      cwd: serviceDir,
      input: stdin,
      encoding: 'utf8',
    });
    return {
      ok: result.status === 0,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  };

  const sql = (script) => run(['db', 'execute', '--url', scratchUrl, '--stdin'], script);
  // `migrate deploy` reads the datasource url from the environment, so it has
  // to be set on the child rather than passed as a flag.
  const deployScratch = () => {
    const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: serviceDir,
      env: { ...process.env, DATABASE_URL: scratchUrl, [envKey]: scratchUrl },
      encoding: 'utf8',
    });
    return {
      ok: result.status === 0,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  };
  const mustRun = (label, script) => {
    const result = sql(script);
    if (!result.ok) throw new Error(`${label}:\n${result.output}`);
  };

  const mustFail = (label, script, expected) => {
    const result = sql(script);
    if (result.ok) throw new Error(`${label}: the database accepted what it must refuse`);
    if (expected && !result.output.includes(expected)) {
      throw new Error(
        `${label}: refused, but not for the expected reason ` +
          `(wanted "${expected}"):\n${result.output}`,
      );
    }
  };

  const cleanup = () =>
    inPlace ? { ok: true } : sql(`DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE;`);

  console.log(`\n${service}:${inPlace ? ' (in place)' : ''}`);
  if (!inPlace) {
    cleanup();
    mustRun('create scratch schema', `CREATE SCHEMA IF NOT EXISTS "${scratchSchema}";`);
    // A misconfigured url would otherwise let this script's DROP statements
    // land on real tables. Refuse to continue unless the session's current
    // schema really is the throwaway one.
    mustRun(
      'the session is pointed at the scratch schema',
      `DO $$
       BEGIN
         IF current_schema() <> '${scratchSchema}' THEN
           RAISE EXCEPTION 'refusing to run: current_schema() is %, not %',
             current_schema(), '${scratchSchema}';
         END IF;
       END
       $$;`,
    );
  }

  try {
    // --- up ------------------------------------------------------------------
    // In place, the migration is already deployed; `migrate deploy` is a no-op
    // that still proves the chain is consistent before anything is reversed.
    let result = deployScratch();
    if (!result.ok) throw new Error(`up: migrate deploy failed:\n${result.output}`);
    mustRun('up: every claim object exists', assertObjects(true));
    mustRun('up: the claim index has the exact definition ADR-050 specifies', assertIndexDef());
    console.log('  ✓ up  ADR-050: 5 columns, 5 constraints, 7 indexes');

    mustRun('up: every B1 stream-ordering object exists', assertB1Objects(true));
    mustRun(
      'up: every B1 object has the exact definition ADR-051 specifies',
      assertB1Definitions(),
    );
    console.log(
      '  ✓ up  ADR-051 B1: sequence table (4 columns, composite PK), ' +
        '2 outbox columns, 5 indexes — all asserted by definition',
    );

    mustRun('up: B1 changed no data', assertB1Inert());
    console.log('  ✓ up  ADR-051 B1: inert — no head set, no sequence allocated, no counter row');

    // --- the constraints actually refuse things ------------------------------
    assertConstraintsBite(mustRun, mustFail);
    console.log('  ✓ up  ADR-050: all five CHECK constraints reject invalid states');

    // --- down ----------------------------------------------------------------
    mustRun('cleanup probe rows', PROBE_CLEANUP);
    // Newest first. Reversing only the older one drops the columns, which
    // cascades the newer migration's indexes away while leaving its
    // `_prisma_migrations` row behind — so the re-deploy skips it and restores
    // three of seven indexes while reporting success.
    for (const [i, dir] of [...migrationDirs.entries()].reverse()) {
      const down = sql(readDown(dir));
      if (!down.ok) throw new Error(`down: ${MIGRATIONS[i]}/down.sql failed:\n${down.output}`);
    }
    mustRun('down: every claim object is gone', assertObjects(false));
    mustRun('down: every B1 stream-ordering object is gone', assertB1Objects(false));
    console.log('  ✓ down: all seventeen ADR-050 objects and all eight B1 objects removed');

    // --- up again ------------------------------------------------------------
    result = deployScratch();
    if (!result.ok) throw new Error(`up again: migrate deploy failed:\n${result.output}`);
    if (/No pending migrations|already in sync/i.test(result.output)) {
      throw new Error(
        'up again: applied nothing — down.sql left the _prisma_migrations row ' +
          'behind, so a real rollback could never be rolled forward again.',
      );
    }
    mustRun('up again: every claim object is back', assertObjects(true));
    mustRun('up again: the claim index definition is back', assertIndexDef());
    mustRun('up again: every B1 stream-ordering object is back', assertB1Objects(true));
    mustRun('up again: every B1 definition is back', assertB1Definitions());
    mustRun('up again: B1 is still inert', assertB1Inert());
    console.log('  ✓ up again: all seventeen ADR-050 objects and all eight B1 objects restored');
  } finally {
    cleanup();
  }
}

function readDown(migrationDir) {
  return readFileSync(join(migrationDir, 'down.sql'), 'utf8');
}

/**
 * Asserts presence (or absence) of all thirteen objects in one statement.
 *
 * A `DO` block rather than a query, because `prisma db execute` reports only
 * whether the script succeeded — so the assertion has to be the thing that
 * fails.
 */
function assertObjects(present) {
  const want = present ? 'must exist' : 'must be gone';
  return `
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'outbox_message'
     AND column_name IN (${COLUMNS.map((c) => `'${c}'`).join(', ')});
  IF n <> ${present ? COLUMNS.length : 0} THEN
    RAISE EXCEPTION 'claim columns ${want}: found % of ${COLUMNS.length}', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = (current_schema() || '.outbox_message')::regclass
     AND contype = 'c'
     AND conname IN (${CONSTRAINTS.map((c) => `'${c}'`).join(', ')});
  IF n <> ${present ? CONSTRAINTS.length : 0} THEN
    RAISE EXCEPTION 'claim constraints ${want}: found % of ${CONSTRAINTS.length}', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema()
     AND tablename = 'outbox_message'
     AND indexname IN (${INDEXES.map((i) => `'${i}'`).join(', ')});
  IF n <> ${present ? INDEXES.length : 0} THEN
    RAISE EXCEPTION 'claim indexes ${want}: found % of ${INDEXES.length}', n;
  END IF;
END
$$;`;
}

function assertIndexDef() {
  return `
DO $$
DECLARE actual TEXT;
BEGIN
  SELECT regexp_replace(indexdef, '\\s+', ' ', 'g') INTO actual
    FROM pg_indexes
   WHERE schemaname = current_schema()
     AND tablename = 'outbox_message'
     AND indexname = 'ix_outbox_claimable';
  IF actual IS NULL THEN
    RAISE EXCEPTION 'ix_outbox_claimable is missing';
  END IF;
  -- Compare against the definition with the scratch schema normalised away.
  IF replace(actual, current_schema() || '.', 'public.') <> '${CLAIMABLE_INDEXDEF}' THEN
    RAISE EXCEPTION 'ix_outbox_claimable has the wrong definition: %', actual;
  END IF;
END
$$;`;
}

/**
 * Each CHECK, against rows the constraint is supposed to refuse.
 *
 * Presence is not the property that matters. A constraint can exist and permit
 * everything, and an existence test cannot tell the difference.
 */
function assertConstraintsBite(mustRun, mustFail) {
  // Clear first, not only at the end. A run that aborts mid-way — a dropped
  // connection, an assertion failure — leaves its probe row behind, and the
  // next run then fails on the primary key instead of on what it came to test.
  mustRun('clear any probe rows a previous run left behind', PROBE_CLEANUP);
  mustRun('seed: a valid unpublished row', insertRow('OBXCHK_VALID'));

  // ck_outbox_claim_triple — two of three is not a claim.
  mustFail(
    'ck_outbox_claim_triple refuses a token with no expiry',
    `UPDATE "outbox_message" SET "claim_token" = 't', "claim_owner" = 'o'
      WHERE id = 'OBXCHK_VALID';`,
    'ck_outbox_claim_triple',
  );
  mustRun(
    'ck_outbox_claim_triple accepts all three together',
    `UPDATE "outbox_message"
        SET "claim_token" = 't', "claim_owner" = 'o',
            "claim_expires_at" = now() + interval '60 seconds'
      WHERE id = 'OBXCHK_VALID';`,
  );

  // ck_outbox_published_is_clean — a published row holds no claim metadata.
  mustFail(
    'ck_outbox_published_is_clean refuses a published row that still holds a claim',
    `UPDATE "outbox_message" SET "published_at" = now() WHERE id = 'OBXCHK_VALID';`,
    'ck_outbox_published_is_clean',
  );

  // ck_outbox_claim_count_nonneg
  mustFail(
    'ck_outbox_claim_count_nonneg refuses a negative claim count',
    `UPDATE "outbox_message" SET "claim_count" = -1 WHERE id = 'OBXCHK_VALID';`,
    'ck_outbox_claim_count_nonneg',
  );

  // ck_outbox_attempts_nonneg
  mustFail(
    'ck_outbox_attempts_nonneg refuses negative attempts',
    `UPDATE "outbox_message" SET "attempts" = -1 WHERE id = 'OBXCHK_VALID';`,
    'ck_outbox_attempts_nonneg',
  );

  // ck_outbox_next_attempt_requires_failure — a retry with no prior attempt.
  mustFail(
    'ck_outbox_next_attempt_requires_failure refuses a retry scheduled with zero attempts',
    `UPDATE "outbox_message" SET "next_attempt_at" = now() + interval '5 seconds'
      WHERE id = 'OBXCHK_VALID';`,
    'ck_outbox_next_attempt_requires_failure',
  );
  mustRun(
    'ck_outbox_next_attempt_requires_failure accepts one after a real failure',
    `UPDATE "outbox_message"
        SET "attempts" = 1, "next_attempt_at" = now() + interval '5 seconds'
      WHERE id = 'OBXCHK_VALID';`,
  );
  mustFail(
    'ck_outbox_next_attempt_requires_failure refuses a retry on a published row',
    `UPDATE "outbox_message"
        SET "claim_token" = NULL, "claim_owner" = NULL, "claim_expires_at" = NULL,
            "published_at" = now()
      WHERE id = 'OBXCHK_VALID';`,
    'ck_outbox_next_attempt_requires_failure',
  );
}

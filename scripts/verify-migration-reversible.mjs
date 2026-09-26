#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Proves a service's migration is reversible by actually reversing it.
//
// AGENTS.md § 7 requires every migration to be "قابل بازگشت". Prisma has no
// down migrations, so each service writes `down.sql` by hand beside its
// `migration.sql` — and until this script existed, nothing ever executed one.
// A down script that is written and never run is a claim, not a capability:
// the file can reference a table that was renamed, drop objects in an order a
// foreign key forbids, or forget the `_prisma_migrations` row that makes the
// forward migration re-appliable, and every one of those failures is invisible
// until the night somebody needs to roll back.
//
// What it does, against a **throwaway schema** in the service's own database:
//
//   1. create the scratch schema, empty
//   2. `prisma migrate deploy`          — up
//   3. assert the schema is really there (tables, triggers, CHECK constraints)
//   4. run `down.sql`                   — down
//   5. assert every one of those objects is gone
//   6. `prisma migrate deploy` again    — up, a second time
//   7. assert the schema is back
//   8. drop the scratch schema
//
// Steps 3, 5 and 7 are the point. A down script that silently does nothing
// still exits zero, so the verification has to *look*.
//
// Usage:
//
//   node scripts/verify-migration-reversible.mjs economic
//   node scripts/verify-migration-reversible.mjs economic --schema migration_check
//
// The connection comes from `DATABASE_URL_<SERVICE>` (or `DATABASE_URL`), the
// same variable `scripts/prisma.mjs` resolves, so CI and a developer machine
// use the identical path. Nothing here needs superuser rights: it creates a
// schema, not a database.
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// What each service's schema must contain, and the SQL that checks it. Kept in
// a module of its own so `verify-migration-reversible-lib.test.mjs` can execute
// the same expectations this CLI runs, rather than a copy of them.
import {
  EXPECTED,
  assertionScript,
  assertSnapshotScript,
  ledgerAssertionScript,
  recordSnapshotScript,
  snapshotStoreScript,
} from './verify-migration-reversible-lib.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function usage(message) {
  console.error(message);
  console.error('\nUsage: node scripts/verify-migration-reversible.mjs <service> [--schema NAME]');
  console.error(`Known services: ${Object.keys(EXPECTED).join(', ')}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const service = args[0];
if (!service) usage('A service name is required.');
if (!EXPECTED[service]) usage(`No expected-object list for "${service}".`);

const schemaFlag = args.indexOf('--schema');
const scratchSchema = schemaFlag >= 0 ? args[schemaFlag + 1] : 'migration_check';
if (!/^[a-z_][a-z0-9_]*$/.test(scratchSchema)) {
  usage(`--schema must be a plain lowercase identifier, received "${scratchSchema}".`);
}

const serviceDir = join(REPO_ROOT, 'services', `${service}-service`);
if (!existsSync(serviceDir)) usage(`No such service directory: ${serviceDir}`);

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const envKey = `DATABASE_URL_${service.replaceAll('-', '_').toUpperCase()}`;
const baseUrl = process.env.DATABASE_URL ?? process.env[envKey];
if (!baseUrl) {
  console.error(
    `${envKey} is not set. Copy .env.example to .env at the repository root, ` +
      'or set DATABASE_URL for this process.',
  );
  process.exit(1);
}

/**
 * The reference schema, where each migration.sql is applied on its own so the
 * state *before* every migration can be recorded, and the schema holding
 * those records. Both are throwaway, like the scratch schema, and derived from
 * its name so two verifications with different --schema values never share.
 */
const referenceSchema = `${scratchSchema}_ref`;
const metaSchema = `${scratchSchema}_meta`;

/**
 * Where the migrations under test are applied.
 *
 * Normally a throwaway schema in the service's own database. Services marked
 * `scratchDatabase` instead get a throwaway **database**, cloned from
 * template1 — which is where the platform's bootstrap installs postgis, ltree
 * and pg_trgm — and are applied to its `public` schema. Their migrations use
 * extension types (`ltree`, `geography`) unqualified, and those resolve only
 * with `public` on the search path, which Prisma sets to the one schema it
 * deploys into. Rewriting migrations that production has already applied to
 * qualify them would change their checksums; a scratch database leaves them as
 * they are.
 */
const inDatabase = Boolean(EXPECTED[service].scratchDatabase);
const targetSchema = inDatabase ? 'public' : scratchSchema;
/**
 * Where the target's deploy puts an extension a migration creates: the first
 * schema on its search path — `public` in a scratch database, the scratch
 * schema otherwise. Snapshots read an extension there, or in the schema they
 * describe, as `(target)` (see `snapshotQuery`).
 */
const extensionHome = targetSchema;

/** The label the target's own state is recorded under, right after its deploy. */
const POST_UP = 'post-up';
const scratchDatabase = inDatabase
  ? `${new URL(baseUrl).pathname.slice(1)}_${scratchSchema}`
  : null;

/** A throwaway schema (or database). Nothing this script does can reach the real one. */
function scratchUrl(schema = targetSchema) {
  const url = new URL(baseUrl);
  if (scratchDatabase) url.pathname = `/${scratchDatabase}`;
  url.searchParams.set('schema', schema);
  return url.toString();
}

/**
 * Prepended to anything run in the reference schema, and to every snapshot:
 * extension types then resolve, and every catalogue rendering is taken with
 * the same search path, so a type reads `ltree` on both sides rather than
 * `public.ltree` on one.
 */
const searchPath = (schema) => `SET search_path TO "${schema}", public;\n`;

// ---------------------------------------------------------------------------
// Migration under test
// ---------------------------------------------------------------------------

const migrationsDir = join(serviceDir, 'prisma', 'migrations');
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (migrations.length === 0) usage(`No migrations found under ${migrationsDir}`);

const missingDown = migrations.filter((name) => !existsSync(join(migrationsDir, name, 'down.sql')));
if (missingDown.length > 0) {
  console.error(
    `These migrations have no down.sql, so they are not reversible ` +
      `(AGENTS.md § 7):\n  ${missingDown.join('\n  ')}`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

/**
 * The Prisma CLI, resolved to its JavaScript entry point and run with this
 * Node.
 *
 * Not `spawnSync('prisma', …, { shell: true })`. `pnpm run` puts
 * `node_modules/.bin` on PATH and a bare `node scripts/…` does not, so the
 * shell form fails when the script is invoked directly — and a shell also
 * concatenates arguments rather than escaping them, which puts a connection
 * string containing `&` at the mercy of the shell's parser. Resolving the
 * module and executing it removes both problems.
 */
const PRISMA_CLI = (() => {
  const require = createRequire(join(serviceDir, 'package.json'));
  const manifest = require.resolve('prisma/package.json');
  return join(manifest, '..', 'build', 'index.js');
})();

function prisma(argv, { stdin, env } = {}) {
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...argv], {
    cwd: serviceDir,
    env: { ...process.env, ...env },
    input: stdin,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    return { ok: false, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }
  return { ok: true, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Runs SQL and returns whether it succeeded. */
function sql(script, schema = targetSchema) {
  return prisma(['db', 'execute', '--url', scratchUrl(schema), '--stdin'], { stdin: script });
}

/** Runs SQL that must succeed, and stops the whole verification if it does not. */
function mustRun(label, script, schema = targetSchema) {
  const result = sql(script, schema);
  if (!result.ok) {
    fail(`${label} failed:\n${result.output}`);
  }
  console.log(`  ✓ ${label}`);
}

/**
 * Runs SQL that must be **refused**, and stops if the database accepts it.
 *
 * A constraint test that only ever runs statements the database accepts proves
 * the constraint exists, not that it does anything. `expectedError` is matched
 * against the output so a statement that fails for an unrelated reason — a typo
 * in a column name — cannot be read as the constraint doing its job.
 */
function mustFail(label, script, expectedError) {
  const result = sql(script);
  if (result.ok) {
    fail(`${label}: the database accepted a statement it should have refused.`);
  }
  if (expectedError && !result.output.includes(expectedError)) {
    fail(
      `${label}: refused, but not for the expected reason.\n` +
        `  expected the error to mention: ${expectedError}\n${result.output}`,
    );
  }
  console.log(`  ✓ ${label}`);
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  // Best effort: leave nothing behind even on failure. A scratch schema that
  // survives a failed run makes the next run fail for a different reason.
  dropScratch();
  process.exit(1);
}

/** Removes everything this run created. Best effort: also called on failure. */
function dropScratch() {
  if (scratchDatabase) {
    return prisma(['db', 'execute', '--url', baseUrl, '--stdin'], {
      stdin: `DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE);`,
    });
  }
  return sql(
    `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE; ` +
      `DROP SCHEMA IF EXISTS "${referenceSchema}" CASCADE; ` +
      `DROP SCHEMA IF EXISTS "${metaSchema}" CASCADE;`,
  );
}

// ---------------------------------------------------------------------------
// The verification
// ---------------------------------------------------------------------------

const expected = EXPECTED[service];
const startedAt = Date.now();

console.log(`Verifying migration reversibility for ${service}-service`);
console.log(`  migrations : ${migrations.join(', ')}`);
console.log(
  scratchDatabase
    ? `  database   : ${scratchDatabase} (throwaway, from template1)`
    : `  schema     : ${scratchSchema} (throwaway)`,
);
console.log('');

if (scratchDatabase) {
  // Two calls: CREATE DATABASE refuses to run inside the implicit transaction
  // a multi-statement script gets.
  for (const statement of [
    `DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE);`,
    `CREATE DATABASE "${scratchDatabase}" TEMPLATE template1;`,
  ]) {
    const result = prisma(['db', 'execute', '--url', baseUrl, '--stdin'], { stdin: statement });
    if (!result.ok) fail(`scratch database: ${statement} failed:\n${result.output}`);
  }
  console.log('  ✓ clean scratch database');
} else {
  mustRun(
    'clean scratch schema',
    `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE; CREATE SCHEMA "${scratchSchema}";`,
  );
}

function deploy(label) {
  const result = prisma(['migrate', 'deploy'], { env: { DATABASE_URL: scratchUrl() } });
  if (!result.ok) fail(`${label} failed:\n${result.output}`);
  if (/No migration found|already in sync/i.test(result.output) && label.includes('again')) {
    fail(
      `${label} applied nothing — the down script left the _prisma_migrations row behind, ` +
        'so a real rollback could never be re-applied.\n' +
        result.output,
    );
  }
  console.log(`  ✓ ${label}`);
}

// --- reference states --------------------------------------------------------
//
// Each migration.sql applied on its own, in order, into the reference schema,
// with the catalogue recorded after each. `before:<name>` is the state a
// migration's down.sql must restore exactly (see `snapshotQuery`).
mustRun(
  'reference: clean reference and snapshot schemas',
  `DROP SCHEMA IF EXISTS "${referenceSchema}" CASCADE; CREATE SCHEMA "${referenceSchema}";\n` +
    snapshotStoreScript(metaSchema),
);
const stateBefore = (index) => (index === 0 ? 'initial' : `after:${migrations[index - 1]}`);
mustRun(
  'reference: record the empty schema',
  searchPath(referenceSchema) +
    recordSnapshotScript(metaSchema, 'initial', referenceSchema, extensionHome),
  referenceSchema,
);
for (const name of migrations) {
  const forward = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
  // In a scratch database, the path Prisma's deploy has there: the extensions'
  // `public` alongside the schema itself.
  const applied = sql(
    (scratchDatabase ? searchPath(referenceSchema) : '') + forward,
    referenceSchema,
  );
  if (!applied.ok) fail(`reference: ${name}/migration.sql failed on its own:\n${applied.output}`);
  const recorded = sql(
    searchPath(referenceSchema) +
      recordSnapshotScript(metaSchema, `after:${name}`, referenceSchema, extensionHome),
    referenceSchema,
  );
  if (!recorded.ok)
    fail(`reference: recording the state after ${name} failed:\n${recorded.output}`);
}
console.log(
  `  ✓ reference: ${migrations.length} migration(s) applied one by one, each state recorded`,
);

// The recorded states are all that is needed from here on. Dropping the
// reference schema now keeps its objects from pinning what a down script does
// to the database: an extension its migration created cannot be dropped while
// the reference's indexes still use it, and a leftover one could not be told
// from the reference's own. Extensions the reference run created stay
// installed unless they lived in that schema, exactly as the target's
// `CREATE EXTENSION IF NOT EXISTS` would then find them.
mustRun(
  'reference: drop the reference schema, keeping the recorded states',
  `DROP SCHEMA IF EXISTS "${referenceSchema}" CASCADE;`,
);
const finalState = `after:${migrations.at(-1)}`;

// --- up ---------------------------------------------------------------------
deploy('up: prisma migrate deploy');
mustRun('up: every expected object exists', assertionScript(expected, true, targetSchema));
mustRun(
  'up: identical to the migrations applied one by one',
  searchPath(targetSchema) +
    assertSnapshotScript(
      metaSchema,
      finalState,
      targetSchema,
      'after prisma migrate deploy',
      undefined,
      { extensionHome },
    ),
);
mustRun('up: every migration in the ledger', ledgerAssertionScript(migrations, 'after up'));
// The target as deployed: the only form in which a down script may leave an
// extension its migration created (EXPECTED.<service>.keptExtensions).
mustRun(
  'up: record the deployed state',
  searchPath(targetSchema) + recordSnapshotScript(metaSchema, POST_UP, targetSchema, extensionHome),
);

// --- rollback against real data ---------------------------------------------
//
// Before the whole-chain reversal, which necessarily runs against an empty
// schema. See MARKETPLACE_DATA_ROLLBACK for why an empty schema cannot test
// this.
if (expected.dataRollback) {
  const probe = expected.dataRollback;
  console.log(`\n  rolling back ${probe.migration} over ${probe.label}:`);

  const downScript = readFileSync(join(migrationsDir, probe.migration, 'down.sql'), 'utf8');

  for (const step of probe.steps) {
    if (step.runDownScript) {
      const result = sql(downScript);
      if (!result.ok) {
        fail(
          `${step.label} failed. The rollback cannot be applied to a database ` +
            `that holds the data the migration it reverses was written to allow:\n${result.output}`,
        );
      }
      console.log(`  ✓ ${step.label}`);
    } else if (step.reapply) {
      deploy(step.label);
    } else if (step.mustFail) {
      mustFail(step.label, step.sql, step.mustFail);
    } else {
      mustRun(step.label, step.sql);
    }
  }
  console.log('');
}

// --- down -------------------------------------------------------------------
//
// Each down.sql is held to two things before the next one runs: the schema is
// exactly the state before its migration, and the ledger no longer lists it —
// so a partial rollback, or one a later deploy would silently skip, fails
// here and names the migration.
for (let index = migrations.length - 1; index >= 0; index -= 1) {
  const name = migrations[index];
  const script = readFileSync(join(migrationsDir, name, 'down.sql'), 'utf8');
  const result = sql(script);
  if (!result.ok) fail(`down: ${name}/down.sql failed:\n${result.output}`);

  const exact = sql(
    searchPath(targetSchema) +
      assertSnapshotScript(
        metaSchema,
        stateBefore(index),
        targetSchema,
        `down: ${name}/down.sql`,
        expected.inexactInverse?.[name],
        {
          keptExtensions: expected.keptExtensions?.[name] ?? [],
          keptFrom: POST_UP,
          extensionHome,
        },
      ),
  );
  if (!exact.ok)
    fail(`down: ${name}/down.sql is not the exact inverse of its migration:\n${exact.output}`);

  const ledger = sql(
    ledgerAssertionScript(migrations.slice(0, index), `down: ${name}/down.sql`, name),
  );
  if (!ledger.ok) {
    fail(
      `down: ${name}/down.sql left the ledger wrong, so a re-deploy would skip it:\n${ledger.output}`,
    );
  }
  const allowance = expected.inexactInverse?.[name]
    ? 'exact inverse apart from its documented allowance'
    : 'exact inverse';
  console.log(`  ✓ down: ${name}/down.sql — ${allowance}, ledger row removed`);
}
mustRun('down: every expected object is gone', assertionScript(expected, false, targetSchema));

// --- up again ---------------------------------------------------------------
deploy('up again: prisma migrate deploy');
mustRun('up again: every expected object is back', assertionScript(expected, true, targetSchema));
mustRun(
  'up again: identical to the first up',
  searchPath(targetSchema) +
    assertSnapshotScript(metaSchema, finalState, targetSchema, 'after up again', undefined, {
      extensionHome,
    }),
);
mustRun(
  'up again: every migration in the ledger',
  ledgerAssertionScript(migrations, 'after up again'),
);

// --- clean up ---------------------------------------------------------------
{
  const dropped = dropScratch();
  if (!dropped.ok) fail(`clean up failed:\n${dropped.output}`);
  console.log(
    `  ✓ drop scratch ${scratchDatabase ? 'database' : 'reference and snapshot schemas'}`,
  );
}

console.log(
  `\n✓ ${service}-service migration is reversible: up → down → up in ${Date.now() - startedAt}ms`,
);

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

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * What each service's schema must contain after `up`, and must not contain
 * after `down`.
 *
 * Named objects rather than "some tables exist", because the objects listed
 * here are the ones that carry the invariants: an immutability trigger that
 * the down script drops but the forward migration forgets to recreate would
 * leave a ledger that is append-only in name only.
 */
const EXPECTED = {
  economic: {
    tables: ['wallet', 'ledger_account', 'journal', 'ledger_entry', 'transaction', 'settlement'],
    triggers: ['trg_ledger_entry_immutable', 'trg_journal_immutable', 'trg_journal_balanced'],
    constraints: ['ck_wallet_balances'],
  },
  /**
   * The constraints listed are the ones carrying a financial invariant, not a
   * sample: `ck_order_settled_after_receipt` is what makes "no settlement
   * without a recorded confirmation" true of the *row* as well as of the state
   * machine, and a down script that dropped it without the forward migration
   * restoring it would leave an order table that enforces nothing.
   */
  marketplace: {
    tables: ['product', 'offer', 'order', 'order_line', 'fulfillment', 'order_status_history'],
    triggers: [],
    constraints: [
      'ck_order_settled_after_receipt',
      'ck_order_completed_has_settlement',
      'ck_order_line_total_consistent',
      'ck_offer_available_non_negative',
    ],
  },
};

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

/** The same database, a different schema. Nothing this script does can reach the real one. */
function scratchUrl() {
  const url = new URL(baseUrl);
  url.searchParams.set('schema', scratchSchema);
  return url.toString();
}

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
function sql(script) {
  return prisma(['db', 'execute', '--url', scratchUrl(), '--stdin'], { stdin: script });
}

/** Runs SQL that must succeed, and stops the whole verification if it does not. */
function mustRun(label, script) {
  const result = sql(script);
  if (!result.ok) {
    fail(`${label} failed:\n${result.output}`);
  }
  console.log(`  ✓ ${label}`);
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  // Best effort: leave nothing behind even on failure. A scratch schema that
  // survives a failed run makes the next run fail for a different reason.
  sql(`DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE;`);
  process.exit(1);
}

/**
 * A DO block that raises unless every named object is present (or absent).
 *
 * `prisma db execute` reports no rows, only an exit status — so the assertion
 * has to be expressed as an error the database raises. That is a feature here:
 * the failure message names the object, not just "expected 6, got 5".
 */
function assertionScript(expected, present) {
  const { tables, triggers, constraints } = expected;
  const not = present ? 'NOT ' : '';
  const verb = present ? 'missing' : 'still present';

  const checks = [
    ...tables.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_tables
                       WHERE schemaname = '${scratchSchema}' AND tablename = '${name}') THEN
        RAISE EXCEPTION 'table % is ${verb}', '${name}';
      END IF;`,
    ),
    ...triggers.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_trigger t
                         JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = '${scratchSchema}' AND t.tgname = '${name}') THEN
        RAISE EXCEPTION 'trigger % is ${verb}', '${name}';
      END IF;`,
    ),
    ...constraints.map(
      (name) => `
      IF ${not}EXISTS (SELECT 1 FROM pg_constraint con
                         JOIN pg_namespace n ON n.oid = con.connamespace
                       WHERE n.nspname = '${scratchSchema}' AND con.conname = '${name}') THEN
        RAISE EXCEPTION 'constraint % is ${verb}', '${name}';
      END IF;`,
    ),
  ].join('\n');

  return `DO $$\nBEGIN\n${checks}\nEND\n$$;`;
}

// ---------------------------------------------------------------------------
// The verification
// ---------------------------------------------------------------------------

const expected = EXPECTED[service];
const startedAt = Date.now();

console.log(`Verifying migration reversibility for ${service}-service`);
console.log(`  migrations : ${migrations.join(', ')}`);
console.log(`  schema     : ${scratchSchema} (throwaway)`);
console.log('');

mustRun(
  'clean scratch schema',
  `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE; CREATE SCHEMA "${scratchSchema}";`,
);

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

// --- up ---------------------------------------------------------------------
deploy('up: prisma migrate deploy');
mustRun('up: every expected object exists', assertionScript(expected, true));

// --- down -------------------------------------------------------------------
for (const name of [...migrations].reverse()) {
  const file = join(migrationsDir, name, 'down.sql');
  const script = readFileSync(file, 'utf8');
  const result = sql(script);
  if (!result.ok) fail(`down: ${name}/down.sql failed:\n${result.output}`);
  console.log(`  ✓ down: ${name}/down.sql`);
}
mustRun('down: every expected object is gone', assertionScript(expected, false));

// --- up again ---------------------------------------------------------------
deploy('up again: prisma migrate deploy');
mustRun('up again: every expected object is back', assertionScript(expected, true));

// --- clean up ---------------------------------------------------------------
mustRun('drop scratch schema', `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE;`);

console.log(
  `\n✓ ${service}-service migration is reversible: up → down → up in ${Date.now() - startedAt}ms`,
);

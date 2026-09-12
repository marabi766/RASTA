#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Proves identity-service's `20260912120000_audit_correction_command` migration
// (AUD-003's correction half, ADR-053 § 7) is reversible, by reversing it.
//
// Why a script of its own. `verify-migration-reversible.mjs` reverses a
// service's *whole* chain and needs a `down.sql` for every migration in it;
// identity's initial migration has none, so that harness cannot reach any
// identity migration at all. `verify-outbox-claim-migration.mjs` addresses the
// ADR-050/051 outbox migrations by name, and
// `verify-security-event-outbox-migration.mjs` addresses AUD-004's refusal
// queue by name. None of them covers this table, and none of them should:
// discovery by convention is exactly what let this migration ship with a
// hand-written `down.sql` that nothing ever executed. It is registered here
// explicitly — and only here.
//
// What is expected lives in `verify-audit-correction-command-lib.mjs` and is
// unit-tested there. This file is how that expectation is executed against a
// real database. The unit tests do not replace this proof and cannot: a
// generated string is not a rollback.
//
// Against a **throwaway schema** in identity's own database:
//
//   1. create the scratch schema and refuse to continue unless the session is
//      really pointed at it
//   2. `prisma migrate deploy`                     — up (the whole chain)
//   3. assert the table, all seven columns by exact signature, the composite
//      primary key by definition, this migration's ledger row, every other
//      migration's ledger row, and every pre-existing object that must survive
//   4. exercise the table: the composite key's uniqueness and the fact that the
//      actor is genuinely part of it, every NOT NULL, both declared widths, the
//      `created_at` default, and that `response_body` is really JSONB
//   5. `down.sql`                                  — down
//   6. assert the table and its ledger row are gone and that *nothing else* is:
//      every survivor, and every other migration's ledger row, still standing
//   7. `prisma migrate deploy`                     — up again, and it must
//      report this migration applied, or the down script left its ledger row
//      behind and a real rollback could never be rolled forward
//   8. assert everything is back, then drop the scratch schema
//
// Usage:  node scripts/verify-audit-correction-command-migration.mjs [--schema NAME]
// Connection: DATABASE_URL_IDENTITY (or DATABASE_URL).
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ACCEPTED_MARKER,
  CLEAR_PROBES,
  COLUMNS,
  MIGRATION,
  PRIMARY_KEY,
  SQLSTATE,
  TABLE,
  assertState,
  insertCommand,
  refusalProbe,
} from './verify-audit-correction-command-lib.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SERVICE_DIR = join(REPO_ROOT, 'services', 'identity-service');
const MIGRATIONS_DIR = join(SERVICE_DIR, 'prisma', 'migrations');
const migrationDir = (name) => join(MIGRATIONS_DIR, name);

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

for (const file of ['migration.sql', 'down.sql']) {
  if (!existsSync(join(migrationDir(MIGRATION), file))) fail(`${MIGRATION}/${file} is missing`);
}

/**
 * Every other migration in identity's chain, read from disk rather than listed.
 *
 * A later migration does not have to be remembered here to be protected: after
 * the rollback, whatever the chain holds except this one must still have its
 * ledger row, and the ledger must hold no more rows than that.
 */
const OTHER_MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => name !== MIGRATION)
  .sort();

if (OTHER_MIGRATIONS.length === 0) {
  fail(`no other migration found in ${MIGRATIONS_DIR} — the ledger assertions would be vacuous`);
}

const args = process.argv.slice(2);
const schemaFlag = args.indexOf('--schema');
const scratchSchema = schemaFlag >= 0 ? args[schemaFlag + 1] : 'audit_correction_command_check';
if (!/^[a-z_][a-z0-9_]*$/.test(scratchSchema)) {
  fail(`--schema must be a plain lowercase identifier, received "${scratchSchema}".`);
}

const baseUrl = process.env.DATABASE_URL_IDENTITY ?? process.env.DATABASE_URL;
if (!baseUrl) fail('DATABASE_URL_IDENTITY is not set.');
const url = new URL(baseUrl);
url.searchParams.set('schema', scratchSchema);
const scratchUrl = url.toString();

const PRISMA_CLI = (() => {
  const require = createRequire(join(SERVICE_DIR, 'package.json'));
  return join(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
})();

function prisma(argv, { stdin, env } = {}) {
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...argv], {
    cwd: SERVICE_DIR,
    env: { ...process.env, ...env },
    input: stdin,
    encoding: 'utf8',
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const sql = (script) =>
  prisma(['db', 'execute', '--url', scratchUrl, '--stdin'], { stdin: script });
const dropScratch = () => sql(`DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE;`);

function mustRun(label, script) {
  const result = sql(script);
  if (!result.ok) {
    dropScratch();
    fail(`${label} failed:\n${result.output}`);
  }
  console.log(`  ✓ ${label}`);
}

/**
 * Runs a `refusalProbe` and requires the database to have refused for exactly
 * the declared reason.
 *
 * The probe reports the refusal in PostgreSQL's own terms rather than Prisma's
 * rendering of them — see `refusalProbe` for what that rendering loses — so
 * `expected` is one exact line and matching it is an equality check on the
 * evidence, not a guess at wording.
 */
function mustFail(label, { script, expected }) {
  const result = sql(script);
  if (result.ok) {
    dropScratch();
    fail(`${label}: the probe did not raise at all, so it proves nothing.`);
  }
  if (result.output.includes(ACCEPTED_MARKER)) {
    dropScratch();
    fail(`${label}: the database accepted a statement it must refuse.`);
  }
  if (!result.output.includes(expected)) {
    dropScratch();
    fail(`${label}: refused, but not by ${expected}:\n${result.output}`);
  }
  console.log(`  ✓ ${label}`);
}

function deploy(label, { mustApply = [] } = {}) {
  const result = prisma(['migrate', 'deploy'], {
    env: { DATABASE_URL: scratchUrl, DATABASE_URL_IDENTITY: scratchUrl },
  });
  if (!result.ok) {
    dropScratch();
    fail(`${label} failed:\n${result.output}`);
  }
  for (const name of mustApply) {
    if (!result.output.includes(name)) {
      dropScratch();
      fail(
        `${label} did not apply ${name} — its down.sql left the _prisma_migrations row behind, ` +
          `so a real rollback could never be rolled forward again.\n${result.output}`,
      );
    }
  }
  console.log(`  ✓ ${label}`);
  // Named, not implied by the tick: the re-application is the evidence that
  // down.sql removed its own ledger row.
  for (const name of mustApply) console.log(`      re-applied ${name}`);
}

const present = assertState({ present: true, otherMigrations: OTHER_MIGRATIONS });
const absent = assertState({ present: false, otherMigrations: OTHER_MIGRATIONS });
/** Every probe starts from an empty table, so no case depends on the one before it. */
const fresh = (statement) => `${CLEAR_PROBES} ${statement}`;

const startedAt = Date.now();
console.log(`Verifying ${MIGRATION} (identity-service) in scratch schema ${scratchSchema}\n`);

mustRun(
  'clean scratch schema',
  `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE; CREATE SCHEMA "${scratchSchema}";`,
);
mustRun(
  'the session is pointed at the scratch schema',
  `DO $$ BEGIN
     IF current_schema() <> '${scratchSchema}' THEN
       RAISE EXCEPTION 'refusing to run: current_schema() is %', current_schema();
     END IF;
   END $$;`,
);

// --- up ------------------------------------------------------------------------
deploy('up: prisma migrate deploy');
mustRun('up: the table, its exact column shape, its key and every ledger row', present);

// --- the composite key ----------------------------------------------------------
mustRun('a command row is accepted', fresh(insertCommand()));
mustFail(
  'the same actor cannot replay the same key',
  refusalProbe({
    statement: fresh(`${insertCommand()} ${insertCommand({ request_hash: `repeat('b', 64)` })}`),
    sqlstate: SQLSTATE.UNIQUE_VIOLATION,
    table: TABLE,
    constraint: PRIMARY_KEY.name,
  }),
);
mustRun(
  'the actor is part of the key: another administrator may reuse the key',
  fresh(`${insertCommand()} ${insertCommand({ actor_id: `'USR_ACCCHK_OTHER'` })}`),
);
mustRun(
  'one administrator may hold many keys',
  fresh(`${insertCommand()} ${insertCommand({ idempotency_key: `'KEY_ACCCHK_0002'` })}`),
);

// --- NOT NULL, on every column that carries evidence -------------------------------
for (const { name } of COLUMNS.filter((column) => column.name !== 'created_at')) {
  mustFail(
    `${name} is never null`,
    refusalProbe({
      statement: fresh(insertCommand({ [name]: 'NULL' })),
      sqlstate: SQLSTATE.NOT_NULL_VIOLATION,
      table: TABLE,
      column: name,
    }),
  );
}

// --- the declared widths ------------------------------------------------------------
// A SHA-256 hex digest is exactly 64 characters and a ULID exactly 26. A column
// wide enough for anything would still store every value the service writes
// today, and would stop the database being the thing that says the value is the
// right shape.
mustFail(
  'request_hash is exactly a SHA-256 digest wide',
  refusalProbe({
    statement: fresh(insertCommand({ request_hash: `repeat('a', 65)` })),
    sqlstate: SQLSTATE.STRING_TOO_LONG,
    message: 'value too long for type character(64)',
  }),
);
mustFail(
  'event_id is exactly a ULID wide',
  refusalProbe({
    statement: fresh(insertCommand({ event_id: `repeat('A', 27)` })),
    sqlstate: SQLSTATE.STRING_TOO_LONG,
    message: 'value too long for type character varying(26)',
  }),
);

// --- created_at, and that response_body is really JSONB -------------------------------
mustRun(
  'created_at defaults rather than being required of the caller',
  `${fresh(insertCommand({ created_at: undefined }))}
   DO $$
   DECLARE n INT;
   BEGIN
     SELECT count(*) INTO n FROM "${TABLE}"
      WHERE actor_id LIKE 'USR_ACCCHK%' AND created_at IS NOT NULL;
     IF n <> 1 THEN
       RAISE EXCEPTION 'the created_at default did not fill the column, matched % rows', n;
     END IF;
   END $$;`,
);
mustRun(
  'response_body is JSONB, not text: it can be read by key',
  `${fresh(insertCommand({ response_body: `'{"status":"ACCEPTED","eventId":"E"}'::jsonb` }))}
   DO $$
   DECLARE txt TEXT;
   BEGIN
     SELECT response_body ->> 'status' INTO txt FROM "${TABLE}"
      WHERE actor_id LIKE 'USR_ACCCHK%';
     IF txt IS DISTINCT FROM 'ACCEPTED' THEN
       RAISE EXCEPTION 'response_body did not behave as JSONB, read %', coalesce(txt, '<null>');
     END IF;
   END $$;`,
);
mustRun('clear the probe rows', CLEAR_PROBES);

// --- down --------------------------------------------------------------------------
const downScript = readFileSync(join(migrationDir(MIGRATION), 'down.sql'), 'utf8');
mustRun(`down: ${MIGRATION}/down.sql`, downScript);
mustRun('down: the table and its ledger row are gone, and nothing else is', absent);

// --- up again ------------------------------------------------------------------------
deploy('up again: prisma migrate deploy re-applies the migration', { mustApply: [MIGRATION] });
mustRun('up again: the table, its shape, its key and every ledger row are back', present);

mustRun('drop scratch schema', `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE;`);
console.log(`\n✓ ${MIGRATION} is reversible: up → down → up in ${Date.now() - startedAt}ms`);

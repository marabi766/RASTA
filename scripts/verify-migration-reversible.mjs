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
 * A cancelled-before-hold order, as the running service writes one.
 *
 * Every column the other CHECK constraints demand is populated, because a row
 * that only satisfies the constraint under test would not prove anything about
 * a real database: it has to be an order the service could genuinely have
 * produced.
 */
const CANCELLED_BEFORE_HOLD = (id, status = 'CANCELLED') => `
INSERT INTO "order" (
  "id", "organization_id", "supplier_organization_id", "placed_by", "status",
  "total_amount_minor", "currency", "economic_transaction_id",
  "idempotency_key", "correlation_id",
  "cancelled_at", "cancellation_reason",
  "created_by", "updated_at"
) VALUES (
  '${id}', 'ORG-MIGCHECK-BUYER', 'ORG-MIGCHECK-SUPPLIER', 'USR-MIGCHECK', '${status}',
  250000, 'IRR', NULL,
  'KEY-${id}', 'COR-${id}',
  NOW(), 'cancelled before the saga created the obligation',
  'USR-MIGCHECK', NOW()
);`;

/**
 * The rollback of `20260830103500_cancel_before_hold`, run against data only
 * the migration it reverses permits.
 *
 * The whole-chain reversal below cannot test this. It runs every `down.sql` in
 * order against a schema that was created seconds earlier and holds no rows, so
 * a down script that works on an empty table and fails on a real one passes it
 * — and a constraint-restoring rollback is exactly the kind that does. This
 * one restores a *narrower* CHECK, which PostgreSQL validates against every
 * existing row unless told otherwise.
 *
 * The step that matters is `down` itself succeeding. With a plain
 * `ADD CONSTRAINT`, it aborts here with a constraint violation naming the
 * seeded order, and the rollback is left part-applied.
 */
const MARKETPLACE_DATA_ROLLBACK = {
  migration: '20260830103500_cancel_before_hold',
  label: 'a cancellation that happened before the hold',
  steps: [
    {
      label: 'seed: the widened constraint accepts a cancellation before the hold',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_BEFORE'),
    },
    {
      // Run alone rather than as part of the chain: the init down script drops
      // the table, which would destroy the evidence this probe exists to check.
      label: 'down: the rollback succeeds with that order in the table',
      runDownScript: true,
    },
    {
      label: 'down: the order is still there, unaltered',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "order"
           WHERE id = 'ORD_MIGCHECK_BEFORE'
             AND status = 'CANCELLED'
             AND economic_transaction_id IS NULL
             AND cancellation_reason = 'cancelled before the saga created the obligation';
          IF row_count <> 1 THEN
            RAISE EXCEPTION
              'the rollback did not preserve the cancelled-before-hold order (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'down: the restored constraint still refuses a new violating insert',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_AFTER'),
      mustFail: 'ck_order_held_has_transaction',
    },
    {
      // NOT VALID skips existing rows; it does not skip updates to them.
      // PostgreSQL checks the new row version, so a surviving row cannot be
      // edited into staying violating.
      label: 'down: the restored constraint still checks an update to the surviving row',
      sql: `UPDATE "order" SET cancellation_reason = 'edited'
             WHERE id = 'ORD_MIGCHECK_BEFORE';`,
      mustFail: 'ck_order_held_has_transaction',
    },
    { label: 'up again: the forward migration re-applies over the surviving order', reapply: true },
    {
      label: 'up again: the order survived the whole round trip',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "order"
           WHERE id = 'ORD_MIGCHECK_BEFORE'
             AND status = 'CANCELLED'
             AND economic_transaction_id IS NULL;
          IF row_count <> 1 THEN
            RAISE EXCEPTION 'the order did not survive down → up (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'up again: the widened constraint accepts a cancellation before the hold',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_AFTER'),
    },
    {
      // The constraint is genuinely restored and not merely absent: a status
      // that does hold money is still required to name a transaction.
      label: 'up again: the widened constraint is not vacuous',
      sql: CANCELLED_BEFORE_HOLD('ORD_MIGCHECK_HELD', 'FUNDS_HELD'),
      mustFail: 'ck_order_held_has_transaction',
    },
    {
      label: 'clean up the probe rows',
      sql: `DELETE FROM "order" WHERE id LIKE 'ORD_MIGCHECK%';`,
    },
  ],
};

/**
 * An infected document as the **init** schema permitted one: no quarantine
 * record, because the columns did not exist yet.
 *
 * Every column the init CHECK constraints demand is populated, so the row is
 * one the service of that era could genuinely have written.
 */
const INFECTED_WITHOUT_QUARANTINE = (id) => `
INSERT INTO "document" (
  "id", "organization_id", "object_key", "document_class", "status",
  "content_type", "size_bytes", "filename",
  "scan_state", "scan_engine", "scan_version", "scan_signature", "scanned_at",
  "upload_intent_id", "created_by", "updated_at"
) VALUES (
  '${id}', 'ORG-MIGCHECK-DOC', 'ORG-MIGCHECK-DOC/CONTRACT/${id}', 'CONTRACT', 'REGISTERED',
  'application/pdf', 4096, 'infected.pdf',
  'INFECTED', 'clamav', '1.5.4', 'Eicar-Test-Signature', NOW(),
  'UPI_MIGCHECK_${id}', 'USR-MIGCHECK', NOW()
);`;

/**
 * The forward migration applied over data the schema it upgrades allowed.
 *
 * `ck_document_infected_is_quarantined` is validated against every existing
 * row the moment it is added, and the init schema permitted an `INFECTED`
 * document with no quarantine record. Nothing ever produced one — the only
 * scanner was a stub that inspects nothing — but "no deployment happens to
 * hold that row" is a different claim from "this migration is safe", and the
 * difference only surfaces on the deployment that does hold one.
 *
 * The whole-chain reversal below cannot test this. It runs against a schema
 * created seconds earlier holding no rows, so a forward migration that works
 * on an empty table and aborts halfway on a populated one passes it — leaving
 * the columns added and the constraints missing, which is the worst of the
 * three possible outcomes.
 *
 * The steps run in the order the harness executes them: roll this migration
 * back to the init schema, seed the row that schema allowed, re-apply, and
 * assert the row came back **quarantined** rather than merely surviving.
 */
const DOCUMENT_DATA_ROLLBACK = {
  migration: '20260831180000_document_scan_lifecycle',
  label: 'an infected document registered before quarantine was recorded',
  steps: [
    {
      // Run alone rather than as part of the chain: the init down script drops
      // the table, and this probe needs the init schema still standing.
      label: 'down: the rollback succeeds and leaves the init schema behind',
      runDownScript: true,
    },
    {
      label: 'down: the init schema accepts an infected document with no quarantine',
      sql: INFECTED_WITHOUT_QUARANTINE('DOC_MIGCHECK_INFECTED'),
    },
    { label: 'up again: the forward migration applies over that row', reapply: true },
    {
      label: 'up again: the row survived and was quarantined rather than left mid-policy',
      sql: `
        DO $$
        DECLARE row_count INT;
        BEGIN
          SELECT count(*) INTO row_count FROM "document"
           WHERE id = 'DOC_MIGCHECK_INFECTED'
             AND scan_state = 'INFECTED'
             AND scan_signature = 'Eicar-Test-Signature'
             AND quarantined_at IS NOT NULL
             AND quarantine_reason IS NOT NULL;
          IF row_count <> 1 THEN
            RAISE EXCEPTION
              'the infected document was not carried through and quarantined (found %)', row_count;
          END IF;
        END
        $$;`,
    },
    {
      label: 'up again: a new infected document with no quarantine is refused',
      sql: INFECTED_WITHOUT_QUARANTINE('DOC_MIGCHECK_REFUSED'),
      mustFail: 'ck_document_infected_is_quarantined',
    },
    {
      label: 'up again: a worker lease cannot be attached to a document that is not pending',
      sql: `UPDATE "document" SET scan_lease_owner = 'worker-1',
              scan_lease_expires_at = NOW() + INTERVAL '1 minute'
             WHERE id = 'DOC_MIGCHECK_INFECTED';`,
      mustFail: 'ck_document_scan_lease_only_when_pending',
    },
    {
      label: 'cleanup: the probe rows are removed before the chain reversal',
      sql: `DELETE FROM "document" WHERE id LIKE 'DOC_MIGCHECK_%';`,
    },
  ],
};

/**
 * What each service's schema must contain after `up`, and must not contain
 * after `down`.
 *
 * Named objects rather than "some tables exist", because the objects listed
 * here are the ones that carry the invariants: an immutability trigger that
 * the down script drops but the forward migration forgets to recreate would
 * leave a ledger that is append-only in name only.
 *
 * `dataRollback` is optional and describes a rollback that has to be tested
 * against **rows**, not just against an empty schema.
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
    dataRollback: MARKETPLACE_DATA_ROLLBACK,
  },
  /**
   * The constraints listed carry the claims a reader would otherwise have to
   * take on trust.
   *
   * `ck_document_scan_attributable` is what makes "we know which engine said
   * this" true of the row: any state but `PENDING` must name an engine and a
   * time. `ck_document_signature_only_when_infected` stops a clean document
   * from carrying a signature a consumer would act on.
   * `ck_document_deleted_has_actor` is the tombstone rule — a deletion with no
   * actor, time or reason is not an audit record. A down script that dropped
   * any of them without the forward migration restoring it would leave a
   * document table that enforces nothing while looking untouched.
   */
  document: {
    tables: ['upload_intent', 'document', 'access_grant', 'outbox_message'],
    triggers: [],
    constraints: [
      'ck_document_scan_attributable',
      'ck_document_signature_only_when_infected',
      'ck_document_deleted_has_actor',
      'ck_document_size_positive',
      'ck_document_owner_reference_complete',
      'ck_upload_intent_consumed_complete',
      'ck_grant_revoked_has_actor',
      // Added by 20260831180000_document_scan_lifecycle (ADR-049). The first
      // two are the quarantine policy expressed as a rule the database keeps:
      // an infection is held, and a hold belongs to an infection. The third
      // stops a FAILED scan from being undiagnosable, and the last two stop a
      // worker lease from outliving the work it claims.
      'ck_document_quarantine_complete',
      'ck_document_infected_is_quarantined',
      'ck_document_failure_reason_only_when_failed',
      'ck_document_scan_lease_complete',
      'ck_document_scan_lease_only_when_pending',
    ],
    dataRollback: DOCUMENT_DATA_ROLLBACK,
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

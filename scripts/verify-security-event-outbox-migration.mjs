#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Proves identity-service's `security_event_outbox` migration (ADR-053 § 4,
// AUD-004 Phase C1) is reversible, by reversing it.
//
// Why a script of its own. `verify-migration-reversible.mjs` reverses a
// service's *whole* chain and needs a down.sql for every migration in it;
// identity's initial migration has none. `verify-outbox-claim-migration.mjs`
// discovers services by `model OutboxMessage` and addresses the ADR-050/051
// migrations by name, so it neither covers nor should cover this table. Nothing
// in the repository's discovery reaches this migration, so it is registered
// here explicitly — and only here.
//
// Against a **throwaway schema** in identity's own database:
//
//   1. create the scratch schema and refuse to continue unless the session is
//      really pointed at it
//   2. `prisma migrate deploy`                         — up (the whole chain)
//   3. assert the table, all 13 CHECK constraints and all 3 partial indexes,
//      the indexes by definition
//   4. exercise every CHECK against rows it must refuse
//   5. run this migration's down.sql                   — down
//   6. assert the table is gone and its `_prisma_migrations` row with it
//   7. `prisma migrate deploy` again                   — up, and it must apply
//   8. assert everything is back; drop the scratch schema
//
// Usage:  node scripts/verify-security-event-outbox-migration.mjs [--schema NAME]
// Connection: DATABASE_URL_IDENTITY (or DATABASE_URL).
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SERVICE_DIR = join(REPO_ROOT, 'services', 'identity-service');
const MIGRATION = '20260911120000_security_event_outbox';
const MIGRATION_DIR = join(SERVICE_DIR, 'prisma', 'migrations', MIGRATION);
const TABLE = 'security_event_outbox';

const CONSTRAINTS = [
  'ck_security_event_outbox_claim_triple',
  'ck_security_event_outbox_claim_count_nonneg',
  'ck_security_event_outbox_attempts_nonneg',
  'ck_security_event_outbox_published_is_clean',
  'ck_security_event_outbox_next_attempt_requires_failure',
  'ck_security_event_outbox_actor_type',
  'ck_security_event_outbox_actor_id_not_blank',
  'ck_security_event_outbox_organization_id_not_blank',
  'ck_security_event_outbox_resource_id_not_blank',
  'ck_security_event_outbox_correlation_id_not_blank',
  'ck_security_event_outbox_actor_roles_bounded',
  'ck_security_event_outbox_action_dotted',
  'ck_security_event_outbox_traceparent_format',
];

/** Index → its exact definition, schema normalised to `public`. */
const INDEXES = {
  ix_security_event_outbox_claimable:
    'CREATE INDEX ix_security_event_outbox_claimable ON public.security_event_outbox ' +
    'USING btree (created_at, id) WHERE (published_at IS NULL)',
  ix_security_event_outbox_claim_expiry:
    'CREATE INDEX ix_security_event_outbox_claim_expiry ON public.security_event_outbox ' +
    'USING btree (claim_expires_at) WHERE ((published_at IS NULL) AND (claim_expires_at IS NOT NULL))',
  ix_security_event_outbox_next_attempt:
    'CREATE INDEX ix_security_event_outbox_next_attempt ON public.security_event_outbox ' +
    'USING btree (next_attempt_at) WHERE ((published_at IS NULL) AND (next_attempt_at IS NOT NULL))',
};

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

for (const file of ['migration.sql', 'down.sql']) {
  if (!existsSync(join(MIGRATION_DIR, file))) fail(`${MIGRATION}/${file} is missing`);
}

const args = process.argv.slice(2);
const schemaFlag = args.indexOf('--schema');
const scratchSchema = schemaFlag >= 0 ? args[schemaFlag + 1] : 'security_event_outbox_check';
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

function mustFail(label, script, expected) {
  const result = sql(script);
  if (result.ok) {
    dropScratch();
    fail(`${label}: the database accepted a statement it must refuse.`);
  }
  if (!result.output.includes(expected)) {
    dropScratch();
    fail(`${label}: refused, but not by ${expected}:\n${result.output}`);
  }
  console.log(`  ✓ ${label}`);
}

function deploy(label, { mustApply = false } = {}) {
  const result = prisma(['migrate', 'deploy'], {
    env: { DATABASE_URL: scratchUrl, DATABASE_URL_IDENTITY: scratchUrl },
  });
  if (!result.ok) {
    dropScratch();
    fail(`${label} failed:\n${result.output}`);
  }
  if (mustApply && !result.output.includes(MIGRATION)) {
    dropScratch();
    fail(
      `${label} did not apply ${MIGRATION} — down.sql left its _prisma_migrations row behind, ` +
        `so a real rollback could never be rolled forward again.\n${result.output}`,
    );
  }
  console.log(`  ✓ ${label}`);
}

function assertPresent(present) {
  const want = present ? 'must exist' : 'must be gone';
  const indexChecks = Object.entries(INDEXES)
    .map(
      ([name, definition]) => `
  SELECT replace(regexp_replace(indexdef, '\\s+', ' ', 'g'), current_schema() || '.', 'public.')
    INTO def FROM pg_indexes
   WHERE schemaname = current_schema() AND indexname = '${name}';
  IF ${present ? `def IS DISTINCT FROM '${definition}'` : 'def IS NOT NULL'} THEN
    RAISE EXCEPTION '${name} ${want} with its exact definition, found %', def;
  END IF;`,
    )
    .join('\n');

  return `
DO $$
DECLARE n INT; def TEXT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = current_schema() AND table_name = '${TABLE}';
  IF n <> ${present ? 1 : 0} THEN
    RAISE EXCEPTION 'table ${TABLE} ${want}';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint c
    JOIN pg_namespace s ON s.oid = c.connamespace
   WHERE s.nspname = current_schema() AND c.contype = 'c'
     AND c.conname IN (${CONSTRAINTS.map((c) => `'${c}'`).join(', ')});
  IF n <> ${present ? CONSTRAINTS.length : 0} THEN
    RAISE EXCEPTION 'CHECK constraints ${want}: found % of ${CONSTRAINTS.length}', n;
  END IF;
${indexChecks}

  SELECT count(*) INTO n FROM _prisma_migrations WHERE migration_name = '${MIGRATION}';
  IF n <> ${present ? 1 : 0} THEN
    RAISE EXCEPTION '_prisma_migrations row for ${MIGRATION} ${want}';
  END IF;

  -- The domain outbox is untouched either way.
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = current_schema() AND table_name = 'outbox_message';
  IF n <> 1 THEN
    RAISE EXCEPTION 'outbox_message must be unaffected';
  END IF;
END
$$;`;
}

const PROBE = 'SEOCHK00000000000000000001';
const insertProbe = (overrides = {}) => {
  const values = {
    id: `'${PROBE}'`,
    organization_id: `'ORG_PROBE'`,
    actor_type: `'USER'`,
    actor_id: `'USR_PROBE'`,
    action: `'identity.active_organization.switch'`,
    resource_type: `'User'`,
    error_code: `'TENANT_MISMATCH'`,
    correlation_id: `'COR_PROBE'`,
    producer_version: `'0.0.0'`,
    occurred_at: 'now()',
    ...overrides,
  };
  return `INSERT INTO "${TABLE}" (${Object.keys(values).join(', ')})
          VALUES (${Object.values(values).join(', ')});`;
};
const clearProbe = `DELETE FROM "${TABLE}" WHERE id = '${PROBE}';`;
const update = (set) => `UPDATE "${TABLE}" SET ${set} WHERE id = '${PROBE}';`;

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

// --- up ----------------------------------------------------------------------
deploy('up: prisma migrate deploy');
mustRun('up: table, 13 CHECK constraints and 3 index definitions exist', assertPresent(true));

// --- the constraints refuse what they exist to refuse --------------------------
mustRun('seed: a valid unpublished refusal row', `${clearProbe} ${insertProbe()}`);
mustFail(
  'claim triple refuses a token without an expiry',
  update(`claim_token = 't', claim_owner = 'o'`),
  'ck_security_event_outbox_claim_triple',
);
mustRun(
  'claim triple accepts all three together',
  update(`claim_token = 't', claim_owner = 'o', claim_expires_at = now()`),
);
mustFail(
  'a published row must hold no claim',
  update('published_at = now()'),
  'ck_security_event_outbox_published_is_clean',
);
mustFail(
  'claim count is never negative',
  update('claim_count = -1'),
  'ck_security_event_outbox_claim_count_nonneg',
);
mustFail(
  'attempts are never negative',
  update('attempts = -1'),
  'ck_security_event_outbox_attempts_nonneg',
);
mustFail(
  'a retry needs a prior failure',
  update(`next_attempt_at = now()`),
  'ck_security_event_outbox_next_attempt_requires_failure',
);
mustFail(
  'actor type is a closed set',
  update(`actor_type = 'ANONYMOUS'`),
  'ck_security_event_outbox_actor_type',
);
mustFail(
  'actor id is never blank',
  update(`actor_id = '  '`),
  'ck_security_event_outbox_actor_id_not_blank',
);
mustFail(
  'organization id is null or non-blank',
  update(`organization_id = ''`),
  'ck_security_event_outbox_organization_id_not_blank',
);
mustFail(
  'resource id is null or non-blank',
  update(`resource_id = ' '`),
  'ck_security_event_outbox_resource_id_not_blank',
);
mustFail(
  'correlation id is never blank',
  update(`correlation_id = ' '`),
  'ck_security_event_outbox_correlation_id_not_blank',
);
mustFail(
  'the role list is bounded at 64',
  update(`actor_roles = array_fill('ROLE'::text, ARRAY[65])`),
  'ck_security_event_outbox_actor_roles_bounded',
);
mustFail(
  'action must be a dotted verb',
  update(`action = 'SWITCH_ORG'`),
  'ck_security_event_outbox_action_dotted',
);
mustFail(
  'traceparent must be W3C-shaped',
  update(`traceparent = 'not-a-trace'`),
  'ck_security_event_outbox_traceparent_format',
);
mustRun('clear the probe row', clearProbe);

// --- down --------------------------------------------------------------------
mustRun(`down: ${MIGRATION}/down.sql`, readFileSync(join(MIGRATION_DIR, 'down.sql'), 'utf8'));
mustRun('down: the table, its constraints, indexes and ledger row are gone', assertPresent(false));

// --- up again ----------------------------------------------------------------
deploy('up again: prisma migrate deploy re-applies the migration', { mustApply: true });
mustRun('up again: everything is back', assertPresent(true));

mustRun('drop scratch schema', `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE;`);
console.log(`\n✓ ${MIGRATION} is reversible: up → down → up in ${Date.now() - startedAt}ms`);

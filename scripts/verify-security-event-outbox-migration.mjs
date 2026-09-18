#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Proves identity-service's `security_event_outbox` migrations (ADR-053 § 4,
// AUD-004 Phases C1 and C2) are reversible, by reversing them.
//
//   20260911120000_security_event_outbox              the refusal queue (C1)
//   20260911130000_security_event_outbox_aggregation  windowed aggregation (C2)
//
// Why a script of its own. `verify-migration-reversible.mjs` reverses a
// service's *whole* chain and needs a down.sql for every migration in it;
// identity's initial migration has none. `verify-outbox-claim-migration.mjs`
// discovers services by `model OutboxMessage` and addresses the ADR-050/051
// migrations by name, so it neither covers nor should cover this table. Nothing
// in the repository's discovery reaches these migrations, so they are
// registered here explicitly — and only here.
//
// Against a **throwaway schema** in identity's own database:
//
//   1. create the scratch schema and refuse to continue unless the session is
//      really pointed at it
//   2. `prisma migrate deploy`                              — up (whole chain)
//   3. assert both migrations' objects: the table, 18 CHECK constraints, 5
//      indexes by exact definition, 3 aggregation columns, the evidence trigger
//      and its function, and both ledger rows
//   4. exercise every CHECK, the partial unique index and the trigger
//   5. C2 down.sql                                          — down one
//   6. assert C2 is gone and C1 is intact; insert two single-occurrence rows the
//      way Phase C1 wrote them — same identity, same instant
//   7. `prisma migrate deploy`                              — up one
//   8. assert C2 is back and those rows were backfilled without colliding
//   9. C2 down.sql, then C1 down.sql                        — down both
//  10. assert everything is gone, ledger rows included
//  11. `prisma migrate deploy`                              — up both
//  12. assert everything is back; drop the scratch schema
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
const TABLE = 'security_event_outbox';

const C1 = '20260911120000_security_event_outbox';
const C2 = '20260911130000_security_event_outbox_aggregation';
const migrationDir = (name) => join(SERVICE_DIR, 'prisma', 'migrations', name);

const C1_CONSTRAINTS = [
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

const C2_CONSTRAINTS = [
  'ck_security_event_outbox_occurrence_count_range',
  'ck_security_event_outbox_window_bounds',
  'ck_security_event_outbox_occurred_within_window',
  'ck_security_event_outbox_aggregate_needs_window',
  'ck_security_event_outbox_published_was_claimed',
];

const C2_COLUMNS = ['occurrence_count', 'window_started_at', 'window_ends_at'];
const C2_TRIGGER = 'tg_security_event_outbox_guard';
const C2_FUNCTION = 'security_event_outbox_guard';

/** Index → its exact definition, schema normalised to `public`. */
const C1_INDEXES = {
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

const C2_INDEXES = {
  ux_security_event_outbox_open_bucket:
    'CREATE UNIQUE INDEX ux_security_event_outbox_open_bucket ON public.security_event_outbox ' +
    'USING btree (organization_id, actor_type, actor_id, action, resource_type, resource_id, ' +
    'error_code, window_started_at, window_ends_at) NULLS NOT DISTINCT ' +
    'WHERE ((published_at IS NULL) AND (claim_count = 0) AND (occurrence_count < 2147483647) ' +
    "AND ((window_ends_at - window_started_at) >= '00:00:01'::interval))",
  ix_security_event_outbox_closed_windows:
    'CREATE INDEX ix_security_event_outbox_closed_windows ON public.security_event_outbox ' +
    'USING btree (window_ends_at, id) WHERE (published_at IS NULL)',
};

/**
 * The partial unique index, as `prisma db execute` reports a violation of it:
 * by name, or as P2002 naming exactly the index's columns.
 */
const OPEN_BUCKET_VIOLATION = [
  'ux_security_event_outbox_open_bucket',
  'Unique constraint failed on the fields: (`organization_id`,`actor_type`,`actor_id`,' +
    '`action`,`resource_type`,`resource_id`,`error_code`,`window_started_at`,`window_ends_at`)',
];

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

for (const name of [C1, C2]) {
  for (const file of ['migration.sql', 'down.sql']) {
    if (!existsSync(join(migrationDir(name), file))) fail(`${name}/${file} is missing`);
  }
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
/** A code-authored string as a SQL literal body. */
const literal = (value) => value.replaceAll("'", "''");

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
  // A list when a row breaks two constraints at once and PostgreSQL may report
  // either — it does not promise an order among CHECKs.
  const acceptable = Array.isArray(expected) ? expected : [expected];
  if (!acceptable.some((name) => result.output.includes(name))) {
    dropScratch();
    fail(`${label}: refused, but not by ${acceptable.join(' or ')}:\n${result.output}`);
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
}

function indexChecks(indexes, present, want) {
  return Object.entries(indexes)
    .map(
      ([name, definition]) => `
  SELECT replace(regexp_replace(indexdef, '\\s+', ' ', 'g'), current_schema() || '.', 'public.')
    INTO def FROM pg_indexes
   WHERE schemaname = current_schema() AND indexname = '${name}';
  IF ${present ? `def IS DISTINCT FROM '${literal(definition)}'` : 'def IS NOT NULL'} THEN
    RAISE EXCEPTION '${name} ${want} with its exact definition, found %', def;
  END IF;`,
    )
    .join('\n');
}

const constraintCount = (names) => `
  SELECT count(*) INTO n FROM pg_constraint c
    JOIN pg_namespace s ON s.oid = c.connamespace
   WHERE s.nspname = current_schema() AND c.contype = 'c'
     AND c.conname IN (${names.map((c) => `'${c}'`).join(', ')});`;

/** Asserts which of the two migrations are applied, by every object each one owns. */
function assertState({ c1, c2 }) {
  const has = (present) => (present ? 'must exist' : 'must be gone');
  return `
DO $$
DECLARE n INT; def TEXT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = current_schema() AND table_name = '${TABLE}';
  IF n <> ${c1 ? 1 : 0} THEN
    RAISE EXCEPTION 'table ${TABLE} ${has(c1)}';
  END IF;
${constraintCount(C1_CONSTRAINTS)}
  IF n <> ${c1 ? C1_CONSTRAINTS.length : 0} THEN
    RAISE EXCEPTION 'C1 CHECK constraints ${has(c1)}: found % of ${C1_CONSTRAINTS.length}', n;
  END IF;
${indexChecks(C1_INDEXES, c1, has(c1))}

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = '${TABLE}'
     AND column_name IN (${C2_COLUMNS.map((c) => `'${c}'`).join(', ')});
  IF n <> ${c2 ? C2_COLUMNS.length : 0} THEN
    RAISE EXCEPTION 'aggregation columns ${has(c2)}: found % of ${C2_COLUMNS.length}', n;
  END IF;
${constraintCount(C2_CONSTRAINTS)}
  IF n <> ${c2 ? C2_CONSTRAINTS.length : 0} THEN
    RAISE EXCEPTION 'C2 CHECK constraints ${has(c2)}: found % of ${C2_CONSTRAINTS.length}', n;
  END IF;
${indexChecks(C2_INDEXES, c2, has(c2))}

  SELECT count(*) INTO n FROM pg_trigger t
    JOIN pg_class r ON r.oid = t.tgrelid
    JOIN pg_namespace s ON s.oid = r.relnamespace
   WHERE s.nspname = current_schema() AND t.tgname = '${C2_TRIGGER}' AND NOT t.tgisinternal;
  IF n <> ${c2 ? 1 : 0} THEN
    RAISE EXCEPTION 'trigger ${C2_TRIGGER} ${has(c2)}';
  END IF;

  SELECT count(*) INTO n FROM pg_proc p
    JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = current_schema() AND p.proname = '${C2_FUNCTION}';
  IF n <> ${c2 ? 1 : 0} THEN
    RAISE EXCEPTION 'function ${C2_FUNCTION} ${has(c2)}';
  END IF;

  SELECT count(*) INTO n FROM _prisma_migrations WHERE migration_name = '${C1}';
  IF n <> ${c1 ? 1 : 0} THEN
    RAISE EXCEPTION '_prisma_migrations row for ${C1} ${has(c1)}';
  END IF;
  SELECT count(*) INTO n FROM _prisma_migrations WHERE migration_name = '${C2}';
  IF n <> ${c2 ? 1 : 0} THEN
    RAISE EXCEPTION '_prisma_migrations row for ${C2} ${has(c2)}';
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

// --- probe rows ----------------------------------------------------------------
// A far-future window, so a probe is never an "open now" or "closed now" row by
// accident and every value is deterministic.
const PROBE = 'SEOCHK00000000000000000001';
const SECOND = 'SEOCHK00000000000000000002';

const C1_VALUES = {
  id: `'${PROBE}'`,
  organization_id: `'ORG_PROBE'`,
  actor_type: `'USER'`,
  actor_id: `'USR_PROBE'`,
  action: `'identity.active_organization.switch'`,
  resource_type: `'User'`,
  error_code: `'TENANT_MISMATCH'`,
  correlation_id: `'COR_PROBE'`,
  producer_version: `'0.0.0'`,
  occurred_at: `'2099-01-01 00:00:30'`,
};
const C2_VALUES = {
  ...C1_VALUES,
  occurrence_count: '1',
  window_started_at: `'2099-01-01 00:00:00'`,
  window_ends_at: `'2099-01-01 00:01:00'`,
};

const insertInto =
  (base) =>
  (overrides = {}) => {
    const values = { ...base, ...overrides };
    return `INSERT INTO "${TABLE}" (${Object.keys(values).join(', ')})
          VALUES (${Object.values(values).join(', ')});`;
  };
/** A row as Phase C1 wrote it — no aggregation columns. */
const insertLegacy = insertInto(C1_VALUES);
/** A row as Phase C2 writes it. */
const insertProbe = insertInto(C2_VALUES);
const clearProbes = `DELETE FROM "${TABLE}" WHERE id LIKE 'SEOCHK%';`;
const update = (set, id = PROBE) => `UPDATE "${TABLE}" SET ${set} WHERE id = '${id}';`;
const fresh = (statement) => `${clearProbes} ${statement}`;

const startedAt = Date.now();
console.log(`Verifying ${C1} and ${C2} (identity-service) in scratch schema ${scratchSchema}\n`);

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
mustRun(
  'up: every C1 and C2 object exists, indexes by exact definition',
  assertState({ c1: true, c2: true }),
);

// --- C1: delivery-state constraints (updates the trigger permits) ---------------
mustRun('seed: a valid unpublished refusal row', fresh(insertProbe()));
mustFail(
  'claim triple refuses a token without an expiry',
  update(`claim_token = 't', claim_owner = 'o'`),
  'ck_security_event_outbox_claim_triple',
);
mustRun(
  'claim triple accepts all three together',
  update(`claim_token = 't', claim_owner = 'o', claim_expires_at = now(), claim_count = 1`),
);
mustFail(
  'a published row must hold no claim',
  update('published_at = now()'),
  'ck_security_event_outbox_published_is_clean',
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

// --- C1: evidence constraints (inserts — the trigger freezes evidence on update)
for (const [label, overrides, constraint] of [
  [
    'claim count is never negative',
    { claim_count: '-1' },
    'ck_security_event_outbox_claim_count_nonneg',
  ],
  [
    'actor type is a closed set',
    { actor_type: `'ANONYMOUS'` },
    'ck_security_event_outbox_actor_type',
  ],
  ['actor id is never blank', { actor_id: `'  '` }, 'ck_security_event_outbox_actor_id_not_blank'],
  [
    'organization id is null or non-blank',
    { organization_id: `''` },
    'ck_security_event_outbox_organization_id_not_blank',
  ],
  [
    'resource id is null or non-blank',
    { resource_id: `' '` },
    'ck_security_event_outbox_resource_id_not_blank',
  ],
  [
    'correlation id is never blank',
    { correlation_id: `' '` },
    'ck_security_event_outbox_correlation_id_not_blank',
  ],
  [
    'the role list is bounded at 64',
    { actor_roles: `array_fill('ROLE'::text, ARRAY[65])` },
    'ck_security_event_outbox_actor_roles_bounded',
  ],
  [
    'action must be a dotted verb',
    { action: `'SWITCH_ORG'` },
    'ck_security_event_outbox_action_dotted',
  ],
  [
    'traceparent must be W3C-shaped',
    { traceparent: `'not-a-trace'` },
    'ck_security_event_outbox_traceparent_format',
  ],
]) {
  mustFail(label, fresh(insertProbe(overrides)), constraint);
}

// --- C2: aggregation constraints ------------------------------------------------
for (const [label, overrides, constraint] of [
  [
    'occurrence count is at least 1',
    { occurrence_count: '0' },
    'ck_security_event_outbox_occurrence_count_range',
  ],
  [
    'a window is not empty',
    { window_ends_at: `'2099-01-01 00:00:00'`, occurred_at: `'2099-01-01 00:00:00'` },
    // An empty window cannot contain its first occurrence either, so both
    // constraints refuse this row.
    ['ck_security_event_outbox_window_bounds', 'ck_security_event_outbox_occurred_within_window'],
  ],
  [
    'a window is at most one hour',
    { window_ends_at: `'2099-01-01 02:00:00'` },
    'ck_security_event_outbox_window_bounds',
  ],
  [
    'the first occurrence is not before its window',
    { occurred_at: `'2098-12-31 23:59:59'` },
    'ck_security_event_outbox_occurred_within_window',
  ],
  [
    'the first occurrence is not at its window end',
    { occurred_at: `'2099-01-01 00:01:00'` },
    'ck_security_event_outbox_occurred_within_window',
  ],
  [
    'only a real window holds an aggregate',
    {
      occurrence_count: '2',
      occurred_at: `'2099-01-01 00:00:00'`,
      window_ends_at: `'2099-01-01 00:00:00.001'`,
    },
    'ck_security_event_outbox_aggregate_needs_window',
  ],
  [
    'a published row was claimed',
    { published_at: `'2099-01-01 00:02:00'` },
    'ck_security_event_outbox_published_was_claimed',
  ],
]) {
  mustFail(label, fresh(insertProbe(overrides)), constraint);
}
mustRun(
  'the count accepts the INTEGER ceiling',
  fresh(insertProbe({ occurrence_count: '2147483647' })),
);

// --- C2: the partial unique index -------------------------------------------------
mustFail(
  'one open row per identity and window',
  fresh(`${insertProbe()} ${insertProbe({ id: `'${SECOND}'` })}`),
  OPEN_BUCKET_VIOLATION,
);
mustFail(
  'a NULL tenant and resource are one identity, not two unknowns',
  fresh(
    `${insertProbe({ organization_id: 'NULL', resource_id: 'NULL' })}
     ${insertProbe({ id: `'${SECOND}'`, organization_id: 'NULL', resource_id: 'NULL' })}`,
  ),
  OPEN_BUCKET_VIOLATION,
);
mustRun(
  'a claimed row leaves the index: a successor is accepted',
  fresh(
    `${insertProbe()}
     ${update(`claim_token = 't', claim_owner = 'o', claim_expires_at = now(), claim_count = 1`)}
     ${insertProbe({ id: `'${SECOND}'` })}`,
  ),
);
mustRun(
  'a full row leaves the index: a successor is accepted',
  fresh(`${insertProbe({ occurrence_count: '2147483647' })} ${insertProbe({ id: `'${SECOND}'` })}`),
);
mustRun(
  'another window is another row',
  fresh(
    `${insertProbe()}
     ${insertProbe({
       id: `'${SECOND}'`,
       occurred_at: `'2099-01-01 00:01:30'`,
       window_started_at: `'2099-01-01 00:01:00'`,
       window_ends_at: `'2099-01-01 00:02:00'`,
     })}`,
  ),
);
mustRun(
  'single-instant (pre-aggregation) windows are outside the index',
  fresh(
    `${insertProbe({ occurred_at: `'2099-01-01 00:00:00'`, window_ends_at: `'2099-01-01 00:00:00.001'` })}
     ${insertProbe({
       id: `'${SECOND}'`,
       occurred_at: `'2099-01-01 00:00:00'`,
       window_ends_at: `'2099-01-01 00:00:00.001'`,
     })}`,
  ),
);

// --- C2: the evidence trigger --------------------------------------------------
mustRun('seed: a fresh open row', fresh(insertProbe()));
mustFail('evidence is immutable', update(`actor_id = 'USR_OTHER'`), C2_TRIGGER);
mustFail('the window is immutable', update(`window_ends_at = '2099-01-01 00:00:59'`), C2_TRIGGER);
mustRun('the count grows before the first claim', update('occurrence_count = 5'));
mustFail('the count never shrinks', update('occurrence_count = 4'), C2_TRIGGER);
mustRun(
  'a claim is accepted',
  update(`claim_token = 't', claim_owner = 'o', claim_expires_at = now(), claim_count = 1`),
);
mustFail('a claimed row cannot change its count', update('occurrence_count = 6'), C2_TRIGGER);
mustFail(
  'claim_count never decreases',
  update(`claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL, claim_count = 0`),
  C2_TRIGGER,
);
mustRun(
  'delivery state still moves on a claimed row',
  update(`published_at = now(), claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL`),
);
mustRun('clear the probe rows', clearProbes);

// --- down C2 -------------------------------------------------------------------
mustRun(`down: ${C2}/down.sql`, readFileSync(join(migrationDir(C2), 'down.sql'), 'utf8'));
mustRun(
  'down: C2 objects and ledger row are gone, C1 intact',
  assertState({ c1: true, c2: false }),
);
mustRun(
  'down: Phase C1 can write again — two single-occurrence rows, same identity, same instant',
  `${insertLegacy()} ${insertLegacy({ id: `'${SECOND}'` })}`,
);

// --- up C2 over existing rows ------------------------------------------------------
deploy(`up again: prisma migrate deploy re-applies ${C2} over existing rows`, { mustApply: [C2] });
mustRun('up again: every C1 and C2 object exists', assertState({ c1: true, c2: true }));
mustRun(
  'up again: existing rows became single-instant, single-occurrence windows without colliding',
  `DO $$
   DECLARE n INT;
   BEGIN
     SELECT count(*) INTO n FROM "${TABLE}"
      WHERE id IN ('${PROBE}', '${SECOND}')
        AND occurrence_count = 1
        AND window_started_at = occurred_at
        AND window_ends_at = occurred_at + interval '1 millisecond';
     IF n <> 2 THEN
       RAISE EXCEPTION 'expected both existing rows backfilled, found %', n;
     END IF;
   END $$;`,
);
mustRun('clear the probe rows', clearProbes);

// --- down both -------------------------------------------------------------------
mustRun(`down: ${C2}/down.sql`, readFileSync(join(migrationDir(C2), 'down.sql'), 'utf8'));
mustRun(`down: ${C1}/down.sql`, readFileSync(join(migrationDir(C1), 'down.sql'), 'utf8'));
mustRun(
  'down: both migrations, every object and both ledger rows are gone',
  assertState({ c1: false, c2: false }),
);

// --- up both -----------------------------------------------------------------------
deploy('up again: prisma migrate deploy re-applies both migrations', { mustApply: [C1, C2] });
mustRun('up again: everything is back', assertState({ c1: true, c2: true }));

mustRun('drop scratch schema', `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE;`);
console.log(`\n✓ ${C1} and ${C2} are reversible: up → down → up in ${Date.now() - startedAt}ms`);

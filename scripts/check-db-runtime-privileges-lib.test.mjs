import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FINDINGS_SQL,
  FUNCTION_GRANT_LINE,
  TIMEZONE_FINDINGS_SQL,
  allowlistSql,
  classifyServices,
  findingsSql,
  grantsModesFromLibrary,
  parseRequiredRuntimeFunctions,
  policyFor,
  requiredRuntimeFunctions,
  timezoneVerdict,
  verdict,
} from './check-db-runtime-privileges-lib.mjs';
import { servicesFromLibrary, splitServicesFromLibrary } from './infra-preflight-lib.mjs';

test('every service is placed exactly once: split or audit (D-045)', () => {
  const placed = classifyServices();
  assert.deepEqual(
    placed.map((entry) => entry.service),
    servicesFromLibrary(),
  );
  assert.deepEqual(
    placed
      .filter((entry) => entry.kind === 'split')
      .map((entry) => entry.service)
      .sort(),
    [...splitServicesFromLibrary()].sort(),
  );
  assert.ok(splitServicesFromLibrary().includes('economic'));
  assert.ok(!splitServicesFromLibrary().includes('audit'));
  for (const entry of placed) {
    assert.equal(entry.database, `rasta_${entry.service}`);
    assert.equal(entry.runtime, `rasta_${entry.service}`);
  }
});

// #421 r1 F3b: each service is held to the policy the split gives it.
test('every service is held to its split policy: audit, its own in migration mode, else default', () => {
  const policies = Object.fromEntries(classifyServices().map((e) => [e.service, e.policy]));
  assert.equal(policies.audit, 'audit');
  assert.equal(policies.supplier, 'supplier');
  assert.equal(policies.analytics, 'analytics');
  assert.equal(policies.economic, 'default');
  const modes = grantsModesFromLibrary();
  for (const [service, mode] of modes) {
    assert.equal(policies[service], mode === 'default' ? 'default' : service, service);
  }
  // Every policy a service is held to has rows, and no policy is left unused.
  const named = new Set(allowlistRows().map((row) => row.policy));
  assert.deepEqual([...named].sort(), ['*', ...new Set(Object.values(policies))].sort());
  assert.throws(() => policyFor('x', 'split', undefined), /unknown grants mode/);
  assert.throws(() => policyFor('x', 'split', 'grants'), /unknown grants mode/);
});

test('a service not split, split twice over, or unknown is refused — a new service has to be split', () => {
  const services = ['a', 'b', 'audit'];
  assert.throws(
    () => classifyServices({ services, split: ['a'] }),
    /b: in RASTA_SERVICES but not in PRIVILEGE_SPLIT_SERVICES/,
  );
  assert.throws(
    () => classifyServices({ services, split: ['a', 'b', 'audit'] }),
    /audit is both split and audit/,
  );
  assert.throws(
    () => classifyServices({ services, split: ['a', 'b', 'c'] }),
    /c is not in RASTA_SERVICES/,
  );
});

test('a split service fails on any finding and passes on none', () => {
  const split = { service: 'construction', kind: 'split' };
  assert.equal(verdict(split, []).ok, true);
  const failed = verdict(split, ['TRIGGER on public.tender', 'owns table public.tender']);
  assert.equal(failed.ok, false);
  assert.match(failed.line, /TRIGGER on public\.tender/);
  assert.match(failed.line, /owns table public\.tender/);
  assert.equal(
    verdict({ service: 'audit', kind: 'audit' }, ['owns database rasta_audit']).ok,
    false,
  );
});

test('the query asks about every right the PM ruled out, through role membership', () => {
  for (const fragment of [
    'rolsuper',
    'rolcreatedb',
    'rolcreaterole',
    'rolbypassrls',
    "'owns database '",
    "'owns schema '",
    "'owns function '",
    "'owns type '",
    "ARRAY['CREATE', 'TEMPORARY', 'CONNECT']",
    "ARRAY['CREATE', 'USAGE']",
    "ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']",
    "ARRAY['USAGE', 'SELECT', 'UPDATE']",
    "c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')",
    "' WITH GRANT OPTION'",
    'pg_default_acl',
    '_prisma_migrations',
    "'allowed but not held: ",
    "pg_has_role(me.oid, t.relowner, 'MEMBER')",
    "pg_has_role(me.oid, m.oid, 'MEMBER')",
    "'member of '",
  ]) {
    assert.ok(FINDINGS_SQL.includes(fragment), fragment);
  }
  assert.match(FINDINGS_SQL, /rolname = :'runtime'/);
  assert.match(FINDINGS_SQL, /a\.policy IN \(:'policy', '\*'\)/);
});

// #421 r1 F3/F3b: one rule set. The split revokes by the very files the check
// reports from — the allowlist and the forbidden rights derived from it — and
// keeps no privilege list of its own; its default-mode grants are the
// allowlist's `default` rows.
test('the split and the check read one allowlist and one forbidden-rights file', () => {
  const lib = new URL('../infrastructure/docker/postgres/lib/', import.meta.url);
  const rules = readFileSync(new URL('runtime-forbidden.sql', lib), 'utf8');
  const split = readFileSync(new URL('service-privilege-split.bash', lib), 'utf8');
  assert.ok(
    FINDINGS_SQL.includes(
      rules
        .replaceAll('MIGRATOR_ROLE', "(:'runtime' || '_migrator')")
        .replaceAll('RUNTIME_ROLE', ":'runtime'")
        .replaceAll('RUNTIME_POLICY', ":'policy'"),
    ),
  );
  assert.ok(FINDINGS_SQL.includes(readFileSync(new URL('runtime-allowlist.sql', lib), 'utf8')));
  assert.match(split, /runtime-forbidden\.sql/);
  assert.match(split, /runtime-allowlist\.sql/);
  const cleanup = split.slice(
    split.indexOf('_restrict_reachable_acl() {'),
    split.indexOf('restrict_extension_relations() {'),
  );
  for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'TEMPORARY', 'USAGE', 'INSERT']) {
    assert.ok(!cleanup.includes(`'${privilege}'`), `the split names ${privilege} itself`);
  }
  assert.ok(!/relkind|pg_proc|pg_class/.test(cleanup), 'the split selects objects itself');
  const grants = split.slice(
    split.indexOf('grant_service_tables() {'),
    split.indexOf('_runtime_reachable_sql() {'),
  );
  assert.ok(!/GRANT (SELECT|USAGE)/.test(grants), 'the split grants a privilege list of its own');
  assert.match(grants, /WHERE policy = 'default'/);
});

/** runtime-allowlist.sql's rows (a test-only reading; PostgreSQL reads the file). */
function allowlistRows() {
  const rows = [
    ...allowlistSql.matchAll(/^\s*\('([^']+)', '([^']+)', '([^']+)', ARRAY\[([^\]]*)\]\),?$/gm),
  ].map(([, policy, cls, object, privileges]) => ({
    policy,
    cls,
    object,
    privileges: privileges.split(',').map((p) => p.trim().replaceAll("'", '')),
  }));
  const declared = allowlistSql.split('\n').filter((line) => /^\s*\('/.test(line)).length;
  assert.equal(rows.length, declared, 'a row the test cannot read');
  return rows;
}

/**
 * What a service's migrations leave its runtime role holding on tables and
 * sequences, statement by statement in migration order: GRANT adds, REVOKE ALL
 * clears. Any other GRANT/REVOKE naming the runtime role fails the test, so a
 * new form cannot slip past it.
 */
function migrationGrants(service, schema) {
  const runtime = `rasta_${service}`;
  const dir = new URL(`../services/${service}-service/prisma/migrations/`, import.meta.url);
  const held = new Map();
  const names = (list) =>
    list
      .split(',')
      .map((name) => name.trim().replaceAll('"', ''))
      .filter(Boolean)
      .map((name) => (name.includes('.') ? name : `${schema}.${name}`));
  for (const migration of readdirSync(dir)
    .filter((d) => /^\d{14}_/.test(d))
    .sort()) {
    const sql = readFileSync(new URL(`${migration}/migration.sql`, dir), 'utf8').replace(
      /--[^\n]*/g,
      '',
    );
    for (const [statement] of sql.matchAll(/\b(GRANT|REVOKE)\b[^;]*;/gi)) {
      if (!new RegExp(`\\b${runtime}\\b`).test(statement)) continue;
      const flat = statement.replace(/\s+/g, ' ');
      let m;
      if (/ ON (TYPE|FUNCTION|ROUTINE) /i.test(flat) || /^GRANT USAGE ON SCHEMA/i.test(flat))
        continue;
      if ((m = /^GRANT ([A-Z, ]+) ON (SEQUENCE |TABLE )?(.+) TO (\w+);$/i.exec(flat))) {
        assert.equal(m[4], runtime, flat);
        const cls = m[2]?.trim().toUpperCase() === 'SEQUENCE' ? 'sequence' : 'relation';
        for (const name of names(m[3])) {
          const key = `${cls} ${name}`;
          const set = held.get(key) ?? new Set();
          for (const p of m[1].split(',')) set.add(p.trim().toUpperCase());
          held.set(key, set);
        }
      } else if ((m = /^REVOKE ALL ON ALL SEQUENCES IN SCHEMA (\w+) FROM (\w+);$/i.exec(flat))) {
        for (const key of [...held.keys()])
          if (key.startsWith(`sequence ${m[1]}.`)) held.delete(key);
      } else if ((m = /^REVOKE ALL ON (SEQUENCE |TABLE )?(.+) FROM (\w+);$/i.exec(flat))) {
        const cls = m[1]?.trim().toUpperCase() === 'SEQUENCE' ? 'sequence' : 'relation';
        for (const name of names(m[2])) held.delete(`${cls} ${name}`);
      } else if (/^ALTER DEFAULT PRIVILEGES .* REVOKE ALL ON (TABLES|SEQUENCES) FROM/i.test(flat)) {
        continue; // removes the old default-mode defaults; the policy grants none
      } else {
        assert.fail(`${migration}: a grant form this test does not read: ${flat}`);
      }
    }
  }
  return held;
}

// F3b: the allowlist is derived from the migrations — for every policy whose
// migrations grant per table, row for row and privilege for privilege. (The
// check on a fresh bootstrap holds the database to it as well, both ways.)
test('each migration-managed policy is exactly what its migrations grant', () => {
  const rows = allowlistRows();
  for (const [policy, schema] of [
    ['supplier', 'public'],
    ['analytics', 'public'],
    ['audit', 'audit'],
  ]) {
    const declared = new Map(
      rows
        .filter((r) => r.policy === policy && ['relation', 'sequence'].includes(r.cls))
        .map((r) => [`${r.cls} ${r.object}`, [...r.privileges].sort()]),
    );
    const granted = new Map(
      [...migrationGrants(policy, schema)]
        .filter(([, set]) => set.size > 0)
        .map(([key, set]) => [key, [...set].sort()]),
    );
    assert.deepEqual(
      Object.fromEntries([...declared].sort()),
      Object.fromEntries([...granted].sort()),
      policy,
    );
    assert.ok(
      rows.some((r) => r.policy === policy && r.cls === 'schema' && r.object === schema),
      `${policy}: USAGE on ${schema}`,
    );
  }
  // The review's sweep (#520 r1 R1), in the file's own words.
  const allowed = (policy, object) =>
    rows.find((r) => r.policy === policy && r.object === object)?.privileges ?? [];
  assert.deepEqual(allowed('analytics', 'public.baseline_metric'), ['SELECT']);
  for (const table of ['fact_maintenance', 'processed_event', 'projection_coverage']) {
    assert.deepEqual(allowed('analytics', `public.${table}`), ['SELECT', 'INSERT']);
  }
  assert.ok(!rows.some((r) => r.policy === 'analytics' && r.cls === 'sequence'));
  assert.ok(!rows.some((r) => r.policy === 'supplier' && r.cls === 'sequence'));
  assert.deepEqual(allowed('supplier', 'public.performance_formula_version'), [
    'SELECT',
    'INSERT',
    'UPDATE',
  ]);
  assert.deepEqual(allowed('audit', 'audit.organization_ref'), ['SELECT', 'INSERT', 'UPDATE']);
  assert.deepEqual(allowed('audit', 'audit.audit_chain_head'), ['SELECT', 'INSERT', 'UPDATE']);
  assert.deepEqual(allowed('audit', 'audit.tender_receipt_pending'), [
    'SELECT',
    'INSERT',
    'DELETE',
  ]);
  assert.ok(!rows.some((r) => /audit_event_/.test(r.object) && r.cls === 'relation'));
  // Wildcards and defaults only in the default policy.
  for (const row of rows.filter((r) => r.object.endsWith('.*') || r.cls.startsWith('default'))) {
    assert.equal(row.policy, 'default', `${row.policy} ${row.cls} ${row.object}`);
  }
});

// #421 r1 F5: the list the split repairs from and the check holds to.
test('the required runtime function list: every line, the last one too; malformed refuses', () => {
  const line =
    'economic|public.f(text,public."BusinessLine")|20261016120000_commission_business_lines';
  assert.deepEqual(parseRequiredRuntimeFunctions(`# c\n${line}`), [line.split('|')]);
  assert.deepEqual(parseRequiredRuntimeFunctions(`${line}\n`), [line.split('|')]);
  for (const bad of [
    'economic|public.f(text)',
    `${line}|extra`,
    "economic|public.f(text');DROP|20261016120000_x",
    'economic|f(text)|20261016120000_x',
    'economic|public.f(text)|20261016_x',
  ]) {
    assert.throws(() => parseRequiredRuntimeFunctions(bad), /malformed/, bad);
  }
  assert.ok(requiredRuntimeFunctions.length >= 4);
  // The types are schema-qualified: search_path decides nothing.
  for (const [, signature] of requiredRuntimeFunctions) {
    const types = signature.slice(signature.indexOf('(') + 1, -1).split(',');
    for (const type of types) {
      assert.ok(/^(text|integer|public\."[A-Za-z]+")$/.test(type), `${signature}: ${type}`);
    }
  }
});

// #520 r1 R2: one grammar on both sides. The split's bash reader and this
// parser see the same lines and must reach the same verdict, row for row.
const SPLIT_LIB = fileURLToPath(
  new URL('../infrastructure/docker/postgres/lib/service-privilege-split.bash', import.meta.url),
);
const GOOD =
  'economic|public.f(text,public."BusinessLine")|20261016120000_commission_business_lines';
const LIST_CORPUS = {
  // The review's two rows.
  'trailing empty field': 'economic|public.f(text)|20261016120000_x|',
  'empty service': '|public.f(text)|20261016120000_x',
  'two trailing empty fields': 'economic|public.f(text)|20261016120000_x||',
  'empty signature': 'economic||20261016120000_x',
  'empty migration': 'economic|public.f(text)|',
  'only separators': '||',
  'a fourth field': `${GOOD}|extra`,
  'two fields': 'economic|public.f(text)',
  'carriage return': `${GOOD}\r`,
  'leading blank': ` ${GOOD}`,
  'trailing blank': `${GOOD} `,
  'a tab': `${GOOD}\t`,
  'indented comment': ' # comment',
  'only a blank': ' ',
  'a quote': "economic|public.f(text');DROP|20261016120000_x",
  'unqualified signature': 'economic|f(text)|20261016120000_x',
  'short migration': 'economic|public.f(text)|20261016_x',
  'upper-case service': 'Economic|public.f(text)|20261016120000_x',
  'NUL in a row': 'econ\0omic|public.f(text)|20261016120000_x',
  'NUL in a comment': '# a \0 comment',
};

/** The split's reader on `text`: its rows, or null when it refuses. */
function bashRows(text) {
  const dir = mkdtempSync(join(tmpdir(), 'grant-list-'));
  try {
    const file = join(dir, 'list.txt');
    writeFileSync(file, text);
    const result = spawnSync(
      'bash',
      ['-c', 'source "$1" && _runtime_function_grant_rows "$2"', 'grant-list', SPLIT_LIB, file],
      { encoding: 'utf8' },
    );
    return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsRows(text) {
  try {
    return parseRequiredRuntimeFunctions(text).map((parts) => parts.join('|'));
  } catch {
    return null;
  }
}

test('the split and the check read the function list by one grammar: the same rows refused, the same kept', () => {
  for (const [name, bad] of Object.entries(LIST_CORPUS)) {
    for (const text of [bad, `# list\n\n${GOOD}\n${bad}\n`, `${GOOD}\n${bad}`]) {
      assert.equal(jsRows(text), null, `the check accepts ${name}`);
      assert.equal(bashRows(text), null, `the split accepts ${name}`);
    }
  }
  for (const text of [
    GOOD,
    `${GOOD}\n`,
    `# c\n\n${GOOD}\n\n# d\n${GOOD.replace('economic', 'procurement')}`,
    '',
    '# only a comment\n',
    '\n\n',
  ]) {
    assert.deepEqual(bashRows(text), jsRows(text), JSON.stringify(text));
  }
  assert.deepEqual(jsRows(GOOD), [GOOD]);
  // The very pattern, in both readers.
  const split = readFileSync(SPLIT_LIB, 'utf8');
  const bashPattern = /local line_re='([^']+)'/.exec(split)[1];
  assert.equal(bashPattern, FUNCTION_GRANT_LINE.source);
  // The real list, through both.
  const real = readFileSync(
    new URL('../infrastructure/docker/postgres/lib/runtime-function-grants.txt', import.meta.url),
    'utf8',
  );
  assert.deepEqual(bashRows(real), jsRows(real));
  assert.equal(jsRows(real).length, requiredRuntimeFunctions.length);
});

// …and every reader of it in the split refuses before it sends any SQL: the
// repair, both cleanups and the final assertion, each on its own.
test('every split step that reads the function list refuses a malformed one, sending nothing', () => {
  const lib = fileURLToPath(new URL('../infrastructure/docker/postgres/lib/', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'grant-list-lib-'));
  try {
    cpSync(lib, dir, { recursive: true });
    writeFileSync(
      join(dir, 'runtime-function-grants.txt'),
      `${GOOD}\n${LIST_CORPUS['empty service']}\n`,
    );
    for (const step of [
      'restore_runtime_function_grants economic db rt rt_migrator',
      'restrict_service_functions_and_rights db rt rt_migrator default',
      'restrict_extension_relations db rt rt_migrator default',
      'assert_no_forbidden_rights db rt rt_migrator default',
      'grant_service_tables economic db default',
    ]) {
      const result = spawnSync(
        'bash',
        [
          '-c',
          'source "$1/service-privilege-split.bash" && ' +
            '_svc_split_psql() { printf "SQL\\n"; } && ' +
            `${step}`,
          'grant-list',
          dir,
        ],
        { encoding: 'utf8' },
      );
      const sent = result.stdout.split('\n').filter((line) => line === 'SQL').length;
      if (step.startsWith('grant_service_tables')) {
        // It reads only the allowlist: it goes on, and grants by it.
        assert.equal(result.status, 0, `${step}: ${result.stderr}`);
        continue;
      }
      assert.notEqual(result.status, 0, `${step} accepted a malformed list`);
      assert.match(result.stderr, /runtime-function-grants\.txt: malformed line 2/, step);
      // The default-privilege REVOKE precedes the cleanup and reads no list.
      assert.equal(sent, step.startsWith('restrict_service_functions') ? 1 : 0, step);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each required function maps to the migration that creates it and grants its EXECUTE', () => {
  for (const [service, signature, migration] of requiredRuntimeFunctions) {
    const dir = new URL(`../services/${service}-service/prisma/migrations/`, import.meta.url);
    assert.ok(readdirSync(dir).includes(migration), `${service}: no migration ${migration}`);
    const sql = readFileSync(new URL(`${migration}/migration.sql`, dir), 'utf8');
    const name = signature.slice(signature.indexOf('.') + 1, signature.indexOf('('));
    assert.match(sql, new RegExp(`CREATE (OR REPLACE )?FUNCTION "?${name}"?\\(`), signature);
    assert.match(
      sql,
      new RegExp(`GRANT EXECUTE ON FUNCTION "?${name}"?\\([^)]*\\) TO rasta_${service};`),
      signature,
    );
  }
});

test('a test holds a role to its own required list', () => {
  const sql = findingsSql([['d825e1', 'public.f(text)', '20261016120000_x']]);
  assert.ok(sql.includes("('d825e1', 'public.f(text)')"));
  assert.ok(!sql.includes("('economic',"));
});

test('UTC session defaults: any finding fails, none passes (L7-37)', () => {
  assert.equal(timezoneVerdict({ service: 'fleet' }, []).ok, true);
  const { ok, line } = timezoneVerdict({ service: 'fleet' }, [
    'database rasta_fleet default TimeZone is unset',
  ]);
  assert.equal(ok, false);
  assert.match(line, /fleet: sessions may not start in UTC:\n {4}- database rasta_fleet/);
});

test('the UTC query covers the database, both roles and a per-database override', () => {
  for (const needle of [
    ":'runtime'",
    ":'migrator'",
    'z.setrole = 0',
    'z.setdatabase = 0',
    'overrides TimeZone',
    'does not exist',
  ]) {
    assert.ok(TIMEZONE_FINDINGS_SQL.includes(needle), needle);
  }
});

test('the disposable analytics superuser stays in its two dedicated test tasks', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const privileged = steps.filter((step) => step.env?.TEST_ANALYTICS_ADMIN_URL);
  assert.deepEqual(privileged.map((step) => step.name).sort(), [
    'Analytics coverage gate',
    'Analytics database privilege integration tests',
  ]);
  assert.ok(!steps.some((step) => step.env?.DATABASE_URL_ANALYTICS_TEST_ADMIN));
  assert.ok(!steps.find((step) => step.name === 'Integration tests').env.TEST_ANALYTICS_ADMIN_URL);
});

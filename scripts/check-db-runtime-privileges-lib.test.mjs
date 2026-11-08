import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTABLE_DATABASES_SQL,
  FINDINGS_SQL,
  SAME_DATABASE_SQL,
  databaseConnectionString,
  parseDatabases,
  psqlRows,
  shownDatabase,
  FOREIGN_FINDINGS_SQL,
  FUNCTION_GRANT_LINE,
  TIMEZONE_FINDINGS_SQL,
  allowlistSql,
  classifyServices,
  findingsSql,
  foreignExceptionsSql,
  foreignVerdict,
  grantsModesFromLibrary,
  matrix,
  parseRequiredRuntimeFunctions,
  policyFor,
  requiredRuntimeFunctions,
  runtimeRolesSql,
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

// #540 r1 F1 (D-097): the complete inventory. Every ACL column PostgreSQL 16
// has is modeled, one that is not is a finding nobody can revoke, and the
// classes the review named are judged by built-in privileges, not skipped.
test('every ACL PostgreSQL 16 has is in the inventory, and an unmodeled one fails closed', () => {
  const lib = new URL('../infrastructure/docker/postgres/lib/', import.meta.url);
  const entries = readFileSync(new URL('runtime-acl-entries.sql', lib), 'utf8');
  for (const column of [
    "('pg_database', 'datacl')",
    "('pg_namespace', 'nspacl')",
    "('pg_class', 'relacl')",
    "('pg_attribute', 'attacl')",
    "('pg_proc', 'proacl')",
    "('pg_type', 'typacl')",
    "('pg_language', 'lanacl')",
    "('pg_largeobject_metadata', 'lomacl')",
    "('pg_foreign_data_wrapper', 'fdwacl')",
    "('pg_foreign_server', 'srvacl')",
    "('pg_tablespace', 'spcacl')",
    "('pg_parameter_acl', 'paracl')",
    "('pg_default_acl', 'defaclacl')",
  ]) {
    assert.ok(entries.includes(column), column);
  }
  for (const source of [
    'FROM pg_largeobject_metadata lo',
    'FROM pg_foreign_data_wrapper w',
    'FROM pg_foreign_server s',
    'FROM pg_tablespace ts',
    'FROM pg_parameter_acl pa',
    'FROM pg_language l',
    'FROM pg_type t',
    'FROM pg_default_acl da',
    'LEFT JOIN pg_init_privs i',
    "atttypid = 'aclitem[]'::regtype",
  ]) {
    assert.ok(entries.includes(source), source);
  }
  for (const rule of [
    'the ACL column %s is not modeled (runtime-acl-entries.sql): nothing checks it',
    'beyond the built-in privileges',
    'not to the runtime role itself',
    "('type', ARRAY['USAGE'])",
  ]) {
    assert.ok(FINDINGS_SQL.includes(rule), rule);
  }
  assert.ok(FINDINGS_SQL.includes(entries), 'the check reads the inventory as written');
});

test('role attributes, ownership and membership: REPLICATION, every owned class, every predefined role', () => {
  const lib = new URL('../infrastructure/docker/postgres/lib/', import.meta.url);
  const dangerous = readFileSync(new URL('runtime-dangerous-roles.sql', lib), 'utf8');
  const split = readFileSync(new URL('service-privilege-split.bash', lib), 'utf8');
  for (const fragment of [
    "('REPLICATION', rolreplication)",
    "s.refclassid = 'pg_authid'::regclass AND s.deptype = 'o'",
    "'member of predefined role '",
    "r.rolname LIKE 'pg\\_%'",
    "' is a member of the runtime role'",
    "current_setting('lo_compat_privileges')",
    'which accepts no connections and so cannot be checked',
    'm.oid IN (SELECT d.oid FROM dangerous d)',
  ]) {
    assert.ok(FINDINGS_SQL.includes(fragment), fragment);
  }
  for (const fragment of [
    'r.rolreplication',
    "r.rolname LIKE 'pg\\_%'",
    "s.deptype = 'o'",
    'r.rolname = ANY (RUNTIME_ROLES)',
    "m.rolname = r.rolname || '_migrator'",
  ]) {
    assert.ok(dangerous.includes(fragment), fragment);
  }
  // One split core (_split_database) for both entry points (#540 r2): one reset.
  assert.equal(
    split.match(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION/g)?.length,
    1,
  );
  assert.match(split, /runtime-dangerous-roles\.sql/);
  assert.match(split, /OR am\.roleid = '\$\{runtime\}'::regrole/);
});

// #540 r1 F2 (D-097): the service-role × database matrix.
test('the matrix visits every database that accepts connections, with its own runtime role or none', () => {
  const entries = [
    { database: 'rasta_audit', runtime: 'rasta_audit' },
    { database: 'rasta_economic', runtime: 'rasta_economic' },
  ];
  const records = (...rows) => rows.map(([name, connectable]) => ({ name, connectable }));
  assert.deepEqual(
    matrix(
      entries,
      records(
        ['postgres', true],
        ['rasta_audit', true],
        ['rasta_economic', true],
        ['template0', false],
        ['x', true],
      ),
    ),
    [
      { database: 'postgres', runtime: '' },
      { database: 'rasta_audit', runtime: 'rasta_audit' },
      { database: 'rasta_economic', runtime: 'rasta_economic' },
      { database: 'x', runtime: '' },
    ],
  );
  assert.deepEqual(matrix(entries, records(['rasta_audit', false])), [
    { database: 'rasta_audit', problem: 'accepts no connections, so it cannot be checked' },
    { database: 'rasta_economic', problem: 'does not exist' },
  ]);
  assert.match(CONNECTABLE_DATABASES_SQL, /FROM pg_database/);
  assert.equal(foreignVerdict('rasta_audit', []).ok, true);
  const failed = foreignVerdict('rasta_audit', [
    'rasta_economic can CONNECT to database rasta_audit',
  ]);
  assert.equal(failed.ok, false);
  assert.match(failed.line, /rasta_economic can CONNECT to database rasta_audit/);
});

test('the split and the check read one foreign-access rule set and one runtime-role list', () => {
  const lib = new URL('../infrastructure/docker/postgres/lib/', import.meta.url);
  const split = readFileSync(new URL('service-privilege-split.bash', lib), 'utf8');
  const foreign = readFileSync(new URL('runtime-foreign.sql', lib), 'utf8');
  const services = servicesFromLibrary();
  const roles = runtimeRolesSql(services);
  assert.equal(roles, `ARRAY[${services.map((s) => `'rasta_${s}'`).join(', ')}]::text[]`);
  assert.ok(
    FOREIGN_FINDINGS_SQL.includes(
      foreign.replaceAll('RUNTIME_ROLES', roles).replaceAll('RUNTIME_ROLE', ":'runtime'"),
    ),
  );
  assert.ok(FOREIGN_FINDINGS_SQL.includes(foreignExceptionsSql));
  assert.throws(() => runtimeRolesSql(["x'); DROP"]), /unreadable service name/);
  for (const file of [
    'runtime-foreign.sql',
    'runtime-acl-entries.sql',
    'runtime-foreign-exceptions.sql',
    'runtime-dangerous-roles.sql',
  ]) {
    assert.ok(split.includes(file), file);
  }
  assert.match(
    split,
    /restrict_foreign_access "\$\{db\}" "\$\{runtime\}" "\$\{migrator\}" "\$\{policy\}" \|\| return 1/,
  );
  // Both entry points run that one core: audit under its own policy.
  assert.match(split, /_split_database "\$\{svc\}" "\$\{db\}" migration audit audit \|\| return 1/);
  assert.match(
    split,
    /_split_database "\$\{svc\}" "\$\{db\}" "\$\{mode\}" "\$\{policy\}" public \|\| return 1/,
  );
  assert.match(split, /for svc in "\$\{RASTA_SERVICES\[@\]\}"; do list\+=/);
});

// #540 r1 F1, beyond ACLs: a stored setting is applied at login unchecked.
test('the split and the check read one stored-settings rule, and both splits reset by it', () => {
  const lib = new URL('../infrastructure/docker/postgres/lib/', import.meta.url);
  const split = readFileSync(new URL('service-privilege-split.bash', lib), 'utf8');
  const settings = readFileSync(new URL('runtime-settings.sql', lib), 'utf8');
  assert.ok(FINDINGS_SQL.includes(settings.replaceAll('RUNTIME_ROLE', ":'runtime'")));
  assert.ok(split.includes('runtime-settings.sql'));
  // The one split core both entry points run, right after the membership cleanup.
  assert.equal(
    split.split(
      'revoke_owner_memberships "${db}" "${runtime}" || return 1\n  reset_runtime_settings "${db}" "${runtime}" || return 1',
    ).length,
    2,
  );
  // The allowed parameters: exactly the three the bootstrap stores.
  assert.match(
    settings,
    /NOT IN \('timezone', 'statement_timeout', 'rasta\.disposable_database'\)\s*$/,
  );
});

// Expected: none for a service database (D-097).
test('the foreign-access exceptions: no service database, PUBLIC only, CONNECT or TEMPORARY, a reason each', () => {
  const rows = [
    ...foreignExceptionsSql.matchAll(
      /^\s*\('([^']+)', '([^']+)', '([^']+)', '((?:[^']|'')+)'\),?$/gm,
    ),
  ];
  const declared = foreignExceptionsSql.split('\n').filter((line) => /^\s*\('/.test(line)).length;
  assert.equal(rows.length, declared, 'a row the test cannot read');
  const services = new Set(servicesFromLibrary().map((s) => `rasta_${s}`));
  for (const [, database, privilege, grantee, reason] of rows) {
    assert.ok(!services.has(database) && !database.startsWith('rasta_'), database);
    assert.equal(grantee, 'PUBLIC', database);
    assert.ok(['CONNECT', 'TEMPORARY'].includes(privilege), `${database} ${privilege}`);
    assert.ok(reason.trim().length > 0, `${database}: no reason`);
  }
  // D-100: PostgreSQL's own databases, and the infrastructure ones only while
  // the bootstrap superuser owns them (Keycloak and Temporal connect as it).
  // One with a dedicated owner loses PUBLIC at bootstrap instead.
  const bootstrap = readFileSync(
    new URL('../infrastructure/docker/postgres/00-init-databases.sh', import.meta.url),
    'utf8',
  );
  const infra = /^INFRA_DATABASES=\(([^)]*)\)$/m.exec(bootstrap)?.[1].trim().split(/\s+/);
  assert.deepEqual(infra, ['keycloak', 'temporal', 'temporal_visibility']);
  assert.match(
    bootstrap,
    /for db in "\$\{INFRA_DATABASES\[@\]\}"; do[\s\S]*?CREATE DATABASE \$\{db\} OWNER \$\{POSTGRES_USER\}/,
    'an infrastructure database with an owner of its own: revoke PUBLIC there, not an exception',
  );
  assert.deepEqual([...new Set(rows.map(([, database]) => database))].sort(), [
    'keycloak',
    'postgres',
    'template1',
    'template_postgis',
    'temporal',
    'temporal_visibility',
  ]);
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
      if (/ ON (FUNCTION|ROUTINE) /i.test(flat) || /^GRANT USAGE ON SCHEMA/i.test(flat)) continue;
      // A type's USAGE (#540 r1 F1): the allowlist's `type` rows.
      if ((m = /^GRANT USAGE ON TYPE (\w+) TO (\w+);$/i.exec(flat))) {
        assert.equal(m[2], runtime, flat);
        held.set(`type ${names(m[1])[0]}`, new Set(['USAGE']));
      } else if ((m = /^GRANT ([A-Z, ]+) ON (SEQUENCE |TABLE )?(.+) TO (\w+);$/i.exec(flat))) {
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
        .filter((r) => r.policy === policy && ['relation', 'sequence', 'type'].includes(r.cls))
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
  assert.deepEqual(allowed('audit', 'audit.rfq_receipt_pending'), ['SELECT', 'INSERT', 'DELETE']);
  assert.ok(!rows.some((r) => /audit_event_/.test(r.object) && r.cls === 'relation'));
  assert.deepEqual(
    rows.filter((r) => r.cls === 'type').map((r) => `${r.policy} ${r.object}`),
    ['audit audit.organization_relation_state', 'audit audit.audit_chain_scope'],
  );
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
      assert.ok(/^(text|integer|boolean|public\."[A-Za-z]+")$/.test(type), `${signature}: ${type}`);
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

// #540 r2 R2-2: the database list is structured, and a name is a value.
test('the database list is one JSON array of records; anything else is refused, never guessed at', () => {
  assert.match(
    CONNECTABLE_DATABASES_SQL,
    /jsonb_agg\(jsonb_build_object\('name', datname, 'connectable', datallowconn\)/,
  );
  // The review's spoof: a newline and `|t` inside one name stay one record.
  assert.deepEqual(
    parseDatabases(
      '[{"name": "postgres|t\\npostgres", "connectable": true}, {"name": "x", "connectable": false}]',
    ),
    [
      { name: 'postgres|t\npostgres', connectable: true },
      { name: 'x', connectable: false },
    ],
  );
  assert.deepEqual(parseDatabases('[]'), []);
  for (const [text, pattern] of [
    ['postgres|t', /not JSON/],
    ['{"name": "x", "connectable": true}', /not an array/],
    ['[{"name": "x"}]', /unreadable database record/],
    ['[{"name": "x", "connectable": "t"}]', /unreadable database record/],
    ['[{"name": 7, "connectable": true}]', /unreadable database record/],
    ['[{"name": "x", "connectable": true, "extra": 1}]', /unreadable database record/],
    ['[null]', /unreadable database record/],
    ['["x|t"]', /unreadable database record/],
    ['[{"name": "", "connectable": true}]', /unsupported database name/],
    ['[{"name": "a\\u0000b", "connectable": true}]', /unsupported database name/],
    [`[{"name": "${'é'.repeat(32)}", "connectable": true}]`, /unsupported database name/],
    ['[{"name": "x", "connectable": true}, {"name": "x", "connectable": false}]', /listed twice/],
  ]) {
    assert.throws(() => parseDatabases(text), pattern, text);
  }
  // 63 bytes is PostgreSQL's longest name, and is accepted.
  assert.equal(parseDatabases(`[{"name": "${'a'.repeat(63)}", "connectable": true}]`).length, 1);
});

test('a database name reaches libpq as a quoted literal, and the session must be in it', () => {
  assert.equal(databaseConnectionString('rasta_audit'), "dbname='rasta_audit'");
  assert.equal(databaseConnectionString('dbname=postgres'), "dbname='dbname=postgres'");
  assert.equal(
    databaseConnectionString('postgresql://h/postgres'),
    "dbname='postgresql://h/postgres'",
  );
  assert.equal(databaseConnectionString("it's \\ x"), "dbname='it\\'s \\\\ x'");
  // What psql is given: the quoted name as -d, the expected name as a
  // variable, and the identity check ahead of the query.
  let seen;
  const fake = (command, args, options) => {
    seen = { command, args, options };
    return { status: 0, stdout: 'a\n\nb\n', stderr: '' };
  };
  assert.deepEqual(psqlRows('dbname=postgres', 'SELECT 1;', { runtime: 'r' }, fake), ['a', 'b']);
  assert.equal(seen.command, 'psql');
  assert.equal(seen.args.at(-2), '-d');
  assert.equal(seen.args.at(-1), "dbname='dbname=postgres'");
  assert.ok(seen.args.includes('expected_database=dbname=postgres'));
  assert.ok(seen.args.includes('runtime=r'));
  assert.ok(seen.options.input.startsWith(SAME_DATABASE_SQL));
  assert.ok(seen.options.input.endsWith('SELECT 1;'));
  assert.match(
    SAME_DATABASE_SQL,
    /current_database\(\) <> current_setting\('rasta\.expected_database'\)/,
  );
  assert.match(SAME_DATABASE_SQL, /RAISE EXCEPTION/);
  assert.throws(
    () => psqlRows('x\ny', 'SELECT 1;', {}, () => ({ status: 3, stdout: '', stderr: 'boom' })),
    /^Error: "x\\ny": the catalogue query failed\nboom/,
  );
  // A report line names an odd database as a JSON string: no forged lines.
  assert.equal(shownDatabase('rasta_audit'), 'rasta_audit');
  assert.equal(shownDatabase('postgres|t\nok   x'), '"postgres|t\\nok   x"');
  assert.doesNotMatch(foreignVerdict('a\nok   b', []).line, /\n/);
  // The check itself connects only through psqlRows.
  const cli = readFileSync(new URL('./check-db-runtime-privileges.mjs', import.meta.url), 'utf8');
  assert.match(cli, /psqlRows as rows/);
  assert.doesNotMatch(cli, /spawnSync|'-d'/);
  assert.match(cli, /parseDatabases\(rows\('postgres', CONNECTABLE_DATABASES_SQL/);
});

// #540 r2 R2-3: a stored setting is named by parameter and scope, never value.
test('the stored-settings rule never selects a value, so neither the check nor the split can print one', () => {
  const settings = readFileSync(
    new URL('../infrastructure/docker/postgres/lib/runtime-settings.sql', import.meta.url),
    'utf8',
  );
  const body = settings.replace(/--[^\n]*/g, '');
  assert.match(
    body,
    /format\('a stored setting reaches its sessions: %s \(%s\)', s\.name, s\.scope\) AS label/,
  );
  // cfg (name=value) is read only through split_part(cfg, '=', 1).
  assert.equal(body.match(/\bcfg\b/g).length, body.match(/split_part\(cfg, '=', 1\)/g).length + 1);
  assert.match(body, /unnest\(st\.setconfig\) cfg/);
});

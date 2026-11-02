import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  FINDINGS_SQL,
  TIMEZONE_FINDINGS_SQL,
  classifyServices,
  findingsSql,
  parseRequiredRuntimeFunctions,
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
    "ARRAY['CREATE', 'TEMPORARY'], '%s on database %s'",
    "ARRAY['CREATE'], '%s on schema %s'",
    "ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'], '%s on %s'",
    "ARRAY['UPDATE'], '%s on sequence %s'",
    "c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')",
    'pg_default_acl',
    '_prisma_migrations',
    "pg_has_role(me.oid, t.relowner, 'MEMBER')",
    "pg_has_role(me.oid, m.oid, 'MEMBER')",
    "'member of '",
  ]) {
    assert.ok(FINDINGS_SQL.includes(fragment), fragment);
  }
  assert.match(FINDINGS_SQL, /rolname = :'runtime'/);
});

// #421 r1 F3: one rule set. The split revokes by the very file the check
// reports from, and keeps no privilege list of its own.
test('the split and the check read one forbidden-rights file', () => {
  const lib = new URL('../infrastructure/docker/postgres/lib/', import.meta.url);
  const rules = readFileSync(new URL('runtime-forbidden.sql', lib), 'utf8');
  const split = readFileSync(new URL('service-privilege-split.bash', lib), 'utf8');
  assert.ok(
    FINDINGS_SQL.includes(rules.replaceAll('MIGRATOR_ROLE', "(:'runtime' || '_migrator')")),
  );
  assert.match(split, /runtime-forbidden\.sql/);
  const cleanup = split.slice(
    split.indexOf('_restrict_reachable_acl() {'),
    split.indexOf('restrict_extension_relations() {'),
  );
  for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'TEMPORARY', 'USAGE']) {
    assert.ok(!cleanup.includes(`'${privilege}'`), `the split names ${privilege} itself`);
  }
  assert.ok(!/relkind|pg_proc|pg_class/.test(cleanup), 'the split selects objects itself');
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

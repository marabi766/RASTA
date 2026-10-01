// -----------------------------------------------------------------------------
// The D-045 runtime-role check, and the generic split it checks, on a real
// cluster.
//
//   pnpm test:db-runtime-privileges      (a PostgreSQL superuser in PG* env)
//
// A throwaway database is built the way main leaves an unsplit service: owned
// by its runtime role, which created a table with an integrity trigger and a
// row. The check must report everything that role can do it must not. Then
// lib/service-privilege-split.bash runs — the upgrade the runbook describes —
// and the check must report nothing, the row must still be there and writable,
// and DISABLE TRIGGER must be refused. A table the migrator creates afterwards
// must reach the runtime role as DML by default privileges, and the migration
// ledger only until scripts/prisma-lib.mjs's revoke runs. The split runs a
// second time to prove it is idempotent.
//
// The roles are throwaway too (`rasta_d045t<pid>` and its migrator), so the
// test never touches a real service's roles. Needs `psql` and a superuser:
// PGHOST, PGPORT, PGUSER, PGPASSWORD.
// -----------------------------------------------------------------------------
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINDINGS_SQL } from './check-db-runtime-privileges-lib.mjs';
import { ledgerRevoke } from './prisma-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPLIT = join(ROOT, 'infrastructure/docker/postgres/lib/service-privilege-split.bash');

const SERVICE = `d045t${process.pid}`;
const DB = `rasta_${SERVICE}`;
const RUNTIME = `rasta_${SERVICE}`;
const MIGRATOR = `${RUNTIME}_migrator`;
const PASSWORD = {
  [RUNTIME]: `rt_${randomBytes(12).toString('hex')}`,
  [MIGRATOR]: `mg_${randomBytes(12).toString('hex')}`,
};

/** psql as `role` (the superuser when omitted), SQL on stdin. */
function psql(sql, { role, database = DB, variables = {} } = {}) {
  const env = { ...process.env };
  if (role) {
    env.PGUSER = role;
    env.PGPASSWORD = PASSWORD[role];
  }
  const vars = Object.entries(variables).flatMap(([k, v]) => ['-v', `${k}=${v}`]);
  return spawnSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', ...vars, '-d', database], {
    env,
    input: sql,
    encoding: 'utf8',
  });
}

function ok(sql, options) {
  const result = psql(sql, options);
  assert.equal(result.status, 0, `${sql}\n${result.stderr}`);
  return result.stdout.trim();
}

const findings = () =>
  ok(FINDINGS_SQL, { variables: { runtime: RUNTIME } })
    .split('\n')
    .filter(Boolean);

function split() {
  const script =
    `source "${SPLIT}"; declare -gA ROLE_PASSWORDS=([${MIGRATOR}]=${PASSWORD[MIGRATOR]}); ` +
    `split_service_privileges ${SERVICE} ${DB} default`;
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, POSTGRES_USER: process.env.PGUSER },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

before(() => {
  assert.ok(process.env.PGUSER, 'PGUSER must name a superuser');
  ok(`CREATE ROLE ${RUNTIME} LOGIN CREATEDB PASSWORD '${PASSWORD[RUNTIME]}'`, {
    database: 'postgres',
  });
  ok(`CREATE DATABASE ${DB} OWNER ${RUNTIME}`, { database: 'postgres' });
  // As main leaves an unsplit service: the runtime role made everything.
  ok(
    `CREATE TABLE guarded (id integer PRIMARY KEY, frozen boolean NOT NULL DEFAULT false);
     CREATE FUNCTION refuse_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF OLD.frozen THEN RAISE EXCEPTION 'frozen'; END IF; RETURN NEW; END $$;
     CREATE TRIGGER tg_guarded BEFORE UPDATE ON guarded FOR EACH ROW EXECUTE FUNCTION refuse_frozen();
     CREATE SEQUENCE guarded_seq;
     INSERT INTO guarded VALUES (1, true), (2, false);`,
    { role: RUNTIME },
  );
});

after(() => {
  psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, { database: 'postgres' });
  for (const role of [RUNTIME, MIGRATOR])
    psql(`DROP ROLE IF EXISTS ${role}`, { database: 'postgres' });
});

test('an unsplit runtime role: the check reports every right it must not hold', () => {
  const found = findings();
  for (const expected of [
    'is CREATEDB',
    `owns database ${DB}`,
    `CREATE on database ${DB}`,
    'owns table public.guarded',
    'owns sequence public.guarded_seq',
    'owns function refuse_frozen()',
    'TRUNCATE on public.guarded',
    'TRIGGER on public.guarded',
    'REFERENCES on public.guarded',
  ]) {
    assert.ok(found.includes(expected), `missing "${expected}" in:\n${found.join('\n')}`);
  }
  // …and, owning the table, it really can lift the guard.
  ok('BEGIN; ALTER TABLE guarded DISABLE TRIGGER tg_guarded; ROLLBACK;', { role: RUNTIME });
});

test('after the split: nothing to report, the data intact and writable, the guard out of reach', () => {
  split();
  assert.deepEqual(findings(), []);
  assert.equal(ok('SELECT count(*) FROM guarded', { role: RUNTIME }), '2');
  ok('UPDATE guarded SET id = id WHERE id = 2', { role: RUNTIME });
  ok("SELECT nextval('guarded_seq')", { role: RUNTIME });
  // The trigger still binds the runtime role (EXECUTE is checked at CREATE TRIGGER).
  assert.match(psql('UPDATE guarded SET id = id WHERE id = 1', { role: RUNTIME }).stderr, /frozen/);
  for (const sql of [
    'ALTER TABLE guarded DISABLE TRIGGER tg_guarded',
    'DROP TRIGGER tg_guarded ON guarded',
    'ALTER TABLE guarded ADD COLUMN probe integer',
    'DROP TABLE guarded',
    'TRUNCATE guarded',
    'CREATE TABLE probe (id integer)',
  ]) {
    const result = psql(sql, { role: RUNTIME });
    assert.notEqual(result.status, 0, `the runtime role was allowed: ${sql}`);
    assert.match(result.stderr, /must be owner|permission denied/, sql);
  }
  // The split is idempotent.
  split();
  assert.deepEqual(findings(), []);
});

test('a table the migrator creates later reaches the runtime role as DML; its migration ledger only until the revoke', () => {
  ok(
    `CREATE TABLE later (id integer);
     CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY);`,
    { role: MIGRATOR },
  );
  assert.equal(
    ok(
      `SELECT has_table_privilege('${RUNTIME}', 'later', 'SELECT, INSERT, UPDATE, DELETE')
          AND NOT has_table_privilege('${RUNTIME}', 'later', 'TRUNCATE')`,
    ),
    't',
  );
  // Default privileges cover the ledger too — which is why scripts/prisma.mjs
  // revokes it after every migration run.
  assert.deepEqual(findings(), ['a right on public._prisma_migrations']);
  const revoke = ledgerRevoke({
    migratorUrl: `postgresql://${MIGRATOR}:x@h/${DB}?schema=public`,
    runtimeUrl: `postgresql://${RUNTIME}:x@h/${DB}?schema=public`,
  });
  ok(revoke, { role: MIGRATOR });
  assert.deepEqual(findings(), []);
});

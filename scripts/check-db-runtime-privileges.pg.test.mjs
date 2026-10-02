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
// must reach the runtime role as DML by default privileges. The migration
// ledger is the split's own (Codex review of #176): created before any
// migration, the migrator's, granted to no one — and a real `prisma migrate
// deploy` that fails half-way leaves it so, with no help from
// scripts/prisma.mjs's revoke. The pre-created ledger is Prisma's shape, column
// for column. The split runs a second time to prove it is idempotent.
//
// The roles are throwaway too (`rasta_d045t<pid>` and its migrator), so the
// test never touches a real service's roles. Needs `psql` and a superuser:
// PGHOST, PGPORT, PGUSER, PGPASSWORD.
// -----------------------------------------------------------------------------
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { FINDINGS_SQL } from './check-db-runtime-privileges-lib.mjs';
import { ledgerRevoke } from './prisma-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPLIT = join(ROOT, 'infrastructure/docker/postgres/lib/service-privilege-split.bash');
// The services' own startup check, exactly as built (`pnpm build` first).
const { CONNECTED_ROLE_SQL, connectedRoleProblems } = createRequire(import.meta.url)(
  join(ROOT, 'packages', 'nest-common', 'dist', 'index.js'),
);
// Any service's Prisma CLI: the version every service migrates with.
const PRISMA = join(ROOT, 'services/construction-service/node_modules/.bin/prisma');

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

const LEDGER_RIGHTS = `SELECT has_table_privilege('${RUNTIME}', 'public._prisma_migrations',
                                 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                         OR has_any_column_privilege('${RUNTIME}', 'public._prisma_migrations',
                                 'SELECT, INSERT, UPDATE, REFERENCES')`;

test('the split creates the migration ledger itself: the migrator owns it, the runtime role holds nothing on it', () => {
  assert.equal(
    ok(
      `SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public._prisma_migrations'::regclass`,
    ),
    MIGRATOR,
  );
  assert.equal(ok(LEDGER_RIGHTS), 'f');
  const write = psql(
    `INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES ('x', 'x', 'x')`,
    { role: RUNTIME },
  );
  assert.match(write.stderr, /permission denied/);
});

test('a table the migrator creates later reaches the runtime role as DML', () => {
  ok('CREATE TABLE later (id integer)', { role: MIGRATOR });
  assert.equal(
    ok(
      `SELECT has_table_privilege('${RUNTIME}', 'later', 'SELECT, INSERT, UPDATE, DELETE')
          AND NOT has_table_privilege('${RUNTIME}', 'later', 'TRUNCATE')`,
    ),
    't',
  );
  assert.deepEqual(findings(), []);
});

/** A Prisma project in a temporary directory: `migrations` maps name → SQL. */
function prismaProject(migrations) {
  const dir = mkdtempSync(join(tmpdir(), 'd045-prisma-'));
  writeFileSync(
    join(dir, 'schema.prisma'),
    'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
  );
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
  for (const [name, sql] of Object.entries(migrations)) {
    mkdirSync(join(dir, 'migrations', name));
    writeFileSync(join(dir, 'migrations', name, 'migration.sql'), sql);
  }
  return dir;
}

/** `prisma migrate deploy` as the migrator, straight — not through scripts/prisma.mjs. */
function deployAsMigrator(dir, schema = 'public') {
  const host = process.env.PGHOST ?? '127.0.0.1';
  const port = process.env.PGPORT ?? '5432';
  return spawnSync(PRISMA, ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')], {
    cwd: dir,
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://${MIGRATOR}:${PASSWORD[MIGRATOR]}@${host}:${port}/${DB}?schema=${schema}`,
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    },
    encoding: 'utf8',
  });
}

test('a migration that fails half-way leaves the runtime role no right on the ledger — no revoke needed', () => {
  const dir = prismaProject({
    '20260101000000_applies': 'CREATE TABLE "made_by_migration" (id integer);',
    '20260101000001_fails': 'CREATE TABLE "half_done" (id integer);\nSELECT 1 / 0;',
  });
  try {
    const run = deployAsMigrator(dir);
    assert.notEqual(run.status, 0, 'the second migration was meant to fail');
    assert.match(run.stdout + run.stderr, /20260101000001_fails/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Prisma adopted the pre-created ledger: the first migration is recorded as
  // finished, the second as started and never finished.
  assert.equal(
    ok(
      `SELECT string_agg(migration_name || ':' || (finished_at IS NOT NULL), ',' ORDER BY migration_name)
         FROM _prisma_migrations`,
    ),
    '20260101000000_applies:true,20260101000001_fails:false',
  );
  // …and the runtime role still holds nothing on it, so it cannot mark the
  // failed migration applied (or rewrite any other row).
  assert.equal(ok(LEDGER_RIGHTS), 'f');
  const forge = psql(
    `UPDATE _prisma_migrations SET finished_at = now(), logs = NULL WHERE finished_at IS NULL`,
    { role: RUNTIME },
  );
  assert.match(forge.stderr, /permission denied/);
  assert.deepEqual(findings(), []);
  // The migration's own table reached the runtime role as DML, as any would.
  assert.equal(
    ok(`SELECT has_table_privilege('${RUNTIME}', 'made_by_migration', 'SELECT, INSERT')`),
    't',
  );
});

test('the pre-created ledger is the one Prisma would have made, column for column', () => {
  const dir = prismaProject({ '20260101000000_applies': 'SELECT 1;' });
  try {
    const run = deployAsMigrator(dir, 'prisma_made');
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const shape = (schema) =>
    ok(
      `SELECT string_agg(concat_ws(' ', column_name, data_type, character_maximum_length,
                                    is_nullable, column_default), E'\n' ORDER BY ordinal_position)
         FROM information_schema.columns
        WHERE table_schema = '${schema}' AND table_name = '_prisma_migrations';
       SELECT string_agg(a.attname, ',') FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indisprimary AND i.indrelid = '"${schema}"."_prisma_migrations"'::regclass;`,
    );
  assert.notEqual(shape('prisma_made'), '');
  assert.equal(shape('public'), shape('prisma_made'));
});

test('belt and braces: a ledger Prisma re-creates (a reset) inherits DML, and the revoke in scripts/prisma.mjs takes it back', () => {
  ok(
    `DROP TABLE _prisma_migrations;
     CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY);`,
    { role: MIGRATOR },
  );
  assert.deepEqual(findings(), ['a right on public._prisma_migrations']);
  const revoke = ledgerRevoke({
    migratorUrl: `postgresql://${MIGRATOR}:x@h/${DB}?schema=public`,
    runtimeUrl: `postgresql://${RUNTIME}:x@h/${DB}?schema=public`,
  });
  ok(revoke, { role: MIGRATOR });
  assert.deepEqual(findings(), []);
});

/** What the services' startup check (@rasta/nest-common assertRuntimeRole) says, connected as the runtime role. */
function startupProblems() {
  const json = ok(`SELECT row_to_json(f) FROM (${CONNECTED_ROLE_SQL}) f`, { role: RUNTIME });
  return connectedRoleProblems(JSON.parse(json));
}

const asRuntime = (sql) => psql(sql, { role: RUNTIME });

test('a runtime role granted its migrator WITH INHERIT FALSE, SET TRUE is caught by both checks and its membership revoked by the split (Codex round 3)', () => {
  assert.deepEqual(startupProblems(), []);
  ok(`GRANT ${MIGRATOR} TO ${RUNTIME} WITH INHERIT FALSE, SET TRUE`);
  // The shape inherits nothing — yet SET ROLE makes it the owner, and the guard comes off.
  assert.equal(
    ok(`SELECT pg_has_role('${RUNTIME}', '${MIGRATOR}', 'USAGE')`),
    'f',
    'a USAGE-based check would see nothing',
  );
  const lifted = asRuntime(
    `BEGIN; SET ROLE ${MIGRATOR}; ALTER TABLE guarded DISABLE TRIGGER tg_guarded; ROLLBACK;`,
  );
  assert.equal(
    lifted.status,
    0,
    `the grant shape no longer reproduces the hole:\n${lifted.stderr}`,
  );

  assert.ok(
    findings().some((finding) => finding.startsWith(`member of ${MIGRATOR}`)),
    findings().join('\n'),
  );
  assert.ok(
    startupProblems().some((problem) => problem.startsWith(`is a member of ${MIGRATOR}`)),
    startupProblems().join('\n'),
  );

  split();
  assert.equal(
    ok(`SELECT count(*) FROM pg_auth_members WHERE member = '${RUNTIME}'::regrole`),
    '0',
  );
  assert.match(asRuntime(`SET ROLE ${MIGRATOR}`).stderr, /permission denied/);
  assert.deepEqual(findings(), []);
  assert.deepEqual(startupProblems(), []);
});

test("…and through an intermediate role too: the split revokes the runtime role's way in", () => {
  const via = `${RUNTIME}_via`;
  try {
    ok(
      `CREATE ROLE ${via} NOLOGIN; GRANT ${MIGRATOR} TO ${via}; GRANT ${via} TO ${RUNTIME} WITH INHERIT FALSE`,
    );
    assert.ok(findings().some((finding) => finding.startsWith(`member of ${MIGRATOR}`)));
    assert.ok(
      startupProblems().some((problem) => problem.startsWith(`is a member of ${MIGRATOR}`)),
    );
    split();
    assert.deepEqual(findings(), []);
    assert.deepEqual(startupProblems(), []);
  } finally {
    psql(`DROP ROLE IF EXISTS ${via}`, { database: 'postgres' });
  }
});

/** A TCP login as `role` with `password`, as the split's own verification makes it. */
function logsIn(role, password) {
  return (
    spawnSync('psql', ['-X', '-q', '-tA', '-d', DB, '-c', 'SELECT 1'], {
      env: {
        ...process.env,
        PGHOST: process.env.PGHOST?.startsWith('/')
          ? '127.0.0.1'
          : (process.env.PGHOST ?? '127.0.0.1'),
        PGUSER: role,
        PGPASSWORD: password,
      },
      encoding: 'utf8',
    }).status === 0
  );
}

test('a standalone split rotates the runtime password to the supplied one and proves both logins; the old one stops working (Codex round 3)', () => {
  const stale = PASSWORD[RUNTIME];
  const fresh = `rt2_${randomBytes(12).toString('hex')}`;
  assert.ok(logsIn(RUNTIME, stale), 'the runtime role should still have its original password');
  const script =
    `source "${SPLIT}"; ` +
    `declare -gA ROLE_PASSWORDS=([${RUNTIME}]=${fresh} [${MIGRATOR}]=${PASSWORD[MIGRATOR]}); ` +
    `rotate_and_verify_split_logins ${SERVICE} ${DB}`;
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, POSTGRES_USER: process.env.PGUSER },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(logsIn(RUNTIME, fresh), 'the supplied runtime password does not log in');
  assert.ok(!logsIn(RUNTIME, stale), 'the old runtime password still logs in');
  assert.ok(logsIn(MIGRATOR, PASSWORD[MIGRATOR]));
  PASSWORD[RUNTIME] = fresh;

  // A supplied credential that does not work fails the run, naming the role only.
  const wrong = spawnSync(
    'bash',
    [
      '-c',
      `source "${SPLIT}"; ` +
        `declare -gA ROLE_PASSWORDS=([${RUNTIME}]=${fresh} [${MIGRATOR}]=not_the_migrators_password_x); ` +
        `rotate_and_verify_split_logins ${SERVICE} ${DB}`,
    ],
    { env: { ...process.env, POSTGRES_USER: process.env.PGUSER }, encoding: 'utf8' },
  );
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, new RegExp(`${MIGRATOR} cannot log in`));
  assert.ok(!wrong.stderr.includes('not_the_migrators_password_x'));
});

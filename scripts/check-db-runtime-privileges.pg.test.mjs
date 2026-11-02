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
// Last, a legacy cluster (Codex round 4 on #176): a service database and an
// audit database in the worst realistic pre-split state — `public` owned by
// the superuser (a PostgreSQL 14 upgrade), the runtime role owning everything
// else and a member of its migrator WITH SET, both roles sharing one password
// — go through the standalone upgrade exactly as an operator runs it, and
// every invariant must hold afterwards.
//
// The roles are throwaway too (`rasta_d045t<pid>` and its migrator, the
// legacy fixture's `rasta_d045l<pid>` and `rasta_d045a<pid>` pairs, and every
// later fixture's `rasta_d…<pid>` pair — the economic and procurement repair
// included, whose migrations are applied with their runtime role renamed), so
// the test never touches a real service's roles, and checks that it did not.
// Needs `psql` and a superuser: PGHOST, PGPORT, PGUSER, PGPASSWORD.
// -----------------------------------------------------------------------------
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  classifyServices,
  FINDINGS_SQL,
  findingsSql,
  requiredRuntimeFunctions,
} from './check-db-runtime-privileges-lib.mjs';
import { ledgerRevoke } from './prisma-lib.mjs';
import { eligibilityClockSql } from '../packages/testing/src/eligibility-clock.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPLIT = join(ROOT, 'infrastructure/docker/postgres/lib/service-privilege-split.bash');
const ROLE_PASSWORDS = join(ROOT, 'infrastructure/docker/postgres/lib/role-passwords.bash');
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

// ---------------------------------------------------------------------------
// A legacy cluster, the worst realistic pre-split state, through the
// standalone upgrade (Codex round 4 on #176)
// ---------------------------------------------------------------------------

const LEGACY = [
  { kind: 'service', service: `d045l${process.pid}`, mode: 'default' },
  { kind: 'audit', service: `d045a${process.pid}`, mode: 'audit' },
].map((fixture) => ({
  ...fixture,
  db: `rasta_${fixture.service}`,
  runtime: `rasta_${fixture.service}`,
  migrator: `rasta_${fixture.service}_migrator`,
  variable: `POSTGRES_PASSWORD_${fixture.service.toUpperCase()}`,
  // What the operator supplies: distinct, as resolve_role_passwords demands.
  supplied: {
    runtime: `lrt_${randomBytes(12).toString('hex')}`,
    migrator: `lmg_${randomBytes(12).toString('hex')}`,
  },
}));
// The one password both roles of each pair share before the upgrade.
const SHARED = `shared_${randomBytes(12).toString('hex')}`;

function legacyFindings({ db, runtime }) {
  return ok(FINDINGS_SQL, { database: db, variables: { runtime } }).split('\n').filter(Boolean);
}

function legacyStartupProblems({ db, runtime }) {
  const json = ok(`SELECT row_to_json(f) FROM (${CONNECTED_ROLE_SQL}) f`, {
    role: runtime,
    database: db,
  });
  return connectedRoleProblems(JSON.parse(json));
}

/** `bash service-privilege-split.bash <svc>` as an operator runs it, for a throwaway pair. */
function upgrade({ service, db, mode, variable }, passwords) {
  const env = { ...process.env, POSTGRES_USER: process.env.PGUSER };
  delete env.RASTA_DB_BOOTSTRAP; // a real cluster: no development fallback
  env[variable] = passwords.runtime;
  env[`${variable}_MIGRATOR`] = passwords.migrator;
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail; source "${ROLE_PASSWORDS}"; source "${SPLIT}"; ` +
        `upgrade_service_split ${service} ${db} ${mode}`,
    ],
    { env, encoding: 'utf8' },
  );
}

function legacyLogsIn(role, password, database) {
  return (
    spawnSync('psql', ['-X', '-q', '-tA', '-d', database, '-c', 'SELECT 1'], {
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

after(() => {
  for (const { db, runtime, migrator } of LEGACY) {
    psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, { database: 'postgres' });
    for (const role of [runtime, migrator])
      psql(`DROP ROLE IF EXISTS ${role}`, { database: 'postgres' });
  }
});

test('a legacy cluster — public owned by the superuser, the runtime role owning everything and a member of its migrator WITH SET, one shared password, audit included — leaves the upgrade with every invariant true (Codex round 4)', () => {
  const [service, audit] = LEGACY;
  for (const { db, runtime, migrator } of LEGACY) {
    PASSWORD[runtime] = SHARED;
    PASSWORD[migrator] = SHARED;
    // As the bootstrap before D-045 made them — and with one password between them.
    ok(
      `CREATE ROLE ${runtime} LOGIN CREATEDB PASSWORD '${SHARED}';
       CREATE ROLE ${migrator} LOGIN CREATEDB PASSWORD '${SHARED}';
       GRANT ${migrator} TO ${runtime} WITH INHERIT FALSE, SET TRUE;`,
      { database: 'postgres' },
    );
    ok(`CREATE DATABASE ${db} OWNER ${runtime}`, { database: 'postgres' });
    ok(`GRANT ALL PRIVILEGES ON DATABASE ${db} TO ${runtime}`, { database: 'postgres' });
    // A cluster upgraded from PostgreSQL 14: `public` is the superuser's, open to all.
    ok(
      `ALTER SCHEMA public OWNER TO CURRENT_USER;
       GRANT ALL ON SCHEMA public TO PUBLIC;
       GRANT ALL ON SCHEMA public TO ${runtime};`,
      { database: db },
    );
  }

  // The service database: the runtime role made everything, the ledger included.
  ok(
    `CREATE TYPE stage AS ENUM ('open', 'frozen');
     CREATE TABLE guarded (id integer PRIMARY KEY, frozen boolean NOT NULL DEFAULT false, s stage);
     CREATE FUNCTION refuse_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF OLD.frozen THEN RAISE EXCEPTION 'frozen'; END IF; RETURN NEW; END $$;
     CREATE TRIGGER tg_guarded BEFORE UPDATE ON guarded FOR EACH ROW EXECUTE FUNCTION refuse_frozen();
     CREATE SEQUENCE guarded_seq;
     INSERT INTO guarded VALUES (1, true, 'frozen'), (2, false, 'open');
     CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY, migration_name varchar(255) NOT NULL);
     INSERT INTO _prisma_migrations VALUES ('m1', '20250101000000_init');`,
    { role: service.runtime, database: service.db },
  );
  // The audit database as ADR-053 left it — schema `audit` and its table the
  // migrator's, INSERT and SELECT for the runtime role — plus what the runtime
  // role, owning the database, made in `public`.
  ok(
    `CREATE SCHEMA audit AUTHORIZATION ${audit.migrator};
     GRANT USAGE ON SCHEMA audit TO ${audit.runtime};`,
    { database: audit.db },
  );
  ok(
    `CREATE TABLE audit.audit_event (id integer PRIMARY KEY, payload text NOT NULL);
     GRANT SELECT, INSERT ON audit.audit_event TO ${audit.runtime};
     CREATE TABLE audit._prisma_migrations (id varchar(36) PRIMARY KEY, migration_name varchar(255) NOT NULL);
     INSERT INTO audit._prisma_migrations VALUES ('a1', '20250101000000_audit');`,
    { role: audit.migrator, database: audit.db },
  );
  ok(
    `INSERT INTO audit.audit_event VALUES (1, 'before the upgrade');
     CREATE TABLE stray (id integer);`,
    { role: audit.runtime, database: audit.db },
  );

  // Before: both checks see the hole, and the runtime role really can take the owner's place.
  for (const fixture of LEGACY) {
    assert.ok(legacyFindings(fixture).length > 0);
    assert.ok(
      legacyStartupProblems(fixture).some((p) =>
        p.startsWith(`is a member of ${fixture.migrator}`),
      ),
    );
    assert.ok(
      legacyLogsIn(fixture.migrator, SHARED, fixture.db),
      "the shared password is the owner's",
    );
  }
  assert.equal(
    ok(`SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'`, {
      database: service.db,
    }),
    process.env.PGUSER,
  );

  // The operator cannot carry the shared password over: supplied equal, nothing runs.
  const same = upgrade(service, { runtime: SHARED, migrator: SHARED });
  assert.equal(same.status, 1);
  assert.match(same.stderr, new RegExp(`${service.variable}_MIGRATOR equals ${service.variable}`));
  assert.ok(!same.stderr.includes(SHARED));
  assert.equal(
    ok(`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${service.db}'`, {
      database: 'postgres',
    }),
    service.runtime,
    'a refused run changed the cluster',
  );

  // The upgrade, then once more: it converges.
  for (const run of [1, 2]) {
    for (const fixture of LEGACY) {
      const result = upgrade(fixture, fixture.supplied);
      assert.equal(
        result.status,
        0,
        `${fixture.kind}, run ${run}:\n${result.stdout}${result.stderr}`,
      );
      PASSWORD[fixture.runtime] = fixture.supplied.runtime;
      PASSWORD[fixture.migrator] = fixture.supplied.migrator;
    }
  }

  for (const fixture of LEGACY) {
    const { kind, db, runtime, migrator, supplied } = fixture;
    const as = (role, sql) => psql(sql, { role, database: db });
    const owners = ok(
      `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database();
       SELECT string_agg(nspname || '=' || pg_get_userbyid(nspowner), ',' ORDER BY nspname)
         FROM pg_namespace WHERE nspname IN ('public', 'audit');`,
      { database: db },
    ).split('\n');
    assert.equal(owners[0], migrator, `${kind}: the database`);
    assert.equal(
      owners[1],
      kind === 'audit' ? `audit=${migrator},public=${migrator}` : `public=${migrator}`,
      `${kind}: the schemas`,
    );

    // Neither check finds anything; the service would start.
    assert.deepEqual(legacyFindings(fixture), [], kind);
    assert.deepEqual(legacyStartupProblems(fixture), [], kind);

    // No membership left, and SET ROLE to the owner is refused.
    assert.equal(
      ok(`SELECT count(*) FROM pg_auth_members WHERE member = '${runtime}'::regrole`, {
        database: 'postgres',
      }),
      '0',
    );
    assert.match(as(runtime, `SET ROLE ${migrator}`).stderr, /permission denied/);

    // The credentials: the supplied ones work, the shared one works for neither role.
    assert.ok(legacyLogsIn(runtime, supplied.runtime, db), `${kind}: runtime, supplied`);
    assert.ok(legacyLogsIn(migrator, supplied.migrator, db), `${kind}: migrator, supplied`);
    assert.ok(
      !legacyLogsIn(runtime, SHARED, db),
      `${kind}: the shared password still logs in as ${runtime}`,
    );
    assert.ok(
      !legacyLogsIn(migrator, SHARED, db),
      `${kind}: the shared password still logs in as ${migrator}`,
    );

    // The ledger kept its history, is the migrator's, and grants the runtime role nothing.
    const schema = kind === 'audit' ? 'audit' : 'public';
    assert.equal(
      ok(
        `SELECT pg_get_userbyid(relowner) || ':' || (SELECT count(*) FROM "${schema}"._prisma_migrations)
           FROM pg_class WHERE oid = '"${schema}"._prisma_migrations'::regclass`,
        { database: db },
      ),
      `${migrator}:1`,
    );
    assert.match(
      as(runtime, `SELECT * FROM "${schema}"._prisma_migrations`).stderr,
      /permission denied/,
    );

    // The migrator can migrate: CREATE in its schema, as `public` now is its own.
    ok(`BEGIN; CREATE TABLE "${schema}".probe_after_upgrade (id integer); ROLLBACK;`, {
      role: migrator,
      database: db,
    });
    // The runtime role cannot create, anywhere.
    assert.match(as(runtime, 'CREATE TABLE public.probe (id integer)').stderr, /permission denied/);
  }

  // The service's data survived and is writable; its guard is out of reach.
  const asServiceRuntime = (sql) => psql(sql, { role: service.runtime, database: service.db });
  assert.equal(
    ok('SELECT count(*) FROM guarded', { role: service.runtime, database: service.db }),
    '2',
  );
  ok("UPDATE guarded SET s = 'open' WHERE id = 2; SELECT nextval('guarded_seq')", {
    role: service.runtime,
    database: service.db,
  });
  assert.match(asServiceRuntime("UPDATE guarded SET s = 'open' WHERE id = 1").stderr, /frozen/);
  for (const sql of [
    'ALTER TABLE guarded DISABLE TRIGGER tg_guarded',
    'DROP TABLE guarded',
    'TRUNCATE guarded',
    'DROP TYPE stage CASCADE',
  ]) {
    assert.match(asServiceRuntime(sql).stderr, /must be owner|permission denied/, sql);
  }

  // audit: appends still work, nothing else does — and its `public` table is no longer the runtime role's.
  const asAuditRuntime = (sql) => psql(sql, { role: audit.runtime, database: audit.db });
  ok("INSERT INTO audit.audit_event VALUES (2, 'after the upgrade')", {
    role: audit.runtime,
    database: audit.db,
  });
  assert.equal(
    ok('SELECT count(*) FROM audit.audit_event', { role: audit.runtime, database: audit.db }),
    '2',
  );
  for (const sql of [
    "UPDATE audit.audit_event SET payload = 'rewritten'",
    'DELETE FROM audit.audit_event',
    'DROP TABLE audit.audit_event',
    'DROP TABLE public.stray',
    'CREATE TABLE audit.probe (id integer)',
  ]) {
    assert.match(asAuditRuntime(sql).stderr, /must be owner|permission denied/, sql);
  }
});

/** `split_service_privileges <svc> <db> <mode>` with `lib`'s splitter; the run, not asserted. */
function splitRun(svc, db, mode, migrator, lib = dirname(SPLIT)) {
  return spawnSync(
    'bash',
    [
      '-eu',
      '-c',
      `source "${join(lib, 'service-privilege-split.bash')}"
       declare -gA ROLE_PASSWORDS=([${migrator}]=${PASSWORD[migrator]})
       split_service_privileges ${svc} ${db} ${mode}`,
    ],
    { env: { ...process.env, POSTGRES_USER: process.env.PGUSER }, encoding: 'utf8' },
  );
}

/** Every ACL in `db` the split could touch, as text: equal before and after a no-op rerun. */
const ACLS_SQL = `
  SELECT string_agg(x, E'\n' ORDER BY x) FROM (
    SELECT 'db ' || datacl::text AS x FROM pg_database WHERE datname = current_database()
    UNION ALL SELECT 'ns ' || nspname || ' ' || coalesce(nspacl::text, '') FROM pg_namespace
    UNION ALL SELECT 'rel ' || oid::regclass || ' ' || coalesce(relacl::text, '') FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
    UNION ALL SELECT 'col ' || attrelid::regclass || '.' || attname || ' ' || attacl::text
      FROM pg_attribute WHERE attacl IS NOT NULL
    UNION ALL SELECT 'fn ' || oid::regprocedure || ' ' || coalesce(proacl::text, '') FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
    UNION ALL SELECT 'def ' || defaclrole::regrole || ' ' || defaclnamespace || ' ' || defaclobjtype::text
      || ' ' || defaclacl::text FROM pg_default_acl) acls`;

// ---------------------------------------------------------------------------
// #421 r1 F1: a grant chain through a role of the runtime role's closure. The
// cleanup used to revoke from a list read once: a CASCADE could take an entry a
// later REVOKE named, whose grantor then held nothing on the object, and PG16
// refused it — the split stopped before the function repair, every run alike
// (reproduced: the grantor sorting after the migrator, for a function's
// EXECUTE, a table's TRUNCATE and a column's REFERENCES). And PG16 keeps a
// column grant made under a TABLE-level grant option when that option is
// revoked: an orphan its grantor can no longer revoke. With the grantor's name
// on either side of the migrator's, and an orphan already there, the split
// converges, the check finds nothing, and a second split changes nothing.
// ---------------------------------------------------------------------------
for (const order of ['a', 'z']) {
  test(`a grant chain through a closure role converges whatever the order, an orphaned column grant included (#421 r1 F1, grantor sorting ${order === 'a' ? 'before' : 'after'} the migrator)`, () => {
    const svc = `d138${order}${process.pid}`;
    const runtime = `rasta_${svc}`;
    const migrator = `${runtime}_migrator`;
    const db = runtime;
    // "a_…" sorts before "rasta_…", "z_…" after it.
    const grantor = `${order}_d138g${process.pid}`;
    const orphaner = `${order}_d138o${process.pid}`;
    PASSWORD[runtime] = `rt_${randomBytes(12).toString('hex')}`;
    PASSWORD[migrator] = `mg_${randomBytes(12).toString('hex')}`;
    const run = (sql, role) => ok(sql, { database: db, role });
    const inspect = () =>
      run(FINDINGS_SQL.replaceAll(":'runtime'", `'${runtime}'`))
        .split('\n')
        .filter(Boolean);
    const split = () => {
      const result = splitRun(svc, db, 'default', migrator);
      assert.equal(result.status, 0, result.stderr);
    };
    const holds = (sql) => run(`SELECT ${sql}`) === 't';
    try {
      ok(
        `CREATE ROLE ${runtime} LOGIN PASSWORD '${PASSWORD[runtime]}';
         CREATE ROLE ${grantor}; CREATE ROLE ${orphaner};`,
        { database: 'postgres' },
      );
      ok(`CREATE DATABASE ${db} TEMPLATE template0 OWNER ${runtime}`, { database: 'postgres' });
      split();
      run(
        `CREATE TABLE chained (id integer, v integer);
         CREATE VIEW chained_view AS SELECT id FROM chained;
         CREATE SEQUENCE chained_seq;
         CREATE FUNCTION chained_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
         CREATE PROCEDURE chained_procedure() LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
         GRANT USAGE ON SCHEMA public TO ${grantor}, ${orphaner};
         GRANT EXECUTE ON ROUTINE chained_definer(), chained_procedure() TO ${grantor} WITH GRANT OPTION;
         GRANT TRUNCATE, REFERENCES, TRIGGER ON chained, chained_view TO ${grantor} WITH GRANT OPTION;
         GRANT UPDATE ON SEQUENCE chained_seq TO ${grantor} WITH GRANT OPTION;
         GRANT REFERENCES (v) ON chained TO ${grantor} WITH GRANT OPTION;
         GRANT REFERENCES ON chained TO ${orphaner} WITH GRANT OPTION;`,
        migrator,
      );
      run(
        `SET ROLE ${grantor};
         GRANT EXECUTE ON ROUTINE chained_definer(), chained_procedure() TO ${runtime};
         GRANT TRUNCATE, REFERENCES, TRIGGER ON chained, chained_view TO ${runtime};
         GRANT UPDATE ON SEQUENCE chained_seq TO ${runtime};
         GRANT REFERENCES (id), REFERENCES (v) ON chained TO ${runtime};
         SET ROLE ${orphaner};
         GRANT REFERENCES (v) ON chained TO ${runtime};
         RESET ROLE;`,
      );
      // The orphan: its grantor's table-level option revoked, the column grant kept.
      run(`REVOKE REFERENCES ON chained FROM ${orphaner} CASCADE`, migrator);
      assert.ok(!holds(`has_column_privilege('${orphaner}', 'chained', 'v', 'REFERENCES')`));
      assert.match(
        run(
          `SELECT attacl::text FROM pg_attribute WHERE attrelid = 'chained'::regclass AND attname = 'v'`,
        ),
        new RegExp(`${runtime}=x/${orphaner}`),
        'PG no longer keeps the orphan: the fixture proves nothing',
      );
      run(`GRANT ${grantor} TO ${runtime}`);
      const found = inspect();
      for (const expected of [
        'reachable EXECUTE on definer/trigger function chained_definer()',
        'reachable EXECUTE on definer/trigger function chained_procedure()',
        'TRUNCATE on public.chained',
        'REFERENCES on public.chained',
        'TRIGGER on public.chained',
        'TRIGGER on public.chained_view',
        'UPDATE on sequence public.chained_seq',
      ]) {
        assert.ok(found.includes(expected), `missing "${expected}" in:\n${found.join('\n')}`);
      }

      split();
      assert.deepEqual(inspect(), []);
      for (const role of [runtime, grantor]) {
        assert.ok(
          !holds(`has_function_privilege('${role}', 'chained_definer()', 'EXECUTE')
              OR has_function_privilege('${role}', 'chained_procedure()', 'EXECUTE')
              OR has_table_privilege('${role}', 'chained', 'TRUNCATE, REFERENCES, TRIGGER')
              OR has_any_column_privilege('${role}', 'chained', 'REFERENCES')
              OR has_table_privilege('${role}', 'chained_view', 'TRUNCATE, REFERENCES, TRIGGER')
              OR has_sequence_privilege('${role}', 'chained_seq', 'UPDATE')`),
          `${role} still holds a right of the chain`,
        );
      }
      // The orphan's grantor was lent its option and has nothing again; the
      // runtime role keeps its DML and its sequence.
      assert.equal(
        run(`SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.oid = 'chained'::regclass AND a.grantee = '${orphaner}'::regrole`),
        '0',
      );
      assert.equal(
        run(`SELECT count(*) FROM pg_attribute, aclexplode(attacl)
              WHERE attrelid = 'chained'::regclass AND attname = 'v'`),
        '0',
      );
      assert.ok(
        holds(`has_table_privilege('${runtime}', 'chained', 'SELECT, INSERT, UPDATE, DELETE')
           AND has_sequence_privilege('${runtime}', 'chained_seq', 'USAGE, SELECT')`),
      );

      // Converged: a second split changes no ACL at all.
      const repaired = run(ACLS_SQL);
      split();
      assert.equal(run(ACLS_SQL), repaired);
      assert.deepEqual(inspect(), []);

      // A right no REVOKE can remove fails the split closed, naming it — as
      // it fails the check — instead of ending as if it had converged.
      run(`GRANT pg_read_all_data TO ${grantor}`);
      const refused = splitRun(svc, db, 'default', migrator);
      assert.notEqual(refused.status, 0);
      assert.match(
        refused.stderr,
        new RegExp(
          `the split did not converge: ${runtime} still holds a right on public\\._prisma_migrations`,
        ),
      );
      assert.ok(inspect().includes('member of predefined role pg_read_all_data'));
      run(`REVOKE pg_read_all_data FROM ${grantor}`);
      split();
      assert.deepEqual(inspect(), []);
    } finally {
      psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, { database: 'postgres' });
      for (const role of [runtime, migrator, grantor, orphaner]) {
        const result = psql(`DROP ROLE IF EXISTS ${role}`, { database: 'postgres' });
        assert.equal(result.status, 0, result.stderr);
      }
    }
  });
}

// Every configured service, including audit's separate path, in both bootstrap
// orders. Synthetic roles/databases keep this safe beside the real CI services.
const extensionModes = spawnSync(
  'bash',
  [
    '-c',
    `source "${ROLE_PASSWORDS}"; for svc in "\${PRIVILEGE_SPLIT_SERVICES[@]}"; do printf '%s:%s\n' "$svc" "$(privilege_split_grants_mode "$svc")"; done`,
  ],
  { encoding: 'utf8' },
);
assert.equal(extensionModes.status, 0, extensionModes.stderr);
const modeByService = new Map(
  extensionModes.stdout
    .trim()
    .split('\n')
    .map((line) => line.split(':')),
);

for (const [index, { service, kind }] of classifyServices().entries()) {
  const mode = kind === 'audit' ? 'audit' : modeByService.get(service);
  assert.ok(['audit', 'migration', 'default'].includes(mode), `${service}: unknown mode`);
  for (const history of ['fresh', 'upgraded']) {
    test(`${service} (${mode}), ${history}: extension writes removed on first split and rerun; application grants preserved`, () => {
      const svc = `d820_${process.pid}_${index}_${history}`;
      const runtime = `rasta_${svc}`;
      const migrator = `${runtime}_migrator`;
      const db = runtime;
      const reader = `${runtime}_reader`;
      const grantor = `${runtime}_grantor`;
      PASSWORD[runtime] = `rt_${randomBytes(12).toString('hex')}`;
      PASSWORD[migrator] = `mg_${randomBytes(12).toString('hex')}`;
      const run = (sql, role) => ok(sql, { database: db, role });
      const inspect = () => run(FINDINGS_SQL.replaceAll(":'runtime'", `'${runtime}'`));
      const doSplit = () => {
        const result = spawnSync(
          'bash',
          [
            '-eu',
            '-c',
            `
          source "${SPLIT}"
          declare -gA ROLE_PASSWORDS=([${migrator}]=${PASSWORD[migrator]})
          ${mode === 'audit' ? `split_audit_database_privileges ${db} ${svc}` : `split_service_privileges ${svc} ${db} ${mode}`}
        `,
          ],
          { env: { ...process.env, POSTGRES_USER: process.env.PGUSER }, encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
      };
      const extensions = () => run('CREATE EXTENSION IF NOT EXISTS postgis');
      const assertExtension = () => {
        assert.ok(
          Number(
            run(`SELECT count(*) FROM pg_class c JOIN pg_depend d ON d.objid = c.oid
          WHERE d.classid = 'pg_class'::regclass AND d.deptype = 'e'
            AND c.oid = 'public.spatial_ref_sys'::regclass`),
          ) > 0,
          'extension relation must exist',
        );
        assert.equal(
          run(`SELECT has_table_privilege('${runtime}', 'spatial_ref_sys',
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege('${runtime}', 'spatial_ref_sys', 'INSERT,UPDATE,REFERENCES')`),
          'f',
        );
        assert.equal(inspect(), '');
      };
      const spatialRead = () => {
        // Exercise both repository shapes as runtime: asset geography distance
        // and construction GeoJSON -> geography. Keep existing extension SELECT.
        assert.equal(
          run(
            `SELECT ST_DWithin(
          ST_SetSRID(ST_MakePoint(51.4,35.7),4326)::geography,
          ST_SetSRID(ST_MakePoint(51.4,35.7),4326)::geography, 100)
          AND ST_Distance(ST_SetSRID(ST_MakePoint(51.4,35.7),4326)::geography,
                          ST_SetSRID(ST_MakePoint(51.4,35.7),4326)::geography) = 0
          AND ST_SRID(ST_SetSRID(ST_GeomFromGeoJSON(
            '{"type":"Polygon","coordinates":[[[51,35],[52,35],[52,36],[51,35]]]}'),4326)::geography) = 4326`,
            runtime,
          ),
          't',
        );
        if (mode === 'default' || history === 'upgraded') {
          assert.equal(run('SELECT count(*) > 0 FROM public.spatial_ref_sys', runtime), 't');
        }
      };
      try {
        ok(
          `CREATE ROLE ${runtime} LOGIN PASSWORD '${PASSWORD[runtime]}';
            CREATE ROLE ${reader}; CREATE ROLE ${grantor};`,
          { database: 'postgres' },
        );
        ok(`CREATE DATABASE ${db} TEMPLATE template0 OWNER ${runtime}`, { database: 'postgres' });
        if (history === 'fresh') {
          doSplit(); // Real bootstrap splits BEFORE the superuser installs extensions.
          extensions();
        } else {
          extensions();
          run(`GRANT USAGE ON SCHEMA public TO ${runtime};
               GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}`);
          assert.equal(
            run(`SELECT has_table_privilege('${runtime}', 'spatial_ref_sys', 'INSERT')
              AND has_table_privilege('${runtime}', 'spatial_ref_sys', 'UPDATE')
              AND has_table_privilege('${runtime}', 'spatial_ref_sys', 'DELETE')`),
            't',
          );
          assert.match(inspect(), /INSERT on extension relation public.spatial_ref_sys/);
          // Prove each effective pathway independently, including column-only grants.
          run(`REVOKE INSERT, UPDATE, DELETE ON spatial_ref_sys FROM ${runtime};
               GRANT INSERT ON spatial_ref_sys TO PUBLIC`);
          assert.match(inspect(), /INSERT on extension relation public\.spatial_ref_sys/);
          run(`REVOKE INSERT ON spatial_ref_sys FROM PUBLIC;
               GRANT UPDATE ON spatial_ref_sys TO ${reader}; GRANT ${reader} TO ${runtime} WITH INHERIT FALSE, SET TRUE`);
          assert.match(inspect(), /UPDATE on extension relation public\.spatial_ref_sys/);
          run(`REVOKE UPDATE ON spatial_ref_sys FROM ${reader};
               GRANT INSERT (srid), UPDATE (srtext) ON spatial_ref_sys TO ${runtime}`);
          assert.equal(
            run(`SELECT has_table_privilege('${runtime}', 'spatial_ref_sys', 'INSERT,UPDATE')`),
            'f',
          );
          assert.match(inspect(), /INSERT on extension relation public\.spatial_ref_sys/);
          assert.match(inspect(), /UPDATE on extension relation public\.spatial_ref_sys/);
          // Leave all legacy sources present for the actual repair.
          run(`GRANT SELECT, INSERT, UPDATE, DELETE ON spatial_ref_sys TO ${runtime};
               GRANT DELETE ON spatial_ref_sys TO PUBLIC;
               GRANT UPDATE (srtext) ON spatial_ref_sys TO ${reader};
               GRANT INSERT (srid) ON spatial_ref_sys TO PUBLIC`);
          spatialRead();
          doSplit();
        }
        const schema = mode === 'audit' ? 'audit' : 'public';
        run(
          `CREATE TABLE ${schema}.app_probe (id int PRIMARY KEY, value text);
             INSERT INTO ${schema}.app_probe VALUES (1, 'preserved');`,
          migrator,
        );
        if (mode !== 'default')
          run(`GRANT SELECT, INSERT ON ${schema}.app_probe TO ${runtime}`, migrator);
        // Explicit invoker grants are application permissions too (economic's
        // commission locks and procurement's digest). A rerun must keep them,
        // while PUBLIC, ungranted invokers, definers and trigger functions stay closed.
        run(
          `CREATE FUNCTION ${schema}.app_invoker_probe() RETURNS int LANGUAGE sql AS 'SELECT 42';
             CREATE FUNCTION ${schema}.app_ungranted_probe() RETURNS int LANGUAGE sql AS 'SELECT 42';
             CREATE FUNCTION ${schema}.app_definer_probe() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 42';
             CREATE FUNCTION ${schema}.app_trigger_probe() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
             REVOKE EXECUTE ON FUNCTION ${schema}.app_ungranted_probe() FROM PUBLIC;
             GRANT EXECUTE ON FUNCTION ${schema}.app_invoker_probe(), ${schema}.app_definer_probe(), ${schema}.app_trigger_probe() TO ${runtime};`,
          migrator,
        );
        // Audit intentionally has no USAGE in public, so its spatial API isn't a service grant.
        if (mode === 'audit') {
          assert.equal(run(`SELECT has_schema_privilege('${runtime}', 'public', 'USAGE')`), 'f');
        } else {
          spatialRead();
        }
        // Drift must be detected WITHOUT a split rerun, including audit trigger functions.
        assert.match(inspect(), /reachable EXECUTE on definer\/trigger function/);
        run(`GRANT EXECUTE ON FUNCTION ${schema}.app_ungranted_probe() TO PUBLIC`, migrator);
        assert.match(inspect(), /PUBLIC EXECUTE on migrator function/);
        // One service per grants mode: default, migration and audit.
        const deep =
          history === 'upgraded' &&
          (service === 'economic' || service === 'supplier' || mode === 'audit');
        if (deep) {
          run(`GRANT ${reader} TO ${runtime} WITH INHERIT FALSE, SET TRUE;
             GRANT USAGE ON SCHEMA ${schema}, public TO ${grantor};
             GRANT EXECUTE ON FUNCTION ${schema}.app_definer_probe() TO ${grantor} WITH GRANT OPTION;
             SET ROLE ${grantor};
             GRANT EXECUTE ON FUNCTION ${schema}.app_definer_probe() TO ${reader}; RESET ROLE;
             REVOKE EXECUTE ON FUNCTION ${schema}.app_definer_probe() FROM ${runtime};`);
          assert.equal(run(`SELECT pg_has_role('${runtime}', '${reader}', 'USAGE')`), 'f');
          assert.match(
            inspect(),
            /reachable EXECUTE on definer\/trigger function .*app_definer_probe/,
          );
          run(`CREATE SEQUENCE public.extension_seq;
             ALTER EXTENSION postgis ADD SEQUENCE public.extension_seq;
             GRANT UPDATE ON spatial_ref_sys TO ${grantor} WITH GRANT OPTION;
             GRANT INSERT (srid) ON spatial_ref_sys TO ${grantor} WITH GRANT OPTION;
             GRANT USAGE, UPDATE ON public.extension_seq TO ${grantor} WITH GRANT OPTION;
             SET ROLE ${grantor};
             GRANT UPDATE ON public.spatial_ref_sys TO ${reader};
             GRANT INSERT (srid) ON public.spatial_ref_sys TO ${reader};
             GRANT USAGE, UPDATE ON public.extension_seq TO ${reader}; RESET ROLE;`);
          assert.match(inspect(), /UPDATE on extension relation public.spatial_ref_sys/);
          assert.match(inspect(), /USAGE on extension sequence public.extension_seq/);
          run(`CREATE FUNCTION ${schema}.extension_definer_probe() RETURNS int
               LANGUAGE sql SECURITY DEFINER AS 'SELECT 42';
               ALTER EXTENSION postgis ADD FUNCTION ${schema}.extension_definer_probe();
               GRANT EXECUTE ON FUNCTION ${schema}.extension_definer_probe() TO ${runtime};`);
          // All existing forbidden rules share the same closure, not just extensions/functions.
          run(`GRANT ${reader} TO ${runtime} WITH INHERIT FALSE, SET FALSE;
             GRANT CREATE ON SCHEMA ${schema} TO ${reader};
             GRANT SELECT (id) ON ${schema}._prisma_migrations TO ${reader};
             GRANT TRIGGER ON ${schema}.app_probe TO ${reader};`);
          assert.equal(run(`SELECT pg_has_role('${runtime}', '${reader}', 'SET')`), 'f');
          assert.match(inspect(), /CREATE on schema/);
          assert.match(inspect(), /a right on .*_prisma_migrations/);
          assert.match(inspect(), /TRIGGER on .*app_probe/);
          for (const predefined of [
            'pg_write_all_data',
            'pg_read_all_data',
            'pg_write_server_files',
            'pg_read_server_files',
            'pg_execute_server_program',
          ]) {
            run(`GRANT ${predefined} TO ${runtime} WITH INHERIT FALSE, SET TRUE`);
            assert.match(inspect(), new RegExp(`member of predefined role ${predefined}`));
            run(`REVOKE ${predefined} FROM ${runtime}`);
          }
          // CREATE OR REPLACE keeps the ACL; checker catches the changed definition immediately.
          run(
            `CREATE OR REPLACE FUNCTION ${schema}.app_invoker_probe() RETURNS int
             LANGUAGE sql SECURITY DEFINER AS 'SELECT 42'`,
            migrator,
          );
          assert.match(
            inspect(),
            /reachable EXECUTE on definer\/trigger function .*app_invoker_probe/,
          );
          doSplit();
          assert.equal(
            run(
              `SELECT has_function_privilege('${runtime}', '${schema}.app_invoker_probe()', 'EXECUTE')`,
            ),
            'f',
          );
          run(
            `CREATE OR REPLACE FUNCTION ${schema}.app_invoker_probe() RETURNS int
             LANGUAGE sql SECURITY INVOKER AS 'SELECT 42';
             GRANT EXECUTE ON FUNCTION ${schema}.app_invoker_probe() TO ${runtime}`,
            migrator,
          );
        }
        const created = (suffix) =>
          run(
            `CREATE TABLE ${schema}.made_${suffix} (id int);
             CREATE SEQUENCE ${schema}.made_${suffix}_seq;
             CREATE FUNCTION ${schema}.made_${suffix}_definer() RETURNS int
               LANGUAGE sql SECURITY DEFINER AS 'SELECT 42';
             CREATE SCHEMA made_${suffix}_schema;`,
            migrator,
          );
        // regprocedure leaves out a schema on the search path.
        const fn = (name) => (schema === 'public' ? name : `${schema}.${name}`);
        if (deep) {
          // #421 r1 F3: the rules the split revoked by and the check did not
          // read — TEMPORARY, a view's TRIGGER, a sequence's UPDATE — and
          // default privileges, planted and then inherited by objects made
          // afterwards. Found without a rerun; gone after it, and from what is
          // created later too.
          run(`GRANT TEMPORARY ON DATABASE ${db} TO ${reader};
             CREATE VIEW ${schema}.app_view AS SELECT id FROM ${schema}.app_probe;
             CREATE SEQUENCE ${schema}.app_seq;
             GRANT TRIGGER ON ${schema}.app_view TO ${reader};
             GRANT UPDATE ON SEQUENCE ${schema}.app_seq TO ${reader};
             ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
               GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLES TO ${reader};
             ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} GRANT UPDATE ON SEQUENCES TO ${runtime};
             ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
             ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} GRANT CREATE ON SCHEMAS TO ${reader};`);
          created('before');
          const planted = inspect();
          for (const expected of [
            `TEMPORARY on database ${db}`,
            `TRIGGER on ${schema}.app_view`,
            `UPDATE on sequence ${schema}.app_seq`,
            `default TRUNCATE on new tables of ${migrator} in schema ${schema}`,
            `default UPDATE on new sequences of ${migrator}`,
            `default EXECUTE on new functions of ${migrator}`,
            `default CREATE on new schemas of ${migrator}`,
            `TRUNCATE on ${schema}.made_before`,
            `UPDATE on sequence ${schema}.made_before_seq`,
            `reachable EXECUTE on definer/trigger function ${fn('made_before_definer()')}`,
            'CREATE on schema made_before_schema',
          ]) {
            assert.ok(planted.includes(expected), `missing "${expected}" in:\n${planted}`);
          }
        }
        doSplit();
        if (deep) {
          assert.equal(run(`SELECT ${schema}.extension_definer_probe()`, runtime), '42');
          assert.equal(inspect(), '');
          created('after');
          assert.equal(inspect(), '', 'an object made after the repair inherits a forbidden right');
          assert.equal(
            run(`SELECT has_table_privilege('${runtime}', '${schema}.made_after', 'TRUNCATE, REFERENCES, TRIGGER')
                     OR has_sequence_privilege('${runtime}', '${schema}.made_after_seq', 'UPDATE')
                     OR has_function_privilege('${runtime}', '${schema}.made_after_definer()', 'EXECUTE')
                     OR has_schema_privilege('${runtime}', 'made_after_schema', 'CREATE')
                     OR has_database_privilege('${runtime}', '${db}', 'TEMPORARY')`),
            'f',
          );
        }
        assertExtension();
        for (let rerun = 0; rerun < 2; rerun += 1) {
          if (rerun) doSplit();
          assertExtension();
          assert.equal(
            run(`SELECT value FROM ${schema}.app_probe WHERE id=1`, runtime),
            'preserved',
          );
          run(`INSERT INTO ${schema}.app_probe VALUES (${rerun + 2}, 'append')`, runtime);
          if (mode === 'default') {
            run(
              `UPDATE ${schema}.app_probe SET value='writable' WHERE id=${rerun + 2};
                 DELETE FROM ${schema}.app_probe WHERE id=${rerun + 2}`,
              runtime,
            );
          } else {
            assert.equal(
              run(
                `SELECT has_table_privilege('${runtime}', '${schema}.app_probe', 'UPDATE,DELETE')`,
              ),
              'f',
            );
          }
          assert.equal(run(`SELECT ${schema}.app_invoker_probe()`, runtime), '42');
          if (rerun) {
            for (const fn of ['app_ungranted_probe', 'app_definer_probe', 'app_trigger_probe']) {
              assert.equal(
                run(`SELECT has_function_privilege('${runtime}', '${schema}.${fn}()', 'EXECUTE')`),
                'f',
              );
            }
          }
          if (mode !== 'audit') spatialRead();
        }
      } finally {
        psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, { database: 'postgres' });
        for (const role of [runtime, migrator, reader, grantor]) {
          const result = psql(`DROP ROLE IF EXISTS ${role}`, { database: 'postgres' });
          assert.equal(result.status, 0, result.stderr);
        }
      }
    });
  }
}

/** The real service roles' attributes, password, memberships and settings: never touched here. */
const SHARED_ROLES_SQL = `
  SELECT coalesce(json_agg(row_to_json(r) ORDER BY r.rolname), '[]') FROM (
    SELECT a.rolname, a.rolsuper, a.rolinherit, a.rolcreaterole, a.rolcreatedb, a.rolcanlogin,
      a.rolbypassrls, a.rolconnlimit, a.rolpassword, a.rolvaliduntil,
      ARRAY(SELECT m.roleid::regrole || ' ' || m.admin_option || m.inherit_option || m.set_option
              || ' by ' || m.grantor::regrole FROM pg_auth_members m
             WHERE m.member = a.oid OR m.roleid = a.oid ORDER BY 1) AS memberships,
      ARRAY(SELECT s.setdatabase || ' ' || array_to_string(s.setconfig, ',')
              FROM pg_db_role_setting s WHERE s.setrole = a.oid ORDER BY 1) AS settings
    FROM pg_authid a
    WHERE a.rolname IN ('rasta_economic', 'rasta_economic_migrator',
                        'rasta_procurement', 'rasta_procurement_migrator')) r`;

/**
 * The digest's own trigger path (tg_demand_aggregation_guard), as the sweeper
 * drives it. A reviewed probe (packages/testing reviewedClockTemplates): its
 * window closed an hour ago by the database clock, nowhere near a boundary.
 */
const DIGEST_BY_TRIGGER = eligibilityClockSql`
  BEGIN;
  INSERT INTO demand_aggregation (id, organization_id, product_id, status, opened_at, closes_at,
    window_hours, min_quantity, shortfall_policy, total_quantity, demand_count, extension_count,
    created_at, updated_at)
  VALUES ('AGG-D138', 'ORG-D138', 'PRD_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'OPEN',
    now() - interval '2 hours', now() - interval '1 hour', 1, 1, 'CLOSE', 0, 0, 0,
    now() - interval '2 hours', now() - interval '2 hours');
  -- The window's end begins the digest from nothing…
  UPDATE demand_aggregation SET status = 'LAPSED', closed_at = now(), updated_at = now(),
    version = version + 1, end_digest_counted = 0,
    end_digest_state = '\\x6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd190000000000000000'
   WHERE id = 'AGG-D138';
  -- …and the batch that writes it is checked by the trigger, which reads the
  -- window's demands through demand_aggregation_digest_range.
  UPDATE demand_aggregation SET end_digest_state = NULL,
    demand_ids_sha256 = encode(sha256(''::bytea), 'hex')
   WHERE id = 'AGG-D138';
  SELECT status FROM demand_aggregation WHERE id = 'AGG-D138';
  ROLLBACK;`;

// Original migrations are already applied on a damaged cluster. Exercise the
// declared repair list with real service signatures and real runtime logins —
// on a PID-scoped role pair (#421 r1 F6): the service's own migrations, through
// Prisma, with its runtime role renamed, and the list remapped to that pair in
// a copy of lib/. The real rasta_<svc> roles are never touched, and the test
// proves it.
for (const service of ['economic', 'procurement']) {
  test(`${service}: old splitter damage is detected and repaired; healthy and damaged EXECUTE ACLs converge; a missing helper refuses only once its migration is recorded`, () => {
    const svc = `d825${service[0]}${process.pid}`;
    const runtime = `rasta_${svc}`;
    const migrator = `${runtime}_migrator`;
    const db = runtime;
    PASSWORD[runtime] = `rt_${randomBytes(12).toString('hex')}`;
    PASSWORD[migrator] = `mg_${randomBytes(12).toString('hex')}`;
    const shared = ok(SHARED_ROLES_SQL, { database: 'postgres' });
    const run = (sql, role) => ok(sql, { database: db, role });
    const list = requiredRuntimeFunctions
      .filter(([listed]) => listed === service)
      .map(([, signature, migration]) => [svc, signature, migration]);
    const signatures = list.map(([, signature]) => signature);
    const inspect = () => run(findingsSql(list).replaceAll(":'runtime'", `'${runtime}'`));
    const acl = () =>
      run(`SELECT p.oid::regprocedure::text, p.proacl::text FROM pg_proc p
      WHERE p.oid IN (${signatures.map((sig) => `'${sig}'::regprocedure`).join(',')}) ORDER BY 1`);
    const lib = mkdtempSync(join(tmpdir(), 'd825-lib-'));
    const grants = join(lib, 'runtime-function-grants.txt');
    // No newline after the last line: the split must read it all the same (F5).
    const writeList = (lines) =>
      writeFileSync(grants, lines.map((line) => line.join('|')).join('\n'));
    const repair = (refusal) => {
      const result = splitRun(svc, db, 'default', migrator, lib);
      if (!refusal) assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0, `the repair did not refuse: ${refusal}`);
        assert.match(result.stderr, refusal);
      }
    };
    const project = prismaProject(
      Object.fromEntries(
        readdirSync(join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations'))
          .filter((name) => /^\d/.test(name))
          .map((name) => [
            name,
            readFileSync(
              join(
                ROOT,
                'services',
                `${service}-service`,
                'prisma',
                'migrations',
                name,
                'migration.sql',
              ),
              'utf8',
            ).replace(new RegExp(`\\brasta_${service}\\b`, 'g'), runtime),
          ]),
      ),
    );
    const prisma = (...args) =>
      spawnSync(PRISMA, [...args, '--schema', join(project, 'schema.prisma')], {
        cwd: project,
        env: {
          ...process.env,
          DATABASE_URL: `postgresql://${migrator}:${PASSWORD[migrator]}@${process.env.PGHOST ?? '127.0.0.1'}:${process.env.PGPORT ?? '5432'}/${db}?schema=public`,
          PRISMA_HIDE_UPDATE_MESSAGE: '1',
        },
        encoding: 'utf8',
      });
    try {
      cpSync(dirname(SPLIT), lib, { recursive: true });
      writeList(list);
      ok(`CREATE ROLE ${runtime} LOGIN PASSWORD '${PASSWORD[runtime]}'`, { database: 'postgres' });
      ok(`CREATE DATABASE ${db} TEMPLATE template0 OWNER ${runtime}`, { database: 'postgres' });
      // Bootstrap: before any migration, no helper and nothing recorded — skipped.
      repair();
      const deployed = prisma('migrate', 'deploy');
      assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
      assert.equal(inspect(), '');
      const healthy = acl();
      repair();
      assert.equal(acl(), healthy, 'healthy repair must not change helper ACLs');
      // Exact destructive function loop from the pre-407 splitter (6ef94918^).
      run(`DO $$ DECLARE fn record; BEGIN
        FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
          WHERE p.proowner = '${migrator}'::regrole
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass
            AND d.objid=p.oid AND d.deptype='e')
        LOOP EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, ${runtime}', fn.signature);
        END LOOP; END $$;`);
      for (const signature of signatures) {
        assert.equal(
          run(`SELECT has_function_privilege('${runtime}', '${signature}', 'EXECUTE')`),
          'f',
        );
        assert.ok(inspect().includes(`missing required runtime EXECUTE on ${signature}`));
      }
      if (service === 'economic') {
        assert.match(
          psql(`SELECT commission_pricing_scope_lock('repair', 'PARTS', NULL)`, {
            database: db,
            role: runtime,
          }).stderr,
          /permission denied/,
        );
      } else {
        // The digest's trigger path needs the helper too (addendum H).
        assert.match(
          psql(DIGEST_BY_TRIGGER, { database: db, role: runtime }).stderr,
          /permission denied for function demand_aggregation_digest_range/,
        );
      }
      repair();
      assert.equal(acl(), healthy, 'damaged cluster must restore the exact healthy helper ACLs');
      assert.equal(inspect(), '');
      if (service === 'economic') {
        run(
          `BEGIN; SELECT commission_pricing_scope_lock('repair', 'PARTS', NULL);
          SELECT commission_rule_scope_change('repair', 'PARTS', NULL); ROLLBACK;`,
          runtime,
        );
      } else {
        run(
          `SELECT * FROM demand_aggregation_digest_range('repair', 'repair', NULL, NULL, 1)`,
          runtime,
        );
        assert.equal(run(DIGEST_BY_TRIGGER, runtime).split('\n').at(-1), 'LAPSED');
      }
      repair();
      assert.equal(acl(), healthy, 'repair is idempotent');
      run(`ALTER FUNCTION ${signatures[0]} SECURITY DEFINER`, migrator);
      assert.match(inspect(), /reachable EXECUTE on definer\/trigger function/);
      repair(/required runtime function has unsafe ownership or definition/);
      assert.equal(
        run(`SELECT has_function_privilege('${runtime}', '${signatures[0]}', 'EXECUTE')`),
        'f',
      );
      run(`ALTER FUNCTION ${signatures[0]} SECURITY INVOKER`, migrator);
      repair();
      assert.equal(acl(), healthy, 'safe definition restored without changing the original grants');
      assert.equal(inspect(), '');

      // #421 r1 F5: a listed helper that does not exist. Prisma's own ledger
      // row says whether its migration ran: recorded as applied, the repair
      // refuses (and the check reports it); failed, rolled back or not yet
      // applied, it is skipped — the migration grants EXECUTE when it runs.
      const [, signature, migration] = list[0];
      const name = signature.slice(signature.indexOf('.') + 1, signature.indexOf('('));
      run(`ALTER FUNCTION ${signature} RENAME TO ${name}_moved`, migrator);
      assert.ok(inspect().includes(`missing required runtime EXECUTE on ${signature}`));
      const missing = new RegExp(
        `required runtime function ${signature.replace(/[.()"]/g, '\\$&')} is missing, yet migration ${migration} is recorded as applied`,
      );
      assert.equal(
        run(`SELECT count(*) FROM _prisma_migrations WHERE migration_name = '${migration}'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL`),
        '1',
      );
      repair(missing);
      // Failed half-way, as Prisma records a failure: not finished.
      run(
        `UPDATE _prisma_migrations SET finished_at = NULL, logs = 'failed half-way'
          WHERE migration_name = '${migration}'`,
        migrator,
      );
      repair();
      // Rolled back, by Prisma itself.
      const resolved = prisma('migrate', 'resolve', '--rolled-back', migration);
      assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
      assert.equal(
        run(`SELECT count(*) FROM _prisma_migrations WHERE migration_name = '${migration}'
               AND rolled_back_at IS NOT NULL`),
        '1',
      );
      repair();
      // Not yet applied at all.
      run(`DELETE FROM _prisma_migrations WHERE migration_name = '${migration}'`, migrator);
      repair();
      // Recorded once more: refused again.
      run(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, applied_steps_count)
         VALUES ('d825-${service}', 'x', '${migration}', now(), 1)`,
        migrator,
      );
      repair(missing);
      run(
        `ALTER FUNCTION ${name}_moved(${signature.slice(signature.indexOf('(') + 1)} RENAME TO ${name}`,
        migrator,
      );
      repair();
      assert.equal(acl(), healthy);

      // A malformed list refuses before it restores anything.
      writeList([...list, [svc, 'public.f(text);DROP TABLE x', migration]]);
      repair(/runtime-function-grants\.txt: malformed line/);
      writeList([...list, [svc, signature]]);
      repair(/runtime-function-grants\.txt: malformed line/);
    } finally {
      rmSync(lib, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
      psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, { database: 'postgres' });
      for (const role of [runtime, migrator]) {
        const result = psql(`DROP ROLE IF EXISTS ${role}`, { database: 'postgres' });
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(
        ok(SHARED_ROLES_SQL, { database: 'postgres' }),
        shared,
        'the real service roles changed',
      );
    }
  });
}

// -----------------------------------------------------------------------------
// The supplier-service privilege split, applied to a database the way main
// leaves it (Codex review of #120, round 2 findings 1 and 2).
//
//   pnpm test:supplier-privilege-split     (a PostgreSQL superuser in PG* env)
//
// A throwaway database is created and migrated exactly as on main — owned by
// `rasta_supplier`, the two migrations main carries applied by that role, and
// rows seeded in `public`. Then the upgrade the runbook describes runs:
// lib/supplier-privilege-split.bash as the superuser, and the remaining
// migrations as `rasta_supplier_migrator`. The assertions are the ones the
// review asked for: every seeded row is still visible to the service, the
// ledger is intact, and the runtime role is refused DISABLE TRIGGER, ALTER,
// DROP TABLE and DROP DATABASE with SQLSTATE 42501. The split is run a second
// time to prove it is idempotent.
//
// Needs `psql` and a superuser: PGHOST, PGPORT, PGUSER, PGPASSWORD. The role
// passwords are the development defaults unless POSTGRES_PASSWORD_* say
// otherwise, as in the bootstrap.
// -----------------------------------------------------------------------------
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = join(ROOT, 'services', 'supplier-service');
const SPLIT = join(ROOT, 'infrastructure/docker/postgres/lib/supplier-privilege-split.bash');
const PRISMA = join(SERVICE, 'node_modules', '.bin', 'prisma');

/** The migrations on main when this upgrade was written. */
const MAIN_MIGRATIONS = [
  '20260905120000_init_supplier',
  '20260906090000_supplier_blank_text_hardening',
];

const DB = `rasta_supplier_upgrade_${process.pid}`;
const RUNTIME = 'rasta_supplier';
const MIGRATOR = 'rasta_supplier_migrator';
const password = (role) =>
  process.env[`POSTGRES_PASSWORD_${role.replace(/^rasta_/, '').toUpperCase()}`] ??
  `${role}_dev_password`;

const host = process.env.PGHOST ?? '127.0.0.1';
const port = process.env.PGPORT ?? '5432';
const superuser = process.env.PGUSER;

const url = (role, database = DB) =>
  `postgresql://${role}:${password(role)}@${host}:${port}/${database}?schema=public`;

/** psql as `role` (the superuser when omitted). Returns { status, stdout, stderr }. */
function psql(sql, { role, database = DB } = {}) {
  const env = { ...process.env, PGHOST: host, PGPORT: port };
  if (role) {
    env.PGUSER = role;
    env.PGPASSWORD = password(role);
  }
  return spawnSync(
    'psql',
    [
      '-X',
      '-q',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=verbose',
      '-d',
      database,
      '-c',
      sql,
    ],
    { env, encoding: 'utf8' },
  );
}

function ok(sql, options) {
  const result = psql(sql, options);
  assert.equal(result.status, 0, `${sql}\n${result.stderr}`);
  return result.stdout.trim();
}

function denied(sql, options) {
  const result = psql(sql, options);
  assert.notEqual(result.status, 0, `expected a refusal, but this succeeded: ${sql}`);
  assert.match(
    result.stderr,
    /ERROR:\s+42501/,
    `expected SQLSTATE 42501 for: ${sql}\n${result.stderr}`,
  );
}

function deploy(role, migrations) {
  // `migrate deploy` reads prisma/migrations beside the schema it is given, so
  // "main" is a directory holding only main's migrations.
  const dir = mkdtempSync(join(tmpdir(), 'supplier-upgrade-'));
  try {
    const prismaDir = join(dir, 'prisma');
    mkdirSync(join(prismaDir, 'migrations'), { recursive: true });
    cpSync(join(SERVICE, 'prisma', 'schema.prisma'), join(prismaDir, 'schema.prisma'));
    cpSync(
      join(SERVICE, 'prisma', 'migrations', 'migration_lock.toml'),
      join(prismaDir, 'migrations', 'migration_lock.toml'),
    );
    for (const name of migrations) {
      cpSync(join(SERVICE, 'prisma', 'migrations', name), join(prismaDir, 'migrations', name), {
        recursive: true,
      });
    }
    const result = spawnSync(
      PRISMA,
      ['migrate', 'deploy', '--schema', join(prismaDir, 'schema.prisma')],
      {
        cwd: SERVICE,
        env: { ...process.env, DATABASE_URL: url(role) },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function split() {
  const result = spawnSync('bash', [SPLIT, DB], {
    env: { ...process.env, PGHOST: host, PGPORT: port, POSTGRES_USER: superuser },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

before(() => {
  assert.ok(superuser, 'PGUSER must name a PostgreSQL superuser');
  ok(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`, { database: 'postgres' });
  // As 00-init-databases.sh leaves a service database before the split, and
  // as every supplier database on main still is.
  ok(`ALTER ROLE ${RUNTIME} CREATEDB`, { database: 'postgres' });
  ok(`CREATE DATABASE "${DB}" OWNER ${RUNTIME}`, { database: 'postgres' });
  ok(`GRANT ALL ON SCHEMA public TO ${RUNTIME}`);

  deploy(RUNTIME, MAIN_MIGRATIONS);

  // Rows the service wrote on main, as the service wrote them.
  ok(
    `INSERT INTO supplier (id, organization_id, display_name, registered_by, registered_correlation_id, updated_at)
       VALUES ('SUP_UPGRADE', 'ORG_UPGRADE', 'Upgraded supplier', 'USR_1', 'COR_1', now());
     INSERT INTO qualification (id, supplier_id, organization_id, capability, submitted_by, submitted_correlation_id)
       VALUES ('QLF_UPGRADE', 'SUP_UPGRADE', 'ORG_UPGRADE', 'GOODS_SUPPLY', 'USR_1', 'COR_1');
     INSERT INTO outbox_message (id, aggregate_type, aggregate_id, event_name, topic, partition_key, payload, headers, organization_id, correlation_id)
       VALUES ('EVT_UPGRADE', 'Supplier', 'SUP_UPGRADE', 'SUPPLIER_REGISTERED', 'rasta.supplier.v1', 'SUP_UPGRADE', '{}', '{}', 'ORG_UPGRADE', 'COR_1');
     INSERT INTO processed_event (event_id, consumer_name) VALUES ('EVT_SEEN', 'upgrade-check');`,
    { role: RUNTIME },
  );

  // The upgrade: split as the superuser, then the rest of the migrations as
  // the migrator — which is what applies the runtime grants.
  split();
  deploy(
    MIGRATOR,
    readdirSync(join(SERVICE, 'prisma', 'migrations')).filter((n) => /^\d{14}_/.test(n)),
  );
});

after(() => {
  psql(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`, { database: 'postgres' });
  // `before` handed the runtime role CREATEDB to reproduce main; take it back
  // even if the split never ran, so a failed run leaves the cluster as it was.
  psql(`ALTER ROLE ${RUNTIME} NOCREATEDB`, { database: 'postgres' });
});

test('every row written on main is still there, and visible to the service', () => {
  const counts = ok(
    `SELECT (SELECT count(*) FROM supplier WHERE id = 'SUP_UPGRADE') || ',' ||
            (SELECT count(*) FROM qualification WHERE id = 'QLF_UPGRADE') || ',' ||
            (SELECT count(*) FROM outbox_message WHERE id = 'EVT_UPGRADE') || ',' ||
            (SELECT count(*) FROM processed_event WHERE event_id = 'EVT_SEEN')`,
    { role: RUNTIME },
  );
  assert.equal(counts, '1,1,1,1');
});

test('the tables never moved, and the ledger lists every migration once', () => {
  assert.equal(
    ok(`SELECT count(*) FROM pg_tables WHERE schemaname <> 'public' AND tablename = 'supplier'`),
    '0',
  );
  const ledger = ok(
    `SELECT count(*) || '/' || count(DISTINCT migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
  );
  const expected = readdirSync(join(SERVICE, 'prisma', 'migrations')).filter((n) =>
    /^\d{14}_/.test(n),
  ).length;
  assert.equal(ledger, `${expected}/${expected}`);
});

test('the migrator owns the database and every relation; the runtime role owns nothing', () => {
  assert.equal(
    ok(`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()`),
    MIGRATOR,
  );
  assert.equal(
    // Every table a migration made. The scratch database is cloned from
    // template1, where the bootstrap installed postgis, so `public` also holds
    // postgis's `spatial_ref_sys`, owned by the superuser — excluded by
    // extension membership, never by name.
    ok(
      `SELECT string_agg(DISTINCT t.tableowner, ',') FROM pg_tables t
        WHERE t.schemaname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
             WHERE d.classid = 'pg_class'::regclass AND d.deptype = 'e'
               AND d.objid = format('%I.%I', t.schemaname, t.tablename)::regclass
          )`,
    ),
    MIGRATOR,
  );
  assert.equal(ok(`SELECT rolcreatedb FROM pg_roles WHERE rolname = '${RUNTIME}'`), 'f');
});

test('the service still works: it reads its rows and records a performance fact', () => {
  ok(
    `INSERT INTO performance_event (id, organization_id, source_event_id, source_event_name, component,
       outcome_kind, outcome_key, rating, occurred_at, correlation_id)
     VALUES ('PEV_UPGRADE', 'ORG_UPGRADE', 'EVT_REVIEW', 'REVIEW_SUBMITTED', 'CUSTOMER_SATISFACTION',
       'ORDER', 'ORD_1', 5, now(), 'COR_2')`,
    { role: RUNTIME },
  );
});

for (const [label, sql, database] of [
  ['disable the append-only trigger', 'ALTER TABLE performance_event DISABLE TRIGGER ALL'],
  [
    'disable the formula guard',
    'ALTER TABLE performance_formula_version DISABLE TRIGGER trg_performance_formula_version_guard',
  ],
  ['alter a table seeded on main', 'ALTER TABLE supplier ADD COLUMN smuggled TEXT'],
  ['drop a table seeded on main', 'DROP TABLE qualification_evidence'],
  ['drop a performance table', 'DROP TABLE performance_event'],
  ['truncate the event store', 'TRUNCATE performance_event'],
  ['rewrite a performance fact', `UPDATE performance_event SET rating = 1`],
  ['drop the database', `DROP DATABASE "${DB}" WITH (FORCE)`, 'postgres'],
  ['create a database', `CREATE DATABASE "${DB}_again"`, 'postgres'],
]) {
  test(`the runtime role is refused: ${label}`, () => {
    denied(sql, { role: RUNTIME, ...(database ? { database } : {}) });
  });
}

test('no function the migrator owns is executable by the runtime role, now or later', () => {
  // Round 3: PUBLIC's default EXECUTE is revoked for the migrator's functions,
  // existing (the trigger functions) and future (the global default privilege).
  assert.equal(
    ok(
      `SELECT count(*) FROM pg_proc p
        WHERE p.proowner = '${MIGRATOR}'::regrole
          AND has_function_privilege('${RUNTIME}', p.oid, 'EXECUTE')`,
    ),
    '0',
  );
  const name = `probe_${process.pid}_later`;
  ok(`CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`, {
    role: MIGRATOR,
  });
  try {
    assert.equal(ok(`SELECT has_function_privilege('${RUNTIME}', '${name}()', 'EXECUTE')`), 'f');
    denied(`SELECT ${name}()`, { role: RUNTIME });
  } finally {
    ok(`DROP FUNCTION ${name}()`, { role: MIGRATOR });
  }
});

test('running the split again changes nothing', () => {
  split();
  assert.equal(
    ok(`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()`),
    MIGRATOR,
  );
  assert.equal(
    ok(`SELECT count(*) FROM supplier WHERE id = 'SUP_UPGRADE'`, { role: RUNTIME }),
    '1',
  );
  denied('ALTER TABLE performance_event DISABLE TRIGGER ALL', { role: RUNTIME });
});

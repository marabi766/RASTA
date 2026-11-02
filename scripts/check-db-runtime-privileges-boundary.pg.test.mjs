// -----------------------------------------------------------------------------
// #540 r1 F1 and F2 on a real cluster: the runtime privilege boundary is the
// whole capability inventory (F1), across the whole (database, runtime role)
// matrix (F2).
//
//   pnpm test:db-runtime-privileges      (a PostgreSQL superuser in PG* env)
//
// Two throwaway services, split as the bootstrap splits one: `a` holds the
// data (audit's place in the review's F2 trigger), `b` is another service
// (economic's). Each of the review's exploits is planted through every path
// PostgreSQL offers it — the runtime role itself, PUBLIC, a role it is a
// member of — and then, as D-100 rules: the check reports it, the split
// revokes it, has_*_privilege() is false, and ONE plain attempt to use it is
// refused ("permission denied", "must be owner"). No escalation step is run,
// before the split or after it.
//
//   * parameter ACL: SET / ALTER SYSTEM on session_replication_role;
//   * a system catalogue: SELECT, UPDATE on pg_authid, table and columns —
//     in the role's own database, and in another service's;
//   * REPLICATION, held or reached through a member role (PUBLIC holds no
//     attribute);
//   * a publication's owner reached through membership — and owned directly,
//     and by another service's runtime role (PUBLIC owns nothing);
//   * another service reading `a`'s data: CONNECT, TEMPORARY, the schema, a
//     table, a column, a sequence, a routine, a default privilege — and a
//     membership in `a`'s runtime role itself; connecting is refused AND
//     reading is refused;
//   * every other ACL class: large objects, foreign-data wrappers and servers,
//     tablespaces, types, domains, languages, default privileges for types,
//     system and extension routines;
//   * an ACL column the inventory does not model: the check and the split
//     fail closed;
//   * a database no service owns refuses every runtime role but for
//     lib/runtime-foreign-exceptions.sql's rows.
//
// Roles and databases are `…d540<pid>…`, dropped afterwards; a grant planted
// on a cluster-wide object (a parameter, pg_default) is revoked by the split
// under test, and again in `after` whatever happened. Needs `psql`, a
// superuser (PGHOST, PGPORT, PGUSER, PGPASSWORD), pgcrypto in template1 (the
// bootstrap installs it) and `pnpm build` of @rasta/nest-common.
// -----------------------------------------------------------------------------
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { FINDINGS_SQL, FOREIGN_FINDINGS_SQL } from './check-db-runtime-privileges-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'infrastructure/docker/postgres/lib');
// The services' own startup check, exactly as built.
const { CONNECTED_ROLE_SQL, connectedRoleProblems } = createRequire(import.meta.url)(
  join(ROOT, 'packages', 'nest-common', 'dist', 'index.js'),
);

const TAG = `d540${process.pid}`;
const PASSWORD = {};
const service = (suffix) => {
  const name = `${TAG}${suffix}`;
  const runtime = `rasta_${name}`;
  const migrator = `${runtime}_migrator`;
  PASSWORD[runtime] = `rt_${randomBytes(12).toString('hex')}`;
  PASSWORD[migrator] = `mg_${randomBytes(12).toString('hex')}`;
  return { service: name, db: runtime, runtime, migrator };
};
const A = service('a');
const B = service('b');
/** A plain role: owns nothing, no attribute — the "reachable ordinary role". */
const GROUP = `${TAG}_group`;
const REPL = `${TAG}_repl`;
const PUB_OWNER = `${TAG}_pubowner`;
/** A database no service owns, and that no exception names. */
const SCRATCH = `${TAG}_scratch`;
const ROLES = [A.runtime, A.migrator, B.runtime, B.migrator, GROUP, REPL, PUB_OWNER];

/** psql as `role` (the superuser when omitted), SQL on stdin. */
function psql(sql, { role, database = A.db, variables = {} } = {}) {
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

/** The one denied attempt D-100 allows: it must fail, with `pattern`. */
function refused(sql, options, pattern) {
  const result = psql(sql, options);
  assert.notEqual(result.status, 0, `allowed: ${sql}`);
  assert.match(result.stderr, pattern, sql);
}

const lines = (text) => text.split('\n').filter(Boolean);
/** The check's findings for a service's own runtime role, in its own database. */
const findings = (svc) =>
  lines(
    ok(FINDINGS_SQL, { database: svc.db, variables: { runtime: svc.runtime, policy: 'default' } }),
  );
/** The check's foreign findings in `database` (own runtime role `runtime`), for `of`'s role only. */
const foreign = (database, runtime, of) =>
  lines(ok(FOREIGN_FINDINGS_SQL, { database, variables: { runtime } })).filter((line) =>
    line.startsWith(of.runtime),
  );
/** True or false, as the superuser sees it in `database`. */
const truth = (sql, database = A.db) => ok(`SELECT (${sql})::text`, { database });

function has(found, pattern) {
  assert.ok(
    found.some((line) => (typeof pattern === 'string' ? line === pattern : pattern.test(line))),
    `missing ${pattern} in:\n${found.join('\n')}`,
  );
}

function split(svc, lib = LIB) {
  return spawnSync(
    'bash',
    [
      '-eu',
      '-c',
      `source "${join(lib, 'service-privilege-split.bash')}"
       declare -gA ROLE_PASSWORDS=([${svc.migrator}]=${PASSWORD[svc.migrator]})
       split_service_privileges ${svc.service} ${svc.db} default`,
    ],
    { env: { ...process.env, POSTGRES_USER: process.env.PGUSER }, encoding: 'utf8' },
  );
}

function splitOk(svc) {
  const result = split(svc);
  assert.equal(result.status, 0, result.stderr);
}

/** What the services' startup check says, connected as `svc`'s runtime role. */
function startupProblems(svc) {
  const json = ok(`SELECT row_to_json(f) FROM (${CONNECTED_ROLE_SQL}) f`, {
    role: svc.runtime,
    database: svc.db,
  });
  return connectedRoleProblems(JSON.parse(json));
}

/**
 * The three ways a role holds a grant: its own, PUBLIC's, a member role's.
 * `label` is the grantee as the check names it; `via` as runtime-foreign.sql
 * names the path.
 */
const paths = (svc) => [
  { name: 'its own grant', grantee: svc.runtime, label: svc.runtime, via: 'its own grant' },
  { name: 'PUBLIC', grantee: 'PUBLIC', label: 'PUBLIC', via: 'PUBLIC' },
  {
    name: 'a member role',
    grantee: GROUP,
    label: GROUP,
    via: GROUP,
    enter: () => ok(`GRANT ${GROUP} TO ${svc.runtime}`, { database: 'postgres' }),
    leave: () => ok(`REVOKE ${GROUP} FROM ${svc.runtime}`, { database: 'postgres' }),
  },
];

/** Cluster-wide grants a failed run could leave behind. */
const SHARED_CLEANUP = `
  REVOKE ALL ON PARAMETER session_replication_role FROM PUBLIC;
  REVOKE ALL ON TABLESPACE pg_default FROM PUBLIC;`;

before(() => {
  assert.ok(process.env.PGUSER, 'PGUSER must name a superuser');
  for (const svc of [A, B]) {
    ok(`CREATE ROLE ${svc.runtime} LOGIN PASSWORD '${PASSWORD[svc.runtime]}'`, {
      database: 'postgres',
    });
    ok(`CREATE DATABASE ${svc.db} OWNER ${svc.runtime}`, { database: 'postgres' });
    splitOk(svc);
  }
  ok(
    `CREATE ROLE ${GROUP} NOLOGIN; CREATE ROLE ${REPL} NOLOGIN REPLICATION;
     CREATE ROLE ${PUB_OWNER} NOLOGIN; CREATE DATABASE ${SCRATCH}`,
    { database: 'postgres' },
  );
  // `a`'s data, as its migrator makes it: a schema of its own (audit's shape).
  ok(
    `CREATE SCHEMA vault;
     CREATE TABLE vault.event (id integer PRIMARY KEY, body text NOT NULL);
     CREATE SEQUENCE vault.event_seq;
     CREATE FUNCTION vault.peek() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM vault.event';
     INSERT INTO vault.event VALUES (1, 'one organization''s event');`,
    { role: A.migrator },
  );
  // The other ACL classes, made by the superuser, owned where a service would own them.
  ok(
    `CREATE EXTENSION IF NOT EXISTS pgcrypto;
     CREATE FOREIGN DATA WRAPPER ${TAG}_fdw;
     CREATE SERVER ${TAG}_srv FOREIGN DATA WRAPPER ${TAG}_fdw;
     CREATE TYPE public.${TAG}_t AS ENUM ('x');
     CREATE DOMAIN public.${TAG}_d AS integer;
     ALTER TYPE public.${TAG}_t OWNER TO ${A.migrator};
     ALTER DOMAIN public.${TAG}_d OWNER TO ${A.migrator};
     REVOKE USAGE ON TYPE public.${TAG}_t FROM PUBLIC;
     REVOKE USAGE ON DOMAIN public.${TAG}_d FROM PUBLIC;`,
  );
  // The baseline: nothing to report, in either database, for either role.
  for (const svc of [A, B]) assert.deepEqual(findings(svc), []);
  assert.deepEqual(foreign(A.db, A.runtime, B), []);
  assert.deepEqual(foreign(B.db, B.runtime, A), []);
});

after(() => {
  for (const db of [A.db, B.db, SCRATCH]) {
    psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, { database: 'postgres' });
  }
  psql(SHARED_CLEANUP, { database: 'postgres' });
  const existing = ROLES.filter(
    (role) =>
      psql(`SELECT 1 FROM pg_roles WHERE rolname = '${role}'`, {
        database: 'postgres',
      }).stdout.trim() === '1',
  );
  if (existing.length > 0) {
    // DROP OWNED in `postgres` also takes their grants on shared objects.
    psql(`DROP OWNED BY ${existing.join(', ')} CASCADE`, { database: 'postgres' });
    for (const role of existing) psql(`DROP ROLE IF EXISTS ${role}`, { database: 'postgres' });
  }
});

// ---------------------------------------------------------------------------
// F1, the review's first exploit: SET on session_replication_role lets SQL
// running as the service switch ordinary triggers — economic's immutability
// guards — off. pg_parameter_acl is cluster-wide: the role's own check sees it.
// ---------------------------------------------------------------------------
test('parameter ACL: SET and ALTER SYSTEM on session_replication_role — its own, PUBLIC, a member role — reported, revoked, refused (#540 r1 F1)', () => {
  for (const path of paths(A)) {
    path.enter?.();
    ok(`GRANT SET, ALTER SYSTEM ON PARAMETER session_replication_role TO ${path.grantee}`, {
      database: 'postgres',
    });
    const found = findings(A);
    for (const privilege of ['SET', 'ALTER SYSTEM']) {
      has(
        found,
        `${privilege} on parameter session_replication_role, granted to ${path.label}, beyond the built-in privileges`,
      );
    }
    splitOk(A);
    assert.deepEqual(findings(A), [], path.name);
    for (const privilege of ['SET', 'ALTER SYSTEM']) {
      assert.equal(
        truth(
          `has_parameter_privilege('${A.runtime}', 'session_replication_role', '${privilege}')`,
        ),
        'false',
        `${path.name}: ${privilege}`,
      );
    }
    refused(
      'SET session_replication_role = replica',
      { role: A.runtime },
      /permission denied to set parameter "session_replication_role"/,
    );
    path.leave?.();
  }
});

// ---------------------------------------------------------------------------
// F1, the second: a grant on pg_authid — table or column — in the system
// catalogue the old namespace filter skipped. A grant on a catalogue lives in
// the database it was made in: in another service's database it is a foreign
// right there (F2), which that service's split revokes.
// ---------------------------------------------------------------------------
test('system catalogue: SELECT, UPDATE on pg_authid, table and column — its own, PUBLIC, a member role — reported, revoked, refused (#540 r1 F1)', () => {
  for (const path of paths(A)) {
    path.enter?.();
    ok(
      `GRANT SELECT, UPDATE ON pg_catalog.pg_authid TO ${path.grantee};
       GRANT SELECT (rolpassword), UPDATE (rolsuper) ON pg_catalog.pg_authid TO ${path.grantee}`,
    );
    const found = findings(A);
    const to = `granted to ${path.label}, beyond the built-in privileges`;
    has(found, `SELECT on system table pg_catalog.pg_authid, ${to}`);
    has(found, `UPDATE on system table pg_catalog.pg_authid, ${to}`);
    has(found, `SELECT on system column pg_catalog.pg_authid (rolpassword), ${to}`);
    has(found, `UPDATE on system column pg_catalog.pg_authid (rolsuper), ${to}`);
    splitOk(A);
    assert.deepEqual(findings(A), [], path.name);
    for (const privilege of ['SELECT', 'UPDATE']) {
      assert.equal(
        truth(
          `has_table_privilege('${A.runtime}', 'pg_catalog.pg_authid', '${privilege}')
           OR has_any_column_privilege('${A.runtime}', 'pg_catalog.pg_authid', '${privilege}')`,
        ),
        'false',
        `${path.name}: ${privilege}`,
      );
    }
    refused(
      'SELECT count(*) FROM pg_catalog.pg_authid',
      { role: A.runtime },
      /permission denied for table pg_authid/,
    );
    path.leave?.();
  }
});

test("…and the same grant in ANOTHER service's database: a foreign right there, revoked by that service's split (#540 r1 F2)", () => {
  for (const path of paths(A).filter(({ grantee }) => grantee !== 'PUBLIC')) {
    path.enter?.();
    ok(`GRANT SELECT ON pg_catalog.pg_authid TO ${path.grantee}`, { database: B.db });
    has(
      foreign(B.db, B.runtime, A),
      `${A.runtime}: SELECT on table pg_catalog.pg_authid, through ${path.via}`,
    );
    splitOk(B);
    assert.deepEqual(foreign(B.db, B.runtime, A), [], path.name);
    assert.equal(
      truth(`has_table_privilege('${A.runtime}', 'pg_catalog.pg_authid', 'SELECT')`, B.db),
      'false',
    );
    path.leave?.();
  }
  // PUBLIC's grant in B's database is B's own finding (every role shares it).
  ok('GRANT SELECT ON pg_catalog.pg_authid TO PUBLIC', { database: B.db });
  has(findings(B), /^SELECT on system table pg_catalog\.pg_authid, granted to PUBLIC/);
  has(
    foreign(B.db, B.runtime, A),
    `${A.runtime}: SELECT on table pg_catalog.pg_authid, through PUBLIC`,
  );
  splitOk(B);
  assert.deepEqual(findings(B), []);
  assert.deepEqual(foreign(B.db, B.runtime, A), []);
});

// ---------------------------------------------------------------------------
// F1: REPLICATION in the attribute checks, the dangerous-membership list and
// both reset statements. PUBLIC holds no attribute: two paths.
// ---------------------------------------------------------------------------
test('REPLICATION — held, or reached through a member role — reported by the check and the startup guard, reset by the split (#540 r1 F1)', () => {
  ok(`ALTER ROLE ${A.runtime} REPLICATION`, { database: 'postgres' });
  has(findings(A), 'is REPLICATION');
  assert.ok(startupProblems(A).includes('holds REPLICATION'), startupProblems(A).join('\n'));
  splitOk(A);
  assert.equal(
    truth(`(SELECT rolreplication FROM pg_roles WHERE rolname = '${A.runtime}')`),
    'false',
  );
  assert.deepEqual(findings(A), []);
  assert.deepEqual(startupProblems(A), []);

  ok(`GRANT ${REPL} TO ${A.runtime}`, { database: 'postgres' });
  has(findings(A), `member of ${REPL} (could SET ROLE to an owner or superuser-capable role)`);
  assert.ok(
    startupProblems(A).some((problem) => problem.startsWith(`is a member of ${REPL}`)),
    startupProblems(A).join('\n'),
  );
  splitOk(A);
  assert.equal(truth(`pg_has_role('${A.runtime}', '${REPL}', 'MEMBER')`), 'false');
  assert.deepEqual(findings(A), []);
  refused(`SET ROLE ${REPL}`, { role: A.runtime }, /permission denied to set role/);
});

// ---------------------------------------------------------------------------
// F1, beyond ACLs: a setting a superuser stored for the role, for the role in
// its database, or for its database — applied at every login, unchecked —
// switches the triggers off as surely as the parameter grant above.
// ---------------------------------------------------------------------------
test('a stored session_replication_role — the role, the role in its database, the database — reported, reset by the split, refused (#540 r1 F1)', () => {
  const label = (scope) =>
    // The parameter and its scope, never its value (#540 r2 R2-3).
    `a stored setting reaches its sessions: session_replication_role (${scope})`;
  for (const [store, scope] of [
    [
      `ALTER ROLE ${A.runtime} SET session_replication_role = replica`,
      `role ${A.runtime}, every database`,
    ],
    [
      `ALTER ROLE ${A.runtime} IN DATABASE ${A.db} SET session_replication_role = replica`,
      `role ${A.runtime} in database ${A.db}`,
    ],
    [
      `ALTER DATABASE ${A.db} SET session_replication_role = replica`,
      `every role in database ${A.db}`,
    ],
  ]) {
    ok(store, { database: 'postgres' });
    has(findings(A), label(scope));
    splitOk(A);
    assert.deepEqual(findings(A), [], scope);
    assert.equal(ok('SHOW session_replication_role', { role: A.runtime }), 'origin', scope);
    refused(
      'SET session_replication_role = replica',
      { role: A.runtime },
      /permission denied to set parameter "session_replication_role"/,
    );
  }
  // The allowed ones stay: the split's own TimeZone, a configured statement_timeout.
  ok(`ALTER ROLE ${A.runtime} IN DATABASE ${A.db} SET statement_timeout = '5s'`, {
    database: 'postgres',
  });
  splitOk(A);
  assert.equal(ok('SHOW statement_timeout', { role: A.runtime }), '5s');
  assert.equal(ok('SHOW TimeZone', { role: A.runtime }), 'UTC');
  assert.deepEqual(findings(A), []);
});

// ---------------------------------------------------------------------------
// F1: ownership through membership, for a class the old checks never named.
// A member of a role owning only a publication could SET ROLE and drop it.
// ---------------------------------------------------------------------------
test('a publication: owned through a member role, owned directly, owned by another service — reported, taken away, refused (#540 r1 F1, F2)', () => {
  const pub = (name) => `${TAG}_${name}`;
  ok(
    `CREATE PUBLICATION ${pub('via')}; ALTER PUBLICATION ${pub('via')} OWNER TO ${PUB_OWNER};
     CREATE PUBLICATION ${pub('own')}; ALTER PUBLICATION ${pub('own')} OWNER TO ${A.runtime};
     CREATE PUBLICATION ${pub('other')}; ALTER PUBLICATION ${pub('other')} OWNER TO ${B.runtime};
     CREATE PUBLICATION ${pub('otherv')}; ALTER PUBLICATION ${pub('otherv')} OWNER TO ${GROUP};`,
  );
  ok(`GRANT ${PUB_OWNER} TO ${A.runtime}; GRANT ${GROUP} TO ${B.runtime}`, {
    database: 'postgres',
  });
  const found = findings(A);
  has(found, `owns publication ${pub('via')}, through ${PUB_OWNER}`);
  has(found, `member of ${PUB_OWNER} (could SET ROLE to an owner or superuser-capable role)`);
  has(found, `owns publication ${pub('own')}`);
  const other = foreign(A.db, A.runtime, B);
  has(other, `${B.runtime} owns publication ${pub('other')}`);
  has(other, `${B.runtime} owns publication ${pub('otherv')}, through ${GROUP}`);

  splitOk(A);
  assert.deepEqual(findings(A), []);
  assert.deepEqual(foreign(A.db, A.runtime, B), []);
  assert.equal(truth(`pg_has_role('${A.runtime}', '${PUB_OWNER}', 'MEMBER')`), 'false');
  assert.equal(truth(`pg_has_role('${B.runtime}', '${GROUP}', 'MEMBER')`), 'false');
  assert.equal(
    ok(
      `SELECT string_agg(pubname || '=' || pg_get_userbyid(pubowner), ' ' ORDER BY pubname)
         FROM pg_publication WHERE pubname IN ('${pub('own')}', '${pub('other')}')`,
    ),
    `${pub('other')}=${A.migrator} ${pub('own')}=${A.migrator}`,
  );
  refused(`SET ROLE ${PUB_OWNER}`, { role: A.runtime }, /permission denied to set role/);
  refused(`DROP PUBLICATION ${pub('own')}`, { role: A.runtime }, /must be owner of publication/);
  // GROUP owns nothing again: the later tests' plain member role.
  ok(`DROP PUBLICATION ${['via', 'own', 'other', 'otherv'].map(pub).join(', ')}`);
});

// ---------------------------------------------------------------------------
// F2, the review's trigger: another service's runtime role reading `a`'s
// data — every right a database, schema, table, column, sequence, routine and
// default privilege carries, through each path. Afterwards it can neither
// connect nor, connected by other means, read.
// ---------------------------------------------------------------------------
test("another service's runtime role in this database — its own, PUBLIC, a member role: CONNECT, TEMPORARY and every object right reported, revoked; connecting AND reading refused (#540 r1 F2)", () => {
  for (const path of paths(B)) {
    path.enter?.();
    const g = path.grantee;
    ok(`GRANT CONNECT, TEMPORARY ON DATABASE ${A.db} TO ${g}`, { database: 'postgres' });
    ok(
      `GRANT USAGE ON SCHEMA vault TO ${g};
       GRANT SELECT ON vault.event TO ${g};
       GRANT SELECT (body) ON vault.event TO ${g};
       GRANT USAGE, SELECT ON SEQUENCE vault.event_seq TO ${g};
       GRANT EXECUTE ON FUNCTION vault.peek() TO ${g};
       ALTER DEFAULT PRIVILEGES FOR ROLE ${A.migrator} IN SCHEMA vault GRANT SELECT ON TABLES TO ${g};`,
    );
    const found = foreign(A.db, A.runtime, B);
    const via = `through ${path.via}`;
    for (const expected of [
      `${B.runtime}: CONNECT on database ${A.db}, ${via}`,
      `${B.runtime}: TEMPORARY on database ${A.db}, ${via}`,
      `${B.runtime} can CONNECT to database ${A.db}`,
      `${B.runtime}: USAGE on schema vault, ${via}`,
      `${B.runtime}: SELECT on table vault.event, ${via}`,
      `${B.runtime}: SELECT on column vault.event (body), ${via}`,
      `${B.runtime}: USAGE on sequence vault.event_seq, ${via}`,
      `${B.runtime}: SELECT on sequence vault.event_seq, ${via}`,
      `${B.runtime}: EXECUTE on routine vault.peek(), ${via}`,
      `${B.runtime}: SELECT on default TABLES of ${A.migrator} in schema vault, ${via}`,
    ]) {
      has(found, expected);
    }

    splitOk(A);
    assert.deepEqual(foreign(A.db, A.runtime, B), [], path.name);
    assert.deepEqual(findings(A), [], path.name);
    assert.equal(
      truth(
        `has_database_privilege('${B.runtime}', '${A.db}', 'CONNECT')
         OR has_database_privilege('${B.runtime}', '${A.db}', 'TEMPORARY')
         OR has_schema_privilege('${B.runtime}', 'vault', 'USAGE')
         OR has_table_privilege('${B.runtime}', 'vault.event', 'SELECT')
         OR has_any_column_privilege('${B.runtime}', 'vault.event', 'SELECT')
         OR has_sequence_privilege('${B.runtime}', 'vault.event_seq', 'USAGE')
         OR has_function_privilege('${B.runtime}', 'vault.peek()', 'EXECUTE')
         OR EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) e
                     WHERE d.defaclrole = '${A.migrator}'::regrole
                       AND e.grantee NOT IN ('${A.runtime}'::regrole, '${A.migrator}'::regrole))`,
      ),
      'false',
      path.name,
    );
    // Connecting is refused…
    refused('SELECT 1', { role: B.runtime, database: A.db }, /permission denied for database/);
    // …and so is reading, on a session the superuser hands it.
    refused(
      `SET ROLE ${B.runtime}; SELECT body FROM vault.event`,
      {},
      /permission denied for schema vault/,
    );
    path.leave?.();
  }
});

test("…and a membership in this database's runtime role itself — another service's, a plain role's: reported, revoked; connecting refused (#540 r1 F2)", () => {
  ok(`GRANT ${A.runtime} TO ${B.runtime}`, { database: 'postgres' });
  has(findings(A), `role ${B.runtime} is a member of the runtime role`);
  const found = foreign(A.db, A.runtime, B);
  has(found, `${B.runtime}: CONNECT on database ${A.db}, through ${A.runtime}`);
  has(found, `${B.runtime} can CONNECT to database ${A.db}`);
  splitOk(A);
  assert.equal(truth(`pg_has_role('${B.runtime}', '${A.runtime}', 'MEMBER')`), 'false');
  assert.deepEqual(findings(A), []);
  assert.deepEqual(foreign(A.db, A.runtime, B), []);
  refused('SELECT 1', { role: B.runtime, database: A.db }, /permission denied for database/);
  // A plain role — no service's, owning nothing — reaches every grant of the
  // runtime role it is a member of too: reported, and the split revokes it.
  const member = `${TAG}_member`;
  try {
    ok(`CREATE ROLE ${member} NOLOGIN; GRANT ${A.runtime} TO ${member}`, { database: 'postgres' });
    has(findings(A), `role ${member} is a member of the runtime role`);
    splitOk(A);
    assert.equal(truth(`pg_has_role('${member}', '${A.runtime}', 'MEMBER')`), 'false');
    assert.deepEqual(findings(A), []);
  } finally {
    psql(`DROP ROLE IF EXISTS ${member}`, { database: 'postgres' });
  }
});

// ---------------------------------------------------------------------------
// F1: every other ACL the inventory holds. Each class where PostgreSQL lets
// the path grant it: PUBLIC already holds USAGE on a type or a language and
// EXECUTE on a routine by default, and holds no grant option — so those take
// their own and a member role's grant (with the grant option where PUBLIC's
// built-in would hide the right).
// ---------------------------------------------------------------------------
test('every other ACL class — large object, foreign-data wrapper, server, tablespace, type, domain, language, default for types, system and extension routine — reported, revoked (#540 r1 F1)', () => {
  const lo = ok('SELECT lo_create(0)');
  const t = `public.${TAG}_t`;
  const d = `public.${TAG}_d`;
  const classes = [
    {
      grant: (g) => `GRANT SELECT, UPDATE ON LARGE OBJECT ${lo} TO ${g}`,
      label: `SELECT on large object ${lo}`,
      held: `EXISTS (SELECT 1 FROM pg_largeobject_metadata m, aclexplode(m.lomacl) e
                      WHERE m.oid = ${lo} AND (e.grantee = 0
                        OR pg_has_role('${A.runtime}', e.grantee, 'MEMBER')))`,
      public: true,
    },
    {
      grant: (g) => `GRANT USAGE ON FOREIGN DATA WRAPPER ${TAG}_fdw TO ${g}`,
      label: `USAGE on foreign-data wrapper ${TAG}_fdw`,
      held: `has_foreign_data_wrapper_privilege('${A.runtime}', '${TAG}_fdw', 'USAGE')`,
      public: true,
    },
    {
      grant: (g) => `GRANT USAGE ON FOREIGN SERVER ${TAG}_srv TO ${g}`,
      label: `USAGE on server ${TAG}_srv`,
      held: `has_server_privilege('${A.runtime}', '${TAG}_srv', 'USAGE')`,
      public: true,
    },
    {
      grant: (g) => `GRANT CREATE ON TABLESPACE pg_default TO ${g}`,
      label: 'CREATE on tablespace pg_default',
      held: `has_tablespace_privilege('${A.runtime}', 'pg_default', 'CREATE')`,
      public: true,
    },
    {
      grant: (g) =>
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${A.migrator} IN SCHEMA public GRANT USAGE ON TYPES TO ${g}`,
      label: `USAGE on default TYPES of ${A.migrator} in schema public`,
      held: `EXISTS (SELECT 1 FROM pg_default_acl x, aclexplode(x.defaclacl) e
                      WHERE x.defaclobjtype = 'T' AND (e.grantee = 0
                        OR pg_has_role('${A.runtime}', e.grantee, 'MEMBER')))`,
      public: true,
    },
    {
      grant: (g) => `GRANT EXECUTE ON FUNCTION pg_catalog.pg_stat_reset() TO ${g}`,
      label: 'EXECUTE on system routine pg_stat_reset()',
      held: `has_function_privilege('${A.runtime}', 'pg_catalog.pg_stat_reset()', 'EXECUTE')`,
      public: true,
    },
    {
      grant: (g) => `GRANT USAGE ON TYPE ${t} TO ${g}`,
      label: `USAGE on type ${t}`,
      held: `has_type_privilege('${A.runtime}', '${t}', 'USAGE')`,
    },
    {
      grant: (g) => `GRANT USAGE ON DOMAIN ${d} TO ${g}`,
      label: `USAGE on type ${d}`,
      held: `has_type_privilege('${A.runtime}', '${d}', 'USAGE')`,
    },
    {
      grant: (g) => `GRANT USAGE ON LANGUAGE plpgsql TO ${g} WITH GRANT OPTION`,
      // PUBLIC's built-in USAGE is not this grantee's: the whole entry goes.
      label: /^USAGE on (extension )?language plpgsql/,
      held: `has_language_privilege('${A.runtime}', 'plpgsql', 'USAGE WITH GRANT OPTION')`,
    },
    {
      grant: (g) => `GRANT EXECUTE ON FUNCTION digest(text, text) TO ${g} WITH GRANT OPTION`,
      label: /^EXECUTE on extension routine (public\.)?digest\(text,text\)/,
      held: `has_function_privilege('${A.runtime}', 'digest(text, text)', 'EXECUTE WITH GRANT OPTION')`,
    },
  ];
  for (const path of paths(A)) {
    path.enter?.();
    const applicable = classes.filter((c) => path.grantee !== 'PUBLIC' || c.public);
    for (const c of applicable) ok(c.grant(path.grantee));
    const found = findings(A);
    for (const c of applicable) {
      const suffix = `, granted to ${path.label}, beyond the built-in privileges`;
      has(
        found,
        typeof c.label === 'string'
          ? `${c.label}${suffix}`
          : new RegExp(`${c.label.source}, granted to ${path.label}, beyond`),
      );
    }
    splitOk(A);
    assert.deepEqual(findings(A), [], path.name);
    for (const c of applicable) assert.equal(truth(c.held), 'false', `${path.name}: ${c.label}`);
    path.leave?.();
  }
  // The large object's one plain attempt.
  refused(`SELECT lo_get(${lo})`, { role: A.runtime }, /permission denied for large object/);
});

// ---------------------------------------------------------------------------
// F1, fail closed: a catalogue ACL column the inventory does not model — what
// a later PostgreSQL's new one would be — is a finding for the check and a
// failure for the split, never a silent pass. Shown by forgetting one.
// ---------------------------------------------------------------------------
test('an ACL column the inventory does not model: the check reports it and the split fails (#540 r1 F1)', () => {
  const modeled = "('pg_tablespace', 'spcacl'), ";
  assert.equal(FINDINGS_SQL.split(modeled).length, 2, 'the inventory names spcacl once');
  const unmodeled = lines(
    ok(FINDINGS_SQL.replace(modeled, ''), {
      database: A.db,
      variables: { runtime: A.runtime, policy: 'default' },
    }),
  );
  has(
    unmodeled,
    'the ACL column pg_tablespace.spcacl is not modeled (runtime-acl-entries.sql): nothing checks it',
  );

  const dir = mkdtempSync(join(tmpdir(), 'd540-lib-'));
  try {
    cpSync(LIB, dir, { recursive: true });
    const file = join(dir, 'runtime-acl-entries.sql');
    writeFileSync(file, readFileSync(file, 'utf8').replace(modeled, ''));
    const result = split(A, dir);
    assert.notEqual(result.status, 0, 'the split passed with an unmodeled ACL column');
    assert.match(result.stderr, /pg_tablespace\.spcacl is not modeled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The real files: nothing unmodeled on this PostgreSQL.
  splitOk(A);
  assert.deepEqual(findings(A), []);
});

// ---------------------------------------------------------------------------
// F2: the matrix's other half — a database no service owns. PostgreSQL's
// default lets PUBLIC in; only lib/runtime-foreign-exceptions.sql's rows may
// keep that, so an unlisted database is a finding for every runtime role.
// ---------------------------------------------------------------------------
test('a database no service owns refuses every runtime role unless runtime-foreign-exceptions.sql declares it (#540 r1 F2)', () => {
  // A user routine there: PostgreSQL's default EXECUTE for PUBLIC counts — a
  // SECURITY DEFINER one would run as its owner — though its ACL is NULL.
  const probe = `${TAG}_probe`;
  ok(`CREATE FUNCTION public.${probe}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`, {
    database: SCRATCH,
  });
  assert.equal(
    ok(`SELECT proacl IS NULL FROM pg_proc WHERE proname = '${probe}'`, { database: SCRATCH }),
    't',
  );
  for (const svc of [A, B]) {
    const found = foreign(SCRATCH, '', svc);
    has(found, `${svc.runtime}: CONNECT on database ${SCRATCH}, through PUBLIC`);
    has(found, `${svc.runtime}: TEMPORARY on database ${SCRATCH}, through PUBLIC`);
    has(found, `${svc.runtime} can CONNECT to database ${SCRATCH}`);
    has(found, `${svc.runtime}: EXECUTE on routine ${probe}(), through PUBLIC`);
  }
  ok(`REVOKE EXECUTE ON FUNCTION public.${probe}() FROM PUBLIC`, { database: SCRATCH });
  ok(`REVOKE ALL ON DATABASE ${SCRATCH} FROM PUBLIC`, { database: 'postgres' });
  for (const svc of [A, B]) assert.deepEqual(foreign(SCRATCH, '', svc), []);
  // The declared ones: PUBLIC's default stays, and nothing else is let in.
  for (const database of ['postgres', 'template1']) {
    for (const svc of [A, B]) assert.deepEqual(foreign(database, '', svc), [], database);
  }
});

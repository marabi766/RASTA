// -----------------------------------------------------------------------------
// #540 round 2 on a real cluster: the split's end state, its cleanup order
// across scopes, what its errors and the check print, and the databases the
// check visits.
//
//   pnpm test:db-runtime-privileges      (a PostgreSQL superuser in PG* env)
//
//   * R2-1 — a statement that silently does nothing still fails the split.
//     `psql` is wrapped so that ONE family's statement is dropped (it "succeeds"
//     without running), after the damage that statement repairs is planted:
//     the split must fail on its end-state check, naming what is wrong. Then
//     the real split repairs it. (scripts/service-privilege-split-faults.test.mjs
//     fails each statement outright, with no database.)
//   * R2-4 — a grantor keeps the schema USAGE it needs until every scope's
//     objects are revoked: general → extension, general → foreign, and the
//     initial PUBLIC revokes → general, in both entry points.
//   * R2-3 — a stored setting's value never reaches the check's report or the
//     split's error: a sentinel secret is stored, and looked for.
//   * R2-2 — the check visits a database by its literal name: names that libpq
//     would read as a connection string, and one a line-based list would split
//     in two, are each visited, once, as themselves.
//
// Roles and databases are `…e540<pid>…`, dropped afterwards. Needs `psql`, a
// superuser (PGHOST, PGPORT, PGUSER, PGPASSWORD) and pgcrypto in template1
// (the bootstrap installs it).
// -----------------------------------------------------------------------------
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTABLE_DATABASES_SQL,
  FINDINGS_SQL,
  FOREIGN_FINDINGS_SQL,
  matrix,
  parseDatabases,
  psqlRows,
  verdict,
} from './check-db-runtime-privileges-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'infrastructure/docker/postgres/lib');
const TAG = `e540${process.pid}`;
const SUPERUSER = process.env.PGUSER;
const PASSWORD = {};
const service = (suffix) => {
  const name = `${TAG}${suffix}`;
  const runtime = `rasta_${name}`;
  const migrator = `${runtime}_migrator`;
  PASSWORD[runtime] = `rt_${randomBytes(12).toString('hex')}`;
  PASSWORD[migrator] = `mg_${randomBytes(12).toString('hex')}`;
  return { service: name, db: runtime, runtime, migrator };
};
/** Split as a default-grants service; `U` as audit; `B` is another service. */
const A = service('a');
const U = service('u');
const B = service('b');
// `aaa…` sorts before every other grantor, so its REVOKE is tried first.
const GRANTOR = `aaa${TAG}g`;
const OUTSIDER = `aaa${TAG}x`;
const PUBLIC_GRANTOR = `aaa${TAG}p`;
const GROUP = `${TAG}_group`;
const ROLES = [A.runtime, A.migrator, U.runtime, U.migrator, B.runtime, B.migrator];
const PLAIN_ROLES = [GRANTOR, OUTSIDER, PUBLIC_GRANTOR, GROUP];
/** Databases whose names libpq or a line reader would misread (R2-2). */
const ODD_DATABASES = [
  `dbname=postgres application_name=${TAG}`,
  `postgresql:///postgres?application_name=${TAG}`,
  `postgres|t\npostgres|t\n${TAG}`,
  `it's a \\ name ${TAG}`,
];
const SENTINEL = `sentinel-secret-${randomBytes(8).toString('hex')}`;

/** psql as `role` (the superuser when omitted), SQL on stdin. */
function psql(sql, { role, database = A.db } = {}) {
  const env = { ...process.env };
  if (role) {
    env.PGUSER = role;
    env.PGPASSWORD = PASSWORD[role];
  }
  return spawnSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', database], {
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

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * `psql` first on PATH that drops (does not run, answers success) the stdin
 * SQL matching DROP_SQL — a statement that silently did nothing — and runs
 * every other call; or, with REDIRECT_SQL, sends a matching call to database
 * `postgres` instead.
 */
const WRAPPER = mkdtempSync(join(tmpdir(), 'rasta-split-noop-'));
const REAL_PSQL = spawnSync('bash', ['-c', 'command -v psql'], { encoding: 'utf8' }).stdout.trim();
writeFileSync(
  join(WRAPPER, 'psql'),
  `#!/bin/bash
if [[ " $* " == *" -f - "* ]]; then
  sql="$(cat)"
  if [[ -n "\${DROP_SQL:-}" && "$sql" =~ $DROP_SQL ]]; then
    echo dropped >> "${WRAPPER}/dropped"; exit 0
  fi
  args=("$@")
  if [[ -n "\${REDIRECT_SQL:-}" && "$sql" =~ $REDIRECT_SQL ]]; then
    for i in "\${!args[@]}"; do [[ "\${args[$i]}" == --dbname ]] && args[$((i + 1))]=postgres; done
    echo redirected >> "${WRAPPER}/dropped"
  fi
  printf '%s\\n' "$sql" | "${REAL_PSQL}" "\${args[@]}"; exit $?
fi
exec "${REAL_PSQL}" "$@"
`,
);
chmodSync(join(WRAPPER, 'psql'), 0o755);

/** Runs a split of `svc` (audit's when `audit`), through the wrapper when `drop`/`redirect` are set. */
function split(svc, { audit = false, drop, redirect, env = {} } = {}) {
  rmSync(join(WRAPPER, 'dropped'), { force: true });
  const call = audit
    ? `split_audit_database_privileges ${svc.db} ${svc.service}`
    : `split_service_privileges ${svc.service} ${svc.db} default`;
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "${join(LIB, 'service-privilege-split.bash')}"
       declare -gA ROLE_PASSWORDS=([${svc.migrator}]=${PASSWORD[svc.migrator]})
       ${call} || exit 1`,
    ],
    {
      env: {
        ...process.env,
        POSTGRES_USER: SUPERUSER,
        ...(drop || redirect ? { PATH: `${WRAPPER}:${process.env.PATH}` } : {}),
        ...(drop ? { DROP_SQL: drop } : {}),
        ...(redirect ? { REDIRECT_SQL: redirect } : {}),
        ...env,
      },
      encoding: 'utf8',
    },
  );
  const wrapped = spawnSync('bash', ['-c', `cat "${join(WRAPPER, 'dropped')}" 2>/dev/null`], {
    encoding: 'utf8',
  }).stdout;
  return { ...result, wrapped };
}

function splitOk(svc, options) {
  const result = split(svc, options);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const findings = (svc) =>
  psqlRows(svc.db, FINDINGS_SQL, { runtime: svc.runtime, policy: svc === U ? 'audit' : 'default' });
const foreign = (database, runtime, of) =>
  psqlRows(database, FOREIGN_FINDINGS_SQL, { runtime }).filter((line) =>
    line.startsWith(of.runtime),
  );

before(() => {
  assert.ok(SUPERUSER, 'PGUSER must name a superuser');
  for (const svc of [A, U, B]) {
    ok(`CREATE ROLE ${svc.runtime} LOGIN PASSWORD '${PASSWORD[svc.runtime]}'`, {
      database: 'postgres',
    });
    ok(`CREATE DATABASE ${svc.db} OWNER ${svc.runtime}`, { database: 'postgres' });
    splitOk(svc, { audit: svc === U });
  }
  ok(
    `CREATE ROLE ${GRANTOR} NOLOGIN; CREATE ROLE ${OUTSIDER} NOLOGIN;
     CREATE ROLE ${PUBLIC_GRANTOR} NOLOGIN; CREATE ROLE ${GROUP} NOLOGIN;`,
    { database: 'postgres' },
  );
  ok('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  ok(
    `CREATE SCHEMA vault;
     CREATE TABLE vault.event (id integer PRIMARY KEY, body text NOT NULL);
     CREATE TABLE public.r2_table (id integer PRIMARY KEY);`,
    { role: A.migrator },
  );
  ok(`CREATE TABLE audit.r2_table (id integer PRIMARY KEY)`, { role: U.migrator, database: U.db });
  for (const svc of [A, U, B]) assert.deepEqual(findings(svc), [], svc.service);
});

after(() => {
  rmSync(WRAPPER, { recursive: true, force: true });
  for (const db of [A.db, U.db, B.db, ...ODD_DATABASES]) {
    psql(`DROP DATABASE IF EXISTS ${quoteIdent(db)} WITH (FORCE)`, { database: 'postgres' });
  }
  const existing = [...ROLES, ...PLAIN_ROLES].filter(
    (role) =>
      psql(`SELECT 1 FROM pg_roles WHERE rolname = '${role}'`, {
        database: 'postgres',
      }).stdout.trim() === '1',
  );
  if (existing.length > 0) {
    psql(`DROP OWNED BY ${existing.join(', ')} CASCADE`, { database: 'postgres' });
    for (const role of existing) psql(`DROP ROLE IF EXISTS ${role}`, { database: 'postgres' });
  }
});

// ---------------------------------------------------------------------------
// R2-1: each family of the split, its statement silently skipped after the
// damage it repairs is planted — the split must fail at its end-state check,
// naming the damage; the real split then repairs it, and nothing is reported.
// ---------------------------------------------------------------------------
const STATEMENT_TIMEOUT = `POSTGRES_STATEMENT_TIMEOUT_MS_${A.service.toUpperCase()}`;
const NOOP_CASES = [
  {
    family: 'attribute reset',
    plant: `ALTER ROLE ${A.runtime} REPLICATION`,
    database: 'postgres',
    drop: 'NOREPLICATION',
    expect: new RegExp(`${A.runtime} keeps REPLICATION`),
  },
  {
    family: 'REASSIGN OWNED',
    plant: `CREATE TYPE public.r2_owned AS ENUM ('x'); ALTER TYPE public.r2_owned OWNER TO ${A.runtime}`,
    drop: 'REASSIGN OWNED BY',
    expect: new RegExp(`${A.runtime} still owns type (public\\.)?r2_owned`),
    after: 'DROP TYPE public.r2_owned',
  },
  {
    family: 'database ownership',
    plant: `ALTER DATABASE ${A.db} OWNER TO ${SUPERUSER}`,
    database: 'postgres',
    drop: `ALTER DATABASE ${A.db} OWNER TO`,
    expect: new RegExp(`database ${A.db} is owned by ${SUPERUSER}, not ${A.migrator}`),
  },
  {
    family: 'schema ownership',
    // The migrator keeps USAGE and CREATE, so every other step still works
    // and only the end-state check can notice.
    plant: `ALTER SCHEMA public OWNER TO ${SUPERUSER}; GRANT USAGE, CREATE ON SCHEMA public TO ${A.migrator}`,
    drop: 'ALTER SCHEMA public OWNER TO',
    expect: new RegExp(`schema public is owned by ${SUPERUSER}, not ${A.migrator}`),
  },
  {
    family: 'database grant (CONNECT)',
    plant: `REVOKE CONNECT ON DATABASE ${A.db} FROM ${A.runtime}`,
    database: 'postgres',
    drop: 'GRANT CONNECT ON DATABASE',
    expect: new RegExp(`${A.runtime} lacks CONNECT on database ${A.db}`),
  },
  {
    family: 'schema grant (USAGE)',
    plant: `REVOKE USAGE ON SCHEMA public FROM ${A.runtime}`,
    drop: 'GRANT USAGE ON SCHEMA',
    expect: new RegExp(`${A.runtime} lacks USAGE on schema public`),
  },
  {
    family: 'table grants',
    plant: `REVOKE INSERT ON public.r2_table FROM ${A.runtime}`,
    drop: 'GRANT %s ON ALL %s IN SCHEMA',
    expect: new RegExp(`${A.runtime} lacks INSERT on relation (public\\.)?r2_table`),
  },
  {
    family: 'default privileges',
    plant: `ALTER DEFAULT PRIVILEGES FOR ROLE ${A.migrator} IN SCHEMA public REVOKE INSERT ON TABLES FROM ${A.runtime}`,
    drop: 'GRANT %s ON ALL %s IN SCHEMA',
    expect: new RegExp(
      `${A.migrator} grants ${A.runtime} no default INSERT on new tables of public`,
    ),
  },
  {
    family: 'ledger creation',
    plant: 'DROP TABLE public._prisma_migrations',
    drop: 'CREATE TABLE IF NOT EXISTS',
    expect: /the migration ledger public\._prisma_migrations does not exist/,
  },
  {
    family: 'UTC setup',
    plant: `ALTER ROLE ${A.runtime} RESET TimeZone`,
    database: 'postgres',
    drop: "SET TimeZone = 'UTC'",
    expect: new RegExp(`no TimeZone = UTC default for role ${A.runtime}`),
  },
  {
    family: 'UTC setup, another zone left in place',
    plant: `ALTER ROLE ${A.runtime} IN DATABASE ${A.db} SET TimeZone = 'Asia/Tehran'`,
    database: 'postgres',
    drop: "SET TimeZone = 'UTC'",
    expect: new RegExp(`no TimeZone = UTC default for role ${A.runtime} in database ${A.db}`),
  },
  {
    family: 'stored settings (and no value in the error)',
    plant: `ALTER ROLE ${A.runtime} SET app.r2_token = '${SENTINEL}'`,
    database: 'postgres',
    drop: 'the split cannot reset',
    expect: new RegExp(
      `a stored setting reaches its sessions: app\\.r2_token \\(role ${A.runtime}, every database\\)`,
    ),
  },
  {
    family: 'migrator login',
    plant: `ALTER ROLE ${A.migrator} NOLOGIN`,
    database: 'postgres',
    drop: `ALTER ROLE ${A.migrator} WITH LOGIN PASSWORD`,
    expect: new RegExp(`role ${A.migrator} does not exist or cannot log in`),
  },
  {
    family: 'membership revoke',
    plant: `GRANT ${A.runtime} TO ${GROUP}`,
    database: 'postgres',
    drop: 'GRANTED BY %I CASCADE',
    expect: new RegExp(`${GROUP} is a member of ${A.runtime}`),
  },
  {
    family: 'statement timeout',
    plant: `ALTER ROLE ${A.runtime} IN DATABASE ${A.db} RESET statement_timeout`,
    database: 'postgres',
    drop: 'SET statement_timeout',
    env: { [STATEMENT_TIMEOUT]: '5000' },
    expect: new RegExp(`no statement_timeout = 5000ms for ${A.runtime} on ${A.db}`),
    after: `ALTER ROLE ${A.runtime} IN DATABASE ${A.db} RESET statement_timeout`,
    afterDatabase: 'postgres',
  },
  {
    family: 'audit schema ownership',
    svc: U,
    plant: `ALTER SCHEMA audit OWNER TO ${SUPERUSER}; GRANT USAGE, CREATE ON SCHEMA audit TO ${U.migrator}`,
    drop: 'ALTER SCHEMA audit OWNER TO',
    expect: new RegExp(`schema audit is owned by ${SUPERUSER}, not ${U.migrator}`),
  },
  {
    family: 'audit schema grant (USAGE)',
    svc: U,
    plant: `REVOKE USAGE ON SCHEMA audit FROM ${U.runtime}`,
    drop: 'GRANT USAGE ON SCHEMA audit',
    expect: new RegExp(`${U.runtime} lacks USAGE on schema audit`),
  },
  {
    family: 'audit ledger creation',
    svc: U,
    plant: 'DROP TABLE audit._prisma_migrations',
    drop: 'CREATE TABLE IF NOT EXISTS',
    expect: /the migration ledger audit\._prisma_migrations does not exist/,
  },
];

for (const c of NOOP_CASES) {
  test(`R2-1: ${c.family} skipped silently — the split fails on its end state, then repairs it`, () => {
    const svc = c.svc ?? A;
    const audit = svc === U;
    ok(c.plant, { database: c.database ?? svc.db });
    const skipped = split(svc, { audit, drop: c.drop, env: c.env });
    assert.match(skipped.wrapped, /dropped/, `nothing matched ${c.drop}: the case proves nothing`);
    assert.notEqual(skipped.status, 0, `the split succeeded:\n${skipped.stdout}`);
    assert.match(skipped.stderr, /the split did not reach its end state: /);
    assert.match(skipped.stderr, c.expect);
    assert.ok(
      !`${skipped.stdout}${skipped.stderr}`.includes(SENTINEL),
      'a setting value was printed',
    );
    splitOk(svc, { audit, env: c.env });
    if (c.after) ok(c.after, { database: c.afterDatabase ?? svc.db });
    assert.deepEqual(findings(svc), []);
  });
}

test('R2-1/R2-2: a session on the wrong database fails the end-state check', () => {
  const redirected = split(A, { redirect: 'the split did not reach its end state' });
  assert.match(redirected.wrapped, /redirected/);
  assert.notEqual(redirected.status, 0);
  assert.match(redirected.stderr, new RegExp(`connected to database postgres, not ${A.db}`));
});

test('R2-2: the split refuses a database or service name it would have to interpret', () => {
  for (const [svc, db] of [
    [A.service, 'dbname=postgres'],
    [A.service, 'postgresql:///postgres'],
    [A.service, `${A.db}; DROP`],
    [A.service, 'Upper'],
    [`${A.service}-x`, A.db],
  ]) {
    rmSync(join(WRAPPER, 'dropped'), { force: true });
    const result = spawnSync(
      'bash',
      [
        '-c',
        `source "${join(LIB, 'service-privilege-split.bash')}"
         declare -gA ROLE_PASSWORDS=([rasta_${svc}_migrator]=x)
         split_service_privileges "$1" "$2" default || exit 1`,
        'split',
        svc,
        db,
      ],
      {
        env: {
          ...process.env,
          POSTGRES_USER: SUPERUSER,
          PATH: `${WRAPPER}:${process.env.PATH}`,
          DROP_SQL: '.',
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(result.status, 0, db);
    assert.match(result.stderr, /unsupported (database|service) name/, db);
    assert.equal(
      spawnSync('bash', ['-c', `cat "${join(WRAPPER, 'dropped')}" 2>/dev/null`], {
        encoding: 'utf8',
      }).stdout,
      '',
      `${db}: SQL was sent`,
    );
  }
});

// ---------------------------------------------------------------------------
// R2-4: grant chains whose grantor's schema access another scope removes.
// ---------------------------------------------------------------------------
test('R2-4 general → extension: a closure grantor keeps USAGE on public until its extension routine REVOKE ran', () => {
  ok(`GRANT ${GRANTOR} TO ${A.runtime}`, { database: 'postgres' });
  ok(`GRANT USAGE ON SCHEMA public TO ${GRANTOR}`, { role: A.migrator });
  ok(`GRANT EXECUTE ON FUNCTION public.gen_salt(text) TO ${GRANTOR} WITH GRANT OPTION`);
  ok(`SET ROLE ${GRANTOR}; GRANT EXECUTE ON FUNCTION public.gen_salt(text) TO ${A.runtime}`);
  const found = findings(A);
  assert.ok(
    found.some((f) => f.includes(`USAGE on schema public, granted to ${GRANTOR}`)),
    found.join('\n'),
  );
  assert.ok(
    found.some((f) => f.includes('gen_salt') && f.includes(A.runtime)),
    found.join('\n'),
  );
  splitOk(A);
  assert.deepEqual(findings(A), []);
  assert.equal(
    ok(`SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x
         WHERE p.oid = 'public.gen_salt(text)'::regprocedure
           AND x.grantee IN ('${GRANTOR}'::regrole, '${A.runtime}'::regrole)`),
    '0',
  );
  ok(`REVOKE ${GRANTOR} FROM ${A.runtime}`, { database: 'postgres' });
});

test('R2-4 general → foreign: a grantor whose USAGE comes through a closure role keeps it until its foreign REVOKE ran', () => {
  ok(`GRANT ${GROUP} TO ${A.runtime}; GRANT ${GROUP} TO ${OUTSIDER}`, { database: 'postgres' });
  ok(
    `GRANT USAGE ON SCHEMA vault TO ${GROUP};
     GRANT SELECT ON vault.event TO ${OUTSIDER} WITH GRANT OPTION;`,
    { role: A.migrator },
  );
  ok(`SET ROLE ${OUTSIDER}; GRANT SELECT ON vault.event TO ${B.runtime}`);
  assert.ok(foreign(A.db, A.runtime, B).some((f) => f.includes('vault.event')));
  splitOk(A);
  assert.deepEqual(findings(A), []);
  assert.deepEqual(foreign(A.db, A.runtime, B), []);
  assert.equal(
    ok(`SELECT has_table_privilege('${B.runtime}', 'vault.event', 'SELECT')::text`),
    'false',
  );
  ok(`REVOKE ${GROUP} FROM ${A.runtime}; REVOKE ${GROUP} FROM ${OUTSIDER}`, {
    database: 'postgres',
  });
  ok(`REVOKE ALL ON vault.event FROM ${OUTSIDER} CASCADE`, { role: A.migrator });
});

for (const svc of [A, U]) {
  const schema = svc === U ? 'audit' : 'public';
  test(`R2-4 PUBLIC → general (${svc === U ? 'audit' : 'generic'} split): a grantor reaching ${schema} only through PUBLIC keeps it until its REVOKE ran`, () => {
    ok(
      `GRANT USAGE ON SCHEMA ${schema} TO PUBLIC;
       GRANT TRUNCATE ON ${schema}.r2_table TO ${PUBLIC_GRANTOR} WITH GRANT OPTION;`,
      { role: svc.migrator, database: svc.db },
    );
    ok(`SET ROLE ${PUBLIC_GRANTOR}; GRANT TRUNCATE ON ${schema}.r2_table TO ${svc.runtime}`, {
      database: svc.db,
    });
    assert.ok(findings(svc).some((f) => f.includes('TRUNCATE')));
    splitOk(svc, { audit: svc === U });
    assert.deepEqual(findings(svc), []);
    assert.equal(
      ok(`SELECT has_table_privilege('${svc.runtime}', '${schema}.r2_table', 'TRUNCATE')::text`, {
        database: svc.db,
      }),
      'false',
    );
    assert.equal(
      ok(`SELECT has_schema_privilege('${PUBLIC_GRANTOR}', '${schema}', 'USAGE')::text`, {
        database: svc.db,
      }),
      'false',
    );
    ok(`REVOKE ALL ON ${schema}.r2_table FROM ${PUBLIC_GRANTOR} CASCADE`, {
      role: svc.migrator,
      database: svc.db,
    });
  });
}

// ---------------------------------------------------------------------------
// R2-3: the value of a stored setting is never printed.
// ---------------------------------------------------------------------------
test('R2-3: a stored secret — reported and reset by name and scope; an unresettable one fails the split by name; the value never appears', () => {
  ok(`ALTER ROLE ${A.runtime} SET app.api_token = '${SENTINEL}'`, { database: 'postgres' });
  ok(`ALTER DATABASE ${A.db} SET app.db_token = '${SENTINEL}'`, { database: 'postgres' });
  const found = findings(A);
  assert.ok(
    found.includes(
      `a stored setting reaches its sessions: app.api_token (role ${A.runtime}, every database)`,
    ),
    found.join('\n'),
  );
  assert.ok(
    found.includes(
      `a stored setting reaches its sessions: app.db_token (every role in database ${A.db})`,
    ),
    found.join('\n'),
  );
  const report = verdict({ service: A.service }, found);
  assert.equal(report.ok, false);
  assert.ok(!report.line.includes(SENTINEL), report.line);
  assert.ok(!found.join('\n').includes(SENTINEL));
  // Resettable: the split resets both, printing no value.
  const reset = splitOk(A);
  assert.ok(!`${reset.stdout}${reset.stderr}`.includes(SENTINEL));
  assert.deepEqual(findings(A), []);
  // A name the split will not spell into a RESET (`$`, which PostgreSQL
  // allows in a custom name): it fails, naming the parameter only.
  ok(`ALTER ROLE ${A.runtime} SET "app.tok$en" = '${SENTINEL}'`, { database: 'postgres' });
  const refused = split(A);
  assert.notEqual(refused.status, 0);
  assert.match(
    refused.stderr,
    /cannot reset .*settings: a stored setting reaches its sessions: app\.tok\$en \(role/,
  );
  assert.ok(!`${refused.stdout}${refused.stderr}`.includes(SENTINEL), refused.stderr);
  assert.ok(!findings(A).join('\n').includes(SENTINEL));
  ok(`ALTER ROLE ${A.runtime} RESET "app.tok$en"`, { database: 'postgres' });
  splitOk(A);
  assert.deepEqual(findings(A), []);
});

// ---------------------------------------------------------------------------
// R2-2: the check visits each database as itself.
// ---------------------------------------------------------------------------
test('R2-2: databases named like a connection string, or with a newline and `|t`, are each visited once, as themselves', () => {
  for (const name of ODD_DATABASES) {
    ok(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`, { database: 'postgres' });
    ok(`CREATE DATABASE ${quoteIdent(name)}`, { database: 'postgres' });
  }
  const databases = parseDatabases(psqlRows('postgres', CONNECTABLE_DATABASES_SQL).join('\n'));
  const visits = matrix([], databases);
  for (const name of ODD_DATABASES) {
    const mine = visits.filter((v) => v.database === name);
    assert.equal(mine.length, 1, `${JSON.stringify(name)} visited ${mine.length} times`);
    // Connected to it, not to what libpq would have made of the name.
    assert.deepEqual(psqlRows(name, 'SELECT to_json(current_database());'), [JSON.stringify(name)]);
    // PostgreSQL's default lets PUBLIC in, and no exception names these: a finding.
    const found = foreign(name, '', A);
    assert.ok(
      found.some((f) => f.startsWith(`${A.runtime}: CONNECT on database`)),
      found.join('\n'),
    );
  }
  // `postgres` itself, which two of them would have been read as, is clean.
  assert.deepEqual(foreign('postgres', '', A), []);
  assert.equal(visits.filter((v) => v.database === 'postgres').length, 1);
  // And a connection that lands elsewhere is refused before any query runs.
  const elsewhere = (command, args, options) =>
    spawnSync(
      command,
      args.map((a) => (a.startsWith("dbname='") ? 'postgres' : a)),
      options,
    );
  assert.throws(
    () => psqlRows(ODD_DATABASES[3], 'SELECT 1;', {}, elsewhere),
    /connected to database postgres, not the one asked for/,
  );
  for (const name of ODD_DATABASES) {
    ok(`DROP DATABASE ${quoteIdent(name)}`, { database: 'postgres' });
  }
});

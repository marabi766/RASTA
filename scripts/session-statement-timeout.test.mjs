// The optional database-side statement_timeout for a service's runtime role
// (#268 r4, infrastructure/docker/postgres/lib/session-statement-timeout.bash).
//
// Behind PgBouncer the services' own `options=-c statement_timeout=…` never
// reaches the server, so a timeout there has to be the runtime role's default.
// The bootstrap, the per-service split and the password rotation set it — but
// only for a service whose POSTGRES_STATEMENT_TIMEOUT_MS_<SVC> asks for it.
//
// No database: `psql` is a stand-in on PATH that records the SQL it is given
// on stdin, so this checks exactly what would be sent, and that nothing is
// sent when the variable is unset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const LIB = join(ROOT, 'infrastructure', 'docker', 'postgres', 'lib');
const TIMEOUT_LIB = join(LIB, 'session-statement-timeout.bash');

/** Runs `ensure_runtime_statement_timeout svc db role` with `env`; returns the SQL psql received. */
function ensure(env, svc = 'fleet', db = 'rasta_fleet', role = 'rasta_fleet') {
  const dir = mkdtempSync(join(tmpdir(), 'rasta-st-'));
  try {
    const log = join(dir, 'psql.log');
    const psql = join(dir, 'psql');
    writeFileSync(psql, `#!/bin/bash\ncat >> "${log}"\n`);
    chmodSync(psql, 0o755);
    const run = spawnSync(
      'bash',
      [
        '-c',
        'set -euo pipefail; source "$1"; ensure_runtime_statement_timeout "$2" "$3" "$4"',
        'ensure',
        TIMEOUT_LIB,
        svc,
        db,
        role,
      ],
      {
        env: { PATH: `${dir}:${process.env.PATH}`, POSTGRES_USER: 'rasta', ...env },
        encoding: 'utf8',
      },
    );
    return {
      status: run.status,
      stderr: run.stderr,
      sql: existsSync(log) ? readFileSync(log, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('unset or empty: nothing is sent, so an existing setting stays as it is', () => {
  for (const env of [{}, { POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: '' }]) {
    const { status, sql } = ensure(env);
    assert.equal(status, 0);
    assert.equal(sql, '');
  }
});

test('set: the runtime role gets it on its own database, in milliseconds', () => {
  const { status, sql } = ensure({ POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: '70000' });
  assert.equal(status, 0);
  assert.equal(
    sql.trim(),
    "ALTER ROLE rasta_fleet IN DATABASE rasta_fleet SET statement_timeout = '70000ms';",
  );
});

test('each service reads its own variable', () => {
  const env = { POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: '70000' };
  assert.equal(ensure(env, 'asset', 'rasta_asset', 'rasta_asset').sql, '');
  assert.match(
    ensure({ POSTGRES_STATEMENT_TIMEOUT_MS_ASSET: '20000' }, 'asset', 'rasta_asset', 'rasta_asset')
      .sql,
    /ALTER ROLE rasta_asset IN DATABASE rasta_asset SET statement_timeout = '20000ms'/,
  );
});

test('both bounds of DATABASE_STATEMENT_TIMEOUT_MS are accepted', () => {
  assert.match(ensure({ POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: '1000' }).sql, /= '1000ms'/);
  assert.match(ensure({ POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: '3600000' }).sql, /= '3600000ms'/);
});

for (const value of [
  '0',
  '999',
  '3600001',
  '15s',
  '1e4',
  '-1',
  ' 5000',
  "5000'; DROP ROLE x; --",
]) {
  test(`refuses ${JSON.stringify(value)} and sends nothing`, () => {
    const { status, stderr, sql } = ensure({ POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: value });
    assert.notEqual(status, 0);
    assert.match(stderr, /POSTGRES_STATEMENT_TIMEOUT_MS_FLEET must be whole milliseconds/);
    assert.equal(sql, '');
  });
}

test('the split (every service, audit included) and the rotation apply it; never to the migrator', () => {
  const split = readFileSync(join(LIB, 'service-privilege-split.bash'), 'utf8');
  assert.equal(
    split.match(/ensure_runtime_statement_timeout "\$\{svc\}" "\$\{db\}" "\$\{runtime\}"/g)?.length,
    2,
    'split_service_privileges and split_audit_database_privileges',
  );
  const rotate = readFileSync(join(LIB, 'rotate-role-passwords.bash'), 'utf8');
  assert.match(rotate, /ensure_runtime_statement_timeout "\$\{svc\}" "\$\{db\}" "rasta_\$\{svc\}"/);
  for (const source of [split, rotate])
    assert.doesNotMatch(source, /ensure_runtime_statement_timeout[^\n]*migrator/);
});

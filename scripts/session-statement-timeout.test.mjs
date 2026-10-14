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

/**
 * Runs `script` in bash with `args`, a stand-in `psql` first on PATH that
 * records its stdin and exits with `psqlStatus` for SQL naming
 * statement_timeout (0 for anything else); returns the SQL it received.
 */
function withPsql(script, args, env, { psqlStatus = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rasta-st-'));
  try {
    const log = join(dir, 'psql.log');
    const psql = join(dir, 'psql');
    writeFileSync(
      psql,
      `#!/bin/bash\nsql="$(cat)"\nprintf '%s\\n' "$sql" >> "${log}"\n` +
        `[[ "$sql" == *statement_timeout* ]] && exit ${psqlStatus}\nexit 0\n`,
    );
    chmodSync(psql, 0o755);
    const run = spawnSync('bash', ['-c', script, 'test', ...args], {
      env: { PATH: `${dir}:${process.env.PATH}`, POSTGRES_USER: 'rasta', ...env },
      encoding: 'utf8',
      input: '',
    });
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      sql: existsSync(log) ? readFileSync(log, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `ensure_runtime_statement_timeout svc db role` with `env`; returns the SQL psql received. */
function ensure(env, svc = 'fleet', db = 'rasta_fleet', role = 'rasta_fleet', options = {}) {
  return withPsql(
    'set -euo pipefail; source "$1"; ensure_runtime_statement_timeout "$2" "$3" "$4"',
    [TIMEOUT_LIB, svc, db, role],
    env,
    options,
  );
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
  // Codex r4 on #268, F5: wraps to 1000 in bash's 64-bit arithmetic.
  '18446744073709552616',
  '9223372036854775808',
  '00000001000',
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
    split.match(
      /ensure_runtime_statement_timeout "\$\{svc\}" "\$\{db\}" "\$\{runtime\}" \|\| return 1/g,
    )?.length,
    2,
    'split_service_privileges and split_audit_database_privileges, each passing a failure on',
  );
  const rotate = readFileSync(join(LIB, 'rotate-role-passwords.bash'), 'utf8');
  assert.match(
    rotate,
    /ensure_runtime_statement_timeout "\$\{svc\}" "\$\{db\}" "rasta_\$\{svc\}" \|\| exit 1/,
  );
  for (const source of [split, rotate])
    assert.doesNotMatch(source, /ensure_runtime_statement_timeout[^\n]*migrator/);
});

// Codex r4 on #268, F3: a failed ALTER was followed by the success line, and
// the standalone split runs under `upgrade_service_split … || exit 1`, where
// errexit is off — so nothing stopped it.
test('a failed ALTER returns non-zero and never reports the timeout as set', () => {
  const { status, stdout, stderr } = ensure(
    { POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: '70000' },
    'fleet',
    'rasta_fleet',
    'rasta_fleet',
    { psqlStatus: 2 },
  );
  assert.notEqual(status, 0);
  assert.doesNotMatch(stdout, /default to statement_timeout/);
  assert.match(stderr, /setting statement_timeout for rasta_fleet on rasta_fleet FAILED/);
});

test('with errexit off, as under `… || exit 1`, the split stops at a failed ALTER and fails', () => {
  for (const [call, summary] of [
    ['split_service_privileges fleet rasta_fleet default', /rasta_fleet: owned by/],
    ['split_audit_database_privileges rasta_audit audit', /rasta_audit: database, public/],
  ]) {
    const { status, stdout, sql } = withPsql(
      'source "$1"; declare -A ROLE_PASSWORDS=([rasta_fleet_migrator]=m [rasta_audit_migrator]=m); ' +
        `${call} || exit 7; echo REACHED`,
      [join(LIB, 'service-privilege-split.bash')],
      {
        POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: '70000',
        POSTGRES_STATEMENT_TIMEOUT_MS_AUDIT: '70000',
      },
      { psqlStatus: 2 },
    );
    assert.equal(status, 7, `${call}: ${stdout}`);
    assert.match(sql, /SET statement_timeout = '70000ms'/, `${call} never reached the ALTER`);
    assert.doesNotMatch(stdout, summary);
    assert.doesNotMatch(stdout, /REACHED/);
  }
  // upgrade_service_split hands the split's failure on.
  const split = readFileSync(join(LIB, 'service-privilege-split.bash'), 'utf8');
  assert.match(split, /split_audit_database_privileges "\$\{db\}" "\$\{svc\}" \|\| return 1/);
  assert.match(split, /split_service_privileges "\$\{svc\}" "\$\{db\}" "\$\{mode\}" \|\| return 1/);
});

// Codex r4 on #268, F4: `docker compose exec` gave the container's
// environment and none of the shell's, so an exported value was ignored.
const EXEC = join(ROOT, 'scripts', 'postgres-exec.bash');

/** Runs scripts/postgres-exec.bash with a stand-in `docker`; returns its argv. */
function postgresExec(args, env) {
  const dir = mkdtempSync(join(tmpdir(), 'rasta-pe-'));
  try {
    const log = join(dir, 'docker.log');
    const docker = join(dir, 'docker');
    writeFileSync(docker, `#!/bin/bash\nprintf '%s\\n' "$@" > "${log}"\n`);
    chmodSync(docker, 0o755);
    const run = spawnSync('bash', [EXEC, ...args], {
      env: { PATH: `${dir}:${process.env.PATH}`, ...env },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(log, 'utf8').trimEnd().split('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the compose commands hand every exported POSTGRES_STATEMENT_TIMEOUT_MS_* to the container', () => {
  assert.deepEqual(
    postgresExec(['service-privilege-split.bash', 'fleet'], {
      POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: '70000',
      POSTGRES_STATEMENT_TIMEOUT_MS_ASSET: '20000',
      POSTGRES_PASSWORD_FLEET: 'not-forwarded',
    }),
    [
      'compose',
      'exec',
      '-T',
      '--env',
      'POSTGRES_STATEMENT_TIMEOUT_MS_ASSET=20000',
      '--env',
      'POSTGRES_STATEMENT_TIMEOUT_MS_FLEET=70000',
      'postgres',
      'bash',
      '/docker-entrypoint-initdb.d/lib/service-privilege-split.bash',
      'fleet',
    ],
  );
  // None exported: the container's own values (.env.migrator) stand.
  assert.deepEqual(postgresExec(['rotate-role-passwords.bash'], {}), [
    'compose',
    'exec',
    '-T',
    'postgres',
    'bash',
    '/docker-entrypoint-initdb.d/lib/rotate-role-passwords.bash',
  ]);
});

test('every pnpm command that runs a script applying the timeout goes through postgres-exec.bash', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
  for (const [name, lib] of [
    ['db:privilege-split', 'service-privilege-split.bash'],
    ['db:supplier-privilege-split', 'supplier-privilege-split.bash'],
    ['db:rotate-role-passwords', 'rotate-role-passwords.bash'],
  ]) {
    assert.equal(scripts[name], `bash scripts/postgres-exec.bash ${lib}`, name);
  }
  // No other script runs one of them past the wrapper.
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(
      command,
      /docker compose exec[^&|;]*(service-privilege-split|supplier-privilege-split|rotate-role-passwords)/,
      name,
    );
  }
});

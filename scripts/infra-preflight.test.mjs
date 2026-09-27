import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkInfraEnv,
  passwordVariable,
  ROLE_LIBRARY,
  rolesFromLibrary,
} from './infra-preflight-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = join(ROOT, 'infrastructure/docker/postgres/00-init-databases.sh');
const ROTATE = join(ROOT, 'infrastructure/docker/postgres/lib/rotate-role-passwords.bash');

const noValues = (messages, ...values) => {
  for (const message of messages) {
    for (const value of values) assert.ok(!message.includes(value), `leaks a value: ${message}`);
  }
};

// ---------------------------------------------------------------------------
// infra:up preflight
// ---------------------------------------------------------------------------

test('reads all sixteen service roles and both migrators from the bash library', () => {
  const roles = rolesFromLibrary();
  assert.equal(roles.length, 18);
  assert.ok(roles.includes('rasta_identity'));
  assert.deepEqual(roles.slice(-2), ['rasta_audit_migrator', 'rasta_supplier_migrator']);
  assert.equal(passwordVariable('rasta_audit_migrator'), 'POSTGRES_PASSWORD_AUDIT_MIGRATOR');
  assert.equal(passwordVariable('rasta_supplier_migrator'), 'POSTGRES_PASSWORD_SUPPLIER_MIGRATOR');
});

test('the JS role list is the one the bootstrap library prints', () => {
  // `rolesFromLibrary` parses RASTA_SERVICES and appends the migrators itself;
  // a migrator added to `rasta_roles` but not here would go unchecked.
  const printed = spawnSync('bash', ['-c', `source "${ROLE_LIBRARY}"; rasta_roles`], {
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0);
  assert.deepEqual(printed.stdout.trim().split('\n'), rolesFromLibrary());
});

test('the committed defaults pass with no warning', () => {
  assert.deepEqual(checkInfraEnv({}), { errors: [], warnings: [] });
});

test('the retired shared password is a warning that names the non-destructive fix', () => {
  const { errors, warnings } = checkInfraEnv({
    POSTGRES_SERVICE_PASSWORD: 'old_shared_password_1',
  });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pnpm db:rotate-role-passwords/);
  noValues(warnings, 'old_shared_password_1');
});

test('two roles with one password is an error naming both variables, not the value', () => {
  const shared = 'the_same_password_for_two';
  const { errors } = checkInfraEnv({
    POSTGRES_PASSWORD_IDENTITY: shared,
    POSTGRES_PASSWORD_AUDIT_MIGRATOR: shared,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /POSTGRES_PASSWORD_AUDIT_MIGRATOR equals POSTGRES_PASSWORD_IDENTITY/);
  noValues(errors, shared);
});

test('a role with the superuser password is an error, including the superuser default', () => {
  const explicit = checkInfraEnv({
    POSTGRES_SUPERUSER_PASSWORD: 'superuser_password_x',
    POSTGRES_PASSWORD_AUDIT: 'superuser_password_x',
  });
  assert.deepEqual(explicit.errors, [
    'POSTGRES_PASSWORD_AUDIT equals POSTGRES_SUPERUSER_PASSWORD; every role needs its own password',
  ]);
  const implicit = checkInfraEnv({ POSTGRES_PASSWORD_FLEET: 'rasta_dev_password' });
  assert.equal(implicit.errors.length, 1);
});

test('a role set to another role default is caught too', () => {
  const { errors } = checkInfraEnv({ POSTGRES_PASSWORD_ASSET: 'rasta_fleet_dev_password' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /POSTGRES_PASSWORD_(ASSET|FLEET) equals POSTGRES_PASSWORD_(ASSET|FLEET)/);
});

// ---------------------------------------------------------------------------
// The bash side: nothing reaches psql before every password has been checked
// ---------------------------------------------------------------------------

/**
 * Runs `script` with a stub `psql` first on PATH that records each call and
 * succeeds. Returns the exit status, stderr and the recorded calls.
 */
function runWithStubPsql(script, env, { existing = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rasta-psql-stub-'));
  try {
    const log = join(dir, 'calls.log');
    const stub = join(dir, 'psql');
    // `existing` databases answer the bootstrap's existence query with 1, as
    // a cluster that already holds them would.
    const exists = existing.map((db) => `  *"datname='${db}'"*) echo 1 ;;\n`).join('');
    writeFileSync(
      stub,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in\n${exists}esac\nexit 0\n`,
    );
    chmodSync(stub, 0o755);
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: dir,
        POSTGRES_USER: 'rasta',
        POSTGRES_PASSWORD: 'superuser_password_1',
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { status: result.status, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, script] of [
  ['bootstrap', BOOTSTRAP],
  ['rotation', ROTATE],
]) {
  test(`${label}: duplicate role passwords abort before any role is created or altered`, () => {
    const shared = 'identity_and_migrator_same';
    const { status, stderr, calls } = runWithStubPsql(script, {
      POSTGRES_PASSWORD_IDENTITY: shared,
      POSTGRES_PASSWORD_AUDIT_MIGRATOR: shared,
    });
    assert.equal(status, 1);
    assert.match(stderr, /POSTGRES_PASSWORD_AUDIT_MIGRATOR equals POSTGRES_PASSWORD_IDENTITY/);
    assert.match(stderr, /Nothing was changed/);
    assert.deepEqual(calls, [], 'psql was reached before the check');
    assert.ok(!stderr.includes(shared));
  });

  test(`${label}: a role with the superuser password aborts before any psql call`, () => {
    const { status, stderr, calls } = runWithStubPsql(script, {
      POSTGRES_PASSWORD_AUDIT: 'superuser_password_1',
    });
    assert.equal(status, 1);
    assert.match(stderr, /POSTGRES_PASSWORD_AUDIT equals the superuser's password/);
    assert.deepEqual(calls, []);
  });

  test(`${label}: the retired shared variable aborts before any psql call`, () => {
    const { status, calls } = runWithStubPsql(script, {
      POSTGRES_SERVICE_PASSWORD: 'retired_shared_password',
    });
    assert.equal(status, 1);
    assert.deepEqual(calls, []);
  });
}

test('bootstrap: with distinct passwords it proceeds, and sets each role its own', () => {
  const { status, calls } = runWithStubPsql(BOOTSTRAP, {});
  assert.equal(status, 0);
  const alters = calls.filter((call) => /ALTER ROLE \w+ WITH LOGIN PASSWORD/.test(call));
  // Sixteen service roles and two migrators (audit, supplier).
  assert.equal(alters.length, 18);
  const passwords = alters.map((call) => /PASSWORD '([^']+)'/.exec(call)?.[1]);
  assert.equal(new Set(passwords).size, 18);
});

// ---------------------------------------------------------------------------
// The demo-seed marker (Codex review of #117, finding 1)
// ---------------------------------------------------------------------------

const MARKS = /ALTER DATABASE "(rasta_\w+)" SET rasta\.disposable_database = 'true'/;
const marked = (calls) => calls.map((call) => MARKS.exec(call)?.[1]).filter(Boolean);

test('bootstrap: marks every service database it creates', () => {
  const { status, calls } = runWithStubPsql(BOOTSTRAP, {});
  assert.equal(status, 0);
  assert.equal(marked(calls).length, 16);
});

test('bootstrap: never marks a database that already existed', () => {
  // Run against a cluster it did not create — production, say — the bootstrap
  // must not make those databases seedable: they stay unmarked, and every
  // seed keeps refusing them.
  const { status, calls } = runWithStubPsql(
    BOOTSTRAP,
    {},
    { existing: ['rasta_identity', 'rasta_economic'] },
  );
  assert.equal(status, 0);
  const done = marked(calls);
  assert.ok(!done.includes('rasta_identity'), 'marked a pre-existing rasta_identity');
  assert.ok(!done.includes('rasta_economic'), 'marked a pre-existing rasta_economic');
  assert.equal(done.length, 14);
  assert.ok(!calls.some((call) => call.includes('CREATE DATABASE rasta_identity ')));
});

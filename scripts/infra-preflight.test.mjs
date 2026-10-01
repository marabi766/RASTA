import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvAssignments } from './check-local-postgres-config-lib.mjs';
import {
  checkInfraEnv,
  checkKafkaClientEnv,
  kafkaServicesFromPrincipals,
  migratorCredentialsInEnvFile,
  passwordVariable,
  ROLE_LIBRARY,
  rolesFromLibrary,
  splitServicesFromLibrary,
} from './infra-preflight-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = join(ROOT, 'infrastructure/docker/postgres/00-init-databases.sh');
const ROTATE = join(ROOT, 'infrastructure/docker/postgres/lib/rotate-role-passwords.bash');
const SPLIT = join(ROOT, 'infrastructure/docker/postgres/lib/service-privilege-split.bash');

const noValues = (messages, ...values) => {
  for (const message of messages) {
    for (const value of values) assert.ok(!message.includes(value), `leaks a value: ${message}`);
  }
};

// ---------------------------------------------------------------------------
// infra:up preflight
// ---------------------------------------------------------------------------

test('reads all sixteen service roles and every migrator from the bash library', () => {
  const roles = rolesFromLibrary();
  const split = splitServicesFromLibrary();
  assert.ok(split.includes('supplier') && split.includes('construction'));
  assert.equal(roles.length, 16 + 1 + split.length);
  assert.ok(roles.includes('rasta_identity'));
  assert.deepEqual(roles.slice(16), [
    'rasta_audit_migrator',
    ...split.map((service) => `rasta_${service}_migrator`),
  ]);
  assert.equal(
    passwordVariable('rasta_construction_migrator'),
    'POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR',
  );
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
// A .env copied before the local broker authenticated (#131)
// ---------------------------------------------------------------------------

const envOf = (text) =>
  Object.fromEntries(parseEnvAssignments(text).assignments.map(({ name, value }) => [name, value]));

/**
 * The Kafka section of .env.example as it stood before #131 (ff0a884): every
 * assignment and placeholder as it was, the long comment shortened.
 */
const PRE_131_ENV = `NODE_ENV=development
KAFKA_HOST_PORT=9092
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=rasta
KAFKA_SCHEMA_STRICT=true

# Broker credentials (ADR-061 § 3, RUN-006): one SASL/SCRAM-SHA-512 principal
# per service, named after it; a service reads KAFKA_SASL_PASSWORD_<SERVICE>
# when KAFKA_SASL_PASSWORD is unset, and connects as its own SERVICE_NAME.
KAFKA_ALLOW_PLAINTEXT=true
# KAFKA_SASL_PASSWORD_IDENTITY=change-me-identity-kafka
# KAFKA_SASL_PASSWORD_ORGANIZATION=change-me-organization-kafka
# KAFKA_SASL_PASSWORD_ASSET=change-me-asset-kafka
# KAFKA_SASL_PASSWORD_FLEET=change-me-fleet-kafka
# KAFKA_SASL_PASSWORD_MAINTENANCE=change-me-maintenance-kafka
# KAFKA_SASL_PASSWORD_MARKETPLACE=change-me-marketplace-kafka
# KAFKA_SASL_PASSWORD_SUPPLIER=change-me-supplier-kafka
# KAFKA_SASL_PASSWORD_CONSTRUCTION=change-me-construction-kafka
# KAFKA_SASL_PASSWORD_ECONOMIC=change-me-economic-kafka
# KAFKA_SASL_PASSWORD_NOTIFICATION=change-me-notification-kafka
# KAFKA_SASL_PASSWORD_DOCUMENT=change-me-document-kafka
# KAFKA_SASL_PASSWORD_AUDIT=change-me-audit-kafka
# KAFKA_SSL=false
# KAFKA_SSL_CA_FILE=
`;

/** The gaps a stale-.env warning lists, without the fixed advice after them. */
const gaps = (warning) => /fail to reach Kafka: (.*?)\. Copy /.exec(warning)?.[1];

const CURRENT_EXAMPLE = envOf(readFileSync(join(ROOT, '.env.example'), 'utf8'));

test('the broker has one password variable per service, twelve in all', () => {
  assert.equal(kafkaServicesFromPrincipals().length, 12);
  for (const service of kafkaServicesFromPrincipals()) {
    const variable = `KAFKA_SASL_PASSWORD_${service.replace(/-service$/, '').toUpperCase()}`;
    assert.ok(CURRENT_EXAMPLE[variable], `.env.example does not set ${variable}`);
  }
});

test('a .env copied from the current .env.example raises no Kafka warning', () => {
  assert.deepEqual(checkKafkaClientEnv(CURRENT_EXAMPLE), []);
});

test('a pre-#131 .env warns, names every gap and what to copy, and prints no value', () => {
  const warnings = checkKafkaClientEnv(envOf(PRE_131_ENV));
  assert.equal(warnings.length, 2);
  const [stale, plaintext] = warnings;
  assert.match(stale, /predates the authenticated local broker \(#131\)/);
  assert.match(stale, /the stack starts, but every service and integration suite/);
  assert.equal(
    gaps(stale),
    'KAFKA_SSL is not true; KAFKA_SSL_CA_FILE is unset; no KAFKA_SASL_PASSWORD_<SERVICE> is set',
  );
  assert.match(stale, /"Broker credentials" block of \.env\.example/);
  assert.match(plaintext, /KAFKA_ALLOW_PLAINTEXT is on/);
  assert.match(plaintext, /Delete it/);
  noValues(warnings, 'change-me', 'localhost:9092');
});

test('a partly updated .env names exactly the variables still missing, never their values', () => {
  const env = { ...CURRENT_EXAMPLE, KAFKA_SASL_PASSWORD_FLEET: '', KAFKA_SASL_PASSWORD_AUDIT: ' ' };
  delete env.KAFKA_SASL_PASSWORD_ASSET;
  const warnings = checkKafkaClientEnv(env);
  assert.equal(warnings.length, 1);
  assert.equal(
    gaps(warnings[0]),
    'KAFKA_SASL_PASSWORD_ASSET, KAFKA_SASL_PASSWORD_AUDIT, KAFKA_SASL_PASSWORD_FLEET are unset',
  );
  noValues(
    warnings,
    ...Object.entries(CURRENT_EXAMPLE)
      .filter(([name]) => name.startsWith('KAFKA_SASL_PASSWORD_'))
      .map(([, value]) => value),
  );
});

test('TLS switched off or without the local CA is a warning on its own', () => {
  const off = checkKafkaClientEnv({ ...CURRENT_EXAMPLE, KAFKA_SSL: 'false' });
  assert.equal(off.length, 1);
  assert.equal(gaps(off[0]), 'KAFKA_SSL is not true');

  const noCa = { ...CURRENT_EXAMPLE };
  delete noCa.KAFKA_SSL_CA_FILE;
  assert.equal(gaps(checkKafkaClientEnv(noCa)[0]), 'KAFKA_SSL_CA_FILE is unset');

  // Read the way @rasta/config reads a boolean.
  assert.deepEqual(checkKafkaClientEnv({ ...CURRENT_EXAMPLE, KAFKA_SSL: ' ON ' }), []);
});

test('KAFKA_ALLOW_PLAINTEXT alone, on an otherwise complete .env, is its own warning', () => {
  const warnings = checkKafkaClientEnv({ ...CURRENT_EXAMPLE, KAFKA_ALLOW_PLAINTEXT: 'true' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^KAFKA_ALLOW_PLAINTEXT is on/);
  assert.deepEqual(checkKafkaClientEnv({ ...CURRENT_EXAMPLE, KAFKA_ALLOW_PLAINTEXT: 'false' }), []);
});

// ---------------------------------------------------------------------------
// The bash side: nothing reaches psql before every password has been checked
// ---------------------------------------------------------------------------

/**
 * Runs `script` with a stub `psql` first on PATH that records each call and
 * succeeds. Returns the exit status, stderr and the recorded calls.
 */
function runWithStubPsql(script, env, { existing = [], args = [] } = {}) {
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
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: dir,
        POSTGRES_USER: 'rasta',
        POSTGRES_PASSWORD: 'superuser_password_1',
        // As compose's postgres container and CI run the bootstrap; the tests
        // of the fallback's refusal remove it.
        RASTA_DB_BOOTSTRAP: 'compose',
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
  // Sixteen service roles, audit's migrator and one per split service (D-045).
  assert.equal(alters.length, rolesFromLibrary().length);
  assert.deepEqual(
    alters.map((call) => /ALTER ROLE (\w+) WITH/.exec(call)?.[1]).sort(),
    [...rolesFromLibrary()].sort(),
  );
  const passwords = alters.map((call) => /PASSWORD '([^']+)'/.exec(call)?.[1]);
  assert.equal(new Set(passwords).size, rolesFromLibrary().length);
});

// ---------------------------------------------------------------------------
// The development fallback, only in the disposable bootstrap (Codex review of
// #176, finding 2)
// ---------------------------------------------------------------------------

/** Every role's password, explicit and distinct — as a real environment sets them. */
const explicitPasswords = () =>
  Object.fromEntries(
    rolesFromLibrary().map((role) => [passwordVariable(role), `explicit_${role}_secret`]),
  );

for (const [label, script] of [
  ['bootstrap', BOOTSTRAP],
  ['rotation', ROTATE],
]) {
  test(`${label}: outside RASTA_DB_BOOTSTRAP=compose an unset password aborts before any psql call`, () => {
    const { status, stderr, calls } = runWithStubPsql(script, {
      RASTA_DB_BOOTSTRAP: undefined,
      POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR: undefined,
    });
    assert.equal(status, 1);
    assert.match(stderr, /POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR is not set/);
    assert.match(stderr, /RASTA_DB_BOOTSTRAP=compose/);
    assert.deepEqual(calls, [], 'psql was reached before the check');
    assert.ok(!stderr.includes('_dev_password'), 'a password was printed');
  });

  test(`${label}: outside the flag, every password supplied explicitly proceeds — and none is a default`, () => {
    const { status, calls } = runWithStubPsql(script, {
      RASTA_DB_BOOTSTRAP: undefined,
      ...explicitPasswords(),
    });
    assert.equal(status, 0);
    assert.ok(!calls.some((call) => call.includes('_dev_password')), 'a default reached psql');
  });
}

test('standalone split: no fallback — the migrator password must be exported, and is the only one needed', () => {
  const refused = runWithStubPsql(
    SPLIT,
    { RASTA_DB_BOOTSTRAP: undefined },
    { args: ['construction'] },
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR is not set/);
  assert.deepEqual(refused.calls, []);

  const given = runWithStubPsql(
    SPLIT,
    {
      RASTA_DB_BOOTSTRAP: undefined,
      POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR: 'explicit_construction_migrator_secret',
    },
    { args: ['construction'] },
  );
  assert.equal(given.status, 0, given.stderr);
  assert.ok(
    given.calls.some((call) =>
      call.includes("ALTER ROLE rasta_construction_migrator WITH LOGIN PASSWORD 'explicit_"),
    ),
  );
  assert.ok(!given.calls.some((call) => call.includes('_dev_password')));
});

test('standalone split: in the compose container the development default still applies', () => {
  const { status, calls } = runWithStubPsql(SPLIT, {}, { args: ['construction'] });
  assert.equal(status, 0);
  assert.ok(
    calls.some((call) => call.includes("PASSWORD 'rasta_construction_migrator_dev_password'")),
  );
});

test('standalone audit split sets no password, so needs none', () => {
  const { status, calls } = runWithStubPsql(
    SPLIT,
    { RASTA_DB_BOOTSTRAP: undefined },
    { args: ['audit'] },
  );
  assert.equal(status, 0);
  assert.ok(!calls.some((call) => /PASSWORD/.test(call)));
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

test('a .env still holding owner credentials is named, by variable only (D-045 env split)', () => {
  assert.deepEqual(migratorCredentialsInEnvFile({ DATABASE_URL_IDENTITY: 'x' }), []);
  const [warning] = migratorCredentialsInEnvFile({
    DATABASE_URL_CONSTRUCTION_MIGRATOR: 'postgresql://m:owner_secret@h/d',
    POSTGRES_PASSWORD_AUDIT_MIGRATOR: 'owner_secret',
    DATABASE_URL_CONSTRUCTION: 'x',
  });
  assert.match(warning, /DATABASE_URL_CONSTRUCTION_MIGRATOR, POSTGRES_PASSWORD_AUDIT_MIGRATOR/);
  assert.match(warning, /\.env\.migrator/);
  assert.ok(!warning.includes('owner_secret'));
});

test('.env.example holds no owner credential; .env.migrator.example holds every migrator, URL and password', () => {
  const read = (name) => readFileSync(join(ROOT, name), 'utf8');
  const names = (text) => parseEnvAssignments(text).assignments.map(({ name }) => name);
  assert.deepEqual(
    names(read('.env.example')).filter((name) => /_MIGRATOR$/.test(name)),
    [],
  );
  const migrators = rolesFromLibrary().filter((role) => role.endsWith('_migrator'));
  const inMigratorFile = names(read('.env.migrator.example'));
  for (const role of migrators) {
    const stem = role.replace(/^rasta_/, '').toUpperCase();
    assert.ok(inMigratorFile.includes(`POSTGRES_PASSWORD_${stem}`), `POSTGRES_PASSWORD_${stem}`);
    const url = stem.replace(/_MIGRATOR$/, '');
    assert.ok(
      inMigratorFile.includes(`DATABASE_URL_${url}_MIGRATOR`),
      `DATABASE_URL_${url}_MIGRATOR`,
    );
  }
});

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

test('the broker has one password variable per service, thirteen in all', () => {
  assert.equal(kafkaServicesFromPrincipals().length, 13);
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
function runWithStubPsql(
  script,
  env,
  { existing = [], args = [], failWhen = null, rolesExist = false } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'rasta-psql-stub-'));
  try {
    const log = join(dir, 'calls.log');
    const stub = join(dir, 'psql');
    // `existing` databases answer the bootstrap's existence query with 1, as
    // a cluster that already holds them would.
    const exists = existing.map((db) => `  *"datname='${db}'"*) echo 1 ;;\n`).join('');
    // A call whose arguments contain `failWhen` exits 2, as a refused login would.
    const fails = failWhen ? `  *"${failWhen}"*) exit 2 ;;\n` : '';
    // `rolesExist`: every role-existence query answers 1, as on a cluster that has them all.
    const roles = rolesExist ? `  *"FROM pg_roles WHERE rolname"*) echo 1 ;;\n` : '';
    // argv and stdin are recorded apart: `argv` is what any local user could
    // read from the process table, `calls` is argv plus the SQL a helper sent on
    // stdin (`-f -`), flattened to one line — what the database received.
    const argvLog = join(dir, 'argv.log');
    writeFileSync(
      stub,
      [
        '#!/bin/bash',
        'argv="$*"',
        'call="$argv"',
        'if [[ " $argv " == *" -f - "* ]]; then call="$argv $(cat)"; fi',
        `printf '%s\\n' "$argv" >> '${argvLog}'`,
        `printf '%s\\n' "\${call//$'\\n'/ }" >> '${log}'`,
        'case "$call" in',
        `${fails}${exists}${roles}esac`,
        'exit 0',
        '',
      ].join('\n'),
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
    const lines = (file) =>
      existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    return {
      status: result.status,
      stderr: result.stderr,
      calls: lines(log),
      argv: lines(argvLog),
    };
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
  // role → every password it was given (audit's migrator is set by ensure_role
  // and again by its split — the same value both times).
  const given = new Map();
  for (const call of calls) {
    const [, role, password] = /ALTER ROLE (\w+) WITH LOGIN PASSWORD '([^']+)'/.exec(call) ?? [];
    if (role) given.set(role, new Set([...(given.get(role) ?? []), password]));
  }
  // Sixteen service roles, audit's migrator and one per split service (D-045).
  assert.deepEqual([...given.keys()].sort(), [...rolesFromLibrary()].sort());
  for (const [role, passwords] of given) assert.equal(passwords.size, 1, role);
  const passwords = [...given.values()].map((set) => [...set][0]);
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

test('standalone split: no fallback — the runtime and migrator passwords must both be exported', () => {
  const refused = runWithStubPsql(
    SPLIT,
    { RASTA_DB_BOOTSTRAP: undefined },
    { args: ['construction'] },
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /POSTGRES_PASSWORD_CONSTRUCTION is not set/);
  assert.match(refused.stderr, /POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR is not set/);
  assert.deepEqual(refused.calls, []);

  const noRuntime = runWithStubPsql(
    SPLIT,
    {
      RASTA_DB_BOOTSTRAP: undefined,
      POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR: 'explicit_construction_migrator_secret',
    },
    { args: ['construction'] },
  );
  assert.equal(noRuntime.status, 1);
  assert.match(noRuntime.stderr, /POSTGRES_PASSWORD_CONSTRUCTION is not set/);
  assert.deepEqual(noRuntime.calls, []);

  const given = runWithStubPsql(
    SPLIT,
    {
      RASTA_DB_BOOTSTRAP: undefined,
      POSTGRES_PASSWORD_CONSTRUCTION: 'explicit_construction_runtime_secret',
      POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR: 'explicit_construction_migrator_secret',
    },
    { args: ['construction'] },
  );
  assert.equal(given.status, 0, given.stderr);
  assert.ok(
    given.calls.some((call) =>
      call.includes(
        "ALTER ROLE rasta_construction_migrator WITH LOGIN PASSWORD 'explicit_construction_migrator_secret'",
      ),
    ),
  );
  assert.ok(!given.calls.some((call) => call.includes('_dev_password')));
});

test('standalone split: rotates the runtime password to the supplied one, then proves both logins over TCP (Codex round 3)', () => {
  const { status, stderr, calls } = runWithStubPsql(
    SPLIT,
    {
      RASTA_DB_BOOTSTRAP: undefined,
      PGHOST: '/var/run/postgresql', // a socket directory: the logins still go over TCP
      POSTGRES_PASSWORD_CONSTRUCTION: 'explicit_construction_runtime_secret',
      POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR: 'explicit_construction_migrator_secret',
    },
    { args: ['construction'] },
  );
  assert.equal(status, 0, stderr);
  const rotate = calls.findIndex((call) =>
    call.includes(
      "ALTER ROLE rasta_construction WITH LOGIN PASSWORD 'explicit_construction_runtime_secret'",
    ),
  );
  assert.ok(rotate >= 0, 'the runtime password was not set to the supplied value');
  for (const role of ['rasta_construction', 'rasta_construction_migrator']) {
    const login = calls.findIndex(
      (call) =>
        call.includes(`--username ${role} `) &&
        call.includes('-h 127.0.0.1') &&
        call.includes('SELECT 1'),
    );
    assert.ok(login > rotate, `${role}: no TCP login check after the rotation`);
  }
});

test('standalone split: a supplied credential that cannot log in fails the run', () => {
  const { status, stderr } = runWithStubPsql(
    SPLIT,
    {
      RASTA_DB_BOOTSTRAP: undefined,
      POSTGRES_PASSWORD_CONSTRUCTION: 'explicit_construction_runtime_secret',
      POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR: 'explicit_construction_migrator_secret',
    },
    { args: ['construction'], failWhen: '--username rasta_construction_migrator' },
  );
  assert.equal(status, 1);
  assert.match(stderr, /rasta_construction_migrator cannot log in to rasta_construction/);
  assert.ok(!stderr.includes('explicit_construction_migrator_secret'));
});

test("standalone split: a migrator password equal to its runtime role's aborts before any psql call (Codex on #176)", () => {
  const shared = 'one_password_for_runtime_and_owner';
  const { status, stderr, calls } = runWithStubPsql(
    SPLIT,
    {
      RASTA_DB_BOOTSTRAP: undefined,
      POSTGRES_PASSWORD_CONSTRUCTION: shared,
      POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR: shared,
    },
    { args: ['construction'] },
  );
  assert.equal(status, 1);
  assert.match(
    stderr,
    /POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR equals POSTGRES_PASSWORD_CONSTRUCTION/,
  );
  assert.deepEqual(calls, [], 'psql was reached before the check');
  assert.ok(!stderr.includes(shared));
});

test('standalone split: a migrator password equal to any other known role password aborts too', () => {
  const shared = 'identity_password_reused_as_owner';
  const { status, stderr, calls } = runWithStubPsql(
    SPLIT,
    {
      RASTA_DB_BOOTSTRAP: undefined,
      POSTGRES_PASSWORD_CONSTRUCTION: 'explicit_construction_runtime_secret',
      POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR: shared,
      // Not a role this run changes, but a password it knows.
      POSTGRES_PASSWORD_IDENTITY: shared,
    },
    { args: ['construction'] },
  );
  assert.equal(status, 1);
  assert.match(stderr, /POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR equals POSTGRES_PASSWORD_IDENTITY/);
  assert.deepEqual(calls, []);

  // In the compose container the other roles' development defaults are known passwords too.
  const devDefault = runWithStubPsql(
    SPLIT,
    { POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR: 'rasta_fleet_dev_password' },
    { args: ['construction'] },
  );
  assert.equal(devDefault.status, 1);
  assert.match(
    devDefault.stderr,
    /POSTGRES_PASSWORD_CONSTRUCTION_MIGRATOR equals POSTGRES_PASSWORD_FLEET/,
  );
  assert.deepEqual(devDefault.calls, []);
});

test('standalone split: in the compose container the development default still applies', () => {
  const { status, calls } = runWithStubPsql(SPLIT, {}, { args: ['construction'] });
  assert.equal(status, 0);
  assert.ok(
    calls.some((call) => call.includes("PASSWORD 'rasta_construction_migrator_dev_password'")),
  );
});

test('standalone audit split: the same credential step as every service — both passwords, distinct, set, and proven (Codex round 4)', () => {
  const refused = runWithStubPsql(SPLIT, { RASTA_DB_BOOTSTRAP: undefined }, { args: ['audit'] });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /POSTGRES_PASSWORD_AUDIT is not set/);
  assert.match(refused.stderr, /POSTGRES_PASSWORD_AUDIT_MIGRATOR is not set/);
  assert.deepEqual(refused.calls, []);

  const shared = 'one_password_for_audit_and_owner';
  const equal = runWithStubPsql(
    SPLIT,
    {
      RASTA_DB_BOOTSTRAP: undefined,
      POSTGRES_PASSWORD_AUDIT: shared,
      POSTGRES_PASSWORD_AUDIT_MIGRATOR: shared,
    },
    { args: ['audit'] },
  );
  assert.equal(equal.status, 1);
  assert.match(equal.stderr, /POSTGRES_PASSWORD_AUDIT_MIGRATOR equals POSTGRES_PASSWORD_AUDIT/);
  assert.deepEqual(equal.calls, []);
  assert.ok(!equal.stderr.includes(shared));

  const { status, stderr, calls } = runWithStubPsql(
    SPLIT,
    {
      RASTA_DB_BOOTSTRAP: undefined,
      POSTGRES_PASSWORD_AUDIT: 'explicit_audit_runtime_secret',
      POSTGRES_PASSWORD_AUDIT_MIGRATOR: 'explicit_audit_migrator_secret',
    },
    { args: ['audit'] },
  );
  assert.equal(status, 0, stderr);
  const at = (text) => calls.findIndex((call) => call.includes(text));
  const migrator = at(
    "ALTER ROLE rasta_audit_migrator WITH LOGIN PASSWORD 'explicit_audit_migrator_secret'",
  );
  const runtime = at("ALTER ROLE rasta_audit WITH LOGIN PASSWORD 'explicit_audit_runtime_secret'");
  assert.ok(migrator >= 0, 'the migrator password was not set');
  assert.ok(runtime >= 0, 'the runtime password was not set');
  for (const role of ['rasta_audit', 'rasta_audit_migrator']) {
    const login = at(`-h 127.0.0.1 -p 5432 --username ${role} --dbname rasta_audit -c SELECT 1`);
    assert.ok(
      login > Math.max(migrator, runtime),
      `${role}: no TCP login after the passwords were set`,
    );
  }
  // `public` is the migrator's before anything is revoked or the ledger created.
  const owner = at('ALTER SCHEMA public OWNER TO rasta_audit_migrator');
  assert.ok(owner >= 0 && owner < at('REVOKE ALL ON SCHEMA public FROM PUBLIC'));
  assert.ok(owner < at('_prisma_migrations'));
});

test('standalone split: `public` is handed to the migrator before any revoke and before the ledger (Codex round 4)', () => {
  const { status, calls } = runWithStubPsql(SPLIT, {}, { args: ['construction'] });
  assert.equal(status, 0);
  const at = (text) => calls.findIndex((call) => call.includes(text));
  const owner = at('ALTER SCHEMA public OWNER TO rasta_construction_migrator');
  assert.ok(owner > at('REASSIGN OWNED BY rasta_construction TO rasta_construction_migrator'));
  assert.ok(owner < at('REVOKE ALL ON SCHEMA public FROM PUBLIC'));
  assert.ok(owner < at('_prisma_migrations'));
});

test('rotation: every migrator is checked against its service database — construction included (Codex round 4)', () => {
  const { status, stderr, calls } = runWithStubPsql(ROTATE, {}, { rolesExist: true });
  assert.equal(status, 0, stderr);
  const logins = calls.filter((call) => call.includes('-h 127.0.0.1') && call.endsWith('SELECT 1'));
  assert.equal(logins.length, rolesFromLibrary().length);
  for (const role of rolesFromLibrary()) {
    const database = role.replace(/_migrator$/, '');
    assert.ok(
      logins.some((call) => call.includes(`--username ${role} --dbname ${database} `)),
      `${role} is not checked against ${database}`,
    );
  }
  assert.ok(
    logins.some((call) =>
      call.includes('--username rasta_construction_migrator --dbname rasta_construction '),
    ),
  );
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

// ---------------------------------------------------------------------------
// D-045 follow-up (Codex on #191): a role's password never reaches psql's argv.
// Bootstrap, rotation and the split all set passwords with ALTER ROLE … PASSWORD;
// that SQL goes on stdin, because a process's arguments are readable by every
// local user while it runs.
// ---------------------------------------------------------------------------

for (const [label, script, options] of [
  ['bootstrap', BOOTSTRAP, {}],
  ['rotation', ROTATE, { rolesExist: true }],
  ['split', SPLIT, { args: ['construction'] }],
]) {
  test(`${label}: every ALTER ROLE … PASSWORD goes on stdin, none in psql's argv`, () => {
    const { status, stderr, calls, argv } = runWithStubPsql(script, {}, options);
    assert.equal(status, 0, stderr);

    // What the database received: the passwords really were set.
    const passwords = calls.flatMap((call) =>
      [...call.matchAll(/PASSWORD '([^']+)'/g)].map((match) => match[1]),
    );
    assert.ok(passwords.length > 0, 'no ALTER ROLE … PASSWORD was sent at all');

    // What the process table showed: none of them, and no PASSWORD clause.
    for (const line of argv) {
      assert.doesNotMatch(line, /PASSWORD/i, `a password clause reached argv: ${line}`);
      for (const password of passwords) {
        assert.ok(!line.includes(password), `a role password reached psql's argv (${label})`);
      }
    }
  });
}

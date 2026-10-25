import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_HOST,
  classifyHost,
  parseEnvAssignments,
  validateLocalPostgresConfig,
} from './check-local-postgres-config-lib.mjs';
import { UNREGISTERED_DATABASE_URL } from './database-services.mjs';
import { KEY_SENTINELS, SENTINELS, assertNoSentinel } from './refusal-probes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(here, '..', '.env.example');
const MIGRATOR_EXAMPLE = resolve(here, '..', '.env.migrator.example');
/** What the CLI checks by default: both committed files, as one text. */
const committed = () =>
  [EXAMPLE, MIGRATOR_EXAMPLE].map((file) => readFileSync(file, 'utf8')).join('\n');
const CLI = resolve(here, 'check-local-postgres-config.mjs');

/** A password no message may ever contain. */
const SECRET = 'fixture_secret_pw';
const pg = (role, host = '127.0.0.1:5433', database = role) =>
  `postgresql://${role}:${SECRET}@${host}/${database}?schema=public`;

/** A valid synthetic file; `overrides` replace or append lines by variable name. */
function fixture(overrides = {}, extra = []) {
  const lines = {
    NODE_ENV: 'development',
    POSTGRES_HOST: '127.0.0.1',
    POSTGRES_PORT: '5433',
    DATABASE_URL_IDENTITY: pg('rasta_identity'),
    DATABASE_URL_AUDIT: pg('rasta_audit'),
    DATABASE_URL_AUDIT_MIGRATOR: pg('rasta_audit_migrator', '127.0.0.1:5433', 'rasta_audit'),
    REDIS_URL: 'redis://localhost:6379',
    KEYCLOAK_URL: 'http://localhost:8080',
    ...overrides,
  };
  return [
    '# a comment mentioning postgresql://localhost:5432 is not an assignment',
    '',
    ...Object.entries(lines).map(([name, value]) => `${name}=${value}`),
    ...extra,
  ].join('\n');
}

function assertSafe(errors) {
  for (const error of errors) {
    assert.ok(!error.includes(SECRET), `message leaks a password: ${error}`);
    assert.ok(!error.includes('://'), `message contains a URL: ${error}`);
    assert.ok(!/_dev_password/.test(error), `message leaks a password: ${error}`);
  }
}

function expectErrors(text, ...patterns) {
  const { errors } = validateLocalPostgresConfig(text);
  assert.ok(errors.length > 0, 'expected the contract to fail');
  for (const pattern of patterns) {
    assert.ok(
      errors.some((error) => pattern.test(error)),
      `no error matched ${pattern}; got:\n${errors.join('\n')}`,
    );
  }
  assertSafe(errors);
  return errors;
}

test('accepts the IPv4 loopback literal on the host and every PostgreSQL URL', () => {
  const result = validateLocalPostgresConfig(fixture());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.postgresUrls, [
    'DATABASE_URL_IDENTITY',
    'DATABASE_URL_AUDIT',
    'DATABASE_URL_AUDIT_MIGRATOR',
  ]);
});

test('ignores unrelated variables and non-PostgreSQL URLs, including a DATABASE_URL_* with another scheme', () => {
  const result = validateLocalPostgresConfig(
    fixture({
      DATABASE_URL_CACHE: 'redis://localhost:6379',
      DATABASE_URL_SEARCH: 'http://localhost:9200',
      OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
      SOMETHING_POSTGRES_URL: 'postgresql://x:y@localhost:5432/z',
    }),
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.ignoredUrls, ['DATABASE_URL_CACHE', 'DATABASE_URL_SEARCH']);
});

test('accepts the postgres: scheme and quoted values', () => {
  const result = validateLocalPostgresConfig(
    fixture({
      POSTGRES_HOST: '"127.0.0.1"',
      DATABASE_URL_IDENTITY: `'postgres://rasta_identity:${SECRET}@127.0.0.1:5433/rasta_identity'`,
    }),
  );
  assert.deepEqual(result.errors, []);
});

test('rejects localhost in a PostgreSQL URL', () => {
  expectErrors(
    fixture({ DATABASE_URL_IDENTITY: pg('rasta_identity', 'localhost:5433') }),
    /^DATABASE_URL_IDENTITY \(line \d+\): host must be 127\.0\.0\.1 \(found localhost\)$/,
  );
});

test('rejects the IPv6 loopback [::1]', () => {
  expectErrors(
    fixture({ DATABASE_URL_AUDIT: pg('rasta_audit', '[::1]:5433') }),
    /^DATABASE_URL_AUDIT \(line \d+\): host must be 127\.0\.0\.1 \(found IPv6 literal\)$/,
  );
});

test('rejects a non-loopback host', () => {
  for (const host of ['db.internal.example:5433', '10.0.0.5:5433', '127.0.0.2:5433']) {
    expectErrors(
      fixture({ DATABASE_URL_IDENTITY: pg('rasta_identity', host) }),
      /^DATABASE_URL_IDENTITY \(line \d+\): host must be 127\.0\.0\.1 \(found other host\)$/,
    );
  }
});

test('rejects POSTGRES_HOST other than 127.0.0.1', () => {
  expectErrors(
    fixture({ POSTGRES_HOST: 'localhost' }),
    /^POSTGRES_HOST \(line \d+\): must be 127\.0\.0\.1 \(found localhost\)$/,
  );
  expectErrors(fixture({ POSTGRES_HOST: '::1' }), /^POSTGRES_HOST .*found other host/);
});

test('rejects a URL port that differs from POSTGRES_PORT, or no port at all', () => {
  expectErrors(
    fixture({ DATABASE_URL_AUDIT_MIGRATOR: pg('rasta_audit_migrator', '127.0.0.1:5432') }),
    /^DATABASE_URL_AUDIT_MIGRATOR \(line \d+\): port 5432 does not equal POSTGRES_PORT 5433$/,
  );
  expectErrors(
    fixture({ DATABASE_URL_IDENTITY: pg('rasta_identity', '127.0.0.1') }),
    /^DATABASE_URL_IDENTITY .*port must be stated and equal POSTGRES_PORT$/,
  );
});

test('rejects a malformed PostgreSQL URL or a URL with no scheme', () => {
  expectErrors(
    fixture({ DATABASE_URL_IDENTITY: `postgresql://rasta:${SECRET}@127.0.0.1:notaport/rasta` }),
    /^DATABASE_URL_IDENTITY \(line \d+\): malformed PostgreSQL URL$/,
  );
  expectErrors(
    fixture({ DATABASE_URL_IDENTITY: `rasta:${SECRET}@127.0.0.1:5433/rasta` }),
    /^DATABASE_URL_IDENTITY .*malformed URL \(no scheme\)$/,
  );
  expectErrors(
    fixture({ DATABASE_URL_IDENTITY: `postgresql://rasta:${SECRET}@/rasta` }),
    /^DATABASE_URL_IDENTITY .*malformed PostgreSQL URL/,
  );
  expectErrors(
    fixture({ DATABASE_URL_IDENTITY: `postgresql+x://rasta:${SECRET}@127.0.0.1:5433/rasta` }),
    /^DATABASE_URL_IDENTITY .*unsupported scheme/,
  );
});

test('rejects a malformed or missing POSTGRES_PORT', () => {
  expectErrors(fixture({ POSTGRES_PORT: 'five' }), /^POSTGRES_PORT .*must be a port number/);
  expectErrors(fixture({ POSTGRES_PORT: '70000' }), /^POSTGRES_PORT .*must be a port number/);
  const withoutPort = fixture().replace(/^POSTGRES_PORT=.*$/m, '');
  expectErrors(withoutPort, /^POSTGRES_PORT: missing$/);
});

test('fails closed on a malformed relevant line, and ignores a malformed unrelated one', () => {
  expectErrors(
    fixture({}, ['POSTGRES_HOST 127.0.0.1']),
    /^POSTGRES_HOST \(line \d+\): malformed assignment$/,
  );
  expectErrors(
    fixture({}, [`DATABASE_URL_EXTRA ${pg('rasta_extra')}`]),
    /^a DATABASE_URL_\* named for no service \(line \d+\): malformed assignment$/,
  );
  expectErrors(
    fixture({}, [`DATABASE_URL_IDENTITY_MIGRATOR ${pg('rasta_identity_migrator')}`]),
    /^DATABASE_URL_IDENTITY_MIGRATOR \(line \d+\): malformed assignment$/,
  );
  assert.deepEqual(validateLocalPostgresConfig(fixture({}, ['SOME RANDOM LINE'])).errors, []);
});

test('rejects a duplicate POSTGRES_HOST, POSTGRES_PORT or PostgreSQL URL, even with an identical value', () => {
  expectErrors(
    fixture({}, ['POSTGRES_HOST=127.0.0.1']),
    /^POSTGRES_HOST \(line \d+\): duplicate assignment \(first on line \d+\)$/,
  );
  expectErrors(fixture({}, ['POSTGRES_PORT=5433']), /^POSTGRES_PORT .*duplicate assignment/);
  expectErrors(
    fixture({}, [`DATABASE_URL_IDENTITY=${pg('rasta_identity')}`]),
    /^DATABASE_URL_IDENTITY .*duplicate assignment/,
  );
  expectErrors(fixture({}, ['export POSTGRES_PORT=5433']), /^POSTGRES_PORT .*duplicate assignment/);
});

test('fails when no PostgreSQL URL is declared at all', () => {
  const text = 'POSTGRES_HOST=127.0.0.1\nPOSTGRES_PORT=5433\nREDIS_URL=redis://localhost:6379\n';
  expectErrors(text, /^DATABASE_URL_\*: no PostgreSQL URL declared$/);
});

test('parses assignments, comments and malformed lines with their line numbers', () => {
  const { assignments, malformed } = parseEnvAssignments(
    '# c\n\nA=1\nB = "two"\nnot an assignment\r\nexport C=3',
  );
  assert.deepEqual(assignments, [
    { name: 'A', value: '1', line: 3 },
    { name: 'B', value: 'two', line: 4 },
    { name: 'C', value: '3', line: 6 },
  ]);
  assert.deepEqual(malformed, [{ line: 5, name: 'not' }]);
  assert.equal(classifyHost('LOCALHOST'), 'localhost');
  assert.equal(classifyHost(REQUIRED_HOST), REQUIRED_HOST);
});

test('the committed .env.example and .env.migrator.example satisfy the contract, with no PostgreSQL URL missed', () => {
  const text = committed();
  const result = validateLocalPostgresConfig(text);
  assert.deepEqual(result.errors, []);

  // Counted independently of the parser: every uncommented PostgreSQL URL line.
  const declared = text
    .split(/\r?\n/)
    .map((line) => /^(DATABASE_URL_[A-Z0-9_]+)=postgres(?:ql)?:\/\//.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[1]);
  assert.ok(declared.length >= 16, `expected the per-service URLs, found ${declared.length}`);
  assert.deepEqual([...result.postgresUrls].sort(), [...declared].sort());
  assert.ok(result.postgresUrls.includes('DATABASE_URL_AUDIT_MIGRATOR'));
});

test('negative controls on the real committed text, in memory', () => {
  const text = committed();
  const urlCount = validateLocalPostgresConfig(text).postgresUrls.length;

  // 1. Every PostgreSQL default back to localhost.
  const reverted = text
    .replace(/^POSTGRES_HOST=127\.0\.0\.1$/m, 'POSTGRES_HOST=localhost')
    .replace(/@127\.0\.0\.1:/g, '@localhost:');
  const all = expectErrors(reverted, /^POSTGRES_HOST .*found localhost/);
  assert.equal(
    all.filter((error) => /host must be 127\.0\.0\.1 \(found localhost\)/.test(error)).length,
    urlCount,
  );

  // 2. Only the migrator URL.
  const migratorOnly = text.replace(
    /^(DATABASE_URL_AUDIT_MIGRATOR=postgresql:\/\/[^@]+@)127\.0\.0\.1:/m,
    '$1localhost:',
  );
  assert.notEqual(migratorOnly, text);
  const one = expectErrors(
    migratorOnly,
    /^DATABASE_URL_AUDIT_MIGRATOR \(line \d+\): host must be 127\.0\.0\.1 \(found localhost\)$/,
  );
  assert.equal(one.length, 1);

  // 3. A duplicate assignment appended.
  const duplicated = `${text}\nPOSTGRES_PORT=5433\n`;
  const dup = expectErrors(duplicated, /^POSTGRES_PORT .*duplicate assignment/);
  assert.equal(dup.length, 1);
});

test('the CLI passes on .env.example and fails a temporary copy without printing any value', () => {
  const ok = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /PostgreSQL URL\(s\) use 127\.0\.0\.1 and POSTGRES_PORT/);

  const dir = mkdtempSync(join(tmpdir(), 'rasta-local-pg-'));
  try {
    const copy = join(dir, 'env.example');
    writeFileSync(copy, readFileSync(EXAMPLE, 'utf8').replace(/@127\.0\.0\.1:/g, '@localhost:'));
    const failed = spawnSync(process.execPath, [CLI, '--file', copy], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(
      failed.stderr,
      /DATABASE_URL_IDENTITY \(line \d+\): host must be 127\.0\.0\.1 \(found localhost\)/,
    );
    assert.ok(!/_dev_password/.test(failed.stderr + failed.stdout));
    assert.ok(!/postgres(?:ql)?:\/\//.test(failed.stderr + failed.stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #385 r4: a `DATABASE_URL_*` no service owns came from the text checked. It is
// still checked — detection is by prefix — but every diagnostic shows it as a
// placeholder, through the library and through the real CLI.
const SENTINEL_KEYS = KEY_SENTINELS.map((key) => `DATABASE_URL_${key}`);

function sentinelCases(key) {
  return [
    [fixture({}, [`${key} ${pg('rasta_x')}`]), 'malformed assignment'],
    [fixture({ [key]: pg('rasta_x') }, [`${key}=${pg('rasta_x')}`]), 'duplicate assignment'],
    [fixture({ [key]: 'not-a-url' }), 'malformed URL (no scheme)'],
    [
      fixture({ [key]: pg('rasta_x', 'localhost:5433') }),
      'host must be 127.0.0.1 (found localhost)',
    ],
    [
      fixture({ [key]: pg('rasta_x', '127.0.0.1:5432') }),
      'port 5432 does not equal POSTGRES_PORT 5433',
    ],
    [
      fixture({ [key]: 'postgresql+x://u@127.0.0.1:5433/x' }),
      'malformed PostgreSQL URL (unsupported scheme)',
    ],
  ];
}

test('a DATABASE_URL_* named for no service is checked, and shown only as a placeholder', () => {
  for (const key of SENTINEL_KEYS) {
    for (const [text, problem] of sentinelCases(key)) {
      const { errors } = validateLocalPostgresConfig(text);
      const mine = errors.filter((error) => error.includes(problem));
      assert.equal(mine.length, 1, `${key} ${problem}: ${errors.join('\n')}`);
      assert.match(
        mine[0],
        new RegExp(`^${UNREGISTERED_DATABASE_URL.replace(/\*/g, '\\*')} \\(line \\d+\\): `),
      );
      assertNoSentinel(errors.join('\n'), `${key} ${problem}`);
    }
  }
  // The value of a registered one is no more repeated than before.
  for (const sentinel of SENTINELS) {
    const { errors } = validateLocalPostgresConfig(fixture({ DATABASE_URL_IDENTITY: sentinel }));
    assert.deepEqual(errors, [`DATABASE_URL_IDENTITY (line 6): malformed URL (no scheme)`]);
  }
});

test('the CLI: every line it prints for a DATABASE_URL_* named for no service is free of the name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasta-local-pg-'));
  try {
    for (const key of SENTINEL_KEYS) {
      for (const [text, problem] of sentinelCases(key)) {
        const copy = join(dir, 'env.example');
        writeFileSync(copy, text);
        const run = spawnSync(process.execPath, [CLI, '--file', copy], { encoding: 'utf8' });
        assert.equal(run.status, 1, `${problem}: ${run.stderr}`);
        assert.ok(run.stderr.includes(`${UNREGISTERED_DATABASE_URL} (line`), run.stderr);
        assertNoSentinel(run.stdout + run.stderr, `${key} ${problem}`);
      }
    }
    // Positive control: the same file with only registered names passes.
    const copy = join(dir, 'env.example');
    writeFileSync(copy, fixture());
    const ok = spawnSync(process.execPath, [CLI, '--file', copy], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #385 r4, the rule for numbers: a port is printed only once read as one —
// POSTGRES_PORT after its digits check, a URL's port after the URL parser's.
// Written as text, neither is repeated.
test('a port written as text is refused without being repeated', () => {
  for (const sentinel of SENTINELS) {
    assert.deepEqual(validateLocalPostgresConfig(fixture({ POSTGRES_PORT: sentinel })).errors, [
      'POSTGRES_PORT (line 5): must be a port number 1-65535',
    ]);
    const { errors } = validateLocalPostgresConfig(
      fixture({ DATABASE_URL_IDENTITY: pg('rasta_identity', `127.0.0.1:${sentinel}`) }),
    );
    assert.deepEqual(errors, ['DATABASE_URL_IDENTITY (line 6): malformed PostgreSQL URL']);
    assertNoSentinel(errors.join('\n'), sentinel);
  }
  // A number is printed: it cannot carry text.
  assert.deepEqual(
    validateLocalPostgresConfig(
      fixture({ DATABASE_URL_IDENTITY: pg('rasta_identity', '127.0.0.1:1234') }),
    ).errors,
    ['DATABASE_URL_IDENTITY (line 6): port 1234 does not equal POSTGRES_PORT 5433'],
  );
});

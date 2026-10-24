import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_REFUSALS,
  MIGRATION_STATEMENT_TIMEOUT_SETTING,
  UTC_SESSION_OPTION,
  ledgerRevoke,
  withMigrationStatementTimeout,
  withUtcSession,
} from './prisma-lib.mjs';
import { CREDENTIALS, UTC_SESSION_CORPUS, UTC_SESSION_REFUSED } from './utc-session-corpus.mjs';
import { SENTINELS, assertNoSentinel, thrownBy } from './refusal-probes.mjs';

const pg = (user, db, schema) =>
  `postgresql://${user}:secret_value_here@127.0.0.1:5433/${db}${schema ? `?schema=${schema}` : ''}`;

test('a split service: the runtime role loses the ledger in the migrator URL’s schema', () => {
  const sql = ledgerRevoke({
    migratorUrl: pg('rasta_construction_migrator', 'rasta_construction', 'public'),
    runtimeUrl: pg('rasta_construction', 'rasta_construction', 'public'),
  });
  assert.match(
    sql,
    /REVOKE ALL ON TABLE "public"\."_prisma_migrations" FROM "rasta_construction";/,
  );
  assert.match(sql, /to_regclass\('"public"\."_prisma_migrations"'\) IS NOT NULL/);
  assert.ok(!sql.includes('secret_value_here'), 'no password in the SQL');
});

test('the ledger’s schema follows the URL (audit keeps its tables in schema audit)', () => {
  const sql = ledgerRevoke({
    migratorUrl: pg('rasta_audit_migrator', 'rasta_audit', 'audit'),
    runtimeUrl: pg('rasta_audit', 'rasta_audit', 'audit'),
  });
  assert.match(sql, /"audit"\."_prisma_migrations" FROM "rasta_audit"/);
  assert.match(
    ledgerRevoke({
      migratorUrl: pg('rasta_x_migrator', 'rasta_x'),
      runtimeUrl: pg('rasta_x', 'rasta_x'),
    }),
    /"public"\."_prisma_migrations"/,
  );
});

test('nothing to revoke when not split, or when either URL is missing', () => {
  const same = pg('rasta_economic', 'rasta_economic', 'public');
  assert.equal(ledgerRevoke({ migratorUrl: same, runtimeUrl: same }), null);
  assert.equal(ledgerRevoke({ migratorUrl: undefined, runtimeUrl: same }), null);
  assert.equal(ledgerRevoke({ migratorUrl: same, runtimeUrl: undefined }), null);
});

test('refuses an identifier it would have to interpolate unquoted-unsafe', () => {
  assert.throws(
    () =>
      ledgerRevoke({
        migratorUrl: pg('m', 'db', 'public'),
        runtimeUrl: pg('evil%22%3B%20DROP', 'db', 'public'),
      }),
    { message: MIGRATION_REFUSALS.runtimeRole },
  );
  assert.throws(
    () =>
      ledgerRevoke({
        migratorUrl: pg('m', 'db', 'Pub"lic'),
        runtimeUrl: pg('rasta_x', 'db'),
      }),
    { message: MIGRATION_REFUSALS.schema },
  );
});

// #385 r4: a refusal names the component, never what it holds — nor does any
// part of the thrown object (`new URL` keeps its whole input on `.input`).
test('the ledger refusals repeat nothing of the URLs, in any part of the thrown error', () => {
  for (const sentinel of SENTINELS) {
    const cases = [
      [{ migratorUrl: pg('m', 'db'), runtimeUrl: pg(sentinel, 'db') }, 'runtimeRole'],
      [{ migratorUrl: pg('m', 'db', sentinel), runtimeUrl: pg('rasta_x', 'db') }, 'schema'],
      [
        { migratorUrl: `postgresql://m:${sentinel}@[bad/db`, runtimeUrl: pg('r', 'db') },
        'unreadableUrl',
      ],
      [
        { migratorUrl: pg('m', 'db'), runtimeUrl: `postgresql://${sentinel}@[bad/db` },
        'unreadableUrl',
      ],
      [
        { migratorUrl: pg('m', 'db'), runtimeUrl: `postgresql://%E0%A4%A@h/${sentinel}` },
        'unreadableUrl',
      ],
    ];
    for (const [urls, refusal] of cases) {
      const error = thrownBy(() => ledgerRevoke(urls));
      assert.equal(error.message, MIGRATION_REFUSALS[refusal], `${refusal}: ${sentinel}`);
      assert.equal(error.cause, undefined);
      assert.deepEqual(Object.keys(error), [], 'no property but the message');
      assertNoSentinel(error, `${refusal} (${sentinel})`);
    }
  }
});

// --- withUtcSession (L7-37) ---------------------------------------------------
// The migration runner's copy. The services' copy (packages/config) is held to
// the same output over UTC_SESSION_CORPUS by scripts/db-session-utc.pg.test.mjs.

const ENCODED = 'options=-c%20TimeZone%3DUTC';

test('a migration URL gets the UTC startup option, everything else kept byte for byte', () => {
  assert.equal(
    withUtcSession('postgresql://db:5432/rasta'),
    `postgresql://db:5432/rasta?${ENCODED}`,
  );
  const url = UTC_SESSION_CORPUS[3];
  assert.equal(withUtcSession(url), `${url}&${ENCODED}`);
});

test('an earlier TimeZone in the URL loses to UTC, and a + reads as a space', () => {
  assert.equal(
    new URL(withUtcSession(UTC_SESSION_CORPUS[4])).searchParams.get('options'),
    `-c TimeZone=Asia/Tehran ${UTC_SESSION_OPTION}`,
  );
  assert.equal(
    new URL(withUtcSession(UTC_SESSION_CORPUS[5])).searchParams.get('options'),
    `-c statement_timeout=5000 ${UTC_SESSION_OPTION}`,
  );
});

test('withUtcSession is idempotent, and re-applies after a later TimeZone', () => {
  for (const url of UTC_SESSION_CORPUS) {
    const once = withUtcSession(url);
    assert.equal(withUtcSession(once), once);
    assert.ok(new URL(once).searchParams.get('options').endsWith(UTC_SESSION_OPTION));
  }
  assert.equal(withUtcSession(UTC_SESSION_CORPUS[6]), UTC_SESSION_CORPUS[6]);
});

test('refuses what the services’ copy refuses: repeated options, a raw control character', () => {
  // The r5 examples: `new URL` reads the first as two options (Prisma keeps
  // the last, without the timeout) and drops the tab from the second.
  assert.equal(new URL(UTC_SESSION_REFUSED[0]).searchParams.getAll('options').length, 2);
  assert.equal(
    new URL(UTC_SESSION_REFUSED[4]).searchParams.get('options'),
    '-c statement_timeout=1000 -c TimeZone=UTC',
  );
  for (const url of UTC_SESSION_REFUSED) {
    for (const call of [
      () => withUtcSession(url),
      () => withMigrationStatementTimeout(url, '15min'),
    ]) {
      assert.throws(
        call,
        (error) =>
          /options parameter|raw control character/.test(error.message) &&
          !error.message.includes('db.internal') &&
          !error.message.includes(CREDENTIALS),
        JSON.stringify(url),
      );
    }
  }
  // Percent-encoded, a tab is decoded and read as before.
  assert.equal(
    new URL(
      withUtcSession('postgresql://db/rasta?options=-c%20a%3D1%09-c%20b%3D2'),
    ).searchParams.get('options'),
    `-c a=1\t-c b=2 ${UTC_SESSION_OPTION}`,
  );
});

// --- withMigrationStatementTimeout (D-048) ------------------------------------

test('a statement-timeout override joins the options, before UTC, everything else kept', () => {
  const url = UTC_SESSION_CORPUS[3];
  const overridden = withMigrationStatementTimeout(url, '15min');
  assert.equal(
    overridden,
    `${url}&options=${encodeURIComponent(`-c ${MIGRATION_STATEMENT_TIMEOUT_SETTING}=15min`)}`,
  );
  assert.equal(
    new URL(withUtcSession(overridden)).searchParams.get('options'),
    `-c rasta.migration_statement_timeout=15min ${UTC_SESSION_OPTION}`,
  );
  assert.equal(
    new URL(withMigrationStatementTimeout(UTC_SESSION_CORPUS[5], '90s')).searchParams.get(
      'options',
    ),
    '-c statement_timeout=5000 -c rasta.migration_statement_timeout=90s',
  );
});

test('no override leaves the URL alone; anything but a positive duration is refused', () => {
  for (const value of [undefined, '']) {
    assert.equal(
      withMigrationStatementTimeout(UTC_SESSION_CORPUS[3], value),
      UTC_SESSION_CORPUS[3],
    );
  }
  for (const value of ['0s', '15', '15 min', '1d', '-5s', '5s -c role=postgres', "5s'"]) {
    assert.throws(
      () => withMigrationStatementTimeout(UTC_SESSION_CORPUS[0], value),
      { message: MIGRATION_REFUSALS.statementTimeout },
      value,
    );
  }
});

// Before its check the value is text, not yet a duration: never repeated (#385 r4).
test('a refused statement timeout is not repeated, nor any piece of it', () => {
  for (const sentinel of SENTINELS) {
    for (const value of [sentinel, `15min${sentinel}`, `${sentinel.length}s ${sentinel}`]) {
      const error = thrownBy(() => withMigrationStatementTimeout(UTC_SESSION_CORPUS[0], value));
      assert.equal(error.message, MIGRATION_REFUSALS.statementTimeout);
      assertNoSentinel(error, value);
    }
  }
});

// --- scripts/prisma.mjs, the real entry point (#385 r4) ------------------------
// Run as `db:migrate` runs it, from a service directory, with a stub `prisma`
// first on PATH that records each call: no database is reached, and the record
// shows whether the refusal came before Prisma ran (the statement timeout) or
// after it (the ledger revoke, which follows every run, failed or not).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_DIR = join(ROOT, 'services/document-service');

function runPrismaScript(settings) {
  const bin = mkdtempSync(join(tmpdir(), 'prisma-stub-'));
  const log = join(bin, 'calls.log');
  writeFileSync(
    join(bin, 'prisma'),
    '#!/bin/sh\necho "$*" >> "$STUB_LOG"\ncat > /dev/null\nexit 0\n',
  );
  chmodSync(join(bin, 'prisma'), 0o755);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('DATABASE_URL') && name !== 'RASTA_MIGRATION_STATEMENT_TIMEOUT',
    ),
  );
  try {
    const run = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/prisma.mjs'), 'migrate', 'deploy'],
      {
        cwd: SERVICE_DIR,
        env: { ...env, ...settings, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log },
        encoding: 'utf8',
      },
    );
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

const RUNTIME = 'postgresql://rasta_document:runtime_pw@127.0.0.1:1/rasta_document';
const MIGRATOR = 'postgresql://rasta_document_migrator:owner_pw@127.0.0.1:1/rasta_document';

test('prisma.mjs: a valid configuration migrates, then revokes the ledger (positive control)', () => {
  const run = runPrismaScript({
    DATABASE_URL_DOCUMENT: RUNTIME,
    DATABASE_URL_DOCUMENT_MIGRATOR: MIGRATOR,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls, [
    'migrate deploy',
    'db execute --schema prisma/schema.prisma --stdin',
  ]);
});

test('prisma.mjs: each refusal is its fixed text alone on stderr, at the same point', () => {
  for (const sentinel of SENTINELS) {
    const cases = [
      // Before Prisma runs: nothing is migrated.
      [{ RASTA_MIGRATION_STATEMENT_TIMEOUT: sentinel }, 'statementTimeout', []],
      // After the run, before the revoke is sent.
      [
        { DATABASE_URL_DOCUMENT: `postgresql://${sentinel}:pw@127.0.0.1:1/rasta_document` },
        'runtimeRole',
        ['migrate deploy'],
      ],
      [
        { DATABASE_URL_DOCUMENT_MIGRATOR: `${MIGRATOR}?schema=${sentinel}` },
        'schema',
        ['migrate deploy'],
      ],
      [
        { DATABASE_URL_DOCUMENT_MIGRATOR: `postgresql://m:${sentinel}@[bad/rasta_document` },
        'unreadableUrl',
        ['migrate deploy'],
      ],
    ];
    for (const [settings, refusal, calls] of cases) {
      const run = runPrismaScript({
        DATABASE_URL_DOCUMENT: RUNTIME,
        DATABASE_URL_DOCUMENT_MIGRATOR: MIGRATOR,
        ...settings,
      });
      assert.equal(run.status, 1, `${refusal}: ${run.stderr}`);
      assert.equal(run.stderr, `${MIGRATION_REFUSALS[refusal]}\n`, refusal);
      assert.deepEqual(run.calls, calls, `${refusal}: where it refused`);
      assertNoSentinel(`${run.stdout}\n${run.stderr}`, `${refusal} (${sentinel})`);
    }
  }
});

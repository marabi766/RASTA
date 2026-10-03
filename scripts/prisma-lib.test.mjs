import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UTC_SESSION_CORPUS,
  UTC_SESSION_OPTION,
  ledgerRevoke,
  withUtcSession,
} from './prisma-lib.mjs';

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
    /not a plain identifier/,
  );
  assert.throws(
    () =>
      ledgerRevoke({
        migratorUrl: pg('m', 'db', 'Pub"lic'),
        runtimeUrl: pg('rasta_x', 'db'),
      }),
    /not a plain identifier/,
  );
});

// --- withUtcSession (L7-37) ---------------------------------------------------
// The migration runner's copy. The services' copy (packages/config) is held to
// the same output over UTC_SESSION_CORPUS by scripts/db-session-utc.pg.test.mjs.

const ENCODED = 'options=-c%20TimeZone%3DUTC';

test('a migration URL gets the UTC startup option, everything else kept byte for byte', () => {
  assert.equal(
    withUtcSession('postgresql://u:p@db:5432/rasta'),
    `postgresql://u:p@db:5432/rasta?${ENCODED}`,
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

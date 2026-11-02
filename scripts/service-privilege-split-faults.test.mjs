// -----------------------------------------------------------------------------
// #540 r2 R2-1: a failed statement stops the split, the bootstrap, the
// rotation and the marker, and none of them reports success.
//
//   node --test scripts/service-privilege-split-faults.test.mjs   (no database)
//
// The review's trigger: the standalone split runs under
// `upgrade_service_split … || exit 1`, and bash switches errexit off for
// everything a `||` (or an `if`) tests — so an unchecked `ALTER ROLE …
// NOREPLICATION` that failed was ignored, and the split reported success.
//
// `psql` here is a stand-in first on PATH that records each call and succeeds,
// except the Nth, which fails. For every entry point, a clean run enumerates
// the calls it makes; then EVERY one of them is failed in turn (for the
// bootstrap, which repeats each statement for 16 services: the first call of
// each distinct statement), and the run must
//
//   * exit non-zero,
//   * make no further call — but read-only login checks, which go on to name
//     every role that cannot log in — and
//   * never print its success line.
//
// So no step's failure is swallowed, whichever step it is: the attribute
// reset, REASSIGN, ownership, the migrator and its password, memberships,
// settings, the ledger of lent schema access, the ACL cleanups, the table
// grants, the function repair, the database and schema grants and revokes, the
// ledger, UTC, the return of the lent schema access, the statement_timeout,
// the end-state checks, the runtime password and the logins. Each family is named below and must be among the calls, so the
// enumeration cannot silently shrink.
// -----------------------------------------------------------------------------
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const POSTGRES = join(ROOT, 'infrastructure', 'docker', 'postgres');
const LIB = join(POSTGRES, 'lib');
const SEPARATOR = '\u001e';

/**
 * The stand-in: logs `<argv>\n<stdin>` + SEPARATOR per call, reads stdin only
 * for `-f -` (a `-c` call inside a `while read` loop must not eat the loop's
 * input), answers a role probe `1` and a database probe `1` when
 * FAKE_DB_EXISTS=1, and exits 3 on call number FAIL_AT.
 */
const FAKE_PSQL = `#!/bin/bash
n=$(( $(cat "$FAKE_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE_DIR/count"
sql=""
if [[ " $* " == *" -f - "* ]]; then sql="$(cat)"; fi
printf '%s\\n%s${SEPARATOR}' "$*" "$sql" >> "$FAKE_DIR/calls"
if [[ "$n" == "\${FAIL_AT:-0}" ]]; then echo "psql: injected failure of call $n" >&2; exit 3; fi
if [[ "$*" == *"FROM pg_roles WHERE rolname"* || "$sql" == "SELECT 1 FROM pg_roles"* ]]; then echo 1; fi
if [[ "\${FAKE_DB_EXISTS:-0}" == 1 && ( "$*" == *"FROM pg_database WHERE datname"* || "$sql" == "SELECT 1 FROM pg_database"* ) ]]; then echo 1; fi
exit 0
`;

/** A call that only checks a login (it writes nothing): `-h … -c SELECT 1`. */
const isLoginCheck = (call) =>
  / -h /.test(` ${call.split('\n')[0]} `) && /-c SELECT 1$/.test(call.split('\n')[0]);

function run(entry, failAt) {
  const dir = mkdtempSync(join(tmpdir(), 'rasta-split-faults-'));
  writeFileSync(join(dir, 'psql'), FAKE_PSQL);
  chmodSync(join(dir, 'psql'), 0o755);
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', entry.script, 'faults', ...(entry.args ?? [])], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: process.env.HOME,
        FAKE_DIR: dir,
        FAIL_AT: String(failAt),
        POSTGRES_USER: 'rasta',
        RASTA_DB_BOOTSTRAP: 'compose',
        ...entry.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => {
      const log = join(dir, 'calls');
      const calls = existsSync(log)
        ? readFileSync(log, 'utf8')
            .split(SEPARATOR)
            .filter((c) => c !== '')
        : [];
      rmSync(dir, { recursive: true, force: true });
      resolve({ status, stdout, stderr, calls });
    });
  });
}

/** Runs `jobs` (thunks returning promises) a few at a time. */
async function pool(jobs, size = Math.max(2, Math.min(8, availableParallelism()))) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
      }
    }),
  );
  return results;
}

/** One statement, whichever service or password it names: the bootstrap's call sites. */
const site = (call) =>
  call
    .replace(/_dev_password/g, '')
    .replace(/rasta_[a-z]+/g, 'rasta_X')
    .replace(/'[^']*'/g, "'…'")
    .replace(
      /\b(postgis|ltree|pg_trgm|pgcrypto|btree_gist|keycloak|temporal_visibility|temporal)\b/g,
      'E',
    );

const SPLIT = join(LIB, 'service-privilege-split.bash');

/**
 * The bootstrap repeats the same statements for each of 16 services, which
 * only costs time here: it runs from a copy whose service lists are cut to
 * two — one split in default grants (identity), one in migration grants
 * (supplier) — and audit. Nothing else in the copy differs.
 */
const BOOTSTRAP_COPY = mkdtempSync(join(tmpdir(), 'rasta-bootstrap-copy-'));
cpSync(POSTGRES, BOOTSTRAP_COPY, { recursive: true });
{
  const file = join(BOOTSTRAP_COPY, 'lib', 'role-passwords.bash');
  const source = readFileSync(file, 'utf8');
  const cut = source
    .replace(/^RASTA_SERVICES=\([^)]*\)/m, 'RASTA_SERVICES=(\n  identity\n  supplier\n  audit\n)')
    .replace(
      /^PRIVILEGE_SPLIT_SERVICES=\([^)]*\)/m,
      'PRIVILEGE_SPLIT_SERVICES=(\n  supplier\n  identity\n)',
    );
  assert.notEqual(cut, source);
  assert.ok(cut.includes('RASTA_SERVICES=(\n  identity\n  supplier\n  audit\n)'));
  assert.ok(cut.includes('PRIVILEGE_SPLIT_SERVICES=(\n  supplier\n  identity\n)'));
  writeFileSync(file, cut);
}
after(() => rmSync(BOOTSTRAP_COPY, { recursive: true, force: true }));
const passwords = (svc) => ({
  [`POSTGRES_PASSWORD_${svc.toUpperCase()}`]: `${svc}_runtime_pw_0123456789`,
  [`POSTGRES_PASSWORD_${svc.toUpperCase()}_MIGRATOR`]: `${svc}_migrator_pw_0123456789`,
});

/** Families every split's calls must include (generic and audit alike). */
const SPLIT_FAMILIES = {
  'migrator provisioning': /CREATE ROLE rasta_\w+_migrator LOGIN/,
  'migrator password': /ALTER ROLE rasta_\w+_migrator WITH LOGIN PASSWORD/,
  'attribute reset': /NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION/,
  'database owner': /ALTER DATABASE rasta_\w+ OWNER TO/,
  'REASSIGN OWNED': /REASSIGN OWNED BY/,
  'schema owner': /ALTER SCHEMA public OWNER TO/,
  memberships: /REVOKE %I FROM %I GRANTED BY %I CASCADE/,
  'stored settings': /the split cannot reset/,
  'namespace ledger': /CREATE SCHEMA IF NOT EXISTS rasta_split_lent/,
  'general ACL cleanup': /string_to_array\('general', ','\)/,
  'extension ACL cleanup': /string_to_array\('extension', ','\)/,
  'foreign ownership': /another service''s runtime role/,
  'foreign ACL cleanup': /string_to_array\('foreign', ','\)/,
  'database grants and revokes': /REVOKE ALL ON DATABASE[\s\S]*GRANT CONNECT ON DATABASE/,
  'schema grants and revokes':
    /REVOKE ALL ON SCHEMA public FROM PUBLIC[\s\S]*GRANT USAGE ON SCHEMA/,
  'container ACL cleanup': /string_to_array\('general,extension,foreign', ','\)/,
  'ledger creation': /CREATE TABLE IF NOT EXISTS "\w+"\."_prisma_migrations"/,
  'lent schema access returned': /DROP SCHEMA rasta_split_lent;/,
  'UTC setup': /SET TimeZone = 'UTC'/,
  'forbidden-rights assertion': /the split did not converge/,
  'end-state assertion': /the split did not reach its end state/,
};
const STANDALONE_FAMILIES = {
  'runtime password rotation': /ALTER ROLE rasta_\w+ WITH LOGIN PASSWORD/,
  'login verification': /-c SELECT 1/,
};

const ENTRIES = [
  {
    name: 'standalone split, default grants, listed runtime functions, a statement_timeout (economic)',
    script: `bash "${SPLIT}" economic`,
    env: { ...passwords('economic'), POSTGRES_STATEMENT_TIMEOUT_MS_ECONOMIC: '70000' },
    success: /each log in with the password just set/,
    families: {
      ...SPLIT_FAMILIES,
      ...STANDALONE_FAMILIES,
      'table-grant preparation': /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rasta_economic/,
      'table grants': /GRANT %s ON %s %s TO %I/,
      'runtime function repair': /required runtime function has unsafe ownership/,
      'statement timeout': /SET statement_timeout = '70000ms'/,
    },
  },
  {
    name: 'standalone split, migration grants (supplier, its own entry point)',
    script: `bash "${join(LIB, 'supplier-privilege-split.bash')}"`,
    env: passwords('supplier'),
    success: /each log in with the password just set/,
    families: { ...SPLIT_FAMILIES, ...STANDALONE_FAMILIES },
  },
  {
    name: 'standalone split, audit',
    script: `bash "${SPLIT}" audit`,
    env: passwords('audit'),
    success: /each log in with the password just set/,
    families: {
      ...SPLIT_FAMILIES,
      ...STANDALONE_FAMILIES,
      'audit schema': /CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION rasta_audit_migrator/,
    },
  },
  {
    name: 'bootstrap (00-init-databases.sh; identity, supplier, audit), every distinct statement',
    script: `bash "${join(BOOTSTRAP_COPY, '00-init-databases.sh')}"`,
    distinct: true,
    success: /PostgreSQL bootstrap complete/,
    families: {
      ...SPLIT_FAMILIES,
      'role provisioning': /CREATE ROLE rasta_identity LOGIN CREATEDB/,
      'database probe': /FROM pg_database WHERE datname='rasta_identity'/,
      'database creation': /CREATE DATABASE rasta_identity OWNER/,
      'disposable marker': /rasta\.disposable_database = 'true'/,
      extensions: /CREATE EXTENSION IF NOT EXISTS postgis/,
      'infrastructure databases': /CREATE DATABASE keycloak/,
    },
  },
  {
    name: 'password rotation (rotate-role-passwords.bash), every distinct statement',
    script: `bash "${join(LIB, 'rotate-role-passwords.bash')}"`,
    env: { FAKE_DB_EXISTS: '1', POSTGRES_STATEMENT_TIMEOUT_MS_FLEET: '70000' },
    distinct: true,
    success: /every rotated role logs in with its own password/,
    families: {
      'role probe': /SELECT 1 FROM pg_roles WHERE rolname = 'rasta_identity'/,
      password: /ALTER ROLE rasta_identity WITH PASSWORD/,
      'database probe': /SELECT 1 FROM pg_database WHERE datname = 'rasta_identity'/,
      'UTC setup': /SET TimeZone = 'UTC'/,
      'statement timeout': /SET statement_timeout = '70000ms'/,
      'login verification': /-c SELECT 1/,
    },
  },
  {
    name: 'disposable marker, standalone',
    script: `bash "${join(LIB, 'disposable-marker.bash')}"`,
    env: { FAKE_DB_EXISTS: '1' },
    distinct: true,
    success: /database\(s\) marked/,
    families: {
      'database probe': /FROM pg_database WHERE datname = 'rasta_identity'/,
      marker: /rasta\.disposable_database = 'true'/,
    },
  },
];

for (const entry of ENTRIES) {
  test(`${entry.name}: every call's failure stops the run, which fails`, async () => {
    const clean = await run(entry, 0);
    assert.equal(clean.status, 0, `the clean run failed:\n${clean.stderr}`);
    assert.match(clean.stdout, entry.success);
    const all = clean.calls.join('\n');
    for (const [family, pattern] of Object.entries(entry.families)) {
      assert.match(all, pattern, `no ${family} call among the ${clean.calls.length}`);
    }
    // Which calls to fail: every one, or the first of each distinct statement.
    const targets = [];
    const seen = new Set();
    clean.calls.forEach((call, i) => {
      if (!entry.distinct || !seen.has(site(call))) targets.push(i + 1);
      seen.add(site(call));
    });
    const results = await pool(targets.map((n) => () => run(entry, n)));
    const escapes = [];
    results.forEach((result, i) => {
      const n = targets[i];
      const failed = clean.calls[n - 1].slice(0, 160).replace(/\s+/g, ' ');
      const after = result.calls.slice(n);
      if (result.status === 0) escapes.push(`call ${n} failed, the run exited 0: ${failed}`);
      else if (entry.success.test(result.stdout)) {
        escapes.push(`call ${n} failed, the run printed its success line: ${failed}`);
      } else if (result.calls.length < n) {
        escapes.push(`call ${n} was never reached (the run diverged): ${failed}`);
      } else if (!after.every(isLoginCheck)) {
        escapes.push(
          `call ${n} failed and the run went on to ${after.length} more: ${failed}\n    next: ${after[0].slice(0, 120)}`,
        );
      }
    });
    assert.deepEqual(escapes, [], `${escapes.length} of ${targets.length} failures escaped`);
    assert.ok(targets.length >= Object.keys(entry.families).length);
  });
}

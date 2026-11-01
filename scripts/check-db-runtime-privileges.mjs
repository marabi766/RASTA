#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Fails when a service's runtime database role holds what it must not (D-045).
//
//   pnpm check:db-runtime-privileges     (a PostgreSQL superuser in PG* env,
//                                         every service database migrated)
//
// For every service in RASTA_SERVICES it connects to `rasta_<svc>` as the
// superuser and asks the catalogue what `rasta_<svc>` — the role the service
// connects as — owns or may do: owning the database, a schema, a table, a
// function or a type; SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS or REPLICATION; and any
// right, through any role it is a member of or PUBLIC, that its policy in
// lib/runtime-allowlist.sql does not allow — or one it allows and does not
// hold. Owning a table is what lets SQL running as the service ALTER TABLE …
// DISABLE TRIGGER and lift an integrity guard.
//
// Every service must hold none of it, and every service must be in
// PRIVILEGE_SPLIT_SERVICES (audit has its own split). The rules:
// check-db-runtime-privileges-lib.mjs.
//
// And every database of the cluster that accepts connections — each service's
// and every other — refuses every runtime role but its own (#540 r1 F2): no
// CONNECT, no right on any object, no ownership, through the role itself,
// PUBLIC or a role it is a member of, but what
// lib/runtime-foreign-exceptions.sql declares (for a service database:
// nothing). Every (database, runtime role) pair is checked.
//
// And every session there defaults to UTC on the database side (L7-37): the
// database, `rasta_<svc>` and `rasta_<svc>_migrator` each carry
// `TimeZone = 'UTC'` (lib/session-timezone.bash), and no per-database override
// says otherwise — what still holds when a pooler drops the client's option.
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import {
  CONNECTABLE_DATABASES_SQL,
  FINDINGS_SQL,
  FOREIGN_FINDINGS_SQL,
  TIMEZONE_FINDINGS_SQL,
  classifyServices,
  foreignVerdict,
  matrix,
  timezoneVerdict,
  verdict,
} from './check-db-runtime-privileges-lib.mjs';

function rows(database, sql, variables) {
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-q',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]),
      '-d',
      database,
    ],
    { input: sql, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`${database}: the catalogue query failed\n${result.stderr}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

const entries = classifyServices();
let failed = 0;
const report = (results) => {
  if (results.some(({ ok }) => !ok)) failed += 1;
  for (const { ok, line } of results) {
    (ok ? process.stdout : process.stderr).write(`${ok ? 'ok  ' : 'FAIL'} ${line}\n`);
  }
};
for (const entry of entries) {
  const { runtime, policy } = entry;
  const variables = { runtime, migrator: `${runtime}_migrator`, policy };
  report([
    verdict(entry, rows(entry.database, FINDINGS_SQL, variables)),
    timezoneVerdict(entry, rows(entry.database, TIMEZONE_FINDINGS_SQL, variables)),
  ]);
}
// Every database, every runtime role but its own: the whole matrix. A service
// database that does not accept connections fails here, unchecked.
for (const { database, runtime, problem } of matrix(
  entries,
  rows('postgres', CONNECTABLE_DATABASES_SQL, {}),
)) {
  report([
    problem
      ? { ok: false, line: `${database}: ${problem}` }
      : foreignVerdict(database, rows(database, FOREIGN_FINDINGS_SQL, { runtime })),
  ]);
}
if (failed > 0) {
  process.stderr.write(
    `\n${failed} check(s) failed. A runtime role must own nothing and hold exactly what ` +
      'lib/runtime-allowlist.sql allows it, in its own database and nothing in any other ' +
      '(docs/runbooks/db-role-split.md), and every service database and role must default ' +
      'to UTC sessions (lib/session-timezone.bash; existing volume: pnpm db:rotate-role-passwords).\n',
  );
  process.exit(1);
}

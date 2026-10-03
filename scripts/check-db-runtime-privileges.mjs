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
// function or a type; CREATE on the database or a schema; TRUNCATE, REFERENCES
// or TRIGGER on a table; any right on the migration ledger; SUPERUSER,
// CREATEDB, CREATEROLE or BYPASSRLS. Owning a table is what lets SQL running as
// the service ALTER TABLE … DISABLE TRIGGER and lift an integrity guard.
//
// Every service must hold none of it, and every service must be in
// PRIVILEGE_SPLIT_SERVICES (audit has its own split). The rules:
// check-db-runtime-privileges-lib.mjs.
//
// And every session there defaults to UTC on the database side (L7-37): the
// database, `rasta_<svc>` and `rasta_<svc>_migrator` each carry
// `TimeZone = 'UTC'` (lib/session-timezone.bash), and no per-database override
// says otherwise — what still holds when a pooler drops the client's option.
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import {
  FINDINGS_SQL,
  TIMEZONE_FINDINGS_SQL,
  classifyServices,
  timezoneVerdict,
  verdict,
} from './check-db-runtime-privileges-lib.mjs';

function findings(database, runtime, sql = FINDINGS_SQL) {
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-q',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `runtime=${runtime}`,
      '-v',
      `migrator=${runtime}_migrator`,
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

let failed = 0;
for (const entry of classifyServices()) {
  const results = [
    verdict(entry, findings(entry.database, entry.runtime)),
    timezoneVerdict(entry, findings(entry.database, entry.runtime, TIMEZONE_FINDINGS_SQL)),
  ];
  if (results.some(({ ok }) => !ok)) failed += 1;
  for (const { ok, line } of results) {
    (ok ? process.stdout : process.stderr).write(`${ok ? 'ok  ' : 'FAIL'} ${line}\n`);
  }
}
if (failed > 0) {
  process.stderr.write(
    `\n${failed} service(s) failed. A runtime role must own nothing and hold only DML ` +
      '(docs/runbooks/db-role-split.md), and every service database and role must default ' +
      'to UTC sessions (lib/session-timezone.bash; existing volume: pnpm db:rotate-role-passwords).\n',
  );
  process.exit(1);
}

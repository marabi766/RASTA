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
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { FINDINGS_SQL, classifyServices, verdict } from './check-db-runtime-privileges-lib.mjs';

function findings(database, runtime) {
  const result = spawnSync(
    'psql',
    ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-v', `runtime=${runtime}`, '-d', database],
    { input: FINDINGS_SQL, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`${database}: the catalogue query failed\n${result.stderr}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

let failed = 0;
for (const entry of classifyServices()) {
  const { ok, line } = verdict(entry, findings(entry.database, entry.runtime));
  if (!ok) failed += 1;
  (ok ? process.stdout : process.stderr).write(`${ok ? 'ok  ' : 'FAIL'} ${line}\n`);
}
if (failed > 0) {
  process.stderr.write(
    `\n${failed} service(s) failed. A runtime role must own nothing and hold only DML ` +
      '(docs/runbooks/db-role-split.md).\n',
  );
  process.exit(1);
}

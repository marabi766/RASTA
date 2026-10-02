#!/usr/bin/env node
// -----------------------------------------------------------------------------
// ADR-051 Phase B2 — the outbox maintenance the backfill cannot do (D-045).
//
// The backfill writes as each service's runtime role, which owns no table. For
// such a role PostgreSQL *skips* `VACUUM` with a warning and reports success,
// so the backfill never issues one: an apply that wrote anything ends with
// `vacuum: required` for the outbox table instead (Codex on #180). This command
// pays that debt — `VACUUM (ANALYZE)` on the outbox table, as the table's
// owner — and proves it did, from the table's own counters, or refuses.
//
// Usage, after a `--apply` (and between the slices of a `--max-batches` run):
//
//   node --env-file=.env.migrator scripts/outbox-b2-vacuum.mjs --service document
//   node --env-file=.env.migrator scripts/outbox-b2-vacuum.mjs --all
//
// The credential is `DATABASE_URL_<SERVICE>_MIGRATOR`, read from the
// environment and from nowhere else: there is no URL option, because a process's
// argv is readable by every local user while it runs. It is never handed to the
// backfill, which refuses any `*_MIGRATOR` variable in its environment.
//
// Per service, in order:
//
//   1. The outbox table on that connection, its owner and its counters
//      (`vacuumFactsSql`). No table, or a role that does not own it — directly
//      or by inherited membership — is refused before anything runs: that role's
//      VACUUM would be skipped, and this command exists to never report a
//      skipped one.
//   2. `VACUUM (ANALYZE)` on that table, by its catalogue name.
//   3. The counters again. `vacuum_count` and `analyze_count` count manual runs
//      only (autovacuum has its own), so both must have grown or the run is
//      refused: "it returned without an error" is not evidence that it ran.
//
// Output is NDJSON on stdout, one `vacuum` or `refused` event per service and a
// `summary` last; it names roles, tables and counts, never a URL or password.
// Exit 0 only when every selected service's vacuum was verified.
// -----------------------------------------------------------------------------
import {
  B2RefusalError,
  SERVICES,
  assertEnvironment,
  databaseUrlKey,
  vacuumFactsSql,
  vacuumSql,
} from './outbox-b2-lib.mjs';
import { prismaPort } from './outbox-b2-prisma-port.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** How long the counters may take to show a vacuum that ran (they are written as it ends). */
const SETTLE_MS = 5_000;

const emit = (event) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
};

const refuse = (message) => {
  throw new B2RefusalError(message);
};

/** `--service <name>` (repeatable) or `--all`, and nothing else — no URL, ever. */
export function parseVacuumOptions(argv, env = {}) {
  const services = [];
  let all = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--service') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) refuse('--service needs a value.');
      services.push(next);
      i += 1;
    } else {
      refuse(
        `Unknown option "${arg}". Known: --service, --all. The connection comes from ` +
          'DATABASE_URL_<SERVICE>_MIGRATOR in the environment, never from an argument.',
      );
    }
  }
  if (all && services.length > 0) refuse('--all and --service contradict each other.');
  const selected = all ? [...SERVICES] : services;
  if (selected.length === 0) {
    refuse(`No target selected. Pass --service <name> or --all. Known: ${SERVICES.join(', ')}.`);
  }
  for (const service of selected) databaseUrlKey(service); // refuses an unknown one
  const duplicates = selected.filter((s, i) => selected.indexOf(s) !== i);
  if (duplicates.length > 0)
    refuse(`Named more than once: ${[...new Set(duplicates)].join(', ')}.`);
  assertEnvironment(env);
  return { services: selected };
}

const count = (value) => Number(value);

async function facts(db, service) {
  const [row] = await db.query(vacuumFactsSql());
  if (!row) {
    refuse(`${service}: there is no outbox table on this connection's search_path.`);
  }
  return {
    role: row.role,
    table: row.qualified,
    mayVacuum: row.may_vacuum === true,
    vacuumCount: count(row.vacuum_count),
    analyzeCount: count(row.analyze_count),
  };
}

/** One service: refuse a role that cannot vacuum, vacuum, and prove it from the counters. */
export async function vacuumService({ service, db, settleMs = SETTLE_MS }) {
  const before = await facts(db, service);
  if (!before.mayVacuum) {
    refuse(
      `${service}: ${before.role} does not own ${before.table}, so PostgreSQL would skip its ` +
        `VACUUM. Set ${databaseUrlKey(service)}_MIGRATOR to the service's migrator — the ` +
        "table's owner since D-045.",
    );
  }

  await db.execute(vacuumSql(before.table));

  const ran = (now) =>
    now.vacuumCount > before.vacuumCount && now.analyzeCount > before.analyzeCount;
  const deadline = Date.now() + settleMs;
  let after = await facts(db, service);
  while (!ran(after) && Date.now() < deadline) {
    await new Promise((settled) => setTimeout(settled, 100));
    after = await facts(db, service);
  }
  if (!ran(after)) {
    refuse(
      `${service}: VACUUM (ANALYZE) ${before.table} returned, but the table's counters did ` +
        `not move (vacuum_count ${before.vacuumCount} → ${after.vacuumCount}, analyze_count ` +
        `${before.analyzeCount} → ${after.analyzeCount}); it did not run. Nothing is reported ` +
        'as vacuumed.',
    );
  }
  return {
    role: before.role,
    table: before.table,
    vacuumCount: { before: before.vacuumCount, after: after.vacuumCount },
    analyzeCount: { before: before.analyzeCount, after: after.analyzeCount },
  };
}

async function main() {
  const { services } = parseVacuumOptions(process.argv.slice(2), process.env);
  let verified = 0;
  let refused = 0;
  for (const service of services) {
    let db;
    try {
      const key = `${databaseUrlKey(service)}_MIGRATOR`;
      const url = process.env[key];
      if (!url) refuse(`${key} is not set (see .env.migrator.example).`);
      db = prismaPort(service, url);
      const result = await vacuumService({ service, db });
      verified += 1;
      emit({ type: 'vacuum', service, status: 'verified', ...result });
    } catch (error) {
      refused += 1;
      // The message only: never the stack, which can carry the datasource.
      emit({
        type: 'refused',
        service,
        reason: error instanceof B2RefusalError ? error.message : String(error.message ?? error),
      });
    } finally {
      await db?.close();
    }
  }
  emit({ type: 'summary', services: services.length, verified, refused });
  return refused === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.exitCode = await main().catch((error) => {
    emit({
      type: 'refused',
      reason: error instanceof B2RefusalError ? error.message : String(error.message ?? error),
    });
    return 1;
  });
}

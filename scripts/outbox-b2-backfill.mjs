#!/usr/bin/env node
// -----------------------------------------------------------------------------
// ADR-051 Phase B2 — the operational backfill CLI.
//
// Fills `outbox_message.stream_seq`, marks `is_stream_head`, and establishes
// `outbox_stream_sequence` on the eight service-owned databases that B1
// prepared. It is the first ADR-051 phase that changes data, and it changes it
// only because a human ran this command.
//
// It is NOT a migration and must never become one. No Prisma migration
// contains this DML, nothing in app startup, `pnpm verify`, CI or a deployment
// hook invokes it, and it will not run without an explicit target and an
// explicit `--apply`.
//
// Usage:
//
//   # what would happen — reads only, mutates nothing
//   node --env-file=.env scripts/outbox-b2-backfill.mjs --service document
//
//   # do it
//   node --env-file=.env scripts/outbox-b2-backfill.mjs --service document --apply
//
//   # all eight, resumable, bounded
//   node --env-file=.env scripts/outbox-b2-backfill.mjs --all --apply --max-batches 20
//
// Options:
//
//   --service <name>    repeatable; one of identity, organization, asset, fleet,
//                       maintenance, economic, marketplace, document
//   --all               every one of the eight (explicit; there is no default)
//   --apply             actually write. Without it the run is a plan.
//   --dry-run           name the default explicitly; contradicts --apply
//   --batch-size <n>    rows per transaction, 1..5000 (default 5000)
//   --max-batches <n>   stop after n batches — a bounded, resumable slice
//   --vacuum-every <n>  VACUUM (ANALYZE) every n completed batches (default 1)
//
// Output is NDJSON on stdout: one object per event, counts only. No payload,
// no credential and no connection string is ever printed — the events carry
// the service name and numbers, and the errors name environment variables
// rather than their values.
//
// Exit status is 0 only if every targeted service converged (or planned)
// without a refusal.
// -----------------------------------------------------------------------------
import {
  B2RefusalError,
  parseOptions,
  resolveDatabaseUrl,
  runServiceBackfill,
} from './outbox-b2-lib.mjs';
import { prismaPort } from './outbox-b2-prisma-port.mjs';

const emit = (event) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
};

async function main() {
  const options = parseOptions(process.argv.slice(2), process.env);
  let failures = 0;

  for (const service of options.services) {
    const url = resolveDatabaseUrl(service, process.env);
    let db;
    try {
      db = prismaPort(service, url);
      await runServiceBackfill({ service, db, options, emit });
    } catch (error) {
      failures += 1;
      // The message, never the stack and never the URL: a stack from a Prisma
      // client can carry the datasource in it.
      emit({
        type: 'refused',
        service,
        reason: error instanceof B2RefusalError ? error.message : String(error.message ?? error),
      });
    } finally {
      await db?.close();
    }
  }

  emit({
    type: 'summary',
    mode: options.apply ? 'apply' : 'dry-run',
    services: options.services.length,
    failures,
  });
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main().catch((error) => {
  emit({
    type: 'refused',
    reason: error instanceof B2RefusalError ? error.message : String(error.message ?? error),
  });
  return 1;
});

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
//   --max-batches <n>   stop after n batches — a bounded, resumable slice.
//                       If work remains the run reports `incomplete` and exits 1.
//   --vacuum-every <n>  VACUUM (ANALYZE) every n completed batches (default 1)
//
// Output is NDJSON on stdout: one object per event, counts only. No payload,
// no credential and no connection string is ever printed — the events carry
// the service name and numbers, and the errors name environment variables
// rather than their values.
//
// Per service the run ends in exactly one of three terminal events, and the
// last line is always a `summary`:
//
//   (none)         the service is done — a plan, or an apply that converged.
//                  Counted in `summary.ok`.
//   `incomplete`   an apply that stopped with work still to do: the
//                  `--max-batches` budget ran out, or rows remain unsequenced.
//                  Everything already assigned is committed and a re-run
//                  resumes from it. Counted in `summary.incomplete`.
//   `refused`      a precondition, guard or maintenance failure. Counted in
//                  `summary.refused`.
//
// **Exit status.** 0 only when every selected service finished what it was
// asked to do: a dry run always converges by definition, and an apply
// converges when nothing was truncated and no unsequenced pending row is
// left. Any `incomplete` or any `refused` makes the exit status 1 — a bounded
// slice (`--apply --max-batches N`) that leaves work behind therefore exits
// non-zero *by design*, so an operator's script cannot mistake a partial
// backfill for a finished one. Every selected service is still attempted; one
// service stopping never skips the next.
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

/**
 * Did this service finish what it was asked to do?
 *
 * A plan is complete by definition — it was never going to write anything. An
 * apply is complete only when it *converged*: the `--max-batches` budget did
 * not cut it short, and the post-run count of unpublished unsequenced rows is
 * zero. Both halves matter. Truncation is the ordinary bounded-slice case, and
 * a non-zero remainder without truncation means rows arrived during the run —
 * either way there is work left, and calling that success is what made a
 * partial backfill indistinguishable from a finished one.
 */
function converged(result) {
  if (!result.applied) return true;
  return result.truncated === false && result.verified.remaining === 0;
}

async function main() {
  const options = parseOptions(process.argv.slice(2), process.env);
  let ok = 0;
  let incomplete = 0;
  let refused = 0;

  for (const service of options.services) {
    const url = resolveDatabaseUrl(service, process.env);
    let db;
    try {
      db = prismaPort(service, url);
      const result = await runServiceBackfill({ service, db, options, emit });
      if (converged(result)) {
        ok += 1;
      } else {
        incomplete += 1;
        // Distinct from `refused` on purpose: nothing went wrong, the run was
        // simply bounded. Counts only — no payload, no URL, no stack.
        emit({
          type: 'incomplete',
          service,
          batches: result.batches.length,
          remaining: result.verified.remaining,
          truncated: result.truncated,
          reason:
            `${result.verified.remaining} unpublished row(s) are still unsequenced after ` +
            `${result.batches.length} batch(es)` +
            (result.truncated ? ' — the --max-batches budget was reached' : '') +
            '. Every sequence already assigned is committed and is never renumbered; ' +
            're-run this service without --max-batches to converge.',
        });
      }
    } catch (error) {
      refused += 1;
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
    // No `break`: every explicitly selected service is attempted, so one
    // bounded or refused service never silently skips the rest.
  }

  emit({
    type: 'summary',
    mode: options.apply ? 'apply' : 'dry-run',
    services: options.services.length,
    ok,
    incomplete,
    refused,
  });
  return incomplete + refused === 0 ? 0 : 1;
}

process.exitCode = await main().catch((error) => {
  emit({
    type: 'refused',
    reason: error instanceof B2RefusalError ? error.message : String(error.message ?? error),
  });
  return 1;
});

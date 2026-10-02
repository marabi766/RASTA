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
//
// No VACUUM (D-045, Codex on #180). The backfill connects as the service's
// runtime role, which owns no table, and PostgreSQL skips such a role's VACUUM
// with a warning while reporting success. So it never vacuums: an apply that
// wrote anything emits `vacuum` with `status: "required"` and the table, and
// `scripts/outbox-b2-vacuum.mjs --service <name>` — with the migrator's
// credential in its environment, never in this process — runs
// `VACUUM (ANALYZE)` and proves it from the table's counters. For a large
// table, slice the apply with --max-batches and run it between the slices.
// `--vacuum-every` is refused by name.
//
// Output is NDJSON on stdout: one object per event, counts only. No payload,
// no credential and no connection string is ever printed — the events carry
// the service name and numbers, and the errors name environment variables
// rather than their values.
//
// A run takes exactly one of two paths, and they emit different things.
//
// ## 1. Global preflight refusal
//
// Target selection, option parsing or the environment check fails, before any
// service is iterated: no target, an unknown or repeated service, `--dry-run`
// with `--apply`, a bad or out-of-range numeric option, an unknown option,
// `NODE_ENV=production`, an unrecognised `NODE_ENV`, or a database owner's
// credential (`*_MIGRATOR`) anywhere in the environment (D-045).
//
//   Output:  exactly one `refused` event, and nothing else.
//   Scope:   **unscoped** — it carries no `service` field, because no valid
//            service plan exists yet to attribute it to.
//   Summary: **none.** There is nothing to aggregate.
//   Exit:    1.
//
// ## 2. Validated service run
//
// Options and environment are good, so every selected service is attempted in
// order and the aggregate `summary` is the final line. Per service:
//
//   `plan`         the counts a run would act on. First event for a service
//                  that got as far as opening its database.
//   `batch`        one per batch of an apply: rows assigned.
//   `counters`,    written once, only when the run converged.
//   `heads`
//   `vacuum`       `status: "required"` with the table, once, after an apply
//                  that wrote anything — the maintenance this run did not do.
//   `verify`       the post-run counts, read back from the database.
//   `done`         emitted by the service backfill for any attempt that ran to
//                  the end — a dry run or an apply — carrying `converged`,
//                  `mutated` and, for an apply, `vacuum` (`required` or
//                  `not-required`).
//
// **`mode` and `mutated` are not the same thing, and the difference matters
// for evidence.** `mode: "apply"` says writing was *authorised*. `mutated`
// says the database actually *changed*: it is true only when this run assigned
// at least one sequence, wrote or updated at least one counter row, or changed
// at least one head flag — the three write counts the `batch`, `counters` and
// `heads` events report. A converged apply against a service with nothing to
// do reports `mode: "apply", mutated: false`, and that is the honest answer.
//
// and then exactly one CLI-level outcome for that service:
//
//   (none)         it converged. `done.converged` is true, and the service is
//                  counted in `summary.ok`.
//   `incomplete`   emitted *after* `done` when an apply did not converge: the
//                  `--max-batches` budget ran out, or unsequenced pending rows
//                  remain. Everything already assigned is committed and a
//                  re-run resumes from it. Counted in `summary.incomplete`.
//   `refused`      emitted *instead of* `done` when the attempt failed:
//                  `DATABASE_URL_<SERVICE>` unset, it connects as anything but
//                  the service's runtime role (D-045: a split service's URL is
//                  proven before the first query, so a migrator, owner or
//                  superuser URL never writes), a B1 precondition failed,
//                  or the ordering guard tripped. Scoped to
//                  that one service — every later selected service is still
//                  attempted and the summary is still emitted. Counted in
//                  `summary.refused`.
//
//   Summary: always, as the last line, with `services`, `ok`, `incomplete`
//            and `refused`.
//   Exit:    0 only when `incomplete` and `refused` are both zero — a dry run
//            converges by definition, and an apply converges when nothing was
//            truncated and no unsequenced pending row is left. A bounded slice
//            (`--apply --max-batches N`) that leaves work behind therefore
//            exits non-zero *by design*, so an operator's script cannot
//            mistake a partial backfill for a finished one.
// -----------------------------------------------------------------------------
import {
  B2RefusalError,
  databaseUrlKey,
  parseOptions,
  resolveDatabaseUrl,
  runServiceBackfill,
} from './outbox-b2-lib.mjs';
import { prismaPort } from './outbox-b2-prisma-port.mjs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { splitServicesFromLibrary } from './infra-preflight-lib.mjs';

// The same owner-credential rule every service entry point runs (D-045).
const { assertNoMigratorCredentials } = createRequire(import.meta.url)(
  join(import.meta.dirname, '..', 'packages', 'config', 'dist', 'index.js'),
);

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
  // D-045 (Codex on #178): this command writes to a service's database, so it
  // is held to the rule every entry point is held to. No owner's credential in
  // its environment at all — a global refusal, before any service — and, below,
  // each split service's URL proven to be its runtime role before the first
  // query: `--apply` with a migrator URL in DATABASE_URL_<SERVICE> would
  // otherwise write as the database owner.
  assertNoMigratorCredentials(process.env);
  const options = parseOptions(process.argv.slice(2), process.env);
  const split = new Set(splitServicesFromLibrary());
  let ok = 0;
  let incomplete = 0;
  let refused = 0;

  for (const service of options.services) {
    let db;
    try {
      // Inside the boundary, not above it. Resolving the URL can refuse — a
      // missing `DATABASE_URL_<SERVICE>` is the ordinary case — and a throw
      // from here used to escape to the outer catch, which ended the process
      // before the later selected services were attempted and before any
      // summary was emitted. One service's missing connection is that
      // service's refusal, not the whole run's.
      const url = resolveDatabaseUrl(service, process.env);
      db = prismaPort(service, url);
      // Before the first query; a refusal is this service's `refused` event.
      if (split.has(service)) await db.preflight(databaseUrlKey(service));
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
      // Every way one service can fail lands here: an unresolvable connection,
      // a B1 precondition, the ordering guard. The message,
      // never the stack and never the URL — a stack from a Prisma client can
      // carry the datasource in it, and `resolveDatabaseUrl` deliberately
      // names the environment variable rather than its value.
      emit({
        type: 'refused',
        service,
        reason: error instanceof B2RefusalError ? error.message : String(error.message ?? error),
      });
    } finally {
      await db?.close();
    }
    // No `break`: every explicitly selected service is attempted, so one
    // bounded or refused service never silently skips the rest, and the
    // summary below is always reached.
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

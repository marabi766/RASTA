#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Runs the Prisma CLI with the right database for the calling service.
//
// The repo-root .env names every database explicitly — DATABASE_URL_ASSET,
// DATABASE_URL_IDENTITY and so on — so one file can describe the whole platform
// without any service being able to open another's database by accident
// (ADR-005). The running services map that in their env loader; the Prisma CLI
// has no such loader and looks only at DATABASE_URL.
//
// This script closes that gap. It reads the calling package's name, resolves
// the matching DATABASE_URL_<SERVICE>, and execs Prisma with it — so
// `pnpm db:migrate` works from a clean shell, which is what CLAUDE.md has
// always claimed.
//
// Invoked as: node --env-file=../../.env ../../scripts/prisma.mjs migrate deploy
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitServicesFromLibrary } from './infra-preflight-lib.mjs';
import { ledgerRevoke, withUtcSession } from './prisma-lib.mjs';

const cwd = process.cwd();

function serviceSuffix() {
  const { name } = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  const match = /^@rasta\/(.+)-service$/.exec(name ?? '');
  if (!match) {
    throw new Error(
      `${name} is not a @rasta/<name>-service package; run this from a service directory.`,
    );
  }
  return match[1].replaceAll('-', '_').toUpperCase();
}

const suffix = serviceSuffix();
const key = `DATABASE_URL_${suffix}`;
const migratorKey = `${key}_MIGRATOR`;

// Every command routed through this script is DDL — `migrate deploy` and
// `migrate dev` are its only two callers — so it prefers a migrator connection
// when the service declares one.
//
// audit-service is the first to need this and the reason it exists. ADR-053
// makes `audit_event` append-only at the privilege layer, and a privilege the
// runtime role can hand back to itself is not a barrier: PostgreSQL lets a
// table owner `GRANT UPDATE` to itself unchallenged (measured on 16.4). So the
// audit tables are owned by `rasta_audit_migrator` in a schema that role owns,
// and the runtime role gets only SELECT and INSERT. Migrations must therefore
// connect as the owner, not as the service.
//
// D-045 made it the rule rather than audit's exception: every service in
// PRIVILEGE_SPLIT_SERVICES (lib/role-passwords.bash) is owned by
// `rasta_<svc>_migrator`, and its runtime role cannot run DDL at all. A service
// not split yet resolves exactly as before.
//
// And for a split service the migrator URL is **required**: its runtime role
// can run no DDL, so falling back to it would only fail later and less clearly
// (and a migration that half-ran as the wrong role is worse than none). The
// owner credentials live in .env.migrator, which the `db:migrate` scripts load
// beside .env (Codex review of #176).
const service = suffix.toLowerCase();
const ownerRequired = service === 'audit' || splitServicesFromLibrary().includes(service);
if (ownerRequired && !process.env[migratorKey]) {
  console.error(
    `${migratorKey} is not set. ${service}-service's database is owned by its migrator ` +
      '(D-045) and only it can migrate. Copy .env.migrator.example to .env.migrator at the ' +
      'repository root, or export the variable.',
  );
  process.exit(1);
}
const given = process.env[migratorKey] ?? process.env.DATABASE_URL ?? process.env[key];

if (!given) {
  console.error(
    `Neither ${migratorKey} nor ${key} is set. Copy .env.example to .env at the ` +
      `repository root, or set DATABASE_URL for this process.`,
  );
  process.exit(1);
}

// Every migration session runs in UTC (L7-37): a backfill that writes `now()`
// into a `timestamp(3)` column stores the session's wall time, which Prisma
// reads back as UTC. A startup option, so it holds whatever the server's or
// the migrator role's default is — and for the ledger revoke below too.
const url = withUtcSession(given);

const result = spawnSync('prisma', process.argv.slice(2), {
  cwd,
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'inherit',
  shell: true,
});

// Whatever the run's outcome: a failed migration must not leave the ledger
// writable either.
{
  const revoke = ledgerRevoke({
    migratorUrl: process.env[migratorKey],
    runtimeUrl: process.env[key],
  });
  if (revoke) {
    // D-045: the migration ledger is the migrator's alone. A runtime role that
    // could write it could mark a guard-creating migration as already applied.
    // lib/service-privilege-split.bash creates the ledger itself, owned by the
    // migrator and granted to no one, before any migration runs (Codex review
    // of #176), so this is belt and braces: should the ledger ever be created
    // by Prisma instead — a `migrate reset`, a database split by hand — it
    // would inherit the runtime role's default DML grant, and loses it here,
    // after every run, failed or not (idempotent; a no-op where it holds
    // nothing).
    // Through the schema's datasource — `env("DATABASE_URL")`, the migrator's
    // here — so no credential appears on a command line.
    const after = spawnSync(
      'prisma',
      ['db', 'execute', '--schema', 'prisma/schema.prisma', '--stdin'],
      {
        cwd,
        env: { ...process.env, DATABASE_URL: url },
        input: revoke,
        stdio: ['pipe', 'inherit', 'inherit'],
        shell: true,
      },
    );
    if (after.status !== 0) {
      console.error(`Could not revoke the runtime role's rights on the migration ledger.`);
      process.exit(result.status || after.status || 1);
    }
  }
}

process.exit(result.status ?? 1);

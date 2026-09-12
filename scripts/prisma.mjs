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
// Additive by construction: a service with no `DATABASE_URL_<SVC>_MIGRATOR`
// resolves exactly as before, which is every other service today.
const url = process.env[migratorKey] ?? process.env.DATABASE_URL ?? process.env[key];

if (!url) {
  console.error(
    `Neither ${migratorKey} nor ${key} is set. Copy .env.example to .env at the ` +
      `repository root, or set DATABASE_URL for this process.`,
  );
  process.exit(1);
}

const result = spawnSync('prisma', process.argv.slice(2), {
  cwd,
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);

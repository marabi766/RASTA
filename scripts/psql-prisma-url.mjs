#!/usr/bin/env node
// -----------------------------------------------------------------------------
// psql against a database a service's Prisma URL names (FU-128), for runbooks:
//
//   node scripts/psql-prisma-url.mjs DATABASE_URL_MARKETPLACE_MIGRATOR -X -f file.sql
//
// psql refuses a Prisma URL (`invalid URI query parameter: "schema"`), and cutting the
// query off leaves the schema behind: the same statement then runs on whatever
// another schema holds. `psqlInvocation` is the one conversion. It takes the NAME of
// the variable, so that the URL and its password stay off this process's argv.
// Everything after the name goes to psql; psql's exit code is this one's.
// -----------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import {
  UNREADABLE_DATABASE_URL,
  UNUSABLE_PRISMA_OPTIONS,
  UNUSABLE_PRISMA_SCHEMA,
  psqlInvocation,
} from './verify-migration-reversible-lib.mjs';

const [name, ...args] = process.argv.slice(2);
if (!/^DATABASE_URL_[A-Z0-9_]+$/.test(name ?? '') || !process.env[name]) {
  console.error('the first argument must name a set DATABASE_URL_* variable, never hold a URL');
  process.exit(2);
}

// A service file's `options` would override PGOPTIONS, with no error.
if (process.env.PGSERVICE) {
  console.error(UNUSABLE_PRISMA_OPTIONS);
  process.exit(2);
}

let invocation;
try {
  invocation = psqlInvocation(process.env[name], process.env.PGOPTIONS);
} catch (error) {
  // Only a fixed text: anything else may quote the URL.
  const fixed = [UNUSABLE_PRISMA_SCHEMA, UNUSABLE_PRISMA_OPTIONS];
  console.error(fixed.includes(error.message) ? error.message : UNREADABLE_DATABASE_URL);
  process.exit(2);
}

const result = spawnSync('psql', [invocation.target, ...args], {
  stdio: 'inherit',
  env: { ...process.env, ...invocation.env },
});
if (result.error) console.error('psql could not be started');
process.exit(result.status ?? 1);

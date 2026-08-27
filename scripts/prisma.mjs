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
// An explicit DATABASE_URL wins, so CI and containers — which set exactly one
// database per process — need no special case.
const url = process.env.DATABASE_URL ?? process.env[key];

if (!url) {
  console.error(
    `${key} is not set. Copy .env.example to .env at the repository root, ` +
      `or set DATABASE_URL for this process.`,
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

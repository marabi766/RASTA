#!/usr/bin/env node
/**
 * Fails if a composite index on a tenant-owned table does not lead with
 * `organization_id` and is not exempted with its reason (ADR-011, L7-44).
 *
 *   node scripts/check-tenant-index-order.mjs
 *
 * Static; runs in `pnpm verify` and CI. The reasoning and the exemptions are
 * in `check-tenant-index-order-lib.mjs`.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEMPTIONS,
  SERVICES,
  checkTenantIndexOrder,
  readMigrationTexts,
  replayMigrations,
} from './check-tenant-index-order-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;

for (const service of SERVICES) {
  const dir = join(root, 'services', `${service}-service`, 'prisma', 'migrations');
  if (!existsSync(dir)) {
    console.error(`tenant index order: ${service}: no migrations directory at ${dir}`);
    failed = true;
    continue;
  }
  const state = replayMigrations(readMigrationTexts(dir));
  const { errors, checked } = checkTenantIndexOrder(state, EXEMPTIONS[service] ?? {});
  if (checked === 0) {
    console.error(
      `tenant index order: ${service}: found no composite tenant index — refusing to pass an empty check`,
    );
    failed = true;
  }
  if (errors.length > 0) {
    console.error(`tenant index order: ${service}: ${errors.length} problem(s)`);
    for (const error of errors) console.error(`  ${error}`);
    failed = true;
  } else {
    console.log(`tenant index order: ${service}: ${checked} composite tenant index(es) checked`);
  }
}

process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * Fails if a composite index on a tenant-owned table does not lead with
 * `organization_id`, or a tenant-owned table has no index that does, and
 * neither is exempted with its reason (ADR-011, L7-44).
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
  TABLE_EXEMPTIONS,
  TABLE_FINDINGS_PENDING,
  checkTenantIndexOrder,
  checkTenantLeadingIndex,
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
  const order = checkTenantIndexOrder(state, EXEMPTIONS[service] ?? {});
  const leading = checkTenantLeadingIndex(
    state,
    TABLE_EXEMPTIONS[service] ?? {},
    undefined,
    TABLE_FINDINGS_PENDING[service] ?? [],
  );
  for (const note of leading.notes) console.log(`tenant index order: ${service}: ${note}`);
  const errors = [...order.errors, ...leading.errors];
  const { checked } = order;
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
    console.log(
      `tenant index order: ${service}: ${checked} composite tenant index(es) and ` +
        `${leading.checked} tenant table(s) checked`,
    );
  }
}

process.exit(failed ? 1 : 0);

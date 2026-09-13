#!/usr/bin/env node
/**
 * Fails if the provisioned `Rasta Audit Evidence` Grafana dashboard, its
 * datasource/provider provisioning or its Compose mount break the contract in
 * `check-grafana-dashboard-lib.mjs`.
 *
 *   node scripts/check-grafana-dashboard.mjs            # this repository
 *   node scripts/check-grafana-dashboard.mjs --root DIR # another checkout
 *
 * Runs in `pnpm verify` and in CI's `quality` job. Static only: the live
 * provisioning and PromQL check against the pinned images is
 * `verify-grafana-dashboard-live.mjs`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED, checkRepository } from './check-grafana-dashboard-lib.mjs';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const repoRoot =
  rootFlag >= 0 && args[rootFlag + 1]
    ? resolve(args[rootFlag + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { errors, summary } = checkRepository(repoRoot);

if (errors.length > 0) {
  console.error(`grafana dashboard contract: ${errors.length} defect(s)\n`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.warn(
  `grafana dashboard contract: ${summary.panels} panels, ${summary.targets} queries, ` +
    `${summary.alerts} alerts and ${summary.records} recording rule(s) covered; ` +
    `local Grafana start: ${Object.keys(EXPECTED.grafanaNoOutboundEnv).length} no-outbound settings, ` +
    'inert plugins/alerting provisioning',
);

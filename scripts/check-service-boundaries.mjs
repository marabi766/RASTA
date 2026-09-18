#!/usr/bin/env node
/**
 * Fails if any file in one `services/<service>/` package imports, requires or
 * mocks a path inside another service's package (AGENTS.md A-02).
 *
 *   node scripts/check-service-boundaries.mjs            # this repository
 *   node scripts/check-service-boundaries.mjs --root DIR # another checkout
 *
 * Runs in `pnpm verify` and in CI's `quality` job. The reasoning — and why the
 * ESLint rule alone did not catch the violation this was written for — is in
 * `check-service-boundaries-lib.mjs`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatViolation, scanRepository } from './check-service-boundaries-lib.mjs';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const repoRoot =
  rootFlag >= 0 && args[rootFlag + 1]
    ? resolve(args[rootFlag + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { scanned, services, violations } = scanRepository(repoRoot);

if (services === 0 || scanned === 0) {
  // A gate that scanned nothing must not report success.
  console.error(
    `service boundaries: nothing scanned under ${repoRoot}/services — refusing to pass`,
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `service boundaries: ${violations.length} cross-service import(s) found (AGENTS.md A-02).\n` +
      'A service reaches another only over REST or Kafka; shared code belongs in packages/*.\n',
  );
  for (const violation of violations) console.error(`  ${formatViolation(violation)}`);
  process.exit(1);
}

console.warn(
  `service boundaries: ${scanned} files in ${services} service packages, no cross-service imports`,
);

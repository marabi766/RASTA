#!/usr/bin/env node
/**
 * Fails if the committed local PostgreSQL defaults stop naming `127.0.0.1`.
 *
 *   node scripts/check-local-postgres-config.mjs                  # .env.example + .env.migrator.example
 *   node scripts/check-local-postgres-config.mjs --file PATH      # another file
 *
 * A configuration contract, not a network probe: the file is read as text and
 * nothing is connected to. Runs in `pnpm verify`. The reasoning is in
 * `check-local-postgres-config-lib.mjs`. No value is ever printed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMITTED_CONFIG_FILES,
  REQUIRED_HOST,
  validateLocalPostgresConfig,
} from './check-local-postgres-config-lib.mjs';

const args = process.argv.slice(2);
const fileFlag = args.indexOf('--file');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// By default the two committed files, as one: the migrators' URLs moved to
// .env.migrator.example (D-045) and are held to the same host and port as the
// POSTGRES_HOST / POSTGRES_PORT in .env.example.
const targets =
  fileFlag >= 0 && args[fileFlag + 1]
    ? [resolve(args[fileFlag + 1])]
    : COMMITTED_CONFIG_FILES.map((name) => resolve(root, name));
const target = targets.join(' + ');

let text;
try {
  text = targets.map((file) => readFileSync(file, 'utf8')).join('\n');
} catch {
  console.error(`local postgres config: cannot read ${target} — refusing to pass`);
  process.exit(1);
}

const { errors, postgresUrls } = validateLocalPostgresConfig(text);

if (errors.length > 0) {
  console.error(
    `local postgres config: ${errors.length} problem(s) in ${target}.\n` +
      `Host-side PostgreSQL defaults must name ${REQUIRED_HOST}: \`localhost\` may resolve to ::1 ` +
      'first while the listener is IPv4-only (P2028 at the transaction maxWait).\n',
  );
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.warn(
  `local postgres config: POSTGRES_HOST and ${postgresUrls.length} PostgreSQL URL(s) use ${REQUIRED_HOST} and POSTGRES_PORT`,
);

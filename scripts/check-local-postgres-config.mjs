#!/usr/bin/env node
/**
 * Fails if the committed local PostgreSQL defaults stop naming `127.0.0.1`.
 *
 *   node scripts/check-local-postgres-config.mjs                  # .env.example
 *   node scripts/check-local-postgres-config.mjs --file PATH      # another file
 *
 * A configuration contract, not a network probe: the file is read as text and
 * nothing is connected to. Runs in `pnpm verify`. The reasoning is in
 * `check-local-postgres-config-lib.mjs`. No value is ever printed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_HOST, validateLocalPostgresConfig } from './check-local-postgres-config-lib.mjs';

const args = process.argv.slice(2);
const fileFlag = args.indexOf('--file');
const target =
  fileFlag >= 0 && args[fileFlag + 1]
    ? resolve(args[fileFlag + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.example');

let text;
try {
  text = readFileSync(target, 'utf8');
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

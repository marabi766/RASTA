#!/usr/bin/env node
/**
 * Runs before `pnpm infra:up` and `pnpm infra:reset`. See infra-preflight-lib.mjs.
 *
 * Reads `.env` the way compose does (the shell's environment wins), prints
 * warnings, and exits non-zero only on an error. Prints no value.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvAssignments } from './check-local-postgres-config-lib.mjs';
import { checkInfraEnv } from './infra-preflight-lib.mjs';

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const fromFile = {};
if (existsSync(envFile)) {
  for (const { name, value } of parseEnvAssignments(readFileSync(envFile, 'utf8')).assignments) {
    fromFile[name] = value;
  }
}

const { errors, warnings } = checkInfraEnv({ ...fromFile, ...process.env });
for (const warning of warnings) console.warn(`infra preflight: warning: ${warning}`);
if (errors.length > 0) {
  console.error(`infra preflight: ${errors.length} problem(s); nothing was started.`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

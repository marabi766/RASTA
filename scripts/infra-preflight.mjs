#!/usr/bin/env node
/**
 * Runs before `pnpm infra:up` and `pnpm infra:reset`. See infra-preflight-lib.mjs.
 *
 * Reads `.env` the way compose does (the shell's environment wins), prints
 * warnings, and exits non-zero only on an error. Prints no value. Also refuses
 * any Kafka credential in `.env` that is not a service's own, since every
 * service loads it (check-kafka-credential-scope-lib.mjs), and warns when
 * `.env` would leave the services unable to reach the authenticated broker.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvAssignments } from './check-local-postgres-config-lib.mjs';
import { checkLocalEnv } from './check-kafka-credential-scope-lib.mjs';
import {
  checkInfraEnv,
  checkKafkaClientEnv,
  kafkaServicesFromPrincipals,
  migratorCredentialsInEnvFile,
} from './infra-preflight-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.env');
const fromFile = {};
const kafkaProblems = [];
const services = kafkaServicesFromPrincipals();
if (existsSync(envFile)) {
  kafkaProblems.push(...checkLocalEnv(readFileSync(envFile, 'utf8'), services));
  for (const { name, value } of parseEnvAssignments(readFileSync(envFile, 'utf8')).assignments) {
    fromFile[name] = value;
  }
}

// The migrators' passwords reach the postgres container from its env_file —
// .env.migrator.example, overridden by .env.migrator — not from .env, so they
// are checked from there, after everything else (D-045, Codex review of #176).
const fromMigratorFiles = {};
for (const name of ['.env.migrator.example', '.env.migrator']) {
  const file = resolve(root, name);
  if (!existsSync(file)) continue;
  for (const { name: key, value } of parseEnvAssignments(readFileSync(file, 'utf8')).assignments) {
    fromMigratorFiles[key] = value;
  }
}

const env = { ...fromFile, ...process.env, ...fromMigratorFiles };
const { errors: infraErrors, warnings } = checkInfraEnv(env);
warnings.push(...migratorCredentialsInEnvFile(fromFile));
// Without a .env nothing runs a service yet; the Kafka check is about a stale one.
if (existsSync(envFile)) warnings.push(...checkKafkaClientEnv(env, services));
const errors = [...infraErrors, ...kafkaProblems];
for (const warning of warnings) console.warn(`infra preflight: warning: ${warning}`);
if (errors.length > 0) {
  console.error(`infra preflight: ${errors.length} problem(s); nothing was started.`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

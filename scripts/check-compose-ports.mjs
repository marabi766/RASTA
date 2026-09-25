#!/usr/bin/env node
/**
 * Fails if docker-compose.yml publishes a port on every interface.
 *
 *   node scripts/check-compose-ports.mjs
 *
 * Static; runs in `pnpm verify` and CI. The reasoning is in
 * `check-compose-ports-lib.mjs`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateComposePorts } from './check-compose-ports-lib.mjs';

const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docker-compose.yml');
const { errors, checked } = validateComposePorts(readFileSync(file, 'utf8'));

if (errors.length > 0) {
  console.error(`compose ports: ${errors.length} mapping(s) not bound to loopback in ${file}`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
if (checked === 0) {
  console.error('compose ports: found no port mappings at all — refusing to pass an empty check');
  process.exit(1);
}
console.log(`compose ports: all ${checked} published port(s) bound to loopback by default`);

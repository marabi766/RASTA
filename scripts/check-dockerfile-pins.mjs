#!/usr/bin/env node
/**
 * Fails if a service Dockerfile uses an unpinned base image, if the services
 * disagree on the digest, or if one runs a bare `apk upgrade`.
 *
 *   node scripts/check-dockerfile-pins.mjs
 *
 * Static; runs in `pnpm verify` and CI. See `check-dockerfile-pins-lib.mjs`
 * and docs/runbooks/base-image-update.md.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDockerfilePins } from './check-dockerfile-pins-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfiles = readdirSync(join(root, 'services'))
  .map((service) => join('services', service, 'Dockerfile'))
  .filter((path) => existsSync(join(root, path)))
  .map((name) => ({ name, text: readFileSync(join(root, name), 'utf8') }));

if (dockerfiles.length === 0) {
  console.error('dockerfile pins: found no service Dockerfiles — refusing to pass an empty check');
  process.exit(1);
}

const { errors, digests } = validateDockerfilePins(dockerfiles);
if (errors.length > 0) {
  console.error(`dockerfile pins: ${errors.length} problem(s)`);
  for (const error of errors) console.error(`  ${error}`);
  console.error('See docs/runbooks/base-image-update.md.');
  process.exit(1);
}
console.log(`dockerfile pins: ${dockerfiles.length} Dockerfiles on one base, ${digests[0]}`);

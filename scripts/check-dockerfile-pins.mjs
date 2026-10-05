#!/usr/bin/env node
/**
 * Fails if a service Dockerfile uses an unpinned base image, if the services
 * disagree on the digest, or if one runs a bare `apk upgrade`; and if an image
 * docker-compose.yml, a workflow or a CI shell script starts is not pinned by
 * digest, or one repository appears at two digests (L7-45).
 *
 *   node scripts/check-dockerfile-pins.mjs
 *
 * Static; runs in `pnpm verify` and CI. See `check-dockerfile-pins-lib.mjs`
 * and docs/runbooks/base-image-update.md (Dockerfiles) and
 * docs/runbooks/infrastructure-image-update.md (compose and CI).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDockerfilePins, validateInfraImagePins } from './check-dockerfile-pins-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfiles = readdirSync(join(root, 'services'))
  .map((service) => join('services', service, 'Dockerfile'))
  .filter((path) => existsSync(join(root, path)))
  .map((name) => ({ name, text: readFileSync(join(root, name), 'utf8') }));

if (dockerfiles.length === 0) {
  console.error('dockerfile pins: found no service Dockerfiles — refusing to pass an empty check');
  process.exit(1);
}

const read = (name, kind) => ({ name, kind, text: readFileSync(join(root, name), 'utf8') });
const workflows = readdirSync(join(root, '.github', 'workflows'))
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => read(join('.github', 'workflows', file), 'workflow'));
const scripts = ['infrastructure', 'scripts'].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true })
    .filter((file) => file.endsWith('.sh'))
    .map((file) => read(join(dir, file), 'shell')),
);
if (workflows.length === 0) {
  console.error('infra image pins: found no workflows — refusing to pass an empty check');
  process.exit(1);
}
const infraFiles = [read('docker-compose.yml', 'compose'), ...workflows, ...scripts];

const { errors, digests } = validateDockerfilePins(dockerfiles);
const infra = validateInfraImagePins(infraFiles);
if (errors.length > 0 || infra.errors.length > 0) {
  if (errors.length > 0) {
    console.error(`dockerfile pins: ${errors.length} problem(s)`);
    for (const error of errors) console.error(`  ${error}`);
    console.error('See docs/runbooks/base-image-update.md.');
  }
  if (infra.errors.length > 0) {
    console.error(`infra image pins: ${infra.errors.length} problem(s)`);
    for (const error of infra.errors) console.error(`  ${error}`);
    console.error('See docs/runbooks/infrastructure-image-update.md.');
  }
  process.exit(1);
}
console.log(`dockerfile pins: ${dockerfiles.length} Dockerfiles on one base, ${digests[0]}`);
console.log(
  `infra image pins: ${infra.images.length} image references in ${infraFiles.length} files, all pinned by digest`,
);

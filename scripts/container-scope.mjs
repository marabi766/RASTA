#!/usr/bin/env node
/**
 * Prints, as a JSON array, the service images to build and scan.
 *
 *   node scripts/container-scope.mjs --all              # a push to main
 *   git diff --name-only BASE...HEAD | node scripts/container-scope.mjs
 *
 * The reasoning is in `container-scope-lib.mjs`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servicesToBuild } from './container-scope-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const services = readdirSync(join(root, 'services'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(root, 'services', name, 'Dockerfile')))
  .sort();

const changed = process.argv.includes('--all') ? 'all' : readFileSync(0, 'utf8').split('\n');
process.stdout.write(`${JSON.stringify(servicesToBuild(services, changed))}\n`);

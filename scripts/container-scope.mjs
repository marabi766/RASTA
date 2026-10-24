#!/usr/bin/env node
/**
 * Prints, as a JSON array, the service images to build and scan.
 *
 *   node scripts/container-scope.mjs --all              # a push to main
 *   git diff --name-only BASE...HEAD | node scripts/container-scope.mjs --base BASE
 *
 * The reasoning is in `container-scope-lib.mjs`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { imageWorkflowUnchanged, servicesToBuild } from './container-scope-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const services = readdirSync(join(root, 'services'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(root, 'services', name, 'Dockerfile')))
  .sort();

let selected = [...services];
try {
  if (process.argv.includes('--all')) {
    selected = servicesToBuild(services, 'all');
  } else {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--base' || !/^[a-f0-9]{40}$/i.test(args[1])) {
      throw new Error('PR analysis requires --base with a commit SHA');
    }
    const git = (...args) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    // A missing/unreadable base must never turn a PR into an empty matrix.
    git('cat-file', '-e', `${args[1]}^{commit}`);
    const changed = readFileSync(0, 'utf8').split('\n');
    let workflowUnchanged = false;
    if (changed.some((path) => path.trim() === '.github/workflows/ci.yml')) {
      workflowUnchanged = await imageWorkflowUnchanged(
        git('show', `${args[1]}:.github/workflows/ci.yml`),
        git('show', 'HEAD:.github/workflows/ci.yml'),
      );
    }
    selected = servicesToBuild(services, changed, workflowUnchanged);
  }
} catch {
  process.stderr.write('Container scope analysis failed; building and scanning every image.\n');
}
process.stdout.write(`${JSON.stringify(selected)}\n`);

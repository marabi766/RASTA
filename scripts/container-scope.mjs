#!/usr/bin/env node
/**
 * Prints, as a JSON array, the service images to build and scan.
 *
 *   node scripts/container-scope.mjs --all              # a push to main
 *   node scripts/container-scope.mjs --base BASE        # a pull request
 *
 * The reasoning is in `container-scope-lib.mjs`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  imageWorkflowUnchanged,
  servicesToBuild,
  warnScopeFallback,
} from './container-scope-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const services = readdirSync(join(root, 'services'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(root, 'services', name, 'Dockerfile')))
  .sort();

let selected = [...services];
let failureReason = 'missing or malformed base SHA';
try {
  if (process.argv.includes('--all')) {
    failureReason = 'service selection failed';
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
    // Errors and oversized/truncated output retain ALL. Never use stderr's
    // contents as an annotation: Git errors can contain paths or source text.
    failureReason = 'base commit unavailable';
    git('cat-file', '-e', `${args[1]}^{commit}`);
    failureReason = 'Git merge base unavailable';
    const mergeBase = git('merge-base', args[1], 'HEAD').trim();
    if (!/^[a-f0-9]{40}$/i.test(mergeBase)) throw new Error('Invalid merge base');
    failureReason = 'Git diff failed or returned truncated output';
    const output = git('diff', '--no-renames', '-z', '--name-only', `${args[1]}...HEAD`);
    if (output && !output.endsWith('\0')) throw new Error('Truncated diff');
    // NUL alone separates filenames: spaces, newlines and Unicode are literal.
    // --no-renames retains both sides of moves, even into an exempt directory.
    const changed = output ? output.slice(0, -1).split('\0') : [];
    if (changed.some((path) => !path)) throw new Error('Empty diff path');
    let workflowUnchanged = false;
    if (changed.includes('.github/workflows/ci.yml')) {
      failureReason = 'committed workflow unavailable';
      const baseWorkflow = git('show', `${mergeBase}:.github/workflows/ci.yml`);
      const headWorkflow = git('show', 'HEAD:.github/workflows/ci.yml');
      failureReason = 'workflow comparison failed';
      workflowUnchanged = await imageWorkflowUnchanged(baseWorkflow, headWorkflow);
    }
    failureReason = 'service selection failed';
    selected = servicesToBuild(services, changed, workflowUnchanged);
  }
} catch {
  warnScopeFallback(failureReason);
}
process.stdout.write(`${JSON.stringify(selected)}\n`);

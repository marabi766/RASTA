#!/usr/bin/env node
/**
 * Prints, as a JSON array, the service images to build and scan.
 *
 *   node scripts/container-scope.mjs --all              # every image
 *   node scripts/container-scope.mjs --base BASE        # the affected images
 *   node scripts/container-scope.mjs --run              # CI: decide from the event
 *
 * `--run` reads EVENT_NAME, REF, HEAD_REF, HEAD_REPO, REPOSITORY and BASE_SHA
 * from the environment, prints one JSON line {"mode","services"} and, when
 * GITHUB_OUTPUT is set, appends `mode=` and `services=` to it. A push to main
 * builds all, a merge-train run the affected, an ordinary pull request none,
 * anything unrecognised all. The reasoning is in `container-scope-lib.mjs`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  classifyRun,
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

async function select(argv) {
  let selected = [...services];
  let failureReason = 'missing or malformed base SHA';
  try {
    if (argv.includes('--all')) {
      failureReason = 'service selection failed';
      selected = servicesToBuild(services, 'all');
    } else {
      const args = argv;
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
  return selected;
}

if (process.argv[2] === '--run') {
  if (process.argv.length !== 3) {
    process.stderr.write('--run takes no other argument\n');
    process.exit(2);
  }
  const { mode, reason } = classifyRun(process.env);
  if (mode === 'unknown') warnScopeFallback(reason);
  const selected =
    mode === 'pr'
      ? []
      : await select(mode === 'train' ? ['--base', process.env.BASE_SHA ?? ''] : ['--all']);
  const line = JSON.stringify({ mode, services: selected });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `mode=${mode}\nservices=${JSON.stringify(selected)}\n`,
    );
  }
  process.stdout.write(`${line}\n`);
} else {
  process.stdout.write(`${JSON.stringify(await select(process.argv.slice(2)))}\n`);
}

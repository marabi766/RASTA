#!/usr/bin/env node
/**
 * Fails unless every CI invocation of the workspace's unit suites is bounded
 * (or a named exception) and runs with its failure propagated. The reasoning
 * and the rules are in `check-unit-step-concurrency-lib.mjs`.
 *
 *   node scripts/check-unit-step-concurrency.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unitStepProblems } from './check-unit-step-concurrency-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isYaml = (name) => /\.ya?ml$/.test(name);
const files = {};
const workflows = join(root, '.github', 'workflows');
for (const name of readdirSync(workflows).filter(isYaml).sort()) {
  files[name] = readFileSync(join(workflows, name), 'utf8');
}
// Local composite actions: a unit invocation there is refused (lib).
const actions = join(root, '.github', 'actions');
if (existsSync(actions)) {
  for (const entry of readdirSync(actions, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /^action\.ya?ml$/.test(entry.name)) {
      const path = join(entry.parentPath, entry.name);
      files[`actions/${relative(actions, path)}`] = readFileSync(path, 'utf8');
    }
  }
}
const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = unitStepProblems(files, scripts);
for (const problem of problems) console.error(problem);
process.exit(problems.length === 0 ? 0 : 1);

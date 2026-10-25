#!/usr/bin/env node
/**
 * Fails if the CI "Unit tests" step does not bound turbo's package concurrency.
 * The reasoning and the rules are in `check-unit-step-concurrency-lib.mjs`.
 *
 *   node scripts/check-unit-step-concurrency.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unitStepProblems } from './check-unit-step-concurrency-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = unitStepProblems(
  readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
);
for (const problem of problems) console.error(problem);
process.exit(problems.length === 0 ? 0 : 1);

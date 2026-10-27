#!/usr/bin/env node
/** Static accidental-regression tripwire; see the library header for its limits. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { stepsOf, unitStepProblems } from './check-unit-step-concurrency-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = {};
const pending = readdirSync(join(root, '.github/workflows'))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => ({ path: join(root, '.github/workflows', name), key: name }));
// Also inspect conventional action metadata before it is referenced by a workflow.
const actions = join(root, '.github/actions');
if (existsSync(actions)) {
  for (const entry of readdirSync(actions, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/^action\.ya?ml$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    pending.push({ path, key: `local/${relative(root, path)}` });
  }
}
const seen = new Set();
while (pending.length) {
  const { path, key } = pending.pop();
  if (seen.has(path)) continue; // Recursive composite-action cycles terminate.
  seen.add(path);
  try {
    files[key] = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
    const doc = parse(files[key], { merge: true });
    for (const { step } of stepsOf(doc)) {
      if (typeof step.uses !== 'string' || !step.uses.startsWith('./')) continue;
      const directory = resolve(root, step.uses);
      const metadata = ['action.yml', 'action.yaml'].map((name) => join(directory, name));
      // A missing or unreadable referenced action becomes a refused input.
      const target = metadata.find(existsSync) ?? metadata[0];
      pending.push({ path: target, key: `local/${relative(root, target)}` });
    }
  } catch (error) {
    files[key] = error;
  }
}
const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = unitStepProblems(files, scripts);
for (const problem of problems) console.error(problem);
process.exit(problems.length === 0 ? 0 : 1);

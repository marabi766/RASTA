// What turbo hands a task, read from turbo.json the way turbo reads it.
//
// Turbo 2 runs a task in a strict environment: a variable the task does not
// declare is withheld from the child, silently (D-005). The tests that hold a
// task to the variables its command reads share this reading of the file:
// scripts/prisma-turbo-env.test.mjs (#242) and
// scripts/outbox-purge-turbo-env.test.mjs (D-052).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonComments } from './test-phases-lib.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const readJson = (file) => JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));

export const turbo = readJson(join(ROOT, 'turbo.json'));

/** Every workspace package (pnpm-workspace.yaml: apps, services, packages, tests). */
export function workspacePackages() {
  const found = [];
  for (const group of ['apps', 'services', 'packages', 'tests']) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const dir = join(groupDir, entry.name);
      if (entry.isDirectory() && existsSync(join(dir, 'package.json'))) {
        found.push({ dir, manifest: readJson(join(dir, 'package.json')) });
      }
    }
  }
  return found;
}

/** Turbo's env patterns: `*` matches any run of characters, a `!` entry excludes. */
export function allows(patterns, name) {
  const matches = (pattern) =>
    new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(name);
  return (
    patterns.some((p) => !p.startsWith('!') && matches(p)) &&
    !patterns.some((p) => p.startsWith('!') && matches(p.slice(1)))
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Everything turbo passes a task in strict mode, by declaration. */
export function taskPatterns(task) {
  const config = turbo.tasks[task];
  return [
    ...(turbo.globalEnv ?? []),
    ...(turbo.globalPassThroughEnv ?? []),
    ...(config.env ?? []),
    ...(config.passThroughEnv ?? []),
  ];
}

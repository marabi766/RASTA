// The disclosure guard (#452) reaches every test runner in the repository: each
// Jest configuration, and each of its projects, loads jest.disclosure-guard.cjs;
// each Playwright harness takes `expect` only from its guarded module. A new
// configuration, project or spec that skips it fails here, not in a flaky run.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const GUARD = require.resolve(join(root, 'packages/testing/src/disclosure-guard.ts'));

const SKIPPED = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
]);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const everyFile = files(root).map((path) => relative(root, path));

/** Problems with one loaded Jest configuration: each project must set the guard up. */
export function jestWiringProblems(config, name) {
  const projects = Array.isArray(config.projects) ? config.projects : [config];
  return projects.flatMap((project, index) => {
    const label = Array.isArray(config.projects)
      ? `${name} project ${project.displayName ?? index}`
      : name;
    if (typeof project === 'string') return [`${label}: a project by path is not checked here`];
    return (project.setupFilesAfterEnv ?? []).includes(GUARD)
      ? []
      : [`${label}: setupFilesAfterEnv lacks jest.disclosure-guard.cjs`];
  });
}

/** The Playwright harnesses and the one module of each that may import Playwright's `expect`. */
const HARNESSES = [
  { dir: 'tests/e2e', guarded: 'tests/e2e/src/expect.ts' },
  { dir: 'apps/web', guarded: 'apps/web/e2e/expect.ts' },
];

/** Problems with one Playwright-side file: `expect` straight from `@playwright/test`. */
export function playwrightImportProblems(source, file) {
  const problems = [];
  for (const match of source.matchAll(
    /(?:import|export)\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]@playwright\/test['"]/g,
  )) {
    if (match[1]) continue;
    const names = match[2].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]);
    if (names.includes('expect')) problems.push(`${file}: takes expect from @playwright/test`);
  }
  if (/import\s+\*\s+as\s+\w+\s+from\s+['"]@playwright\/test['"]/.test(source)) {
    problems.push(`${file}: imports @playwright/test whole`);
  }
  return problems;
}

test('every Jest configuration, and each of its projects, loads the disclosure guard', () => {
  const configs = everyFile.filter((path) => /(^|\/)jest\.config\.(c?js|mjs|ts)$/.test(path));
  assert.ok(configs.length >= 25, `found only ${configs.length} Jest configurations`);
  const problems = configs.flatMap((path) => {
    if (!/\.c?js$/.test(path)) return [`${path}: not a CommonJS configuration this test can load`];
    return jestWiringProblems(require(join(root, path)), path);
  });
  assert.deepEqual(problems, []);
});

test('the setup file is the guard, and the guard overrides both matchers', () => {
  assert.equal(require(join(root, 'jest.disclosure-guard.cjs')), GUARD);
  assert.match(
    readFileSync(GUARD, 'utf8'),
    /expect\.extend\(\{ toContain: guarded\('toContain'\), toMatch: guarded\('toMatch'\) \}\)/,
  );
});

test('every Playwright configuration belongs to a guarded harness', () => {
  const configs = everyFile.filter((path) => /(^|\/)playwright\.config\.[cm]?[jt]s$/.test(path));
  assert.deepEqual(
    configs.map((path) => path.replace(/\/playwright\.config\.[cm]?[jt]s$/, '')).sort(),
    HARNESSES.map((harness) => harness.dir).sort(),
  );
});

test('every Playwright spec and helper takes expect from its guarded module', () => {
  const problems = HARNESSES.flatMap(({ dir, guarded }) =>
    everyFile
      .filter((path) => path.startsWith(`${dir}/`) && /\.[cm]?[jt]sx?$/.test(path))
      .filter((path) => path !== guarded && !/(^|\/)playwright\.config\./.test(path))
      .filter((path) => !path.startsWith('apps/web/src/'))
      .flatMap((path) => playwrightImportProblems(readFileSync(join(root, path), 'utf8'), path)),
  );
  assert.deepEqual(problems, []);
  for (const { guarded } of HARNESSES) {
    assert.match(
      readFileSync(join(root, guarded), 'utf8'),
      /export const expect = playwrightExpect\.extend\(guardedAbsenceMatchers\(playwrightExpect\)\);/,
      guarded,
    );
  }
  assert.match(
    readFileSync(join(root, 'tests/e2e/src/api.ts'), 'utf8'),
    /^export \{ expect \} from '\.\/expect';$/m,
  );
});

test('the checks refuse what they exist to refuse', () => {
  assert.deepEqual(
    jestWiringProblems(
      { projects: [{ displayName: 'unit', setupFilesAfterEnv: [GUARD] }, { displayName: 'int' }] },
      'x/jest.config.js',
    ),
    ['x/jest.config.js project int: setupFilesAfterEnv lacks jest.disclosure-guard.cjs'],
  );
  assert.equal(jestWiringProblems({ setupFilesAfterEnv: ['./other.ts'] }, 'y').length, 1);
  assert.deepEqual(jestWiringProblems({ setupFilesAfterEnv: [GUARD] }, 'z'), []);

  for (const source of [
    "import { expect, test } from '@playwright/test';",
    "import { test, expect as e } from '@playwright/test';",
    'import {\n  expect,\n  type Page,\n} from "@playwright/test";',
    "export { expect } from '@playwright/test';",
    "import * as pw from '@playwright/test';",
  ]) {
    assert.equal(playwrightImportProblems(source, 'f.ts').length, 1, source);
  }
  for (const source of [
    "import { test, type Page } from '@playwright/test';\nimport { expect } from './expect';",
    "import type { expect } from '@playwright/test';",
  ]) {
    assert.deepEqual(playwrightImportProblems(source, 'f.ts'), [], source);
  }
});

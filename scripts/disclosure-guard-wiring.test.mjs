// Fail closed at every Jest configuration and Playwright assertion entry point (#452).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

export function jestWiringProblems(config, name, directory = root) {
  if (!config || typeof config !== 'object') return [`${name}: unreadable configuration`];
  const base = resolve(directory, config.rootDir ?? '.');
  const projects =
    Array.isArray(config.projects) && config.projects.length > 0 ? config.projects : [config];
  return projects.flatMap((project, index) => {
    const label = Array.isArray(config.projects)
      ? `${name} project ${project?.displayName ?? index}`
      : name;
    if (!project || typeof project !== 'object') return [`${label}: unchecked project by path`];
    const projectRoot = project === config ? base : resolve(base, project.rootDir ?? '.');
    const guarded = (project.setupFilesAfterEnv ?? []).some((entry) => {
      if (typeof entry !== 'string') return false;
      return resolve(projectRoot, entry.replace('<rootDir>', projectRoot)) === GUARD;
    });
    return guarded ? [] : [`${label}: setupFilesAfterEnv lacks jest.disclosure-guard.cjs`];
  });
}

/** Enumerate defaults, embedded package configuration, and EVERY explicit script selection. */
export function jestConfigurations(paths, read) {
  const configs = paths
    .filter((path) => /(^|\/)jest\.config\.(?:js|cjs|mjs|ts|json)$/.test(path))
    .map((path) => ({ name: path, directory: dirname(path), path }));
  for (const path of paths.filter((path) => /(^|\/)package\.json$/.test(path))) {
    const pkg = JSON.parse(read(path));
    const directory = dirname(path);
    if (Object.hasOwn(pkg, 'jest'))
      configs.push({ name: `${path}#jest`, directory, config: pkg.jest });
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      // Inspect every explicit selection, including flags forwarded through script aliases.
      for (const command of script.split(/&&|\|\||[;\n]/)) {
        for (const match of command.matchAll(
          /(?:--config(?:=|\s+)|(?:^|\s)-c\s*=?\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s]+)/g,
        )) {
          const argument = match[1].replace(/^(['"])(.*)\1$/, '$2');
          const label = `${path} script ${name} ${match[0].trim()}`;
          if (argument.startsWith('{')) {
            configs.push({ name: label, directory, config: JSON.parse(argument) });
          } else {
            const selected = argument.startsWith('/') ? argument : join(directory, argument);
            configs.push({ name: label, directory: dirname(selected), path: selected });
          }
        }
        if (/(?:--config|(?:^|\s)-c)\s*$/.test(command))
          configs.push({
            name: `${path} script ${name}: missing --config value`,
            directory,
            config: null,
          });
      }
    }
  }
  return configs;
}

async function loadConfig(entry) {
  if (Object.hasOwn(entry, 'config')) return entry.config;
  const path = resolve(root, entry.path);
  let value = path.endsWith('.json')
    ? JSON.parse(readFileSync(path, 'utf8'))
    : path.endsWith('.mjs')
      ? (await import(pathToFileURL(path).href)).default
      : require(path);
  if (typeof value === 'function') value = value();
  return await value;
}

const HARNESSES = [
  { dir: 'tests/e2e', guarded: 'tests/e2e/src/expect.ts' },
  { dir: 'apps/web', guarded: 'apps/web/e2e/expect.ts' },
];

/** Any reference in a spec is refused, including require/dynamic import/re-export/type forms.
 * Scanning the literal also covers comments between import tokens without parsing loopholes. */
export function playwrightImportProblems(source, file) {
  if (source.includes('@playwright/test'))
    return [`${file}: bypasses the guarded harness with @playwright/test`];
  const guardedModules = ['tests/e2e/src/api', 'tests/e2e/src/expect', 'apps/web/e2e/expect'].map(
    (path) => resolve(root, path),
  );
  const problems = [];
  for (const match of source.matchAll(
    /(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    const names = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/)[0]);
    if (!names.some((name) => name === 'test' || name === 'expect')) continue;
    const target = resolve(root, dirname(file), match[2]).replace(/\.[cm]?[jt]s$/, '');
    if (!guardedModules.includes(target))
      problems.push(`${file}: test/expect must come from a guarded harness`);
  }
  return problems;
}

test('every Jest config form and every project loads the disclosure guard', async () => {
  const configs = jestConfigurations(everyFile, (path) => readFileSync(join(root, path), 'utf8'));
  assert.ok(configs.length >= 25);
  const problems = [];
  for (const entry of configs) {
    try {
      problems.push(
        ...jestWiringProblems(await loadConfig(entry), entry.name, resolve(root, entry.directory)),
      );
    } catch (error) {
      problems.push(`${entry.name}: cannot verify configuration: ${error.message}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the setup file installs both guarded matchers', () => {
  assert.equal(require(join(root, 'jest.disclosure-guard.cjs')), GUARD);
  assert.match(
    readFileSync(GUARD, 'utf8'),
    /expect\.extend\(\{ toContain: guarded\('toContain'\), toMatch: guarded\('toMatch'\) \}\)/,
  );
});

test('every Playwright config belongs to one of the two harnesses', () => {
  const configs = everyFile.filter((path) => /(^|\/)playwright\.config\.[cm]?[jt]s$/.test(path));
  assert.deepEqual(
    configs.map((path) => dirname(path)).sort(),
    HARNESSES.map(({ dir }) => dir).sort(),
  );
});

test('specs take test and expect only from guarded harnesses, including test.expect', () => {
  const problems = HARNESSES.flatMap(({ dir, guarded }) =>
    everyFile
      .filter((path) => path.startsWith(`${dir}/`) && /\.[cm]?[jt]sx?$/.test(path))
      .filter(
        (path) =>
          path !== guarded &&
          !/(^|\/)playwright\.config\./.test(path) &&
          !path.startsWith('apps/web/src/'),
      )
      // Non-spec fixtures may import Playwright types, but may not import assertion origins.
      .flatMap((path) => {
        const source = readFileSync(join(root, path), 'utf8');
        if (/\.(?:e2e-)?spec\.[cm]?[jt]sx?$/.test(path))
          return playwrightImportProblems(source, path);
        const withoutTypes = source.replace(
          /import\s+type\s+\{[^}]*\}\s+from\s+['"]@playwright\/test['"];?/g,
          '',
        );
        return playwrightImportProblems(withoutTypes, path);
      }),
  );
  assert.deepEqual(problems, []);
  for (const { guarded } of HARNESSES) {
    const source = readFileSync(join(root, guarded), 'utf8');
    assert.match(
      source,
      /export const expect = playwrightExpect\.extend\(guardedAbsenceMatchers\(playwrightExpect\)\);/,
    );
    assert.match(
      source,
      /export const test = Object\.assign\(base\.extend\(\{\}\), \{ expect \}\);/,
    );
  }
  const api = readFileSync(join(root, 'tests/e2e/src/api.ts'), 'utf8');
  assert.match(api, /Object\.assign\(test, \{ expect \}\);/);
  assert.match(api, /import \{ test as base, expect, type APIRequestContext \} from '\.\/expect';/);
});

for (const [name, source] of [
  ['test.expect', "import { test } from '@playwright/test'; test.expect(x).not.toContain('12.5');"],
  ['default.expect', "import pw from '@playwright/test'; pw.expect(x).not.toContain('12.5');"],
  ['require', "const { expect } = require('@playwright/test');"],
  ['dynamic import', "const { expect } = await import('@playwright/test');"],
  ['export star', "export * from '@playwright/test';"],
  ['commented import', "import { /* comment */ expect } from '@playwright/test';"],
])
  test(`negative control: rejects ${name}`, () =>
    assert.equal(playwrightImportProblems(source, 'spec.ts').length, 1));

test('guarded harness imports pass; direct type references in specs fail closed too', () => {
  assert.deepEqual(
    playwrightImportProblems(
      "import { test, expect } from '../../src/api';",
      'tests/e2e/specs/construction/control.spec.ts',
    ),
    [],
  );
  assert.equal(
    playwrightImportProblems("import type { Page } from '@playwright/test';", 'spec.ts').length,
    1,
  );
});

for (const form of ['js', 'cjs', 'mjs', 'ts', 'json'])
  test(`discovers jest.config.${form} without a guard`, () => {
    const entries = jestConfigurations([`x/jest.config.${form}`], () => '{}');
    assert.equal(entries.length, 1);
    assert.equal(jestWiringProblems({}, entries[0].name).length, 1);
  });

test('negative control: embedded package.json jest lacks the guard', () => {
  const entries = jestConfigurations(['x/package.json'], () =>
    JSON.stringify({ jest: { projects: [{}, { setupFilesAfterEnv: [GUARD] }] } }),
  );
  assert.equal(entries.length, 1);
  assert.equal(jestWiringProblems(entries[0].config, entries[0].name).length, 1);
});

test('negative control: every alternative --config/-c selection, including inline JSON, is checked', () => {
  const entries = jestConfigurations(['x/package.json'], () =>
    JSON.stringify({
      scripts: {
        test: `jest --config a.json --config=b.cjs -c c.js -c=d.ts -ce.mjs --config '{"projects":[{}]}'`,
      },
    }),
  );
  assert.equal(entries.length, 6);
  assert.deepEqual(
    entries.slice(0, 5).map(({ path }) => path),
    ['x/a.json', 'x/b.cjs', 'x/c.js', 'x/d.ts', 'x/e.mjs'],
  );
  for (const entry of entries)
    assert.equal(jestWiringProblems(entry.config ?? {}, entry.name).length, 1);
});

test('every project is gated; absent or unreadable configuration fails closed', () => {
  assert.equal(
    jestWiringProblems({ projects: [{ setupFilesAfterEnv: [GUARD] }, {}] }, 'x').length,
    1,
  );
  assert.equal(jestWiringProblems({ projects: ['elsewhere'] }, 'x').length, 1);
  assert.equal(jestWiringProblems(null, 'x').length, 1);
  assert.equal(jestWiringProblems({ projects: [] }, 'x').length, 1);
  assert.deepEqual(jestWiringProblems({ setupFilesAfterEnv: [GUARD] }, 'x'), []);
});

test('numeric disclosure sites retain structural substring assertions (no wholeNumber narrowing)', () => {
  const sites = [
    ['tests/e2e/specs/construction/03-tender-lifecycle.e2e-spec.ts', 8],
    ['tests/e2e/specs/contract/01-contract-lifecycle.e2e-spec.ts', 2],
    ['services/construction-service/test/api-award.int-spec.ts', 1],
    ['services/construction-service/test/evaluation.int-spec.ts', 1],
  ];
  for (const [path, count] of sites) {
    const source = readFileSync(join(root, path), 'utf8');
    assert.equal((source.match(/expectNotDisclosed\(/g) ?? []).length, count, path);
    assert.equal(source.includes('wholeNumber'), false, path);
    assert.equal(source.includes('(?<![\\w-])'), false, path);
  }
});

test('named assertion origins outside the two harnesses are refused', () => {
  for (const source of [
    "import { expect } from './other';",
    "export { test as alias } from './other';",
  ]) {
    assert.equal(playwrightImportProblems(source, 'tests/e2e/specs/control.spec.ts').length, 1);
  }
});

test('alternative file configurations use their own directory for rootDir', () => {
  const [entry] = jestConfigurations(['x/package.json'], () =>
    JSON.stringify({ scripts: { test: 'jest --config configs/custom.json' } }),
  );
  assert.equal(entry.path, 'x/configs/custom.json');
  assert.equal(entry.directory, 'x/configs');
});

test('config flags forwarded through a script alias are still checked', () => {
  const entries = jestConfigurations(['x/package.json'], () =>
    JSON.stringify({ scripts: { custom: 'pnpm run test -- --config alternative.json' } }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'x/alternative.json');
  assert.equal(jestWiringProblems({}, entries[0].name).length, 1);
});

/** Include backend/Jest specs too: importing Playwright there must not create a second origin. */
export function playwrightSpecFiles(paths) {
  return paths.filter((path) => /[.-]spec\.[cm]?[jt]sx?$/.test(path));
}

test('no spec anywhere in the repository references the unguarded Playwright package', () => {
  const problems = playwrightSpecFiles(everyFile).flatMap((path) => {
    const source = readFileSync(join(root, path), 'utf8');
    return source.includes('@playwright/test') ? [`${path}: unguarded Playwright reference`] : [];
  });
  assert.deepEqual(problems, []);
});

test('spec discovery includes both harnesses and backend, package and Jest-side siblings', () => {
  const specs = [
    'tests/e2e/specs/control.e2e-spec.ts',
    'apps/web/e2e/control.spec.ts',
    'services/example/test/control.int-spec.ts',
    'packages/example/src/control.spec.ts',
    'apps/web/src/test/control.spec.tsx',
  ];
  assert.deepEqual(
    playwrightSpecFiles([...specs, 'scripts/control.test.mjs', 'apps/web/e2e/expect.ts']),
    specs,
  );
});

test('every runtime guard and harness is a shared Turbo input, including cross-harness controls', () => {
  const ts = require('typescript');
  const parsed = ts.parseConfigFileTextToJson(
    'turbo.json',
    readFileSync(join(root, 'turbo.json'), 'utf8'),
  );
  assert.equal(parsed.error, undefined);
  for (const path of [
    'jest.disclosure-guard.cjs',
    'packages/testing/src/disclosure-guard.ts',
    'packages/testing/src/absence-guard.ts',
    'packages/testing/src/disclosure.ts',
    'tests/e2e/src/expect.ts',
    'tests/e2e/src/api.ts',
    'apps/web/e2e/expect.ts',
  ]) {
    assert.ok(
      parsed.config.globalDependencies.includes(path),
      `${path} must invalidate cached tests`,
    );
  }
});

// Fail closed at every Jest configuration and Playwright assertion entry point (#452).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { jestCommands } from './disclosure-jest-launches.mjs';
export { jestCommands } from './disclosure-jest-launches.mjs';

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

export function jestWiringProblems(config, name, directory = root, args) {
  if (args !== undefined) return effectiveJestProblems(config, name, directory, args);
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

/** Use Jest's own CLI parser and config normalizer; overrides are applied before inspection. */
async function effectiveJestProblems(config, name, directory, args) {
  const previous = process.cwd();
  try {
    const jestRequire = createRequire(
      require.resolve('jest/package.json', { paths: [join(root, 'apps/web')] }),
    );
    const cliRequire = createRequire(jestRequire.resolve('jest-cli'));
    const { buildArgv } = cliRequire('./run.js');
    const { readConfigs } = jestRequire('jest-config');
    process.chdir(directory);
    const argv = await buildArgv(args);
    if (config !== undefined && argv.config === undefined)
      argv.config = JSON.stringify({
        ...config,
        rootDir: resolve(directory, config.rootDir ?? '.'),
      });
    const { configs } = await readConfigs(
      argv,
      argv.projects?.length ? argv.projects : [directory],
    );
    if (!configs.length) return [`${name}: no effective Jest projects`];
    return configs.flatMap((project, index) =>
      jestWiringProblems(project, `${name} effective project ${index}`, directory),
    );
  } catch (error) {
    return [`${name}: cannot verify effective Jest configuration: ${error.message}`];
  } finally {
    process.chdir(previous);
  }
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

const diskRead = (path) => readFileSync(path, 'utf8');
const originAudits = new WeakMap();
const workspaceRoots = new Map(
  everyFile
    .filter((path) => /^(?:packages|tests|apps)\/[^/]+\/package\.json$/.test(path))
    .map((path) => [JSON.parse(readFileSync(join(root, path), 'utf8')).name, dirname(path)]),
);

/** Parse origins, not spellings. Helpers (including src/test) are audited transitively;
 * unused raw exports are refused too. Only the two guarded harnesses end traversal. */
function originAudit(read) {
  const ts = require('typescript');
  const harnesses = new Set(HARNESSES.map(({ guarded }) => resolve(root, guarded)));
  const nodes = new Map();
  const sources = new Map();
  const readModule = (path) => {
    if (!sources.has(path)) sources.set(path, read(path));
    return sources.get(path);
  };
  const compilerOptions = new Map();
  const resolutionHost = {
    ...ts.sys,
    fileExists: (path) => {
      try {
        return typeof readModule(path) === 'string';
      } catch {
        return false;
      }
    },
    readFile: (path) => {
      try {
        return readModule(path);
      } catch {
        return undefined;
      }
    },
    realpath: (path) => path,
  };
  const resolveOrigin = (specifier, from) => {
    const workspace = workspaceRoots.get(specifier);
    if (workspace) return resolveOrigin(`./${workspace}/src/index`, join(root, 'package.json'));
    const configPath = ts.findConfigFile(dirname(from), ts.sys.fileExists);
    if (!compilerOptions.has(configPath)) {
      const config = configPath && ts.readConfigFile(configPath, ts.sys.readFile);
      if (config?.error) throw new Error(`unreadable origin compiler config ${configPath}`);
      compilerOptions.set(
        configPath,
        configPath
          ? ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options
          : { moduleResolution: ts.ModuleResolutionKind.Node10 },
      );
    }
    const resolved = ts.resolveModuleName(
      specifier,
      from,
      compilerOptions.get(configPath),
      resolutionHost,
    ).resolvedModule;
    if (!resolved)
      throw new Error(`unreadable assertion origin ${specifier} in ${relative(root, from)}`);
    // Third-party dependencies are installed artifacts, not local helper barrels.
    // Named assertion imports still require a guarded harness below.
    return resolved.resolvedFileName.includes('/node_modules/') ? null : resolved.resolvedFileName;
  };
  const parse = (source, path) => {
    const result = { edges: [], problems: [], strictProblems: [], guarded: harnesses.has(path) };
    if (result.guarded) return result;
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    result.ast = ast;
    if (ast.parseDiagnostics.length)
      result.strictProblems.push(`malformed assertion origin ${path}`);
    const edge = (literal, typeOnly = false, assertionBindings = []) => {
      const assertionBinding = assertionBindings.length > 0;
      if (!literal || !ts.isStringLiteralLike(literal)) {
        result.strictProblems.push(`nonliteral assertion origin in ${path}`);
        return;
      }
      const name = literal.text;
      if (/\.(?:css|svg|png|jpg|json)$/.test(name)) return;
      if (name === '@playwright/test' || name === 'playwright/test') {
        if (!typeOnly) result.problems.push(`unguarded Playwright origin ${path}`);
      } else if (!typeOnly) {
        try {
          if (name.startsWith('node:')) {
            if (assertionBinding)
              result.problems.push(`test/expect must originate in a guarded harness (${path})`);
            return;
          }
          const target = resolveOrigin(name, path);
          if (target) result.edges.push({ path: target, assertionBindings });
          else if (assertionBinding)
            result.problems.push(`test/expect must originate in a guarded harness (${path})`);
        } catch (error) {
          if (assertionBinding) result.problems.push(error.message);
          else result.strictProblems.push(error.message);
        }
      }
    };
    const walk = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
          const elements = clause?.namedBindings?.elements ?? clause?.elements ?? [];
          const typeOnly =
            node.isTypeOnly ||
            clause?.isTypeOnly ||
            (elements.length > 0 && elements.every((item) => item.isTypeOnly));
          const assertionBindings = elements
            .filter(
              (item) =>
                !item.isTypeOnly &&
                [item.name.text, (item.propertyName ?? item.name).text].some((name) =>
                  ['test', 'expect'].includes(name),
                ),
            )
            .map((item) => (item.propertyName ?? item.name).text);
          if (clause?.name && ['test', 'expect'].includes(clause.name.text))
            assertionBindings.push('default');
          edge(node.moduleSpecifier, typeOnly, assertionBindings);
        }
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        edge(node.moduleReference.expression, node.isTypeOnly);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        edge(node.arguments[0]);
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
    return result;
  };
  const getNode = (path) => {
    if (!nodes.has(path)) nodes.set(path, parse(readModule(path), path));
    return nodes.get(path);
  };
  const guardedExport = (path, exported, seen = new Set()) => {
    const key = `${path}#${exported}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const node = getNode(path);
    if (node.guarded) return exported === 'expect' || exported === 'test';
    const targetExport = (specifier, name) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return false;
      try {
        const target = resolveOrigin(specifier.text, path);
        return target !== null && guardedExport(target, name, new Set(seen));
      } catch {
        return false;
      }
    };
    const local = (name, locals = new Set()) => {
      if (locals.has(name)) return false;
      locals.add(name);
      for (const statement of node.ast.statements) {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.name?.text === name)
            return targetExport(statement.moduleSpecifier, 'default');
          for (const item of clause?.namedBindings?.elements ?? [])
            if (item.name.text === name)
              return targetExport(statement.moduleSpecifier, (item.propertyName ?? item.name).text);
        }
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
              return expression(declaration.initializer, locals);
      }
      return false;
    };
    const expression = (value, locals = new Set()) => {
      if (!value) return false;
      if (ts.isIdentifier(value)) return local(value.text, locals);
      if (
        ts.isAsExpression(value) ||
        ts.isParenthesizedExpression(value) ||
        ts.isSatisfiesExpression(value)
      )
        return expression(value.expression, locals);
      if (
        ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        value.expression.name.text === 'extend'
      )
        return expression(value.expression.expression, locals);
      if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
        for (const statement of node.ast.statements) {
          if (
            ts.isImportDeclaration(statement) &&
            statement.importClause?.namedBindings &&
            ts.isNamespaceImport(statement.importClause.namedBindings) &&
            statement.importClause.namedBindings.name.text === value.expression.text
          )
            return targetExport(statement.moduleSpecifier, value.name.text);
        }
        return value.name.text === 'expect' && expression(value.expression, locals);
      }
      return false;
    };
    for (const statement of node.ast.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        if (!statement.exportClause && targetExport(statement.moduleSpecifier, exported))
          return true;
        for (const item of statement.exportClause?.elements ?? [])
          if (!item.isTypeOnly && item.name.text === exported)
            return statement.moduleSpecifier
              ? targetExport(statement.moduleSpecifier, (item.propertyName ?? item.name).text)
              : local((item.propertyName ?? item.name).text);
      }
      if (ts.isExportAssignment(statement) && exported === 'default')
        return expression(statement.expression);
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text === exported)
            return expression(declaration.initializer);
    }
    return false;
  };
  return (source, file) => {
    // Playwright specs require a completely readable static origin graph. Jest/Node
    // siblings also reject reachable raw Playwright, while allowing their computed
    // product imports (server actions, generated clients) outside that runner graph.
    const strict = /^(?:tests\/e2e|apps\/web\/e2e)\//.test(file) && !file.endsWith('.test.ts');
    const problems = new Set();
    const seen = new Set();
    const visit = (node, path) => {
      if (seen.has(path)) return;
      seen.add(path);
      [...node.problems, ...(strict ? node.strictProblems : [])].forEach((problem) =>
        problems.add(`${file}: ${problem}`),
      );
      for (const edge of node.edges) {
        visit(getNode(edge.path), edge.path);
        if (edge.assertionBindings.some((name) => !guardedExport(edge.path, name)))
          problems.add(`${file}: test/expect must originate in a guarded harness (${path})`);
      }
    };
    visit(parse(source, resolve(root, file)), resolve(root, file));
    return [...problems];
  };
}

export function playwrightImportProblems(source, file, read = diskRead) {
  // Keep the stricter direct-reference rule for specs, including type references.
  if (source.includes('@playwright/test'))
    return [`${file}: bypasses the guarded harness with @playwright/test`];
  if (!originAudits.has(read)) originAudits.set(read, originAudit(read));
  return originAudits.get(read)(source, file);
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

test('every package/CI Jest command retains the guard after CLI overrides', async () => {
  const commands = jestCommands(everyFile, (path) => readFileSync(join(root, path), 'utf8'));
  assert.ok(commands.length > 50);
  const problems = [];
  for (const command of commands) {
    if (!command.directory || command.opaque)
      problems.push(`${command.name}: unresolved Jest command (${command.reason ?? 'opaque'})`);
    else
      problems.push(
        ...(await jestWiringProblems(undefined, command.name, command.directory, command.args)),
      );
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
    assert.match(source, /export const test = withGuard\(base\.extend\(\{\}\)\);/);
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
    return playwrightImportProblems(source, path);
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

const indirectSpec = 'apps/web/e2e/control.spec.ts';
const rawHelper = 'apps/web/src/test/assertion-helper.ts';
const originModules = new Map([
  [
    rawHelper,
    "export { expect as default, expect as rawExpect, test as rawTest } from '@playwright/test';",
  ],
  ['apps/web/src/test/barrel.ts', "export * from './assertion-helper';"],
]);
const readOriginControl = (path) => {
  const source = originModules.get(relative(root, resolve(root, path)));
  if (source === undefined) throw new Error(`missing control module: ${path}`);
  return source;
};
for (const [form, source] of [
  ['aliased binding', "import { rawExpect as expect } from '../src/test/assertion-helper';"],
  ['aliased test', "import { rawTest as fixture } from '../src/test/assertion-helper';"],
  ['namespace import', "import * as assertions from '../src/test/assertion-helper';"],
  ['default import', "import assertions from '../src/test/assertion-helper';"],
  ['require', "const { rawExpect: expect } = require('../src/test/assertion-helper');"],
  ['dynamic import', "const assertions = await import('../src/test/assertion-helper');"],
  ['export star', "export * from '../src/test/barrel';"],
  [
    'commented import',
    "import /* first */ { rawExpect as expect } /* next */ from /* last */ '../src/test/assertion-helper';",
  ],
]) {
  test(`origin control rejects indirect ${form} through src/test`, () => {
    assert.ok(playwrightImportProblems(source, indirectSpec, readOriginControl).length > 0);
  });
}

test('effective Jest override control: replacing setupFilesAfterEnv drops the guard', async () => {
  const directory = join(root, 'apps/web');
  const config = { rootDir: directory, setupFilesAfterEnv: [GUARD] };
  const argv = ['--setupFilesAfterEnv', join(root, 'jest.swc.cjs')];
  const jestRequire = createRequire(require.resolve('jest/package.json', { paths: [directory] }));
  const { readConfigs } = jestRequire('jest-config');
  const { configs } = await readConfigs(
    {
      _: [],
      $0: 'jest',
      config: JSON.stringify(config),
      setupFilesAfterEnv: [join(root, 'jest.swc.cjs')],
    },
    [directory],
  );
  assert.deepEqual(configs[0].setupFilesAfterEnv, [join(root, 'jest.swc.cjs')]);
  assert.ok((await jestWiringProblems(config, 'override control', directory, argv)).length > 0);
});

for (const form of [
  "export { expect as rawExpect } from '@playwright/test';",
  "import /* a */ { expect as rawExpect } /* b */ from '@playwright/test'; export { rawExpect };",
  "import * as assertions from '@playwright/test'; export default assertions;",
  "import assertions from '@playwright/test'; export default assertions;",
  "const { expect: rawExpect } = require('@playwright/test'); export { rawExpect };",
  "const assertions = await import('@playwright/test'); export default assertions;",
  "export * from '@playwright/test';",
]) {
  test(`helper origin control: ${form}`, () => {
    const read = (path) => {
      assert.equal(path, resolve(root, rawHelper));
      return form;
    };
    assert.ok(
      playwrightImportProblems(
        "import * as helper from '../src/test/assertion-helper';",
        indirectSpec,
        read,
      ).some((problem) => problem.includes('unguarded Playwright origin')),
    );
  });
}

test('guarded aliases, namespace/default imports, requires, dynamic imports and barrels pass', () => {
  const helpers = new Map([
    [
      rawHelper,
      "export { expect as default, expect as rawExpect, test as rawTest } from '../../e2e/expect';",
    ],
    ['apps/web/src/test/barrel.ts', "export * from './assertion-helper';"],
  ]);
  const read = (path) => {
    if (path === resolve(root, 'apps/web/e2e/expect.ts')) return '';
    const source = helpers.get(relative(root, path));
    if (source === undefined) throw new Error('unreadable control');
    return source;
  };
  for (const source of [
    "import { rawExpect as expect, rawTest as test } from '../src/test/assertion-helper';",
    "import * as assertions from '../src/test/assertion-helper';",
    "import assertions from '../src/test/assertion-helper';",
    "const assertions = require('../src/test/assertion-helper');",
    "const assertions = await import('../src/test/assertion-helper');",
    "export * from '../src/test/barrel';",
    "import { rawExpect as expect } from '@/test/assertion-helper';",
  ])
    assert.deepEqual(playwrightImportProblems(source, indirectSpec, read), []);
});

test('unreadable, malformed and computed Playwright assertion origins fail closed', () => {
  for (const source of [
    "import { rawExpect } from './missing';",
    'const assertions = await import(moduleName);',
    'const assertions = require(moduleName);',
    "import { expect from './missing';",
  ])
    assert.ok(playwrightImportProblems(source, indirectSpec).length > 0);
});

test('origin cycles do not hide a raw re-export', () => {
  const modules = new Map([
    [rawHelper, "export * from './barrel'; export * from '@playwright/test';"],
    ['apps/web/src/test/barrel.ts', "export * from './assertion-helper';"],
  ]);
  assert.ok(
    playwrightImportProblems("export * from '../src/test/barrel';", indirectSpec, (path) => {
      const source = modules.get(relative(root, path));
      if (source === undefined) throw new Error('missing origin control');
      return source;
    }).length > 0,
  );
});

for (const flag of ['--setupFilesAfterEnv', '--setup-files-after-env']) {
  test(`effective Jest ${flag}: guarded override passes; unguarded override refuses`, async () => {
    const directory = join(root, 'apps/web');
    const config = { rootDir: directory, setupFilesAfterEnv: [GUARD] };
    const unguarded = await jestWiringProblems(config, flag, directory, [
      flag,
      join(root, 'jest.swc.cjs'),
    ]);
    assert.equal(unguarded.length, 1);
    assert.match(unguarded[0], /setupFilesAfterEnv lacks/);
    assert.deepEqual(
      await jestWiringProblems(config, flag, directory, [flag, GUARD, join(root, 'jest.swc.cjs')]),
      [],
    );
  });
}

test('package, forwarded alias, shell wrapper and CI overrides reach effective Jest inspection', async () => {
  const setup = join(root, 'jest.swc.cjs');
  const paths = ['apps/web/package.json', '.github/workflows/control.yml'];
  const sources = {
    [paths[0]]: JSON.stringify({
      name: '@rasta/web',
      scripts: {
        test: 'jest',
        direct: `jest --setupFilesAfterEnv ${setup}`,
        forwarded: `pnpm run test -- --setupFilesAfterEnv ${setup}`,
        wrapped: `bash -c 'jest --setupFilesAfterEnv ${setup}'`,
        config: `jest --config '${JSON.stringify({ rootDir: join(root, 'apps/web'), setupFilesAfterEnv: [setup] })}'`,
      },
    }),
    [paths[1]]: `jobs:\n  control:\n    steps:\n      - run: pnpm --filter @rasta/web exec jest --setup-files-after-env=${setup}\n`,
  };
  const commands = jestCommands(paths, (path) => sources[path]);
  assert.equal(commands.length, 6);
  for (const command of commands.filter((command) => !command.name.endsWith('script test'))) {
    assert.equal(command.directory, join(root, 'apps/web'));
    assert.equal(command.opaque, false);
    const problems = await jestWiringProblems(
      undefined,
      command.name,
      command.directory,
      command.args,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /setupFilesAfterEnv lacks/);
  }
});

test('opaque CLI setup values are discovered and refused, never silently skipped', () => {
  const commands = jestCommands(['apps/web/package.json'], () =>
    JSON.stringify({
      scripts: { test: 'jest --setupFilesAfterEnv "$SETUP"' },
    }),
  );
  assert.equal(commands.length, 1);
  assert.equal(commands[0].opaque, true);
});

test('unresolved imports in src/test helpers retain the spec fail-closed policy', () => {
  for (const helper of [
    'export const assertions = await import(moduleName);',
    'export const assertions = require(moduleName);',
    "export * from './missing-origin';",
    "export { expect from './broken';",
  ]) {
    const read = (path) => {
      if (path !== resolve(root, rawHelper)) throw new Error('missing origin control');
      return helper;
    };
    assert.ok(
      playwrightImportProblems(
        "import * as assertions from '../src/test/assertion-helper';",
        indirectSpec,
        read,
      ).length > 0,
    );
  }
});

test('workspace re-exports also resolve to the raw assertion origin', () => {
  const read = (path) => {
    if (path !== join(root, 'packages/testing/src/index.ts'))
      throw new Error('missing origin control');
    return "export { expect as hiddenExpect } from '@playwright/test';";
  };
  assert.ok(
    playwrightImportProblems(
      "import { hiddenExpect as expect } from '@rasta/testing';",
      indirectSpec,
      read,
    ).some((problem) => problem.includes('unguarded Playwright origin')),
  );
});

test('readable arbitrary test/expect exports are not approved assertion origins', () => {
  const read = (path) => {
    if (path !== resolve(root, rawHelper)) throw new Error('missing origin control');
    return 'export const expect = () => ({}); export const test = () => {};';
  };
  assert.ok(
    playwrightImportProblems(
      "import { expect, test } from '../src/test/assertion-helper';",
      indirectSpec,
      read,
    ).length > 0,
  );
});

test('compiler path aliases resolve assertion origins instead of relying on import names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rasta-disclosure-origin-'));
  try {
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          moduleResolution: 'node',
          baseUrl: '.',
          paths: { '#assertions': ['./helper.ts'] },
        },
      }),
    );
    writeFileSync(
      join(directory, 'helper.ts'),
      "export { expect as hiddenExpect } from '@playwright/test';",
    );
    assert.ok(
      playwrightImportProblems(
        "import { hiddenExpect as expect } from '#assertions';",
        join(directory, 'control.spec.ts'),
      ).some((problem) => problem.includes('unguarded Playwright origin')),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a guarded side import does not approve a different exported assertion binding', () => {
  const read = (path) => {
    if (path === resolve(root, 'apps/web/e2e/expect.ts')) return '';
    if (path !== resolve(root, rawHelper)) throw new Error('missing origin control');
    return "import { expect as safeExpect } from '../../e2e/expect'; export const rawExpect = () => ({});";
  };
  assert.ok(
    playwrightImportProblems(
      "import { rawExpect as expect } from '../src/test/assertion-helper';",
      indirectSpec,
      read,
    ).length > 0,
  );
});

// R1: ordinary launch paths must reach readConfigs, or explicitly refuse.
function launchControl(run, place = 'workflow', extra = {}) {
  const path =
    place === 'package'
      ? 'apps/web/package.json'
      : place === 'composite'
        ? '.github/actions/control/action.yml'
        : '.github/workflows/control.yml';
  const sources = {
    'apps/web/package.json': JSON.stringify({ name: '@rasta/web', scripts: { test: 'jest' } }),
    ...extra,
  };
  sources[path] =
    place === 'package'
      ? JSON.stringify({ name: '@rasta/web', scripts: { test: 'jest', control: run } })
      : place === 'composite'
        ? require('yaml').stringify({
            runs: { using: 'composite', steps: [{ run, shell: 'bash' }] },
          })
        : require('yaml').stringify({ jobs: { control: { steps: [{ run }] } } });
  return jestCommands(Object.keys(sources), (path) => {
    if (!Object.hasOwn(sources, path)) throw new Error('missing control source');
    return sources[path];
  }).filter(({ name }) =>
    place === 'package' ? name.endsWith('script control') : name.startsWith(path),
  );
}

const selectionFlags = [
  '--config',
  '--config=',
  '-c',
  '--projects',
  '--preset',
  '--rootDir',
  '--root-dir',
];
for (const flag of selectionFlags) {
  for (const place of ['workflow', 'composite', 'package']) {
    for (const wrapped of [false, true]) {
      test(`R1 ${place} ${wrapped ? 'shell' : 'forwarded'} ${flag} reaches effective configuration`, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'rasta-jest-selection-'));
        try {
          const config = join(
            directory,
            flag === '--preset' ? 'jest-preset.json' : 'alternative.json',
          );
          writeFileSync(config, JSON.stringify(flag === '--preset' ? {} : { rootDir: directory }));
          const value = flag === '--preset' ? directory : config;
          const argument = flag === '--config=' ? `${flag}${value}` : `${flag} ${value}`;
          let run =
            place === 'package'
              ? `pnpm test -- ${argument}`
              : `pnpm --filter @rasta/web test -- ${argument}`;
          if (wrapped) run = `bash -lc '${run}'`;
          const commands = launchControl(run, place);
          assert.equal(commands.length, 1);
          assert.equal(commands[0].opaque, false);
          assert.equal(commands[0].directory, join(root, 'apps/web'));
          const args = flag === '--config=' ? [`${flag}${value}`] : [flag, value];
          assert.deepEqual(commands[0].args, args);
          const problems = await jestWiringProblems(
            undefined,
            'R1',
            commands[0].directory,
            commands[0].args,
          );
          // Presets merge with the guarded default; root/config/projects either resolve or refuse.
          if (['--config', '--config=', '-c', '--projects'].includes(flag)) {
            assert.equal(problems.length, 1);
            assert.match(problems[0], /setupFilesAfterEnv lacks/);
          } else if (flag === '--preset') assert.deepEqual(problems, []);
          else assert.ok(problems.length > 0);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
  test(`R1 opaque ${flag} refuses in all three sources and shell wrappers`, () => {
    for (const place of ['workflow', 'composite', 'package']) {
      const prefix = place === 'package' ? 'pnpm test' : 'pnpm --filter @rasta/web test';
      const argument = flag.endsWith('=') ? `${flag}"$ALT"` : `${flag} "$ALT"`;
      for (const run of [`${prefix} -- ${argument}`, `bash -c '${prefix} -- ${argument}'`]) {
        const commands = launchControl(run, place);
        assert.equal(commands.length, 1);
        assert.equal(commands[0].opaque, true);
      }
    }
  });
}

for (const place of ['workflow', 'composite', 'package']) {
  for (const extension of ['sh', 'bash', 'mjs', 'cjs', 'js', 'ts']) {
    for (const launch of ['jest', 'pnpm test']) {
      test(`R1 ${place} unregistered .${extension} spawning ${launch} refuses`, () => {
        const file = `${place === 'package' ? 'apps/web/' : ''}control.${extension}`;
        const body = /^(?:sh|bash)$/.test(extension)
          ? launch
          : launch === 'jest'
            ? "require('node:child_process').spawnSync('jest', []);"
            : "import { spawn as launch } from 'node:child_process'; launch('pnpm', ['test']);";
        const commands = launchControl(
          `${/^(?:sh|bash)$/.test(extension) ? 'bash' : 'node'} control.${extension}`,
          place,
          { [file]: body },
        );
        assert.equal(commands.length, 1);
        assert.equal(commands[0].opaque, true);
        assert.match(commands[0].reason, /unregistered Jest launcher/);
      });
    }
  }
}

test('R1 guarded alternative configuration is accepted through npm, pnpm and shell forwarding', async () => {
  const config = JSON.stringify({ rootDir: join(root, 'apps/web'), setupFilesAfterEnv: [GUARD] });
  for (const run of [
    `pnpm --filter=@rasta/web test -- --config '${config}'`,
    `npm --prefix apps/web run test -- -c '${config}'`,
    `bash -c 'pnpm --dir apps/web test -- --config ${JSON.stringify(config)}'`,
  ]) {
    const commands = launchControl(run);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].opaque, false);
    assert.deepEqual(
      await jestWiringProblems(
        undefined,
        'guarded alternative',
        commands[0].directory,
        commands[0].args,
      ),
      [],
    );
  }
});

test('R1 every Node --test operand and pnpm exec file launcher is pre-checked', () => {
  const extra = {
    'safe.mjs': 'export {};',
    'unsafe.mjs': "import { spawn } from 'node:child_process'; spawn('pnpm', ['test']);",
    'wrapped.mjs': "import launch from 'execa'; launch('pnpm', ['test']);",
  };
  for (const run of [
    'node --test safe.mjs unsafe.mjs',
    'pnpm exec node unsafe.mjs',
    'pnpm exec tsx wrapped.mjs',
  ]) {
    const commands = launchControl(run, 'workflow', extra);
    assert.equal(commands.length, 1);
    assert.match(commands[0].reason, /unregistered/);
  }
});

test('R1 registry checks all three real launch paths and refuses executable/helper drift', async () => {
  const { JEST_LAUNCHERS } = await import('./disclosure-jest-launchers.mjs');
  const paths = everyFile.filter((path) => /(^|\/)package\.json$/.test(path));
  const control = '.github/workflows/registry-control.yml';
  paths.push(control);
  for (const [file, args] of [
    ['scripts/verify-test-independence.mjs', 'services/maintenance-service event-flow'],
    ['scripts/aggregation-evidence.mjs', 'report.txt'],
    ['scripts/run-test-phases.mjs', 'test:integration'],
  ]) {
    const read = (path) =>
      path === control
        ? `jobs:\n  control:\n    steps:\n      - run: node ${file} ${args}\n`
        : readFileSync(join(root, path), 'utf8');
    const commands = jestCommands(paths, read).filter(({ name }) => name.startsWith(control));
    assert.ok(commands.length > 0);
    for (const command of commands) {
      assert.equal(command.opaque, false);
      assert.deepEqual(
        await jestWiringProblems(undefined, file, command.directory, command.args),
        [],
      );
    }
    for (const dependency of Object.keys(JEST_LAUNCHERS[file].sha256)) {
      const drifted = jestCommands(
        paths,
        (path) => read(path) + (path === dependency ? '\n// changed' : ''),
      ).filter(({ name }) => name.startsWith(control));
      assert.equal(drifted.length, 1);
      assert.match(drifted[0].reason, /changed\/unreadable/);
    }
  }
});

test('R1 subshell cwd does not leak to sibling launches', () => {
  const commands = launchControl(
    '( cd apps/web && pnpm test -- --config a.json ); pnpm --filter @rasta/web test -- --config b.json',
  );
  assert.equal(commands.length, 2);
  assert.ok(commands.every(({ directory }) => directory === join(root, 'apps/web')));
  assert.deepEqual(
    commands.map(({ args }) => args),
    [
      ['--config', 'a.json'],
      ['--config', 'b.json'],
    ],
  );
});

test('R1 root phase scripts preserve forwarded configuration through Turbo in both phases', async () => {
  const control = '.github/workflows/root-control.yml';
  const args = [
    '--config',
    JSON.stringify({ rootDir: join(root, 'apps/web'), setupFilesAfterEnv: [GUARD] }),
  ];
  const run = `pnpm run test:integration -- --config '${args[1]}'`;
  const commands = jestCommands(
    [...everyFile.filter((path) => /(^|\/)package\.json$/.test(path)), control],
    (path) =>
      path === control
        ? require('yaml').stringify({ jobs: { control: { steps: [{ run }] } } })
        : readFileSync(join(root, path), 'utf8'),
  ).filter(({ name }) => name.startsWith(control));
  assert.equal(commands.length, 18);
  assert.ok(commands.at(-1).args.includes('aggregation-stress'));
  for (const command of commands) {
    assert.equal(command.opaque, false);
    assert.ok(command.args.includes(args[1]));
    assert.deepEqual(
      await jestWiringProblems(undefined, 'root forwarding', command.directory, command.args),
      [],
    );
  }
});

test('R1 env-prefixed shell wrappers and unresolved script aliases fail closed', () => {
  for (const run of [
    'env CI=1 bash -lc \'pnpm --filter @rasta/web test -- --config "$CONFIG"\'',
    'pnpm --filter @rasta/web missing-script -- --config alternative.cjs',
    'pnpm --filter "$PACKAGE" test -- --config alternative.cjs',
  ]) {
    const commands = launchControl(run);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].opaque, true);
  }
});

test('R1 reviewer trigger: forwarded configs/unit.cjs with normal web transform and no setup refuses', async () => {
  const directory = mkdtempSync(join(root, 'apps/web/.disclosure-reviewer-'));
  try {
    mkdirSync(join(directory, 'configs'));
    writeFileSync(
      join(directory, 'configs/unit.cjs'),
      `module.exports = { ...require(${JSON.stringify(join(root, 'apps/web/jest.config.cjs'))}), setupFilesAfterEnv: [] };`,
    );
    const pkg = relative(root, join(directory, 'package.json'));
    const workflow = '.github/workflows/reviewer-control.yml';
    const commands = jestCommands([pkg, workflow], (path) =>
      path === pkg
        ? JSON.stringify({ name: '@rasta/web', scripts: { test: 'jest' } })
        : 'jobs:\n  control:\n    steps:\n      - run: pnpm --filter @rasta/web test -- --config configs/unit.cjs\n',
    ).filter(({ name }) => name.startsWith(workflow));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].opaque, false);
    assert.deepEqual(commands[0].args, ['--config', 'configs/unit.cjs']);
    const problems = await jestWiringProblems(
      undefined,
      'reviewer trigger',
      commands[0].directory,
      commands[0].args,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /setupFilesAfterEnv lacks/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('R1 unsupported shell/inline launchers refuse instead of hiding configuration flags', () => {
  for (const run of [
    'eval "pnpm --filter @rasta/web test -- --config alternative.cjs"',
    'npx -c "jest --config alternative.cjs"',
    'bash -c \'"$RUNNER" --config alternative.cjs\'',
    'fish -c "pnpm --filter @rasta/web test -- --projects alternative.cjs"',
  ]) {
    const commands = launchControl(run);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].opaque, true);
  }
});

test('R1 unsupported cwd selectors and ambiguous Jest script dispatch refuse', () => {
  for (const prefix of [
    'pnpm -Capps/web exec',
    'pnpm -F@rasta/web exec',
    'pnpm -r exec',
    'env --chdir=apps/web pnpm exec',
    'pnpm --filter @rasta/web run',
    'pnpm --filter @rasta/web test --',
  ]) {
    const commands = launchControl(`${prefix} jest --config alternative.cjs`);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].opaque, true);
  }
});

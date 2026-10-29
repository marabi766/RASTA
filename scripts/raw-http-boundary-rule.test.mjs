import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import rawHttp, { AUDITED_TRANSPORTS } from './raw-http-boundary-rule.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const linter = new Linter({ cwd: ROOT });
/** Findings of the boundary alone, for `code` as the file `path` (repository-relative). */
const check = (code, { path = 'apps/web/src/server/fixture.ts', playwright = false } = {}) => {
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.{ts,tsx,mjs,js}'],
        languageOptions: { parser: tseslint.parser, sourceType: 'module' },
        plugins: { internal: { rules: { 'raw-http': rawHttp } } },
        rules: { 'internal/raw-http': ['error', { playwright }] },
      },
    ],
    `${ROOT}${path}`,
  );
  const fatal = messages.filter(({ fatal }) => fatal);
  assert.deepEqual(fatal, [], `fixture must parse: ${code}`);
  return messages.filter(({ ruleId }) => ruleId === 'internal/raw-http');
};

// PR #492 r1 F1: the reviewer's four fixtures, verbatim. Each passed the credential rule.
const REVIEWER_FIXTURES = {
  'destructured fetch': `const { fetch: send } = globalThis;
send(url, { headers: { authorization: token } });`,
  'headers.authorization assignment': `const headers: Record<string, string> = {};
headers.authorization = token;
fetch(url, { headers });`,
  'bound credentialFetch': `const credentialFetch = globalThis.fetch.bind(globalThis);
credentialFetch(url, { headers: { authorization: token } });`,
  'class-field transport': `class Client {
  transport = globalThis.fetch;
  send(url: string, token: string) {
    return this.transport(url, { headers: { authorization: token } });
  }
}`,
};
// …and the variants the PM named: bind, call, Reflect.apply, factory return, dynamic
// import / require alias, computed name. Credential spelling is irrelevant to the boundary.
const VARIANTS = {
  bind: 'const send = fetch.bind(null); send(url, init);',
  call: 'fetch.call(globalThis, url, init);',
  apply: 'fetch.apply(globalThis, [url, init]);',
  'Reflect.apply': 'Reflect.apply(fetch, globalThis, [url, init]);',
  'Reflect.apply on globalThis.fetch': 'Reflect.apply(globalThis.fetch, globalThis, [url, init]);',
  'Reflect.get': "Reflect.get(globalThis, 'fetch')(url, init);",
  'factory return': 'const make = () => fetch; make()(url, init);',
  'factory returning globalThis.fetch': 'function transport() { return globalThis.fetch; }',
  'default parameter': 'export function send(impl = fetch) { return impl(url, init); }',
  'nullish default': 'const impl = options.fetch ?? fetch;',
  'class field': 'class Client { transport = fetch; }',
  'object property': 'export const deps = { fetch };',
  'dynamic import alias':
    "const { request: send } = await import('undici'); await send(url, init);",
  'dynamic import of a variable': "const m = 'undici'; await import(m);",
  'dynamic import of a computed name': "await import(['un', 'dici'].join(''));",
  'require alias': "const m = 'node:https'; require(m).request(url, init);",
  'aliased require': "const load = require; load('node:https').request(url);",
  'createRequire result': "createRequire(import.meta.url)('undici').request(url);",
  'module.require': "module.require('https').get(url);",
  getBuiltinModule: "process.getBuiltinModule('node:http').request(url);",
  'computed name': "const name = 'fe' + 'tch'; globalThis[name](url, init);",
  'computed literal name': "globalThis['fetch'](url, init);",
  'computed template name': 'self[`fetch`](url, init);',
  'computed name through a cast': '(globalThis as any)[name](url, init);',
  'window.fetch': 'window.fetch(url, init);',
  'self.fetch': 'self.fetch(url, init);',
  'global.fetch': 'global.fetch(url, init);',
  'globalThis.globalThis.fetch': 'globalThis.globalThis.fetch(url, init);',
  'optional chain': 'globalThis?.fetch(url, init);',
  'global object alias': 'const g = globalThis; g.fetch(url, init);',
  'global object spread': 'const g = { ...globalThis }; g.fetch(url, init);',
  'global object passed on': 'Object.assign(target, globalThis);',
  'destructured from window': 'const { fetch: f } = window; f(url);',
  XMLHttpRequest: 'const xhr = new XMLHttpRequest();',
  'eval of a name': "eval('fe' + 'tch')(url, init);",
  'Function constructor': "new Function('return fetch')()(url, init);",
  'Function call': "Function('return globalThis')().fetch(url, init);",
  'axios default import': "import axios from 'axios'; axios.get(url);",
  'undici named import': "import { request } from 'undici'; request(url);",
  'undici fetch import': "import { fetch as undiciFetch } from 'undici'; undiciFetch(url);",
  'node:https namespace': "import * as https from 'node:https'; https.request(url);",
  'http default import': "import http from 'http'; http.get(url);",
  'node:https get': "import { get } from 'node:https'; get(url);",
  'http Agent': "import { Agent } from 'node:http'; new Agent();",
  're-export': "export { fetch } from 'undici';",
  'export all': "export * from 'node:http';",
  'import equals': "import https = require('https'); https.get(url);",
  got: "import got from 'got'; got(url);",
  'node-fetch': "import nodeFetch from 'node-fetch'; nodeFetch(url);",
  'playwright-core': "import { request } from 'playwright-core';",
};

for (const [name, code] of Object.entries({ ...REVIEWER_FIXTURES, ...VARIANTS })) {
  test(`refuses a raw HTTP primitive outside an audited transport: ${name}`, () => {
    assert.ok(check(code).length > 0, code);
  });
}

// The E2E trees (option `playwright`): Playwright's own API contexts bypass the guarded fixture.
const PLAYWRIGHT_RAW = {
  'request import': "import { request } from '@playwright/test';",
  'test import (unguarded fixture)': "import { test } from '@playwright/test';",
  'namespace import': "import * as pw from '@playwright/test';",
  'default import': "import pw from '@playwright/test';",
  're-exported request': "export { request } from '@playwright/test';",
  'playwright.request.newContext': 'const api = await playwright.request.newContext();',
  'page.request': 'await page.request.get(url);',
  'context.request': 'await context.request.post(url, { data });',
  'computed request literal': "await page['request'].get(url);",
  'destructured request': 'const { request } = page;',
  'destructured computed': 'const { [name]: api } = page;',
  'raw fetch in a spec': 'await fetch(url, { method: "POST", body });',
};
for (const [name, code] of Object.entries(PLAYWRIGHT_RAW)) {
  test(`E2E: refuses an unguarded API context: ${name}`, () => {
    assert.ok(check(code, { path: 'apps/web/e2e/fixture.spec.ts', playwright: true }).length);
  });
}

const ALLOWED = {
  'typeof fetch in a type': 'const impl: typeof fetch = injected;',
  'fetch parameter type': 'type Input = Parameters<typeof fetch>[0];',
  'globalThis.fetch in a type': 'let impl: typeof globalThis.fetch;',
  'type-only import': "import type { Dispatcher } from 'undici';",
  'type-only specifier': "import { type Agent } from 'node:http';",
  'server half of node:http': "import { createServer, type Server } from 'node:http';",
  'typeof window': "const browser = typeof window !== 'undefined';",
  'feature test': "const has = 'fetch' in globalThis;",
  'safe global member': 'globalThis.crypto.randomUUID(); window.location.assign(url);',
  'symbol-keyed global': "(globalThis as unknown as Record<symbol, unknown>)[Symbol.for('k')];",
  'injected transport through internalFetch': 'internalFetch(url, init, this.fetchImpl);',
  'injected member': 'deps.fetch(url);',
  'redis eval member': 'await redis.eval(script, 1, key);',
  'Function as a type': 'let callback: Function | undefined;',
  'local binding named fetch': 'function send(fetch: Fetch) { return fetch(url); }',
  'workspace build path': "require(join(ROOT, 'packages', 'x', 'dist', 'index.js'));",
  'path through a const': "const generated = join(dir, 'src', 'generated'); require(generated);",
  'file URL import': 'await import(pathToFileURL(dist).href);',
  'protocol check': "url.protocol.startsWith('http');",
  'domain field named request outside E2E': 'const id = outcome.request.id;',
};
for (const [name, code] of Object.entries(ALLOWED)) {
  test(`leaves non-references alone: ${name}`, () => {
    assert.deepEqual(check(code), []);
  });
}
test('E2E: the guarded entry points and route.request() pass', () => {
  for (const code of [
    "import { expect, defineConfig, devices } from '@playwright/test';",
    "import type { APIRequestContext } from '@playwright/test';",
    "import { test, expect } from './expect'; test('x', async ({ request }) => request.get(url));",
    'const method = route.request().method();',
    'const response = await request[method](url, { headers });',
    'await guardedFetch(url, init);',
  ])
    assert.deepEqual(
      check(code, { path: 'apps/web/e2e/fixture.spec.ts', playwright: true }),
      [],
      code,
    );
});

// The allowlist: short, exact files, each with a reason.
test('every audited transport is one existing file with a reason, never a directory', () => {
  for (const [file, reason] of Object.entries(AUDITED_TRANSPORTS)) {
    assert.match(file, /^[\w@.-]+(?:\/[\w@.[\]-]+)+\.(?:ts|tsx|mjs)$/, file);
    assert.doesNotMatch(file, /[*?{}!]|\/$/, file);
    assert.ok(statSync(`${ROOT}${file}`).isFile(), file);
    assert.ok(reason.length >= 30, `${file}: say why it may reach raw HTTP`);
  }
  // A new entry is a reviewed decision, not a drive-by: this list changes with it.
  assert.deepEqual(Object.keys(AUDITED_TRANSPORTS).sort(), [
    'apps/web/e2e/expect.ts',
    'apps/web/src/lib/session-refusal.ts',
    'apps/web/src/server/credential-fetch.ts',
    'apps/web/src/server/signed-url-upload.ts',
    'packages/nest-common/src/http/internal-fetch.ts',
    'packages/testing/src/guarded-http.ts',
    'packages/testing/src/redirect-probe.ts',
    'scripts/credential-fetch.mjs',
    'tests/e2e/src/expect.ts',
    'tests/e2e/src/http.ts',
  ]);
});

test('an audited transport is exempt as that exact file only', () => {
  const raw = 'export const send = (url: string) => fetch(url);';
  assert.deepEqual(check(raw, { path: 'apps/web/src/server/credential-fetch.ts' }), []);
  for (const path of [
    'apps/web/src/server/credential-fetch-copy.ts',
    'apps/web/src/server/gateway.ts',
    'apps/web/src/server/credential-fetch.ts/inner.ts',
    'apps/web/src/server/x/credential-fetch.ts',
    'other/apps/web/src/server/credential-fetch.ts',
    'packages/nest-common/src/http/internal-get.ts',
    'tests/e2e/src/actor.ts',
  ])
    assert.equal(check(raw, { path }).length, 1, path);
});

// ---------------------------------------------------------------------------
// The real configs: every workspace's own flat config, as `pnpm lint` runs it.

/**
 * Lints `sources` as `filePath` with the workspace's real config, in a child process per
 * workspace (typescript-eslint keeps per-process tsconfig-root state). Per source: the
 * boundary's findings, plus any parse failure (which would hide them).
 */
function lintInWorkspace(workspace, filePath, sources) {
  const script = `
    import { createRequire } from 'node:module';
    const { ESLint } = createRequire(process.env.ROOT_PACKAGE)('eslint');
    const eslint = new ESLint({ cwd: process.cwd() });
    const out = [];
    for (const text of JSON.parse(process.env.SOURCES)) {
      const [result] = await eslint.lintText(text, { filePath: process.env.FILE_PATH });
      out.push(result.messages
        .filter(({ ruleId, fatal }) => ruleId === 'internal/raw-http' || fatal)
        .map(({ ruleId, severity, message }) => ({ ruleId, severity, message })));
    }
    process.stdout.write(JSON.stringify(out));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: `${ROOT}${workspace}`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ROOT_PACKAGE: `${ROOT}package.json`,
      SOURCES: JSON.stringify(sources),
      FILE_PATH: filePath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** Plain-JavaScript forms of the fixtures, for the root scripts (no TypeScript syntax). */
const JS_FORMS = {
  'headers.authorization assignment':
    'const headers = {};\nheaders.authorization = token;\nfetch(url, { headers });',
  'class-field transport':
    'class Client {\n  transport = globalThis.fetch;\n  send(url, token) {\n    return this.transport(url, { headers: { authorization: token } });\n  }\n}',
};
const TS_ONLY = new Set(['computed name through a cast', 'import equals']);
const PRELUDE_TS =
  'declare const url: string, token: string, init: RequestInit, options: { fetch?: typeof fetch };\n' +
  'declare const target: object, name: string, module: { require(id: string): any };\n' +
  'declare function require(id: string): any;\ndeclare function createRequire(base: string): (id: string) => any;\n';
const PRELUDE_JS =
  "import { createRequire } from 'node:module';\nlet url, token, init, options, target, name;\n";

const REAL_SITES = [
  ['apps/web', 'src/server/raw-fixture.ts'],
  ['apps/web', 'src/app/raw-fixture/page.tsx'],
  ['apps/web', 'e2e/raw-fixture.ts'],
  ['apps/web', 'e2e/raw-fixture.spec.ts'],
  ['services/api-gateway', 'src/raw-fixture.ts'],
  ['services/api-gateway', 'dev/raw-fixture.ts'],
  ['services/identity-service', 'src/keycloak/raw-fixture.ts'],
  ['services/economic-service', 'prisma/seed.ts'],
  ['packages/nest-common', 'src/http/raw-fixture.ts'],
  ['packages/testing', 'src/raw-fixture.ts'],
  ['tests/e2e', 'src/raw-fixture.ts'],
  ['tests/e2e', 'specs/document/raw-fixture.e2e-spec.ts'],
  ['tests/e2e', 'global-setup.ts'],
  ['.', 'scripts/raw-fixture.mjs'],
];
for (const [workspace, filePath] of REAL_SITES) {
  test(`real ${workspace} ESLint refuses every fixture and variant as ${filePath}`, () => {
    const js = filePath.endsWith('.mjs');
    const cases = Object.entries({ ...REVIEWER_FIXTURES, ...VARIANTS })
      .filter(([name]) => !(js && TS_ONLY.has(name)))
      .map(([name, code]) => [
        name,
        `${js ? PRELUDE_JS : PRELUDE_TS}${js && JS_FORMS[name] ? JS_FORMS[name] : code}\nexport {};\n`,
      ]);
    const e2e = /^(?:e2e\/|specs\/|global-setup)/.test(filePath) || workspace === 'tests/e2e';
    if (e2e)
      cases.push(
        ...Object.entries(PLAYWRIGHT_RAW).map(([n, c]) => [
          n,
          `${PRELUDE_TS}declare const page: any, context: any, playwright: any, data: unknown, body: string;\n${c}\nexport {};\n`,
        ]),
      );
    const findings = lintInWorkspace(
      workspace,
      filePath,
      cases.map(([, code]) => code),
    );
    cases.forEach(([name], index) => {
      const fatal = findings[index].filter(({ ruleId }) => ruleId === null);
      assert.deepEqual(fatal, [], `${name} must parse: ${JSON.stringify(fatal)}`);
      assert.ok(
        findings[index].some(
          ({ ruleId, severity }) => ruleId === 'internal/raw-http' && severity === 2,
        ),
        `${workspace}/${filePath}: ${name} was accepted`,
      );
    });
  });
}

/** Repository files the boundary must cover, by the rule's scope (PM decision, PR #492 r2). */
const isTestFile = (file) =>
  /\.(?:spec|test|int-spec|e2e-spec)\.[cm]?[jt]sx?$/.test(file) ||
  /(?:^|\/)(?:test|__tests__)\//.test(file);
function inScope(file) {
  if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(file) || file.endsWith('.d.ts')) return false;
  if (/^apps\/web\/e2e\//.test(file)) return true; // specs included
  if (/^tests\/e2e\//.test(file))
    return !/^tests\/e2e\/src\/[^/]+\.test\.ts$/.test(file) && !/eslint\.config\.mjs$/.test(file);
  if (/^apps\/web\/src\//.test(file))
    return !isTestFile(file) && !/^apps\/web\/src\/test\//.test(file);
  if (/^scripts\//.test(file)) return !isTestFile(file);
  return (
    /^(?:services|packages)\/[^/]+\/(?:src|dev|prisma)\//.test(file) &&
    !isTestFile(file) &&
    !/\/src\/generated\//.test(file)
  );
}
const WORKSPACE_OF = (file) =>
  /^(?:apps|services|packages)\/[^/]+\//.exec(file)?.[0].slice(0, -1) ??
  (file.startsWith('tests/e2e/') ? 'tests/e2e' : '.');
const E2E_TREE = /^(?:apps\/web\/e2e|tests\/e2e)\//;
/** Until #483 moves it to internalFetch (then 2, and the exemption must go). */
const KEYCLOAK = 'services/identity-service/src/keycloak/keycloak.client.ts';

test('the boundary is on for every in-scope file, in every workspace, and the lint scripts reach them', () => {
  const tracked = spawnSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  const files = tracked.stdout.split('\n').filter(inScope);
  assert.ok(files.length > 1000, `scope found only ${files.length} files`);
  const byWorkspace = Map.groupBy(files, WORKSPACE_OF);
  const problems = [];
  for (const [workspace, list] of byWorkspace) {
    const relative = list.map((file) =>
      workspace === '.' ? file : file.slice(workspace.length + 1),
    );
    // The workspace's own lint must reach every one of its files.
    const manifest = JSON.parse(readFileSync(`${ROOT}${workspace}/package.json`, 'utf8'));
    const lint = workspace === '.' ? manifest.scripts['lint:scripts'] : manifest.scripts.lint;
    const targets = /^eslint ((?:[\w./-]+ ?)+)/.exec(lint)?.[1].trim().split(' ') ?? [];
    for (const file of relative)
      if (
        !targets.some(
          (target) => target === '.' || file === target || file.startsWith(`${target}/`),
        )
      )
        problems.push(`${workspace}: \`${lint}\` does not lint ${file}`);
    const script = `
      import { createRequire } from 'node:module';
      const { ESLint } = createRequire(process.env.ROOT_PACKAGE)('eslint');
      const eslint = new ESLint({ cwd: process.cwd() });
      const out = {};
      for (const file of JSON.parse(process.env.FILES))
        out[file] = (await eslint.calculateConfigForFile(file))?.rules?.['internal/raw-http'] ?? null;
      process.stdout.write(JSON.stringify(out));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: `${ROOT}${workspace}`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ROOT_PACKAGE: `${ROOT}package.json`, FILES: JSON.stringify(relative) },
    });
    assert.equal(result.status, 0, result.stderr);
    const rules = JSON.parse(result.stdout);
    list.forEach((file, index) => {
      const rule = rules[relative[index]];
      const expected = file === KEYCLOAK ? 0 : 2;
      if (rule?.[0] !== expected)
        problems.push(`${file}: internal/raw-http is ${JSON.stringify(rule)}`);
      else if (expected === 2 && E2E_TREE.test(file) && rule[1]?.playwright !== true)
        problems.push(`${file}: the E2E tree needs { playwright: true }`);
    });
  }
  assert.deepEqual(problems, []);
});

test('no inline directive switches the transport rules off, except the one pinned browser flow', () => {
  const tracked = spawnSync(
    'git',
    ['ls-files', 'apps', 'services', 'packages', 'scripts', 'tests'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const directive =
    /(?:\/\/|\/\*)\s*eslint(?:-disable(?:-next-line|-line)?|-enable)?(?=\s|\*\/|$)([^\n]*)/g;
  const found = [];
  for (const file of tracked.stdout.split('\n').filter((f) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(f))) {
    const text = readFileSync(`${ROOT}${file}`, 'utf8');
    for (const match of text.matchAll(directive)) {
      const rules = match[1]
        .replace(/\*\/.*$/, '')
        .split('--')[0]
        .trim();
      // A blanket disable would switch the boundary off with everything else.
      if (rules === '' || /internal\//.test(rules))
        found.push(`${file}: ${rules || '(all rules)'}`);
    }
  }
  assert.deepEqual(found, [
    // In the page, not the runner: the browser's own same-origin form post (Q-155 scope).
    'apps/web/e2e/usage.spec.ts: internal/raw-http, internal/transport',
  ]);
});

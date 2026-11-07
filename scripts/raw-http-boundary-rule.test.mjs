import { fixtureGitEnv } from './fixture-git-env.mjs';
import {
  trackedFiles as inventory,
  transportDirectives as directives,
} from './source-inventory.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import rawHttp, { AUDITED_TRANSPORTS } from './raw-http-boundary-rule.mjs';
import {
  EXECUTABLE_EXTENSIONS,
  boundaryHolds,
  code as anyExtension,
  requiredBoundary,
} from './lint-extensions.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const trackedFiles = (cwd = ROOT) => inventory(cwd);
const transportDirectives = (files, read) => directives(files, read, PINNED_FILE);

const linter = new Linter({ cwd: ROOT });
/** Findings of the boundary alone, for `code` as the file `path` (repository-relative). */
const check = (code, { path = 'apps/web/src/server/fixture.ts', playwright = false } = {}) => {
  const messages = linter.verify(
    code,
    [
      {
        files: [anyExtension('**/*')],
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
const PROCESS_FORMS = (source) => ({
  named: `import { getBuiltinModule as builtin } from '${source}'; builtin('vm').runInThisContext(code);`,
  default: `import proc from '${source}'; proc.getBuiltinModule('vm');`,
  namespace: `import * as proc from '${source}'; proc.getBuiltinModule('vm');`,
  dynamic: `const { getBuiltinModule: builtin } = await import('${source}'); builtin('vm');`,
  reexport: `export { getBuiltinModule as builtin } from '${source}';`,
  star: `export * from '${source}';`,
  'namespace reexport': `export * as proc from '${source}';`,
  require: `const { getBuiltinModule: builtin } = require('${source}'); builtin('vm');`,
  'unknown named export': `import { futureLoader as load } from '${source}'; load(code);`,
  'unknown default member': `import proc from '${source}'; proc.futureLoader(code);`,
  'object escape': `import * as proc from '${source}'; consume(proc);`,
  'object destructuring': `import proc from '${source}'; const { [name]: load } = proc;`,
  'listener result': `import { on as listen } from '${source}'; const p = listen('x', callback);`,
  'listener alias': `import { once as listen } from '${source}'; const alias = listen;`,
  'listener reexport': `export { off as listen } from '${source}';`,
  'namespace listener result': `import * as proc from '${source}'; const p = proc.on('x', callback);`,
});
const PROCESS_VARIANTS = Object.fromEntries(
  ['process', 'node:process'].flatMap((source) =>
    Object.entries(PROCESS_FORMS(source)).map(([name, code]) => [`${source} ${name}`, code]),
  ),
);
const VARIANTS = {
  ...PROCESS_VARIANTS,
  'normalized URL module': "await import(' \tDaTa:text/javascript,fetch(url)');",

  'process listener result': "const p=process.on('x',callback); p.getBuiltinModule('fs');",

  'factory escapes':
    "import {createRequire} from 'node:module'; const factory = createRequire; consume(factory);",

  'new constructor string': "new (() => {}).constructor('return fetch')();",
  'constructor extracted': "const C = (() => {}).constructor; C('return fetch')()(url);",
  'constructor destructured': "const {constructor:C}=()=>{}; C('return fetch')()(url);",

  'unknown loader base':
    "import { createRequire } from 'node:module'; const load = createRequire(base); load('./index.js');",

  'unknown HTTP export': "import { futureSender } from 'node:http'; futureSender(url);",
  'global process loader': 'globalThis.process.getBuiltinModule(name);',
  'unknown process export': 'process.futureLoader(name);',
  'shadowed Symbol': "const Symbol = pick(); globalThis[Symbol.for('fetch')](url);",

  'ambient fetch': 'declare const fetch: typeof globalThis.fetch; fetch(url);',
  'ambient namespace':
    'declare namespace window { function fetch(u: string): unknown; } window.fetch(url);',
  'aliased factory':
    "import { createRequire as make } from 'node:module'; const load = make(import.meta.url); load(name);",
  'factory result':
    "import { createRequire } from 'node:module'; createRequire(import.meta.url)('ky');",
  'escaping loader':
    "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); consume(load);",
  'fake builder': 'function resolve(x) { return x; } require(resolve(name));',
  'dependency path': "require('./node_modules/undici/index.js');",
  'VM string': "import vm from 'node:vm'; vm.runInThisContext('fetch(url)');",
  'worker string': "import { Worker } from 'node:worker_threads'; new Worker(code, {eval:true});",
  'data module': "await import('data:text/javascript,fetch(url)');",
  'module loader namespace':
    "import * as module from 'node:module'; module.createRequire(base)(name);",
  'process loader alias': 'const { getBuiltinModule: load } = process; load(name);',
  'constructor string': "(() => {}).constructor('return fetch')()(url);",
  'workspace build path': "require(join(ROOT, 'packages', 'x', 'dist', 'index.js'));",
  'path through a const': "const generated = join(dir, 'src', 'generated'); require(generated);",
  'file URL import': 'await import(pathToFileURL(dist).href);',

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
  // PR #492 r2 F2: the Keycloak live spec's own forms before the fix.
  'captured global fetch': 'const realFetch = globalThis.fetch; realFetch(url, init);',
  'global fetch replaced': 'globalThis.fetch = (async () => new Response()) as typeof fetch;',
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
  'native Symbol': "globalThis[Symbol.for('k')];",

  'typeof fetch in a type': 'const impl: typeof fetch = injected;',
  'fetch parameter type': 'type Input = Parameters<typeof fetch>[0];',
  'globalThis.fetch in a type': 'let impl: typeof globalThis.fetch;',
  'type-only import': "import type { Dispatcher } from 'undici';",
  'type-only specifier': "import { type Agent } from 'node:http';",
  'server half of node:http': "import { createServer, type Server } from 'node:http';",
  'typeof window': "const browser = typeof window !== 'undefined';",
  'feature test': "const has = 'fetch' in globalThis;",
  'safe global member': 'globalThis.crypto.randomUUID(); window.location.assign(url);',
  'injected transport through internalFetch': 'internalFetch(url, init, this.fetchImpl);',
  'injected member': 'deps.fetch(url);',
  'redis eval member': 'await redis.eval(script, 1, key);',
  'Function as a type': 'let callback: Function | undefined;',
  'local binding named fetch': 'function send(fetch: Fetch) { return fetch(url); }',
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

test('global and imported process allow only known capabilities and discarded listener results', () => {
  for (const source of ['process', 'node:process']) {
    for (const code of [
      `import { env as environment, cwd as directory } from '${source}'; directory(); consume(environment);`,
      `export { env, cwd as directory } from '${source}';`,
      `import type { Process } from '${source}';`,
      `import { type Process } from '${source}';`,
      `export type * from '${source}';`,
      `import proc from '${source}'; proc.cwd(); void proc.once('x', callback);`,
      `import * as proc from '${source}'; proc.env.MODE; proc.on('x', callback);`,
      `import { on as listen, off } from '${source}'; listen('x', callback); void off('x', callback);`,
      `process.cwd(); process.on('x', callback); void process.once('x', callback);`,
    ])
      assert.deepEqual(check(code), [], code);
  }
});

test('process registry holders are inert through casts and immutable aliases', () => {
  const holder = `
    const REGISTRY = Symbol.for('fixture.registry');
    if (typeof process !== 'object' || process === null) throw new Error();
    const holder = (process as unknown) as Record<symbol, unknown>;
    const alias = holder;
    const existing = alias[REGISTRY];
    Object.defineProperty(holder, REGISTRY, { value: new WeakMap() });`;
  assert.deepEqual(check(holder), []);
  assert.deepEqual(
    check(readFileSync(`${ROOT}packages/config/src/command-failure.js`, 'utf8')),
    [],
  );
  for (const source of [
    '',
    "import process from 'node:process';",
    "import * as process from 'process';",
  ]) {
    assert.deepEqual(check(source + holder), []);
    for (const use of [
      'const load = alias.getBuiltinModule; load(name);',
      'alias.binding(name);',
      'alias[unknownKey];',
      'consume(alias);',
      "const exposed = alias.on('x', callback);",
      'const exposed = Object.defineProperty(alias, REGISTRY, { value: 1 });',
      "Object.defineProperty(alias, 'getBuiltinModule', { value: load });",
      'function fake(Object) { Object.defineProperty(alias, REGISTRY, {}); }',
    ])
      assert.ok(
        check(source + holder + use).some(({ message }) =>
          /process.*(loader|exposes)/.test(message),
        ),
        use,
      );
  }
});

test('process registry keys refuse unproven or shadowed symbols and mutable holders', () => {
  for (const code of [
    'const holder = process; const key = unknown; holder[key];',
    "const holder = process; let key = Symbol.for('k'); holder[key];",
    "function f(Symbol) { const holder = process; holder[Symbol.for('k')]; }",
    "function f(key = Symbol.for('k')) { const holder = process; holder[key]; }",
    'const holder = process; const key = other; const other = key; holder[key];',
    'let holder = process; holder = other;',
    'const holder = process; const { getBuiltinModule: load } = holder;',
    'const holder = process; const alias = holder; export { alias };',
  ])
    assert.ok(check(code).length, code);
});

// FU-127: each of these escapes was accepted at the reviewed 8546796e head.
const HOLDER_ESCAPES = {
  'a exported holder declaration': 'export const holder = process;',
  'b slot function receiver':
    "const K = Symbol.for('k'); const h = process; h[K] = function () { return this; }; const p = h[K]();",
  'c slot getter receiver':
    "const K = Symbol.for('k'); Object.defineProperty(process, K, { get() { return this; } }); const p = process[K];",
  'd descriptor function value':
    "const K = Symbol.for('k'); Object.defineProperty(process, K, { value: function () { return this; } }); const p = process[K]();",
  'e patched Symbol.for':
    "Symbol.for = (k) => k; const K = Symbol.for('getBuiltinModule'); const h = process; const load = h[K]; load('http');",
  'e patched Object.defineProperty':
    "const stash = {}; Object.defineProperty = (t) => { stash.p = t; }; Object.defineProperty(process, Symbol.for('k'), { value: 1 });",
};
for (const [name, code] of Object.entries(HOLDER_ESCAPES))
  test(`FU-127 refuses ${name}`, () => assert.ok(check(code).length, code));

test('FU-127 refuses sibling declaration, receiver, descriptor and intrinsic escapes', () => {
  const prefix = "const K = Symbol.for('k'); const h = process;";
  for (const use of [
    'export const alias = h;',
    'export const alias = (h as unknown);',
    'const alias = h; export default alias;',
    'h[K]();',
    'h[K]`tag`;',
    '(h[K] as Function)();',
    'h[K] = () => 1;',
    'h[K] = class {};',
    'const fn = function () { return this; }; h[K] = fn;',
    'h[K] = unknown;',
    'h[K] += 1;',
    'h[K]++;',
    'delete h[K];',
    '({ value: h[K] } = unknown);',
    '[h[K]] = unknown;',
    'for (h[K] of values) {}',
    'Object.defineProperty(h, K, { set(v) {} });',
    'Object.defineProperty(h, K, { get: () => 1 });',
    'Object.defineProperty(h, K, { value() { return this; } });',
    'Object.defineProperty(h, K, { value: class {} });',
    'Object.defineProperty(h, K, { value: unknown });',
    'Object.defineProperty(h, K, { value: 1, ...unknown });',
    'Object.defineProperty(h, K, descriptor);',
    'Object.defineProperty(h, K, { value: 1, get() {} });',
    'Object.defineProperty(h, K, { [name]: 1 });',
    'const S = Symbol; S.for = (k) => k; h[K];',
    'const O = Object; O.defineProperty = capture; h[K];',
    "Reflect.set(Symbol, 'for', capture); h[K];",
    "Object.defineProperty(Object, 'defineProperty', { value: capture }); h[K];",
    'globalThis.Symbol.for = capture; h[K];',
    'Symbol = replacement; h[K];',
    'Object = replacement; h[K];',
    'h[K]; Symbol.for = capture;',
    'WeakMap = capture; Object.defineProperty(h, K, { value: new WeakMap() });',
    "Symbol.__defineGetter__('for', () => capture); h[K];",
    "Object.__defineGetter__('defineProperty', () => capture); h[K];",
    "function f(Object) { h[Symbol.for('k')]; }",
    'function f(Symbol) { Object.defineProperty(h, K, { value: 1 }); }',
  ])
    assert.ok(check(prefix + use).length, use);
  for (const key of [
    'Symbol.for()',
    'Symbol.for(unknown)',
    "Symbol.for('k', 1)",
    'Symbol.for(`k`)',
  ])
    assert.ok(check(`const h = process; h[${key}];`).length, key);
  for (const code of [
    'export const req = require;',
    "import { createRequire } from 'node:module'; export const load = createRequire(import.meta.url);",
    "Symbol.for = (k) => k; const p = globalThis[Symbol.for('process')];",
    "import p from 'node:process'; export const holder = p;",
    "import * as p from 'process'; export const holder = p;",
    'const h = process; h = other;',
  ])
    assert.ok(check(code).length, code);
});

test('FU-127 preserves plain registry values and immutable key/value aliases', () => {
  for (const value of ['1', 'null', '{ value: [1, null] }', 'new WeakMap()', 'v']) {
    const code = `const K = Symbol.for('k'); const KEY = K; const v = new WeakMap();
      const h = process; h[KEY] = ${value};
      Object.defineProperty(h, KEY, { value: ${value} }); const read = h[KEY];`;
    assert.deepEqual(check(code), [], code);
  }
});

// Both actual E2E configs must reject the import class in every supported source extension.
for (const [workspace, base] of [
  ['apps/web', 'e2e/raw-process.spec'],
  ['tests/e2e', 'specs/raw-process.e2e-spec'],
]) {
  test(`real ${workspace} ESLint refuses imported process capabilities across source extensions`, () => {
    for (const extension of EXECUTABLE_EXTENSIONS) {
      const cases =
        extension === 'cjs'
          ? ['process', 'node:process'].flatMap((source) => [
              PROCESS_FORMS(source).require,
              `(async () => { ${PROCESS_FORMS(source).dynamic} })();`,
            ])
          : Object.values(PROCESS_VARIANTS);
      const findings = lintInWorkspace(workspace, `${base}.${extension}`, cases);
      findings.forEach((messages, index) => {
        assert.ok(
          messages.some(({ ruleId, severity }) => ruleId === 'internal/raw-http' && severity === 2),
          `${workspace}/${base}.${extension}: ${cases[index]} was accepted`,
        );
        assert.ok(!messages.some(({ ruleId }) => ruleId === null), 'fixture must parse');
      });
    }
  });
}

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
    'scripts/test-stall-watchdog.mjs',
    'scripts/workspace-module.mjs',
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
  'global fetch replaced': 'globalThis.fetch = async () => new Response();',
  'headers.authorization assignment':
    'const headers = {};\nheaders.authorization = token;\nfetch(url, { headers });',
  'class-field transport':
    'class Client {\n  transport = globalThis.fetch;\n  send(url, token) {\n    return this.transport(url, { headers: { authorization: token } });\n  }\n}',
};
const TS_ONLY = new Set([
  'computed name through a cast',
  'import equals',
  'ambient fetch',
  'ambient namespace',
]);
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
  // PR #492 r2 F2: a live suite, outside every src/ and E2E block, is in scope by its name.
  ['services/identity-service', 'test/keycloak-live/raw-fixture.live-spec.ts'],
  ['services/notification-service', 'test/raw-fixture.live-spec.ts'],
  ['apps/web', 'src/test/raw-fixture.live-spec.ts'],
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

/**
 * Repository files the boundary must cover: the ONE policy the coverage guard
 * shares (requiredBoundary, scripts/lint-extensions.mjs), over every executable
 * extension (FU-074 r2 F1).
 */
const inScope = (file) => requiredBoundary(file) !== null;
const WORKSPACE_OF = (file) =>
  /^(?:apps|services|packages)\/[^/]+\//.exec(file)?.[0].slice(0, -1) ??
  (file.startsWith('tests/e2e/') ? 'tests/e2e' : '.');

test('the boundary is on for every in-scope file, in every workspace, and the lint scripts reach them', () => {
  const files = trackedFiles().filter(inScope);
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
      // No exemption: #483 moved the Keycloak client to internalFetch and the block went.
      if (!boundaryHolds(rule, requiredBoundary(file)))
        problems.push(`${file}: internal/raw-http is ${JSON.stringify(rule)} (options included)`);
    });
  }
  assert.deepEqual(problems, []);
});

const PINNED_FILE = 'apps/web/e2e/action-outcome.ts';
const PINNED_DIRECTIVE = `${PINNED_FILE}:108:8 Line eslint-disable-next-line: internal/raw-http sha256:050831978467575febdbfcef9fb18a1028a85edd554dfc93f168e3c2078e96a9:39edcde81fa4f4957c4f917d4762cc0c1d6283f677c8bf770e42f181dde9af21`;

test('no inline directive switches the transport rules off, except the one pinned browser flow', () => {
  // Every tracked file, not a list of top-level directories.
  const found = transportDirectives(trackedFiles(), (file) =>
    readFileSync(`${ROOT}${file}`, 'utf8'),
  );
  assert.deepEqual(found, [
    // In the page, not the runner: the browser's own same-origin form post (Q-155 scope),
    // the one transport every spec that proves an action's outcome uses (PR #541 r1 F1).
    PINNED_DIRECTIVE,
  ]);
});

// Compare with the real source's inventory too: these regressions must reject
// broadening, relocation and additions even with the old file/rule-only record.
for (const [name, mutate] of [
  [
    'file-wide disable',
    (source, directive) => source.replace(directive, `/* ${LINT}-disable internal/raw-http */`),
  ],
  ['moved directive', (source, directive) => source.replace(directive, `\n        ${directive}`)],
  [
    'duplicate directive',
    (source, directive) => source.replace(directive, `${directive}\n        ${directive}`),
  ],
  ['extra directive', (source) => `${source}\n// ${LINT}-disable-next-line no-console\n`],
  [
    'block next-line directive',
    (source, directive) =>
      source.replace(directive, `/* ${LINT}-disable-next-line internal/raw-http */`),
  ],
  [
    'same-line directive',
    (source, directive) => source.replace(directive, `// ${LINT}-disable-line internal/raw-http`),
  ],
  [
    'reworded justification',
    (source) => source.replace('browser form replay', 'unreviewed reason'),
  ],
  [
    'changed suppressed line',
    (source) =>
      source.replace(
        'const response = await fetch(',
        'void fetch("/extra"); const response = await fetch(',
      ),
  ],
  ['moved column', (source, directive) => source.replace(directive, ` ${directive}`)],
  [
    'different rule',
    (source, directive) =>
      source.replace(directive, `// ${LINT}-disable-next-line internal/transport`),
  ],
]) {
  test(`the browser-flow pin rejects a ${name}`, () => {
    const source = readFileSync(`${ROOT}${PINNED_FILE}`, 'utf8');
    const directive = `// ${LINT}-disable-next-line internal/raw-http -- browser form replay`;
    assert.ok(source.includes(directive));
    assert.notDeepEqual(
      transportDirectives([PINNED_FILE], () => mutate(source, directive)),
      transportDirectives([PINNED_FILE], () => source),
    );
  });
}

// F1 round 2: the real parser and ESLint must agree with the pin's line table.
for (const [name, newline] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['CR', '\r'],
  ['U+2028', '\u2028'],
  ['U+2029', '\u2029'],
]) {
  test(`the browser-flow pin follows ESLint line boundaries: ${name}`, () => {
    const source = readFileSync(`${ROOT}${PINNED_FILE}`, 'utf8');
    // Replace one terminator above the directive, then insert a new suppressed call.
    const shifted = source
      .replace(/\n(?=[^\r\n])/, newline)
      .replace(
        'const response = await fetch(',
        'await fetch("/extra");\n        const response = await fetch(',
      );
    const messages = check(shifted, { path: PINNED_FILE });
    assert.ok(!messages.some(({ line }) => line === 109), 'ESLint suppresses the inserted call');
    assert.ok(
      messages.some(({ line }) => line === 110),
      'the original call is now unsuppressed',
    );
    assert.notDeepEqual(
      transportDirectives([PINNED_FILE], () => shifted),
      [PINNED_DIRECTIVE],
    );
  });
}

test('the browser-flow pin preserves every ECMAScript line-ending spelling', () => {
  const source = readFileSync(`${ROOT}${PINNED_FILE}`, 'utf8');
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029'])
    assert.deepEqual(
      transportDirectives([PINNED_FILE], () => source.replaceAll('\n', newline)),
      [PINNED_DIRECTIVE],
    );
});

test('a directive without a target line refuses instead of hashing absent text', () => {
  assert.match(
    transportDirectives([PINNED_FILE], () => `// ${LINT}-disable-next-line internal/raw-http`)[0],
    /unclassifiable directive line/,
  );
});

// FU-074 r2 F1: one file per entry-point family, in every executable extension.
const FAMILIES = [
  'apps/web/src/server/fu074',
  'apps/web/src/app/fu074/page',
  'apps/web/e2e/fu074',
  'apps/web/e2e/fu074.spec',
  'apps/web/src/test/fu074.live-spec',
  'services/api-gateway/src/fu074',
  'services/api-gateway/dev/fu074',
  'services/economic-service/prisma/fu074',
  'services/identity-service/test/keycloak-live/fu074.live-spec',
  'packages/nest-common/src/http/fu074',
  'tests/e2e/src/fu074',
  'tests/e2e/specs/document/fu074.e2e-spec',
  'tests/e2e/global-setup-fu074',
  'scripts/fu074',
];
// Assembled, so this file's own text carries no directive for the repository scan.
const LINT = 'eslint';
const DISABLES = [
  `/* ${LINT}-disable internal/raw-http */`,
  `/* ${LINT}-disable */`,
  `// ${LINT}-disable-next-line internal/raw-http`,
  `/* ${LINT} internal/raw-http: off */`,
];
test('the directive scan and the scope reach every extension in every entry-point family', () => {
  for (const family of FAMILIES)
    for (const ext of EXECUTABLE_EXTENSIONS) {
      const file = `${family}.${ext}`;
      assert.ok(inScope(file), `${file} is outside the boundary scope`);
      for (const directive of DISABLES) {
        const text = `${directive}\nexport { getBuiltinModule } from 'node:process';\n`;
        assert.equal(
          transportDirectives([file], () => text).length,
          1,
          `${file}: \`${directive}\` was not seen`,
        );
      }
    }
});

// FU-166 F1: multiline bodies cannot hide a rule or forge the pinned exception.
test('parsed comments hold multiline directives and refuse unclassifiable source', () => {
  for (const family of FAMILIES)
    for (const ext of EXECUTABLE_EXTENSIONS) {
      const file = `${family}.${ext}`;
      for (const newline of ['\n', '\r\n', '\r'])
        for (const directive of [
          `/* ${LINT} no-console: off,${newline} "internal/raw-http": off */`,
          `/* ${LINT}-disable no-console,${newline} internal/raw-http */`,
          `/** ${LINT}-disable no-console,${newline} * internal/raw-http */`,
          `/* ${LINT} no-console: off,${newline} /* "internal/raw-http": off */`,
          `/* ${LINT} "internal\\u002fraw-http": off */`,
          `/* ${LINT}-disable "internal/raw-http" */`,
        ])
          assert.equal(transportDirectives([file], () => directive).length, 1, directive);
      for (const text of [
        `const fake = ${JSON.stringify(`/* ${LINT}-disable internal/raw-http */`)};`,
        `/* prose\n // ${LINT}-disable internal/raw-http */`,
        `/* ${LINT}-disable no-console,\n @typescript-eslint/no-explicit-any */`,
      ])
        assert.deepEqual(
          transportDirectives([file], () => text),
          [],
          text,
        );
      assert.match(transportDirectives([file], () => '/* unterminated')[0], /unclassifiable/);
      assert.match(
        transportDirectives([file], () => {
          throw Error('unreadable');
        })[0],
        /unclassifiable/,
      );
    }
});

// FU-166 inventory sibling: quoted paths must reach both repository scans.
test('tracked inventory preserves quoted and multiline filenames for the directive scan', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fu166-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Model a Git hook without pointing at any shared repository or index.
  const redirects = {
    GIT_DIR: join(root, 'redirect', '.git'),
    GIT_WORK_TREE: join(root, 'redirect'),
    GIT_INDEX_FILE: join(root, 'redirect', 'index'),
    GIT_OBJECT_DIRECTORY: join(root, 'redirect', 'objects'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare',
    GIT_CONFIG_VALUE_0: 'true',
  };
  const previous = Object.fromEntries(Object.keys(redirects).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, redirects);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: fixtureGitEnv() });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  git('config', 'core.quotePath', 'true');
  mkdirSync(join(root, 'scripts'));
  const names = ['fu166-café'];
  if (process.platform !== 'win32') names.push('fu166-line\nbreak', 'fu166-quote"back\\slash');
  const files = names.flatMap((name) =>
    EXECUTABLE_EXTENSIONS.map((ext) => `scripts/${name}.${ext}`),
  );
  for (const file of files)
    writeFileSync(join(root, file), `/* ${LINT} no-console: off,\n "internal/raw-http": off */`);
  git('add', '--', '.');
  assert.deepEqual(trackedFiles(root).sort(), files.sort());
  assert.ok(files.every(inScope));
  const findings = transportDirectives(trackedFiles(root), (file) =>
    readFileSync(join(root, file), 'utf8'),
  );
  assert.equal(findings.length, files.length);
  for (const file of files)
    assert.ok(
      findings.some((finding) => finding.startsWith(`${file}:`)),
      file,
    );
});

// Conservative guard: every Git subprocess in a test must
// use the shared env. Only explicit read-only inventories of ROOT are exempt.
function bareFixtureGit(source, file = 'fixture.mjs') {
  if (!source.includes('child_process')) return [];
  const ast = tseslint.parser.parseForESLint(source, {
    filePath: file,
    sourceType: 'module',
    loc: true,
    ecmaFeatures: { jsx: /\.[jt]sx$/.test(file) },
  }).ast;
  const commands = new Set();
  const environments = new Set();
  const namespaces = new Set();
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration' && node.source.value === './fixture-git-env.mjs')
      for (const spec of node.specifiers)
        if (spec.imported?.name === 'fixtureGitEnv') environments.add(spec.local.name);
    if (node.type !== 'ImportDeclaration' || !/^(node:)?child_process$/.test(node.source.value))
      continue;
    for (const spec of node.specifiers) {
      if (
        spec.type === 'ImportSpecifier' &&
        /^(spawn|spawnSync|execFile|execFileSync)$/.test(spec.imported.name)
      )
        commands.add(spec.local.name);
      else if (spec.type !== 'ImportSpecifier') namespaces.add(spec.local.name);
    }
  }
  const problems = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const callee = node.callee;
    if (
      node.type === 'CallExpression' &&
      node.arguments[0]?.value === 'git' &&
      (commands.has(callee.name) ||
        (callee.type === 'MemberExpression' && namespaces.has(callee.object.name)))
    ) {
      const options = node.arguments[2];
      const plain =
        options?.type === 'ObjectExpression' &&
        options.properties.every(
          (p) => p.type === 'Property' && !p.computed && p.kind === 'init',
        ) &&
        new Set(options.properties.map((p) => p.key?.name)).size === options.properties.length;
      const prop = (name) => options?.properties?.find((p) => p.key?.name === name)?.value;
      const env = prop('env');
      const shared =
        plain &&
        env?.type === 'CallExpression' &&
        environments.has(env.callee.name) &&
        env.arguments.length === 0;
      const read =
        plain &&
        ['ROOT', 'REPO_ROOT'].includes(prop('cwd')?.name) &&
        ['ls-files', 'status'].includes(node.arguments[1]?.elements?.[0]?.value);
      if (!shared && !read) problems.push(node.loc.start.line);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
  return problems;
}

test('temporary Git spawns require the shared fixture environment', () => {
  for (const file of trackedFiles().filter((file) =>
    /\.(?:test|spec|int-spec)\.[cm]?[jt]sx?$/.test(file),
  ))
    assert.deepEqual(bareFixtureGit(readFileSync(`${ROOT}${file}`, 'utf8'), file), [], file);
  for (const command of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const prefix = `import { ${command} as run } from 'node:child_process'; import { fixtureGitEnv } from './fixture-git-env.mjs'; const root = mkdtempSync();`;
    for (const options of [
      '{cwd: root}',
      '{cwd: root, env: process.env}',
      '{cwd: root, env: {}}',
      '{cwd: root, env: fixtureGitEnv(), ...overrides}',
      '{cwd: root, env: fixtureGitEnv(), env: process.env}',
    ])
      assert.equal(bareFixtureGit(`${prefix} run('git', ['add', '.'], ${options})`).length, 1);
    assert.deepEqual(
      bareFixtureGit(`${prefix} run('git', ['add', '.'], {cwd: root, env: fixtureGitEnv()})`),
      [],
    );
  }
});

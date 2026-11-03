// -----------------------------------------------------------------------------
// No native URL parse of configuration outside @rasta/config's reader (#385 r5).
//
//   pnpm test:url-parsing-guard
//
// `new URL(value)` refuses with a TypeError that keeps the whole value on
// `.input` (the base on `.base`), and Node prints it for an uncaught throw —
// a database URL's password included (Codex PR-385 r4 F1). Configuration is
// parsed by `readUrl`/`tryReadUrl` (packages/config/src/url-reader.js), which
// refuse with a fixed text. Every other parse of a value that is not a literal
// in scripts/, packages/, services/, apps/ and tests/ — test files aside, see
// `isTestFile` — must be in ALLOWED below, with the reason it cannot carry
// configuration. A new one fails here; so does an entry that no longer
// matches anything.
//
// Two premises of the class boundary are held here too: the command-line
// contract (scripts/cli-contract.mjs: per file, the options it accepts and the
// kind of value each takes, none a URL or a credential — configuration with a
// secret arrives through the environment), and every service-to-service base
// URL setting is read with `serviceUrlSchema` (an http(s) URL without
// credentials — `fetch` repeats a URL with credentials whole in its TypeError).
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_CONTRACT, OTHER_NAMED_LIKE_CREDENTIALS, VALUE_KINDS } from './cli-contract.mjs';
import {
  commandLineSurface,
  contractProblems,
  isTestFile,
  namesCredential,
  rawUrlParses,
  repositoryUrlParses,
  sourceFiles,
  unlistedUrlParses,
} from './url-parsing-guard-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let scannedRepository;
const repositorySites = () => (scannedRepository ??= repositoryUrlParses(ROOT));

/** Each parse of a non-literal that stays, and why it cannot carry configuration. */
const ALLOWED = Object.freeze([
  {
    file: 'services/economic-service/src/payment/payment-reconciliation.repository.ts',
    call: 'window[window.length - 1]',
    reason:
      'local window is the bounded Prisma result array in heal(); this reads its last row, not a global object or URL parser',
  },
  {
    file: 'packages/config/src/url-reader.js',
    call: 'new URL(value)',
    reason: 'the reader itself: the native error is discarded, a fixed text is thrown',
  },
  {
    file: 'packages/config/src/url-reader.js',
    call: 'new URL(value, base)',
    reason: 'the reader itself: the native error is discarded, a fixed text is thrown',
  },
  {
    file: 'packages/contracts/src/common/parsable-url.ts',
    call: 'new URL(payload.value)',
    reason:
      "zod 3's .url() as a schema check: only whether the value parses; the native error is discarded and the issue carries no text of it",
  },
  {
    file: 'scripts/verify-migration-reversible-lib.mjs',
    call: 'new URL( `../services/identity-service/prisma/migrations/${MEMBERSHIP_GUARD}/migration.sql`, import.meta.url, )',
    reason: 'a repository file: a constant migration name against import.meta.url',
  },
  {
    file: 'scripts/testing-dev-only-source.mjs',
    call: 'new URL(target, pathToFileURL(join(dir, sep)))',
    reason:
      "a package.json exports/imports target against its package's own file URL, as Node resolves it (percent-escapes, ?query); a repository file, no configuration",
  },
  {
    file: 'services/identity-service/test/audit-stub.ts',
    call: "new URL(request.url ?? '/', 'http://stub.invalid')",
    reason: "the stub server's incoming request path against a literal base; no configuration",
  },
  {
    file: 'apps/web/src/test/landing.ts',
    call: "new URL(url, 'http://portal.test')",
    reason: 'test helper: a redirect the portal drew, against a literal base; no configuration',
  },
  {
    file: 'services/identity-service/test/keycloak-http-stub.ts',
    call: "new URL(request.url ?? '', this.url)",
    reason:
      "the stub server's incoming request path against its own loopback base; no configuration",
  },
  {
    file: 'apps/web/src/app/AccountBoundary.tsx',
    call: 'new URL(form.action, window.location.href)',
    reason: 'browser: a form action against the page location; no configuration',
  },
  {
    file: 'apps/web/src/app/ConsumedFlash.tsx',
    call: 'new URL(window.location.href)',
    reason: "browser: the page's own location; no configuration",
  },
  {
    file: 'apps/web/src/app/auth/callback/route.ts',
    call: 'new URL(request.url)',
    reason: 'the incoming request URL, built by Next.js; no configuration',
  },
  {
    file: 'apps/web/src/app/auth/login/route.ts',
    call: 'new URL(request.url)',
    reason: 'the incoming request URL, built by Next.js; no configuration',
  },
  {
    file: 'apps/web/src/app/auth/logout/route.ts',
    call: 'new URL(endpointsFor(env.OIDC_ISSUER_URL).endSession)',
    reason:
      'OIDC_ISSUER_URL is refused at boot unless it parses as http(s) without credentials ' +
      '(apps/web/src/server/env.ts httpUrl); a path is appended to it',
  },
  {
    file: 'apps/web/src/server/asset-documents.ts',
    call: 'new URL(value)',
    reason: "inside try/catch returning false; the value is document-service's signed URL",
  },
  {
    file: 'apps/web/src/server/env.ts',
    call: 'new URL(value)',
    reason: 'inside try/catch returning true (`.url()` refuses it): the native error is discarded',
  },
  {
    file: 'apps/web/src/server/gateway.ts',
    call: 'new URL(baseUrl)',
    reason:
      'API_GATEWAY_URL, refused at boot unless it parses as http(s) without credentials ' +
      '(apps/web/src/server/env.ts httpUrl)',
  },
  {
    file: 'apps/web/src/server/gateway.ts',
    call: 'new URL(path, base)',
    reason: "the portal's own path against the boot-validated gateway base",
  },
  {
    file: 'apps/web/src/server/oidc.ts',
    call: 'new URL(request.endpoints.authorization)',
    reason: 'built from OIDC_ISSUER_URL, refused at boot unless it parses (env.ts httpUrl)',
  },
  {
    file: 'apps/web/src/server/oidc.ts',
    call: 'new URL(url)',
    reason: 'the JWKS URL built from OIDC_ISSUER_URL, refused at boot unless it parses',
  },
  {
    file: 'tests/e2e/src/target-guard.ts',
    call: 'new URL(value)',
    reason: 'inside try/catch returning undefined: the native error is discarded',
  },
  {
    file: 'apps/web/next.config.mjs',
    call: 'createRequire(import.meta.url)',
    reason: 'loads only the local upload-limit.cjs constant from this repository',
  },
  {
    file: 'apps/web/scripts/build-run.mjs',
    call: "createRequire(join(options.nextFrom ?? webDir, 'package.json'))",
    reason:
      'resolves only next/dist/bin/next from the build workspace; it does not load a URL parser',
  },
  {
    file: 'apps/web/src/test/setup.ts',
    call: 'Object.assign(globalThis, { TextEncoder: globalThis.TextEncoder ?? TextEncoder, TextDecoder: globalThis.TextDecoder ?? TextDecoder, })',
    reason:
      'installs only TextEncoder/TextDecoder test globals with static keys; no parser is read or returned',
  },
  {
    file: 'packages/observability/src/__tests__/telemetry-boundary.fixture.ts',
    call: "createRequire(require.resolve('@opentelemetry/sdk-node'))",
    reason:
      'test fixture resolves the pinned SDK api-logs dependency to exercise telemetry refusal',
  },
  {
    file: 'packages/testing/src/disclosure-guard.ts',
    call: "( globalThis as unknown as Record<symbol, { matchers?: Record<string, BuiltIn> } | undefined> )[Symbol.for('$$jest-matchers-object')]",
    reason:
      'reads only the fixed Jest matcher registry symbol to install disclosure assertion guards',
  },
  {
    file: 'scripts/aggregation-evidence.mjs',
    call: "createRequire(join(packageDir, 'package.json'))",
    reason: 'resolves only jest/package.json for the selected repository package',
  },
  {
    file: 'scripts/broker-default-delete.mjs',
    call: 'createRequire(import.meta.url)',
    reason: 'loads pinned KafkaJS transport and codec internals for the disposable-broker harness',
  },
  {
    file: 'scripts/check-kafka-topic-limits.mjs',
    call: 'createRequire(import.meta.url)',
    reason: 'loads only the built repository contracts package for topic limits',
  },
  {
    file: 'scripts/check-test-phases.mjs',
    call: 'createRequire(import.meta.url)',
    reason: 'loads only repository Jest configuration to verify test phase registration',
    line: 53,
  },
  {
    file: 'scripts/check-test-phases.mjs',
    call: 'createRequire(import.meta.url)',
    reason: 'loads only repository Jest configuration to verify test phase registration',
    line: 78,
  },
  {
    file: 'scripts/kafka-acl-generate.mjs',
    call: 'createRequire(import.meta.url)',
    reason: 'loads only the built repository contracts package to generate broker ACL documents',
  },
  {
    file: 'scripts/outbox-b2-backfill.mjs',
    call: 'createRequire(import.meta.url)',
    reason: 'loads only the built config package to enforce the owner-credential startup gate',
  },
  {
    file: 'scripts/outbox-b2-prisma-port.mjs',
    call: 'createRequire(import.meta.url)',
    reason:
      'loads the repository runtime-role gate or the selected service generated Prisma client',
  },
  {
    file: 'scripts/outbox-b2-prisma-port.mjs',
    call: "createRequire(join(serviceDir, 'package.json'))",
    reason:
      'loads the repository runtime-role gate or the selected service generated Prisma client',
  },
  {
    file: 'scripts/replay-dlq.mjs',
    call: 'createRequire(import.meta.url)',
    reason: 'loads only the built repository contracts package to validate replay envelopes',
  },
  {
    file: 'scripts/run-test-phases.mjs',
    call: "createRequire(join(root, 'package.json'))",
    reason: 'resolves only turbo/package.json to select the installed test runner',
  },
  {
    file: 'scripts/runtime-preflight.e2e.mjs',
    call: 'createRequire(import.meta.url)',
    reason:
      'loads repository config/nest-common and its KafkaJS dependency for the runtime preflight harness',
  },
  {
    file: 'scripts/testing-dev-only-source.mjs',
    call: "createRequire(join(workspace, 'package.json'))",
    reason:
      'resolves package paths and hashes pinned Prisma runtime sources for the production dependency guard',
  },
  {
    file: 'scripts/testing-dev-only-source.mjs',
    call: 'createRequire(file)',
    reason:
      'resolves package paths and hashes pinned Prisma runtime sources for the production dependency guard',
  },
  {
    file: 'scripts/verify-audit-correction-command-migration.mjs',
    call: "createRequire(join(SERVICE_DIR, 'package.json'))",
    reason:
      'resolves only prisma/package.json from the audit service for the reversible migration harness',
  },
  {
    file: 'scripts/verify-migration-reversible.mjs',
    call: "createRequire(join(serviceDir, 'package.json'))",
    reason: 'resolves only prisma/package.json from the selected service for reversible migrations',
  },
  {
    file: 'scripts/verify-outbox-claim-migration.mjs',
    call: "createRequire(join(serviceDir, 'package.json'))",
    reason:
      'resolves only prisma/package.json from the selected service for the outbox claim migration harness',
  },
  {
    file: 'scripts/verify-security-event-outbox-migration.mjs',
    call: "createRequire(join(SERVICE_DIR, 'package.json'))",
    reason:
      'resolves only prisma/package.json from the identity service for the security outbox migration harness',
  },
  {
    file: 'scripts/verify-test-independence.mjs',
    call: "createRequire(path.join(cwd, 'noop.js'))",
    reason: 'resolves Jest and reads its manifest to run the test independence harness',
  },
  {
    file: 'scripts/verify-test-independence.mjs',
    call: 'createRequire(import.meta.url)',
    reason: 'resolves Jest and reads its manifest to run the test independence harness',
  },
  {
    file: 'scripts/prepush-scope-lib.mjs',
    call: "createRequire(join(cwd, 'package.json'))",
    reason: 'resolves only turbo/package.json to locate the installed native Turbo binary',
  },
  {
    file: 'scripts/prepush-scope-lib.mjs',
    call: "createRequire(realpathSync(rootRequire.resolve('turbo/package.json')))",
    reason: 'resolves only the installed native Turbo binary package; no module is loaded',
  },
]);

/** zod `.url()` settings in a service's configuration that stay, and why. */
const ALLOWED_ZOD_URL_SETTINGS = Object.freeze({});

const sites = (text, file = 'x.mjs') => rawUrlParses(text, file).map((site) => site.kind);

test('a base is a literal only when it is a const URL of literals, bound once', () => {
  // From configuration: still a site.
  assert.deepEqual(sites("const lib = new URL(env.X); new URL('a.sql', lib);"), [
    'new URL',
    'new URL',
  ]);
  // Reassignable, or the name bound again elsewhere: not resolved.
  assert.deepEqual(sites("let lib = new URL('../lib/', import.meta.url); new URL('a', lib);"), [
    'new URL',
  ]);
  assert.deepEqual(
    sites(
      "const lib = new URL('../lib/', import.meta.url); function f(lib) { return new URL('a', lib); }",
    ),
    ['new URL'],
  );
});

test('every form of a native URL parse is found', () => {
  assert.deepEqual(sites('new URL(process.env.X)'), ['new URL']);
  assert.deepEqual(sites('new globalThis.URL(raw)'), ['new URL']);
  assert.deepEqual(sites("import url from 'node:url'; new url.URL(raw)"), ['new URL']);
  assert.deepEqual(sites('URL.parse(raw)'), ['URL.parse']);
  assert.deepEqual(sites('URL.canParse(raw)'), ['URL.canParse']);
  assert.deepEqual(sites("import { parse } from 'node:url'; parse(raw)"), ['url.parse']);
  assert.deepEqual(sites("import { parse as p } from 'url'; p(raw)"), ['url.parse']);
  assert.deepEqual(sites("import * as u from 'node:url'; u.parse(raw)"), ['url.parse']);
  assert.deepEqual(sites("import u from 'url'; u.parse(raw)"), ['url.parse']);
  assert.deepEqual(sites("const u = require('node:url'); u.parse(raw)", 'x.cjs'), ['url.parse']);
  assert.deepEqual(sites("const { parse } = require('url'); parse(raw)", 'x.cjs'), ['url.parse']);
  // Split over lines, and in TypeScript with a type annotation around it.
  assert.deepEqual(sites('const u: URL = new URL(\n  env.X as string,\n);', 'x.ts'), ['new URL']);
  // A literal path against a base from configuration: the base is on `.base`.
  assert.deepEqual(sites("new URL('/v1/users', this.options.baseUrl)", 'x.ts'), ['new URL']);
  // A template with a substitution is not a literal.
  assert.deepEqual(sites('new URL(`${base}/x`)'), ['new URL']);
});

/**
 * Codex PR-385 r5 F2: each way to reach a parser without spelling it at the
 * call. Resolved where the binding says what it is (import and destructuring
 * aliases, dynamic-import namespaces, computed members with a literal name);
 * refused where it stands otherwise (an alias, an argument, a subclass, a
 * computed member the parser cannot read). Each fails as written and passes
 * once the value is read with the shared reader.
 */
const FIXED = "import { readUrl } from '@rasta/config'; readUrl(env.X);";
const ESCAPES = [
  ['import { URL as U }', "import { URL as U } from 'node:url'; new U(env.X);", 'new URL'],
  [
    "const { URL: U } = require('node:url')",
    "const { URL: U } = require('node:url'); new U(env.X);",
    'new URL',
  ],
  ['const { URL: U } = globalThis', 'const { URL: U } = globalThis; new U(env.X);', 'new URL'],
  ['const U = URL', 'const U = URL; new U(env.X);', 'escape'],
  ['const parse = URL.parse', 'const parse = URL.parse; parse(env.X);', 'escape'],
  [
    'const parse = url.parse',
    "import url from 'node:url'; const parse = url.parse; parse(env.X);",
    'escape',
  ],
  [
    'a dynamic-import namespace',
    "const m = await import('node:url'); m.parse(env.X);",
    'url.parse',
  ],
  [
    'a dynamic-import namespace, its URL',
    "const m = await import('url'); new m.URL(env.X);",
    'new URL',
  ],
  [
    'dynamic-import destructuring',
    "const { parse: p } = await import('url'); p(env.X);",
    'url.parse',
  ],
  ['a dynamic import used unbound', "import('node:url').then((m) => m.parse(env.X));", 'escape'],
  ["globalThis['URL']", "new globalThis['URL'](env.X);", 'new URL'],
  ["URL['parse']", "URL['parse'](env.X);", 'URL.parse'],
  ["url['parse']", "import url from 'node:url'; url['parse'](env.X);", 'url.parse'],
  ['URL[name]', "const name = 'parse'; URL[name](env.X);", 'escape'],
  ['globalThis[name]', "const name = 'URL'; new globalThis[name](env.X);", 'escape'],
  ['a subclass', 'class Parsed extends URL {} new Parsed(env.X);', 'escape'],
  ['an argument', 'Reflect.construct(URL, [env.X]);', 'escape'],
  ["export { parse } from 'url'", "export { parse as p } from 'node:url';", 'escape'],
  ["export * from 'url'", "export * from 'url';", 'escape'],
];

for (const [form, escape, kind] of ESCAPES) {
  test(`the guard sees ${form}`, () => {
    const found = rawUrlParses(escape, 'x.mts');
    if (kind === null) {
      // Re-exported, the binding leaves the file: the importer's call is the
      // site, found there (see "import { URL as U }").
      assert.deepEqual(found, []);
    } else {
      assert.ok(found.length > 0, `${form}: not found`);
      assert.ok(
        found.some((site) => site.kind === kind),
        `${form}: ${JSON.stringify(found)}`,
      );
    }
    assert.deepEqual(rawUrlParses(FIXED, 'x.mts'), [], `${form}: the fix`);
  });
}

// F2 acceptance fixtures go through the real repository walker, in each source
// extension/tree, including fixtures without URL/module text (addendum A).
const F2 = [
  ['shadowed sibling', 'function f(URL){new URL(env.X)} function g(){new globalThis.URL(env.X)}'],
  ['instance constructor', "const base=new URL('http://ok'); new base.constructor(env.X)"],
  ['loader re-export', "export {createRequire as load} from 'node:module'"],
  ['vm re-export', "export * from 'node:vm'"],
  ['computed destructuring', "const {['URL']: U}=globalThis; new U(env.X)"],
  ['nested global destructuring', 'const {globalThis: {URL: U}}=globalThis; new U(env.X)'],
  ['prototype constructor', 'const {prototype: {constructor: U}}=URL; new U(env.X)'],
  ['prototype alias', 'const {constructor: U}=URL.prototype; new U(env.X)'],
  ['global alias', 'const g=globalThis; new g[k](env.X)'],
  ['Reflect.get', "const U=Reflect.get(globalThis,'URL'); new U(env.X)"],
  [
    'createRequire alias',
    "import {createRequire as cr} from 'node:module'; const load=cr(import.meta.url); load('node:url').parse(env.X)",
  ],
  ['builtin module', "process.getBuiltinModule('node:url').parse(env.X)"],
  ['default re-export', "export {default as u} from 'node:url'"],
  ['eval', 'eval(code)'],
  ['Function', 'Function(code)()'],
  ['new Function', 'new Function(code)()'],
  ['vm', "import vm from 'node:vm'; vm.runInThisContext(code)"],
  ['vm import only', "import 'node:vm'"],
  ['vm import expression', "await import('node:vm')"],
  ['dynamic vm', "const vm=await import('node:vm'); vm.runInThisContext(code)"],
  ['mutation', "const base=new URL('http://ok'); base.href=env.X"],
  ['mutation alias', "const base=new URL('http://ok'); const alias=base; alias['href']=env.X"],
];
for (const [label, source] of F2) {
  test(`repository scanner refuses F2 ${label}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'url-guard-'));
    try {
      for (const tree of ['scripts', 'packages', 'services', 'apps', 'tests'])
        mkdirSync(join(root, tree));
      const files = [
        'scripts/a.mjs',
        'packages/a.cts',
        'services/a.ts',
        'apps/a.tsx',
        'tests/a.cjs',
        'scripts/a.js',
        'packages/a.mts',
        'apps/a.jsx',
      ];
      for (const file of files) writeFileSync(join(root, file), source);
      const found = repositoryUrlParses(root);
      if (
        [
          'computed destructuring',
          'nested global destructuring',
          'prototype constructor',
          'prototype alias',
        ].includes(label)
      ) {
        for (const file of files)
          assert.ok(
            found.some((site) => site.file === file && site.kind === 'new URL'),
            `${label}: native binding in ${file}`,
          );
      }
      for (const file of files)
        assert.ok(
          found.some((site) => site.file === file),
          `${label}: ${file}`,
        );
      assert.ok(unlistedUrlParses(found, []).unlisted.length >= files.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// F1 a–d: local exports expose parser escapes even when importers use unrelated names.
const F1 = [
  [
    'a shorthand',
    [
      'const o={URL}; new o.URL(env.X)',
      "import {parse} from 'node:url'; module.exports={parse}",
      "import {createRequire} from 'node:module'; run({createRequire})",
      'const {getBuiltinModule}=process; run({getBuiltinModule})',
      'run({eval})',
    ],
  ],
  [
    'b local export',
    [
      "import {parse} from 'node:url'; export {parse}",
      "import {URL} from 'node:url'; export {URL}",
      "export {URL} from 'node:url'",
      "import * as u from 'node:url'; export {u}",
      "import {createRequire} from 'node:module'; export {createRequire}",
      'const {getBuiltinModule}=process; export {getBuiltinModule}',
    ],
  ],
  [
    'c ambient',
    [
      'declare const URL: typeof globalThis.URL; new URL(env.X)',
      'declare var URL: any; new URL(env.X)',
      'declare let URL: any; new URL(env.X)',
      'declare function URL(x: any): any; new URL(env.X)',
      'declare class URL {}; new URL(env.X)',
      'declare global {var URL: any}; new URL(env.X)',
      "declare const process: any; process.getBuiltinModule('node:url')",
      'interface URL {}; new URL(env.X)',
      'enum URL {}; new URL(env.X)',
      'namespace URL {}; new URL(env.X)',
      'type URL = unknown; new URL(env.X)',
      "import type {URL} from './types.js'; new URL(env.X)",
    ],
  ],
  [
    'd unknown receiver',
    [
      'new window.top.URL(env.X)',
      'new document.defaultView.URL(env.X)',
      'function f(){return new this.URL(env.X)}',
      'new (require(name)).URL(env.X)',
      'new getGlobal().URL(env.X)',
      "new getGlobal()['URL'](env.X)",
    ],
  ],
];
for (const [label, sources] of F1) {
  test(`F1 ${label} fails closed`, () => {
    const extensions = label.startsWith('c')
      ? ['ts', 'mts', 'cts', 'tsx']
      : ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx'];
    for (const extension of extensions)
      for (const source of sources)
        assert.ok(rawUrlParses(source, `a.${extension}`).length > 0, `${extension}: ${source}`);
  });
}

test('F1 b refuses the exporter before a local importer can hide the parser', () => {
  const root = mkdtempSync(join(tmpdir(), 'url-guard-'));
  try {
    for (const tree of ['scripts', 'packages', 'services', 'apps', 'tests']) {
      mkdirSync(join(root, tree));
      writeFileSync(join(root, tree, 'a.js'), "import {parse} from 'node:url'; export {parse}");
      writeFileSync(join(root, tree, 'b.js'), "import {parse} from './a.js'; parse(env.X)");
    }
    const found = repositoryUrlParses(root);
    for (const tree of ['scripts', 'packages', 'services', 'apps', 'tests'])
      assert.ok(
        found.some((site) => site.file === `${tree}/a.js`),
        tree,
      );
    assert.equal(unlistedUrlParses(found, []).unlisted.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F1 shorthand and ambient CLI bindings retain discovery', () => {
  for (const source of [
    "import {argv} from 'node:process'; run({argv})",
    'const {argv}=process; run({argv})',
    'declare const process: any; process.argv',
    'declare global {var process: any}; process.argv',
    'function main(process){process.argv}',
  ])
    assert.equal(commandLineSurface(source, 'a.ts').readsArgv, true, source);
});

// R2-1: no local declaration is proof of its unknown runtime value.
const UNKNOWN_RECEIVERS = [
  "const spec='node:url'; const m=await import(spec); new m.URL(env.X)",
  'const m=require(name); new m.URL(env.X)',
  "const m=module.require('url'); new m.URL(env.X)",
  "const m=process.mainModule.require('url'); new m.URL(env.X)",
  'function f(){const g=this; return new g.URL(env.X)}',
  'const w=window.top; new w.URL(env.X)',
  'const w=document.defaultView; new w.URL(env.X)',
  'const {URL}=await import(spec); new URL(env.X)',
  'const {URL:U}=require(name); new U(env.X)',
  'function f(){const {URL}=this; return new URL(env.X)}',
  'function f({URL}){new URL(env.X)} f(await import(spec))',
  'function f({URL:U}){new U(env.X)} f(await import(spec))',
  'function f({URL}={URL:class {}}){new URL(env.X)} f(unknown)',
  'function f({URL:U}={URL:class {}}){new U(env.X)} f(unknown)',
  'function f(o){new o.nested.URL(env.X)} f({nested:await import(spec)})',
  'const m=await import(spec); f(m.URL)',
  'let m; m=await import(spec); new m.URL(env.X)',
  'var m; m=await import(spec); new m.URL(env.X)',
  'let URL; ({URL}=await import(spec)); new URL(env.X)',
  'let m={}; m=await import(spec); new m.URL(env.X)',
  'let URL=class {}; URL=unknown; new URL(env.X)',
  'let m={URL:class {}}; m=unknown; new m.URL(env.X)',
  'let {URL:U}={URL:class {}}; ({URL:U}=unknown); new U(env.X)',
  'let {URL:U}={}; ({URL:U}=await import(spec)); new U(env.X)',
  'function f(URL){return new URL(env.X)}',
  'try {} catch(URL) {new URL(env.X)}',
  'function f(){const URL=unknown; return new URL(env.X)}',
  'const x={nested:unknown}; new x.nested.URL(env.X)',
  'const x={...unknown}; new x.URL(env.X)',
  'const x={get nested(){return unknown}}; new x.nested.URL(env.X)',
  'const x=[]; new x.URL(env.X)',
  "const base=new URL('http://ok'); new base.URL(env.X)",
  'const x={URL:x.URL}; new x.URL(env.X)',
  'const {nested:{URL:U}}=unknown; new U(env.X)',
  "import * as m from 'unknown-package'; new m.URL(env.X)",
  "let u=require('node:url'); u.parse(env.X)",
  "let {parse:p}=require('url'); p(env.X)",
];
test('R2-1 unknown runtime values fail closed across all scanned trees and extensions', () => {
  const root = mkdtempSync(join(tmpdir(), 'url-guard-'));
  try {
    for (const tree of ['scripts', 'packages', 'services', 'apps', 'tests']) {
      mkdirSync(join(root, tree));
      for (const extension of ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx']) {
        const file = `${tree}/unknown.${extension}`;
        const source = UNKNOWN_RECEIVERS.map((source) => `{${source}}`).join('\n');
        writeFileSync(join(root, file), source);
      }
    }
    const found = repositoryUrlParses(root);
    for (const tree of ['scripts', 'packages', 'services', 'apps', 'tests'])
      for (const extension of ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx'])
        for (let line = 1; line <= UNKNOWN_RECEIVERS.length; line++)
          assert.ok(
            found.some(
              (site) => site.file === `${tree}/unknown.${extension}` && site.line === line,
            ),
            `${tree}/${extension}:${line}: ${UNKNOWN_RECEIVERS[line - 1]}`,
          );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('R2-1 unknown local global-object names stay unknown while their URL member is refused', () => {
  for (const name of ['window', 'self', 'global', 'globalThis']) {
    assert.deepEqual(sites(`function f(${name}){run(${name})}`), []);
    assert.deepEqual(sites(`function f(${name}){new ${name}.URL(env.X)}`), ['new URL']);
  }
});
test('R2-1 mutable bindings retain proven native instance capabilities', () => {
  assert.deepEqual(sites("let base=new URL('http://ok'); base.href=env.X"), ['URL mutation']);
});
test('name floor includes relative reexports; R2-3 import-equals references are visited', () => {
  assert.deepEqual(sites("export { URL } from './local.js'"), ['escape']);
  assert.ok(rawUrlParses("export {URL as U} from 'node:url'", 'a.ts').length > 0);
  assert.ok(rawUrlParses('import U = URL; new U(env.X)', 'a.ts').length > 0);
});
test('R2-1 bodiless function declarations cannot shadow the runtime URL', () => {
  for (const extension of ['ts', 'mts', 'cts', 'tsx'])
    assert.ok(
      rawUrlParses('function URL(x: string): any; new URL(env.X)', `a.${extension}`).length,
    );
});

// R3-1 instances 1–6, plus literal/computed/renamed keys and sibling scopes.
const NAME_FLOOR = [
  'const state={mod:null}; state.mod=await import(spec); new state.mod.URL(env.X)',
  'const o={m:0}; o.m=require(name); new o.m.URL(env.X)',
  'const f=()=>{}; f.m=await import(spec); new f.m.URL(env.X)',
  'class L {mod=null}; const l=new L(); l.mod=await import(spec); new l.mod.URL(env.X)',
  'class C {constructor(){return require(name)}}; new (new C()).URL(env.X)',
  'class Registry {static mod=null}; Registry.mod=await import(spec); new Registry.mod.URL(env.X)',
  'function f(){}; Object.assign(f,await import(spec)); new f.URL(env.X)',
  'function m(){}; m=await import(spec); new m.URL(env.X)',
  'class m {}; m=await import(spec); new m.URL(env.X)',
  'function URL(){}; URL=(await import(spec))[k]; new URL(env.X)',
  'class URL {}; URL=(await import(spec))[k]; new URL(env.X)',
  "import {state} from './state.js'; state.mod=await import(spec); new state.mod.URL(env.X)",
  'class Custom{}; const x={URL:Custom}; Object.assign(x,await import(spec)); new x.URL(env.X)',
  'function f(){class URL {}; return new URL(env.X)}',
  'function f(){function URL(){}; return new URL(env.X)}',
  'class Custom {}; const x={URL:Custom}; const {URL:U}=x; new U(env.X); new x.URL(env.X)',
  "import {URL} from './local.js'; new URL(env.X)",
  "import {URL as U} from './dist/local.js'; new U(env.X)",
  'function f(){class Custom {}; const URL=Custom; return new URL(env.X)}',
  "import {URL as U} from 'node:url'; function f(U){new U(env.X)} new U(env.X)",
  'const {URL:U}={URL:null}; function f(U){new U(env.X)}',
  "const x={URL:null}; new x['URL'](env.X)",
  "const x={URL:null}; const {['URL']:U}=x; new U(env.X)",
  'const x={URL:null}; const {URL}=x; new URL(env.X)',
  "const U=URL; const base=new U('http://ok'); new URL('/path',base)",
];
const NAME_ESCAPE_FLOOR = [
  "export { URL } from './local.js'",
  "export { URL as U } from './local.js'",
  "const globalThis = new URL('http://ok'); globalThis[key]",
  'const window = {}; window[key]',
];
// This is main 5702020a's caught-forms corpus: all native-parse/ESCAPES
// fixtures above, plus F1 forms main caught without lexical symbol resolution.
// Keep it explicit so a resolver swap cannot trade old coverage for new forms.
test("main's caught-forms corpus remains refused by the new resolver", () => {
  const corpus = [
    ...ESCAPES.map(([, source]) => source),
    ...UNKNOWN_RECEIVERS,
    ...NAME_FLOOR,
    ...NAME_ESCAPE_FLOOR,
    'function URL(x: string): any; new URL(env.X)',
    ...F1.flatMap(([, sources]) => sources).filter(
      (source) => !/createRequire|getBuiltinModule|eval/.test(source),
    ),
    'new URL(process.env.X)',
    'new globalThis.URL(raw)',
    "import url from 'node:url'; new url.URL(raw)",
    'URL.parse(raw)',
    'URL.canParse(raw)',
    "import {parse} from 'node:url'; parse(raw)",
    "import {parse as p} from 'url'; p(raw)",
    "import * as u from 'node:url'; u.parse(raw)",
    "import u from 'url'; u.parse(raw)",
    "const u=require('node:url'); u.parse(raw)",
    "const {parse}=require('url'); parse(raw)",
    'const u: URL = new URL(\n env.X as string,\n)',
    "new URL('/v1/users', this.options.baseUrl)",
    'new URL(`${base}/x`)',
  ];
  for (const source of corpus) assert.ok(rawUrlParses(source, 'a.ts').length > 0, source);
});

test('name-only escapes cannot be suppressed by lexical capabilities', () => {
  for (const source of NAME_ESCAPE_FLOOR) assert.ok(sites(source).includes('escape'), source);
});
test('R3-1 name floor refuses every mutable-slot instance and former non-parser exemption', () => {
  for (const extension of ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx'])
    for (const source of NAME_FLOOR) {
      const found = rawUrlParses(source, `a.${extension}`);
      assert.ok(
        found.some((site) => site.kind === 'new URL'),
        `${extension}: ${source}`,
      );
    }
  for (const from of [
    './local.js',
    './dist/local.js',
    './generated/local.js',
    '../root.js',
    './x.test.js',
  ])
    assert.deepEqual(sites(`import {URL} from '${from}'; new URL(env.X)`), ['new URL']);
  // Neither the explicit URL key nor its receiver's initial value proves safety.
  for (const receiver of ['null', '0', '()=>{}', 'class {}', '{}', '{URL: class {}}'])
    for (const use of ['new x.URL(env.X)', "new x['URL'](env.X)", 'const {URL:U}=x; new U(env.X)'])
      assert.ok(sites(`const x=${receiver}; ${use}`).includes('new URL'));
});

test('one expression exemption cannot cover duplicates, neighbours, or a whole loader file', () => {
  const found = rawUrlParses('eval(code);\neval(code);\nnew URL(env.X)', 'a.mjs');
  const entry = { file: 'a.mjs', call: 'eval(code)', reason: 'reviewed test expression' };
  assert.equal(unlistedUrlParses(found, [entry]).unlisted.length, 3);
  assert.equal(unlistedUrlParses(found, [entry]).stale.length, 1);
  assert.equal(unlistedUrlParses(found, [{ ...entry, line: 1 }]).unlisted.length, 2);
  assert.equal(unlistedUrlParses(found, [{ ...entry, line: 9 }]).stale.length, 1);
  const loader = rawUrlParses(
    "import {createRequire} from 'node:module'; const req=createRequire(import.meta.url); new URL(env.X)",
    'a.mjs',
  );
  assert.deepEqual(
    unlistedUrlParses(loader, [{ ...entry, call: 'createRequire(import.meta.url)' }]).unlisted.map(
      (site) => site.kind,
    ),
    ['new URL'],
  );
});

test('an exempt loader factory still exposes an aliased node:url parse', () => {
  const source =
    "import {createRequire as cr} from 'node:module'; const load=cr(import.meta.url); load('node:url').parse(env.X)";
  const found = rawUrlParses(source, 'a.mjs');
  const { unlisted, stale } = unlistedUrlParses(found, [
    { file: 'a.mjs', call: 'cr(import.meta.url)', reason: 'reviewed factory only' },
  ]);
  assert.deepEqual(stale, []);
  assert.ok(unlisted.some((site) => site.kind === 'url.parse'));
});

for (const [label, source] of [
  ['imported argv', "import {argv as args} from 'node:process'; args.slice(2);"],
  ['destructured argv', 'const {argv: args}=process; args.slice(2);'],
  ['namespace argv', "import * as p from 'node:process'; const args=p.argv; args.slice(2);"],
  [
    'namespace parseArgs',
    "import * as u from 'node:util'; u.parseArgs({options:{endpoint:{type:'string'}}});",
  ],
  [
    'CommonJS parseArgs',
    "const u=require('node:util'); u.parseArgs({options:{endpoint:{type:'string'}}});",
  ],
  [
    'destructured parseArgs',
    "const {parseArgs: p}=require('util'); p({options:{endpoint:{type:'string'}}});",
  ],
]) {
  test(`CLI discovery refuses unregistered F2 ${label}`, () => {
    const surface = commandLineSurface(source, 'a.mjs');
    assert.equal(surface.readsArgv, true);
    if (label.includes('parseArgs')) assert.deepEqual(surface.options, ['--endpoint']);
    assert.equal(contractProblems(new Map([['a.mjs', surface]]), {}, {}, {}).length, 1);
    if (surface.options.length)
      assert.ok(
        contractProblems(
          new Map([['a.mjs', surface]]),
          { 'a.mjs': { accepts: { '--endpoint': 'string' }, positionals: [] } },
          { string: 'text' },
          {},
        ).includes('a.mjs: accepts --endpoint'),
      );
  });
}

test('literals, import.meta.url, comments and other parse methods are not sites', () => {
  assert.deepEqual(sites("new URL('http://localhost:3000/x')"), []);
  assert.deepEqual(sites('new URL(`http://localhost/x`)'), []);
  assert.deepEqual(sites("new URL('../x.sql', import.meta.url)"), []);
  assert.deepEqual(sites('// new URL(process.env.X) is how it used to be\n'), []);
  assert.deepEqual(sites("const text = 'new URL(process.env.X)';"), []);
  assert.deepEqual(sites('JSON.parse(raw); path.parse(raw); new URLSearchParams(raw);'), []);
  // A literal against a URL built only from literals (#421's privilege library).
  assert.deepEqual(
    sites(
      "const lib = new URL('../lib/', import.meta.url); const sql = new URL('a.sql', lib); new URL('b.txt', sql);",
    ),
    [],
  );
  // `parse` from another module is not `node:url`'s.
  assert.deepEqual(sites("import { parse } from 'node:path'; parse(raw)"), []);
});

test('test files are left out by name, test helpers are not — __tests__/ included', () => {
  for (const file of [
    'services/a/test/x.int-spec.ts',
    'services/a/src/x.spec.ts',
    'apps/web/src/x.spec.tsx',
    'scripts/x.test.mjs',
    'scripts/x.pg.test.mjs',
    'tests/e2e/specs/x.e2e-spec.ts',
    'packages/a/src/__tests__/x.spec.ts',
  ]) {
    assert.equal(isTestFile(file), true, file);
  }
  for (const file of [
    'services/a/test/helpers.ts',
    'scripts/runtime-preflight.e2e.mjs',
    'scripts/refusal-probes.mjs',
    'tests/e2e/src/target-guard.ts',
    // A helper beside the tests is in scope wherever it lives (#385 r6).
    'packages/a/src/__tests__/x.fixture.ts',
    'packages/a/src/__tests__/helpers.ts',
  ]) {
    assert.equal(isTestFile(file), false, file);
  }
});

test('an unlisted site fails, and so does a stale entry', () => {
  const found = [{ file: 'a.mjs', line: 1, kind: 'new URL', call: 'new URL(raw)' }];
  assert.deepEqual(unlistedUrlParses(found, []).unlisted, found);
  const entry = { file: 'a.mjs', call: 'new  URL(raw)', reason: 'r' };
  assert.deepEqual(unlistedUrlParses(found, [entry]), { unlisted: [], stale: [] });
  assert.deepEqual(unlistedUrlParses([], [entry]).stale, [entry]);
  // Another file's identical call is not covered.
  assert.equal(unlistedUrlParses([{ ...found[0], file: 'b.mjs' }], [entry]).unlisted.length, 1);
});

test('every scanned tree is non-empty, and the reader itself is found', () => {
  const files = sourceFiles(ROOT);
  for (const tree of ['scripts/', 'packages/', 'services/', 'apps/', 'tests/']) {
    assert.ok(
      files.some((file) => file.startsWith(tree)),
      `nothing scanned under ${tree}`,
    );
  }
  // The reader's own two parses are seen: the scan reaches packages/config/src.
  const reader = repositorySites().filter(
    (site) => site.file === 'packages/config/src/url-reader.js',
  );
  assert.equal(reader.length, 2);
});

test('no native URL parse of configuration outside the reader (allow-list aside)', () => {
  for (const entry of ALLOWED) {
    assert.ok(entry.reason.length > 20, `${entry.file}: an allow-list entry needs a reason`);
  }
  const { unlisted, stale } = unlistedUrlParses(repositorySites(), ALLOWED);
  assert.deepEqual(
    unlisted.map((site) => `${site.file}:${site.line} ${site.call}`),
    [],
    'parse configuration with readUrl/tryReadUrl from @rasta/config ' +
      '(scripts: ../packages/config/src/url-reader.js), or allow-list the site with a reason',
  );
  assert.deepEqual(
    stale.map((entry) => `${entry.file}: ${entry.call}`),
    [],
    'these allow-list entries match nothing any more; remove them',
  );
});

test('the option-name backstop: credential and connection names in every spelling', () => {
  // Codex PR-385 r5 F2: the old pattern missed these four.
  for (const option of [
    '--api-key',
    '--apiKey',
    '--databaseUrl',
    '--endpoint',
    '--database-url',
    '--password-stdin',
    '--DATABASE_URL',
    '--broker',
    '--auth-token',
  ]) {
    assert.ok(namesCredential(option), option);
  }
  for (const option of ['--security-opt', '--with-database', '--schema', '--keyword', '--hosted']) {
    assert.ok(!namesCredential(option), option);
  }
});

test('the command-line surface: argv readers, option literals and parseArgs options', () => {
  const surface = (text) => commandLineSurface(text, 'x.mjs');
  assert.deepEqual(surface("const [a] = process.argv.slice(2); if (a === '--apiKey') {}"), {
    readsArgv: true,
    options: ['--apiKey'],
  });
  assert.deepEqual(
    surface(
      "import { parseArgs } from 'node:util'; parseArgs({ options: { 'api-key': { type: 'string' } } });",
    ),
    { readsArgv: true, options: ['--api-key'] },
  );
  assert.deepEqual(surface("process['argv']"), { readsArgv: true, options: [] });
  assert.deepEqual(surface("run('psql', ['-X', '--file=x.sql'])"), {
    readsArgv: false,
    options: ['--file', '-X'],
  });
  // Text that is not an option: a sentence, a range, a negative number.
  assert.deepEqual(surface("const a = '-- note'; const b = '--x needs a value'; const c = '-1';"), {
    readsArgv: false,
    options: [],
  });
});

/** Every scanned file's command-line surface, test files aside. */
function repositorySurfaces() {
  const surfaces = new Map();
  for (const file of sourceFiles(ROOT).filter((name) => !isTestFile(name))) {
    // The contract itself spells every option, as data.
    if (file === 'scripts/cli-contract.mjs') continue;
    const text = readFileSync(join(ROOT, file), 'utf8');
    if (!text.includes('-') && !text.includes('argv')) continue;
    const surface = commandLineSurface(text, file);
    if (surface.readsArgv || surface.options.length > 0) surfaces.set(file, surface);
  }
  return surfaces;
}

test('the contract checker refuses each way out (synthetic surfaces)', () => {
  const kinds = { switch: '', path: '' };
  const surfaces = new Map([
    ['a.mjs', { readsArgv: true, options: ['--api-key', '--quiet'] }],
    ['b.mjs', { readsArgv: true, options: ['--x'] }],
    ['c.mjs', { readsArgv: false, options: ['--token'] }],
    ['d.mjs', { readsArgv: false, options: [] }],
  ]);
  const contract = {
    a: {},
    'a.mjs': { accepts: { '--quiet': 'switch' }, positionals: [] },
    'b.mjs': { accepts: { '--x': 'url', '--databaseUrl': 'path' }, positionals: ['secret'] },
    'c.mjs': { other: ['--token'] },
  };
  assert.deepEqual(contractProblems(surfaces, contract, kinds, {}).sort(), [
    'a.mjs: spells --api-key, not in its entry',
    'a: listed, but neither reads argv nor spells an option',
    'b.mjs: --x takes "url"',
    'b.mjs: a positional takes "secret"',
    'b.mjs: accepts --databaseUrl',
    'b.mjs: its entry lists --databaseUrl, not spelled',
    'c.mjs: passes --token; say why it is not a credential',
    'd.mjs: not in the contract (argv)',
  ]);
  assert.deepEqual(
    contractProblems(
      new Map([['c.mjs', surfaces.get('c.mjs')]]),
      { 'c.mjs': contract['c.mjs'] },
      kinds,
      {
        '--token': 'a reason',
      },
    ),
    [],
  );
});

test('the command-line contract holds for the repository', () => {
  const surfaces = repositorySurfaces();
  assert.ok(surfaces.size > 40, 'the scan found too few command lines');
  for (const kind of Object.keys(VALUE_KINDS)) {
    assert.ok(
      !namesCredential(`--${kind}`) && !/url|uri/i.test(kind),
      `${kind} is not a value kind`,
    );
  }
  assert.deepEqual(
    contractProblems(surfaces, CLI_CONTRACT, VALUE_KINDS, OTHER_NAMED_LIKE_CREDENTIALS),
    [],
  );
});

test('every service base URL is read with serviceUrlSchema, and no bare zod .url()', () => {
  // `.check(parsableUrl())` is zod 3's `.url()` kept under zod 4 (@rasta/contracts).

  const configFiles = sourceFiles(ROOT).filter(
    (file) => /^services\/[^/]+\/src\/config\/[^/]+\.ts$/.test(file) && !isTestFile(file),
  );
  assert.ok(configFiles.length >= 17, "the services' configuration files were not found");
  const problems = [];
  const zodUrlSettings = new Set();
  for (const file of configFiles) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const match of text.matchAll(
      /\b([A-Z][A-Z0-9_]*)\s*:\s*z\s*\.\s*string\(\)\s*\.\s*(?:url\(|check\(\s*parsableUrl\()/g,
    )) {
      zodUrlSettings.add(match[1]);
      if (!(match[1] in ALLOWED_ZOD_URL_SETTINGS)) {
        problems.push(`${file}: ${match[1]} uses z.string().url()`);
      }
    }
    for (const match of text.matchAll(
      /\b([A-Z][A-Z0-9_]*_SERVICE_URL|KEYCLOAK_URL)\s*:\s*([A-Za-z_.]+)/g,
    )) {
      if (match[2] !== 'serviceUrlSchema' && !match[2].startsWith('serviceUrlSchema.')) {
        problems.push(`${file}: ${match[1]} is read with ${match[2]}, not serviceUrlSchema`);
      }
    }
  }
  assert.deepEqual(problems, []);
  for (const setting of Object.keys(ALLOWED_ZOD_URL_SETTINGS)) {
    assert.ok(zodUrlSettings.has(setting), `${setting} is allow-listed but no longer uses .url()`);
  }
});

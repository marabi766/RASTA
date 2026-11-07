import { sourceLines, trackedFiles, transportDirectives } from './source-inventory.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestOnlyPath } from './test-only-path.mjs';
import { sourceProblems } from './testing-dev-only-source.mjs';
import { repoPath } from './internal-token-source-rule.mjs';
import { workspaceDirectories } from './workspace-roots-lib.mjs';

/**
 * The internal-token source boundary's lint layer in real workspaces (PR #423
 * follow-up 1; #503 r2). The boundary itself is at run time
 * (packages/nest-common/src/http/internal-token-boundary.spec.ts).
 *
 * Every fixture is a real file written into a real workspace and linted by the
 * real ESLint binary from that workspace's directory, with its own config and
 * TypeScript project — never a bare `Linter`. Expectations are per line: a
 * line ending in `// ✗ <messageId> …` must carry each of those reports, a line
 * without the mark must carry none, so every case in a file is checked on its
 * own. No fixture may fail on a parser error instead. Fixture files are
 * removed afterwards.
 *
 * `structural` holds every workspace with a `lint` script to the rule at
 * every extension ESLint lints and every path its script names; `coverage`
 * derives from ESLint itself which tracked files each lint script reaches.
 * INTERNAL_TOKEN_LINT_SCRIPTS=1 additionally runs each workspace's own `lint`
 * script over a fixture (a full lint of the repository; not part of CI).
 *
 * The fixtures are files in the working tree while they exist, so this file
 * runs in its own `node --test` step, after the tests that sweep the tree
 * (testing-dev-only.test.mjs): `node --test` runs files concurrently.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ESLINT = path.join(ROOT, 'node_modules/eslint/bin/eslint.js');
const RULE = 'internal/token-source';
const TAG = `__token_source_${process.pid}__`;
const EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];
const MARK = /\/\/ ✗ ([\w ]+)$/;
/** The one file the rule exempts whole (scripts/internal-token-source-rule.mjs). */
const CLIENT_FILE = 'packages/nest-common/src/http/internal-http-client.ts';

/**
 * Writes `files` (paths relative to `cwd` → text), refusing to overwrite anything, and returns
 * the cleanup: it removes only the files written and the directories this call created, deepest
 * first, each with a non-recursive rmdir, so a file someone else put there fails the cleanup
 * instead of being deleted.
 */
function placeFixtures(cwd, files) {
  const written = [];
  const created = new Set();
  const remove = () => {
    for (const file of written.splice(0)) fs.rmSync(file, { force: true });
    for (const dir of [...created].sort((a, b) => b.length - a.length)) fs.rmdirSync(dir);
    created.clear();
  };
  try {
    for (const relative of Object.keys(files)) {
      const absolute = path.join(cwd, relative);
      assert.ok(!fs.existsSync(absolute), `fixture would overwrite ${absolute}`);
    }
    for (const [relative, text] of Object.entries(files)) {
      const absolute = path.join(cwd, relative);
      for (let dir = path.dirname(absolute); !fs.existsSync(dir); dir = path.dirname(dir)) {
        created.add(dir);
      }
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, text, { flag: 'wx' });
      written.push(absolute);
    }
  } catch (error) {
    remove();
    throw error;
  }
  return remove;
}

/** Writes `files` (workspace-relative path → text), lints them, removes them. */
function lintFixtures(workspace, files, { stdin } = {}) {
  const cwd = path.join(ROOT, workspace);
  const remove = placeFixtures(cwd, files);
  try {
    const args = [ESLINT, '--format', 'json', '--no-warn-ignored'];
    const result = stdin
      ? spawnSync(process.execPath, [...args, '--stdin', '--stdin-filename', stdin.file], {
          cwd,
          input: stdin.text,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        })
      : spawnSync(process.execPath, [...args, ...Object.keys(files)], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
    assert.equal(result.error, undefined);
    assert.ok([0, 1].includes(result.status), result.stderr);
    const byFile = new Map();
    for (const entry of JSON.parse(result.stdout)) {
      byFile.set(path.relative(cwd, entry.filePath).split(path.sep).join('/'), entry.messages);
    }
    return byFile;
  } finally {
    remove();
  }
}

/** The fixture's boundary messages, after proving it parsed. */
function boundary(messages, file) {
  assert.ok(messages, `${file} was not linted`);
  const fatal = messages.filter((message) => message.fatal);
  assert.deepEqual(fatal, [], `${file} must parse; a parser error is not the boundary`);
  return messages.filter((message) => message.ruleId === RULE);
}

/**
 * Each marked line carries (at least) its marked reports; no other line
 * carries any. A file without marks must be clean.
 */
function expectMarked(byFile, file, text) {
  const expected = new Map();
  sourceLines(text).forEach((line, index) => {
    const mark = MARK.exec(line);
    if (mark) expected.set(index + 1, mark[1].trim().split(/\s+/));
  });
  const actual = new Map();
  for (const message of boundary(byFile.get(file), file)) {
    actual.set(message.line, [...(actual.get(message.line) ?? []), message.messageId]);
  }
  for (const [line, ids] of expected) {
    for (const id of ids) {
      assert.ok(
        actual.get(line)?.includes(id),
        `${file}:${line} must report ${id}, got [${actual.get(line) ?? []}]: ${sourceLines(text)[line - 1]}`,
      );
    }
  }
  for (const [line, ids] of actual) {
    assert.ok(
      expected.has(line),
      `${file}:${line} reports [${ids}] on an unmarked line: ${sourceLines(text)[line - 1]}`,
    );
  }
}

/** Lints `files` in `workspace` and checks every one by its marks. */
function lintMarked(workspace, files) {
  const byFile = lintFixtures(workspace, files);
  for (const [file, text] of Object.entries(files)) expectMarked(byFile, file, text);
  return byFile;
}

// ---------------------------------------------------------------------------
// Fixtures for a NestJS service (economic-service: @rasta/nest-common, a test
// project that covers src/test/dev/seed).

const ISSUER = "import { InternalTokenService } from '@rasta/nest-common';\n";
const S = `src/${TAG}`;
const lines = (...rows) => rows.join('\n') + '\n';

const SERVICE_FIXTURES = {
  // r1 evasion 1. Headers/constants built in another file.
  [`${S}/e1-header-module.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    "export const INTERNAL = 'X-Internal-Token' as const;",
    'export const minted = (tokens: InternalTokenService) => tokens.issue("a", "b", "SERVICE"); // ✗ issuance',
    'export const internalHeaders = (token: string) => ({ [INTERNAL]: token }); // ✗ header',
    'export const tokens = new InternalTokenService("x".repeat(32), "rasta-internal", 60);',
  ),
  [`${S}/e1-sender.ts`]: lines(
    "import { INTERNAL, tokens } from './e1-header-module';",
    'export async function send(url: string) {',
    '  const token = await tokens.issue("a", "b", "SERVICE"); // ✗ issuance',
    '  return fetch(url, { headers: { [INTERNAL]: token } }); // ✗ header',
    '}',
  ),
  // 2. Constructor parameter transport.
  [`${S}/e2-constructor.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    'export class Sender {',
    '  constructor(private readonly tokens: InternalTokenService, private readonly http: typeof fetch = fetch) {}',
    '  async go(url: string) {',
    '    const token = await this.tokens.issue("a", "b", "SERVICE"); // ✗ issuance',
    "    return this.http(url, { headers: { 'x-internal-token': token } }); // ✗ header",
    '  }',
    '}',
  ),
  // 3. Class field transport alias.
  [`${S}/e3-field.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    'export class Sender {',
    '  private readonly send = fetch;',
    '  private readonly mint = this.tokens.issue; // ✗ issuance',
    "  constructor(private readonly tokens: Pick<InternalTokenService, 'issue'>) {}",
    '  async go(url: string) { return this.send(url, { headers: { "x-internal-token": await this.mint("a", "b") } }); } // ✗ header',
    '}',
  ),
  // 4. Destructured transport and destructured issuance.
  [`${S}/e4-destructured.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    'export async function go(tokens: InternalTokenService, url: string) {',
    '  const { fetch: f } = globalThis;',
    '  const { issue } = tokens; // ✗ issuance',
    "  return f(url, { headers: [['X-Internal-Token', await issue('a', 'b')]] }); // ✗ header",
    '}',
  ),
  // 5. bind/call/Reflect.apply/Reflect.get.
  [`${S}/e5-indirect.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    'export async function go(tokens: InternalTokenService) {',
    '  const bound = tokens.issue.bind(tokens); // ✗ issuance',
    '  const called = await tokens.issue.call(tokens, "a", "b"); // ✗ issuance',
    '  const applied = await Reflect.apply(tokens.issue, tokens, ["a", "b"]); // ✗ issuance escape',
    '  const got = Reflect.get(tokens, "is" + "sue"); // ✗ escape',
    '  return [bound, called, applied, got];',
    '}',
  ),
  // 6. require/dynamic import, with no transport import at all.
  [`${S}/e6-dynamic.ts`]: lines(
    'export async function go(name: string, url: string, token: string) {',
    '  // eslint-disable-next-line @typescript-eslint/no-require-imports',
    "  const common = require('@rasta/nest-common'); // ✗ unresolved",
    '  const transport = await import(name); // ✗ unresolved',
    "  return [common, transport.request(url, { headers: { 'x-internal-token': token } })]; // ✗ header",
    '}',
  ),
  // 7. http2/got/ky/superagent/XHR: refused at issuance and at the header.
  [`${S}/e7-alternates.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    "import http2 from 'node:http2';",
    'declare const got: (url: string, options: object) => unknown;',
    'declare const ky: { get(url: string, options: object): unknown };',
    'declare const superagent: { get(url: string): { set(name: string, value: string): unknown } };',
    'declare const xhr: { setRequestHeader(name: string, value: string): void };',
    'export async function go(tokens: InternalTokenService, url: string) {',
    '  const token = await tokens.issue("a", "b", "SERVICE"); // ✗ issuance',
    "  http2.connect(url).request({ ':path': '/', 'x-internal-token': token }); // ✗ header",
    "  got(url, { headers: { 'X-INTERNAL-TOKEN': token } }); // ✗ header",
    "  ky.get(url, { headers: new Headers([['x-internal-token', token]]) }); // ✗ header",
    "  superagent.get(url).set('X-Internal-Token', token); // ✗ header",
    "  xhr.setRequestHeader('x-internal-token', token); // ✗ header",
    '}',
  ),
  // 8. A local internalFetch / InternalHttpClient grants nothing.
  [`${S}/e8-fake-client.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    'async function internalFetch(url: string, init: RequestInit) { return fetch(url, init); }',
    'export class InternalHttpClient {',
    '  constructor(private readonly tokens: InternalTokenService) {}',
    '  async go(url: string) {',
    '    const token = await this.tokens.issue("a", "b", "SERVICE"); // ✗ issuance',
    "    return internalFetch(url, { headers: { 'x-internal-token': token } }); // ✗ header",
    '  }',
    '}',
  ),
  // Fail closed: structural Pick, structural stand-in, any, computed key.
  [`${S}/f-structural.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    'type Minter = { issue(caller: string, target: string): Promise<string> };',
    "export const viaPick = (tokens: Pick<InternalTokenService, 'issue'>) => tokens['issue']('a', 'b'); // ✗ issuance",
    'export const standIn = (tokens: InternalTokenService) => { const m: Minter = tokens; return m; }; // ✗ escape',
    'export const erased = (tokens: InternalTokenService) => (tokens as unknown as { issue(): string }).issue(); // ✗ escape',
    'export const keyed = (tokens: InternalTokenService, key: keyof InternalTokenService) => tokens[key]; // ✗ issuance',
    'export const dynamic = (tokens: InternalTokenService & Record<string, unknown>, key: string) => tokens[key]; // ✗ unresolved',
    "export const untyped = (value: any) => value.issue('a', 'b'); // ✗ unresolved",
    "export const fromText = () => [eval('1'), Function('return 1')(), new Function('return 1')()]; // ✗ unresolved",
  ),
  // r2, review F1: capability carried in containers, closures, generics; the
  // constructor allowance only for a verified DI factory.
  [`${S}/r2-f1.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    'type Minter = { issue(caller: string, target: string): Promise<string> };',
    "export const nested = (t: InternalTokenService) => ({ t } as unknown as { t: Minter }).t.issue('a', 'b'); // ✗ escape",
    "export const listed = (t: InternalTokenService) => ([t] as unknown as Minter[])[0]!.issue('a', 'b'); // ✗ escape",
    "export const closure = (t: InternalTokenService) => ((() => t) as unknown as () => Minter)().issue('a', 'b'); // ✗ escape",
    "export const spread = (t: InternalTokenService) => { const w: { t: Minter } = { ...{ t } }; return w.t.issue('a', 'b'); }; // ✗ escape",
    'export const promised = (t: InternalTokenService) => Promise.resolve(t) as unknown as Promise<Minter>; // ✗ escape',
    "export function mint<T>(t: T): Promise<string> { return Reflect.get(t as object, ['is', 'sue'].join('')).call(t, 'a', 'b', 'SERVICE'); }",
    'export const viaGeneric = (tokens: InternalTokenService) => mint(tokens); // ✗ escape',
    "export const castCtor = (secret: string) => (new InternalTokenService(secret, 'rasta-internal', 60) as any as Minter).issue('a', 'b'); // ✗ escape",
    "export const folded = (t: InternalTokenService) => t['is' + 'sue']('a', 'b'); // ✗ issuance",
    'type Provider = { provide: unknown; useFactory: (...args: any[]) => any };',
    "export const verified: Provider = { provide: InternalTokenService, useFactory: (secret: string) => new InternalTokenService(secret, 'i', 60) };",
    "export const otherToken: Provider = { provide: 'TOKENS', useFactory: (secret: string) => new InternalTokenService(secret, 'i', 60) }; // ✗ escape",
    "export const anyFactory = (secret: string): any => new InternalTokenService(secret, 'i', 60); // ✗ escape",
  ),
  // r2, review F2: the secret named as a string, folded or computed.
  [`${S}/r2-f2-secret.ts`]: lines(
    'declare const env: { INTERNAL_TOKEN_SECRET: string; PORT: number };',
    "export const reflected = () => Reflect.get(env, 'INTERNAL_TOKEN_SECRET'); // ✗ signer",
    "export const joined = () => Reflect.get(env, ['INTERNAL', 'TOKEN', 'SECRET'].join('_')); // ✗ signer",
    "export const folded = () => env['INTERNAL_' + 'TOKEN_SECRET']; // ✗ signer",
    "export const cased = () => Reflect.get(env, 'internal_token_secret'.toUpperCase()); // ✗ signer",
    'export const keyed = (name: keyof typeof env) => env[name]; // ✗ signer',
    'export const dynamic = (name: string) => (env as typeof env & Record<string, unknown>)[name]; // ✗ unresolved',
    'export const port = () => env.PORT;',
  ),
  // r2, review F2: header names built at run time from constants.
  [`${S}/r2-f2-header.ts`]: lines(
    "export const joined = (token: string) => fetch('/x', { headers: { [['x', 'internal', 'token'].join('-')]: token } }); // ✗ header",
    "export const lowered = (token: string) => fetch('/x', { headers: { ['X-INTERNAL-TOKEN'.toLowerCase()]: token } }); // ✗ header",
    "export const entries = (token: string) => new Headers([[['x', 'internal', 'token'].join('-'), token]]); // ✗ header",
    "export const fromEntries = (token: string) => Object.fromEntries([['x-internal-' + 'token', token]]); // ✗ header",
  ),
  // r2, review F3: loaders and code generation in production JavaScript.
  [`${S}/r2-f3.mjs`]: lines(
    "import { createRequire } from 'node:module';",
    "import { join } from 'node:path';",
    "export const computed = (t) => t['is' + 'sue']('a', 'b'); // ✗ unresolved",
    "export const named = (t, name) => t[name]('a', 'b'); // ✗ unresolved",
    'export const reflected = (t, name) => Reflect.get(t, name).call(t); // ✗ unresolved',
    "export const splitCommon = () => import('@rasta/' + 'nest-' + 'common'); // ✗ unresolved",
    "export const splitJose = () => import('jo' + 'se'); // ✗ signer",
    "export const splitPath = () => import(join('../../packages/nest-', 'common/dist/index.js')); // ✗ unresolved",
    'const load = require;',
    "export const viaAlias = () => load('@rasta/nest-common'); // ✗ unresolved",
    "export const viaModule = () => module.require('jose'); // ✗ signer",
    'const req = createRequire(import.meta.url);',
    "export const viaCreate = () => req('@rasta/nest-common'); // ✗ unresolved",
    "export const viaMain = () => require.main.require('x'); // ✗ unresolved",
    'export const passed = (use) => use(require); // ✗ unresolved',
    'const run = eval; // ✗ unresolved',
    "export const viaGlobal = () => globalThis.eval('1'); // ✗ unresolved",
    "export const viaComputed = () => globalThis['ev' + 'al']('1'); // ✗ unresolved",
    'const F = Function; // ✗ unresolved',
    "export const viaCtor = () => (() => 0).constructor('return 1'); // ✗ unresolved",
    "export const viaHelper = (helper) => import(helper('safe')); // ✗ unresolved",
    "export const viaTimer = () => setTimeout('1', 0); // ✗ unresolved",
    "export const viaVm = () => import('node:vm'); // ✗ unresolved",
    "export const fine = () => [import('./x.mjs'), require.main === module, [run, F]];",
  ),
  // Signing an internal token by hand, or reading its secret.
  [`${S}/f-signer.ts`]: lines(
    "import { SignJWT } from 'jose';",
    'export const sign = (env: { INTERNAL_TOKEN_SECRET: string }) =>',
    '  new SignJWT({ svc: "a" }).sign(new TextEncoder().encode(env.INTERNAL_TOKEN_SECRET)); // ✗ signer',
  ),
  // A re-export is the same method.
  [`${S}/f-reexport.ts`]: "export { InternalTokenService as Minter } from '@rasta/nest-common';\n",
  [`${S}/f-reexport-user.ts`]: lines(
    "import { Minter } from './f-reexport';",
    'export const go = (minter: Minter) => minter.issue("a", "b"); // ✗ issuance',
  ),
  // Still valid: domain issue(), reading the header, redaction, OpenAPI, the
  // secret as the issuer's first argument, an env schema's key.
  [`${S}/v-domain.ts`]: lines(
    "import { InternalTokenService } from '@rasta/nest-common';",
    'class Rfqs { issue(id: string) { return id; } }',
    'class Reservations { issue(id: string, dto: object) { return { id, dto }; } }',
    'export const rfq = new Rfqs().issue("RFQ-1");',
    'export const reservation = new Reservations().issue("R-1", {});',
    "export const read = (headers: Headers, raw: Record<string, string>) => [headers.get('X-Internal-Token'), raw['x-internal-token']];",
    'export const redaction = (paths: string[]) => paths.push(\'req.headers["x-internal-token"]\');',
    "export const openApi = { type: 'apiKey', in: 'header', name: 'X-Internal-Token' };",
    'export const schema = { INTERNAL_TOKEN_SECRET: 32 };',
    'export const provider = { provide: InternalTokenService, useFactory: (env: { INTERNAL_TOKEN_SECRET: string }) =>',
    '  new InternalTokenService(env.INTERNAL_TOKEN_SECRET, "rasta-internal", 60) };',
  ),
  // 9. dev, a seed-like file and a file no project includes.
  [`dev/${TAG}.ts`]: `${ISSUER}export const go = (tokens: InternalTokenService) => tokens.issue('a', 'b'); // ✗ issuance\n`,
  [`prisma/${TAG}.ts`]:
    "export const go = (tokens: { issue(a: string, b: string): unknown }) => tokens.issue('a', 'b'); // ✗ unresolved\n",
  // Test token factories: the same issuance and header in a spec and in test/.
  [`${S}/t-factory.spec.ts`]: `${ISSUER}export const factory = async (tokens: InternalTokenService) => ({ 'x-internal-token': await tokens.issue('a', 'b') });\n`,
  [`test/${TAG}/factory.ts`]: `${ISSUER}export const factory = async (tokens: InternalTokenService) => ({ 'x-internal-token': await tokens.issue('a', 'b') });\n`,
};

/** One fixture per extension ESLint lints: an untyped `issue`. */
function extensionFixtures(directory) {
  return Object.fromEntries(
    EXTENSIONS.map((extension) => [
      `${directory}/x-ext.${extension}`,
      extension === 'cjs'
        ? "module.exports = (t) => t.issue('a', 'b'); // ✗ unresolved\n"
        : extension.endsWith('x')
          ? "export const go = (t: any) => t.issue('a', 'b'); // ✗ unresolved\n"
          : "export const go = (t) => t.issue('a', 'b'); // ✗ unresolved\n",
    ]),
  );
}

test('economic-service: every evasion and exception, one line each', () => {
  lintMarked('services/economic-service', {
    ...SERVICE_FIXTURES,
    ...extensionFixtures(`${S}/ext`),
  });
});

test('economic-service: the real seed is linted with the rule', () => {
  const seed = 'prisma/seed.ts';
  const text = `${fs.readFileSync(path.join(ROOT, 'services/economic-service', seed), 'utf8')}\nexport const leak = (headers: Record<string, string>, token: string) => { headers['X-Internal-Token'] = token; };\n`;
  const byFile = lintFixtures('services/economic-service', {}, { stdin: { file: seed, text } });
  // Text that is not on disk is linted without types, so its nest-common
  // import fails closed too; the appended line is refused for the header.
  const last = sourceLines(text.trimEnd()).length;
  assert.deepEqual(
    boundary(byFile.get(seed), seed).map((message) => [message.messageId, message.line === last]),
    [
      ['unresolved', false],
      ['header', true],
    ],
  );
});

test('the rule sees types for the seed, E2E root files and service sources as they are on disk', () => {
  const script = `
    const { typedOrUntypedParser } = await import(${JSON.stringify(path.join(ROOT, 'scripts/internal-token-parser.mjs'))});
    const tseslint = (await import(${JSON.stringify(path.join(ROOT, 'node_modules/typescript-eslint/dist/index.js'))})).default;
    const fs = await import('node:fs');
    const parser = typedOrUntypedParser(tseslint.parser);
    const out = {};
    for (const file of JSON.parse(process.argv[1])) {
      const code = fs.readFileSync(file, 'utf8');
      out[file] = {
        disk: Boolean(parser.parseForESLint(code, { filePath: file, sourceType: 'module' }).services.program),
        edited: Boolean(parser.parseForESLint(code + '\\n', { filePath: file, sourceType: 'module' }).services.program),
      };
    }
    process.stdout.write(JSON.stringify(out));`;
  const files = [
    'services/economic-service/prisma/seed.ts',
    'services/economic-service/test/api-helpers.ts',
    'services/economic-service/src/provenance/source-facts.client.ts',
    'tests/e2e/global-setup.ts',
    'tests/e2e/playwright.config.ts',
    'apps/web/src/server/gateway.ts',
  ].map((file) => path.join(ROOT, file));
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify(files)],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  for (const [file, typed] of Object.entries(JSON.parse(result.stdout))) {
    assert.deepEqual(typed, { disk: true, edited: false }, path.relative(ROOT, file));
  }
});

test('nest-common: only the client file may mint; jose signers by any import form', () => {
  lintMarked('packages/nest-common', {
    [`src/${TAG}/mint.ts`]: lines(
      "import type { InternalTokenService } from '../http/internal-http-client';",
      "export const mint = (tokens: InternalTokenService) => tokens.issue('a', 'b'); // ✗ issuance",
    ),
    // r2, review F2: every signing subpath, namespace aliases, computed members.
    [`src/${TAG}/subpaths.ts`]: lines(
      "import { SignJWT } from 'jose/jwt/sign';",
      "import { CompactSign } from 'jose/jws/compact/sign';",
      "import { FlattenedSign } from 'jose/jws/flattened/sign';",
      "import { GeneralSign } from 'jose/jws/general/sign';",
      'export const jwt = () => new SignJWT({}); // ✗ signer',
      'export const compact = () => new CompactSign(new Uint8Array()); // ✗ signer',
      'export const flattened = () => new FlattenedSign(new Uint8Array()); // ✗ signer',
      'export const general = () => new GeneralSign(new Uint8Array()); // ✗ signer',
    ),
    [`src/${TAG}/namespace.ts`]: lines(
      "import * as j from 'jose';",
      'const other = j; // ✗ signer',
      'export const viaAlias = () => new other.SignJWT({}); // ✗ signer',
      "export const computed = () => new j['Sign' + 'JWT']({}); // ✗ signer",
      'export const member = () => new j.SignJWT({}); // ✗ signer',
      'export const passed = () => Reflect.get(j, String(1)); // ✗ signer',
      'export const { SignJWT: Renamed } = j; // ✗ signer',
      'export const fine = j.decodeJwt;',
    ),
    [`src/${TAG}/reexport.ts`]: "export { SignJWT } from 'jose'; // ✗ signer\n",
  });
});

test('apps/web: its own config carries the rule, on every extension it lints', () => {
  lintMarked('apps/web', {
    ...extensionFixtures(`src/${TAG}`),
    [`src/${TAG}/header.tsx`]:
      "export const send = (token: string) => fetch('/x', { headers: { 'X-Internal-Token': token } }); // ✗ header\n",
    [`src/${TAG}/loader.mjs`]: 'export const go = (name) => import(name); // ✗ unresolved\n',
    [`src/${TAG}/factory.spec.ts`]:
      "export const factory = (token: string) => ({ 'x-internal-token': token });\n",
  });
});

test('tests/e2e: src, root files and the named exceptions', () => {
  lintMarked('tests/e2e', {
    [`src/${TAG}.ts`]:
      "export const send = (token: string) => fetch('/x', { headers: { 'x-internal-token': token } }); // ✗ header\n",
    [`${TAG}.mjs`]:
      "export const send = (token) => fetch('/x', { headers: { 'x-internal-token': token } }); // ✗ header\n",
  });

  for (const file of ['global-setup.ts', 'playwright.config.ts']) {
    const text = `${fs.readFileSync(path.join(ROOT, 'tests/e2e', file), 'utf8')}\nexport const leak = (token: string) => new Headers([['x-internal-token', token]]);\n`;
    const byFile = lintFixtures('tests/e2e', {}, { stdin: { file, text } });
    assert.deepEqual(
      boundary(byFile.get(file), file).map((message) => message.messageId),
      ['header'],
    );
  }

  // Each exception is one function: the same construct anywhere else in the
  // same file is refused.
  const cases = [
    [
      'src/http.ts',
      "export const other = (token: string) => ({ 'x-internal-token': token });",
      'header',
    ],
    ['src/internal.ts', 'export const other = () => new SignJWT({});', 'signer'],
    ['src/env.ts', "export const other = () => process.env['INTERNAL_TOKEN_SECRET'];", 'signer'],
  ];
  for (const [file, widening, messageId] of cases) {
    const original = fs.readFileSync(path.join(ROOT, 'tests/e2e', file), 'utf8');
    const clean = lintFixtures('tests/e2e', {}, { stdin: { file, text: original } });
    assert.deepEqual(boundary(clean.get(file), file), [], `${file} as it is must pass`);
    const widened = lintFixtures(
      'tests/e2e',
      {},
      { stdin: { file, text: `${original}\n${widening}\n` } },
    );
    assert.deepEqual(
      boundary(widened.get(file), file).map((message) => message.messageId),
      [messageId],
      `${file}: ${widening}`,
    );
  }
});

test('packages/testing: the test signer is allowed in mintTestInternalToken only', () => {
  const file = 'src/internal-token.ts';
  const original = fs.readFileSync(path.join(ROOT, 'packages/testing', file), 'utf8');
  const clean = lintFixtures('packages/testing', {}, { stdin: { file, text: original } });
  assert.deepEqual(boundary(clean.get(file), file), [], `${file} as it is must pass`);
  const widened = `${original}\nexport const other = () => new SignJWT({});\n`;
  const byFile = lintFixtures('packages/testing', {}, { stdin: { file, text: widened } });
  assert.deepEqual(
    boundary(byFile.get(file), file).map((message) => message.messageId),
    ['signer'],
  );
});

test('root scripts (test-only): issuance, header and secret refused; loaders left to run time', () => {
  lintMarked('.', {
    [`scripts/${TAG}.mjs`]: lines(
      "import { InternalTokenService } from '@rasta/nest-common';",
      "export const go = async (t, name) => [t.issue('a', 'b'), await import(name), InternalTokenService]; // ✗ unresolved",
      "const NAME = 'x-internal-' + 'token';",
      'export const send = (token) => fetch(`/x`, { headers: { [`${NAME}`]: token } }); // ✗ header',
      "export const secret = () => process.env['INTERNAL_TOKEN_' + 'SECRET']; // ✗ signer",
      "export const signer = async () => new (await import('jose')).SignJWT({}); // ✗ signer",
    ),
  });
});

// ---------------------------------------------------------------------------
// #503 r2 F4: privileged files are exact repository paths, never suffixes.
// Each shadow below is an ordinary file whose path ENDS like a privileged one
// (the client exemption or one of the six function allowances) and does what
// only the privileged file may; each must be refused, by the full config.

const SHADOW = 'src/packages/nest-common/src/http/internal-http-client.ts';
const SHADOWS = {
  // The client exemption (CLIENT_FILE): the review's example, verbatim…
  [SHADOW]: lines(
    'export const key = process.env.INTERNAL_TOKEN_SECRET; // ✗ signer',
    "export const headers = { 'x-internal-token': 'chosen' }; // ✗ header",
    // …and the issuer's own allowances: a shadow InternalTokenService is no
    // issuer, so neither its DI factory nor the secret as its argument is.
    'export class InternalTokenService {',
    '  constructor(readonly secret: string) {}',
    '  issue(): string { return this.secret; }',
    '}',
  ),
  [`${S}/shadow-issuer-user.ts`]: lines(
    "import { InternalTokenService } from '../packages/nest-common/src/http/internal-http-client';",
    'export const tokens = (env: { INTERNAL_TOKEN_SECRET: string }) =>',
    '  new InternalTokenService(env.INTERNAL_TOKEN_SECRET); // ✗ signer',
  ),
  // The six function allowances (eslint.config.mjs), each in its function.
  'src/tests/e2e/src/http.ts': lines(
    'export function send(token: string) {',
    "  return fetch('/x', { headers: { 'x-internal-token': token } }); // ✗ header",
    '}',
  ),
  'src/tests/e2e/src/internal.ts': lines(
    "import { SignJWT } from 'jose';",
    'export function mintInternalToken() {',
    '  return new SignJWT({}); // ✗ signer',
    '}',
  ),
  'src/tests/e2e/src/env.ts': lines(
    'export function e2eConfig() {',
    '  return process.env.INTERNAL_TOKEN_SECRET; // ✗ signer',
    '}',
  ),
  'src/packages/testing/src/internal-token.ts': lines(
    "import { SignJWT } from 'jose';",
    'export function mintTestInternalToken() {',
    '  return new SignJWT({}); // ✗ signer',
    '}',
  ),
  'src/scripts/internal-token-source-rule.mjs': lines(
    'export function secretName() {',
    "  return 'INTERNAL_TOKEN_SECRET'; // ✗ signer",
    '}',
  ),
  'src/scripts/internal-token-transport-rule.mjs': lines(
    'export function credentialNames() {',
    "  return ['x-internal-token', 'authorization']; // ✗ header",
    '}',
  ),
};

test('review F4: a file whose path only ends like a privileged one is ordinary production code', async () => {
  // Every privileged path has its shadow here (`src/<path>`), so a new
  // allowance needs one.
  const { INTERNAL_TOKEN_SOURCE } = await import(path.join(ROOT, 'eslint.config.mjs'));
  const allow = INTERNAL_TOKEN_SOURCE.flatMap((block) => block.rules?.[RULE]?.[1]?.allow ?? []);
  assert.equal(allow.length, 6, 'the allow-list was read');
  assert.deepEqual(
    [CLIENT_FILE, ...allow.map((allowance) => allowance.file)].filter(
      (file) => !(`src/${file}` in SHADOWS),
    ),
    [],
    'a privileged path without a shadow fixture',
  );
  lintMarked('services/economic-service', SHADOWS);
  // The portal's own config: no allowances, but the client exemption.
  lintMarked('apps/web', {
    [SHADOW]: "export const headers = { 'x-internal-token': 'chosen' }; // ✗ header\n",
  });
});

test('review F4: the genuine privileged files keep their privilege, under their canonical path', () => {
  assert.equal(repoPath(path.join(ROOT, CLIENT_FILE)), CLIENT_FILE);
  assert.equal(
    repoPath(path.join(ROOT, 'packages/nest-common/src/http/../http/internal-http-client.ts')),
    CLIENT_FILE,
  );
  assert.equal(repoPath(path.join(ROOT, 'services/economic-service', SHADOW)), null, 'not on disk');
  assert.equal(repoPath(path.join(os.tmpdir(), CLIENT_FILE)), null, 'outside the repository');
  // A link is its target: a link named like the client to another file is
  // that file; a link elsewhere to the client is the client's own bytes.
  const dir = fs.mkdtempSync(path.join(ROOT, `services/economic-service/src/${TAG}-link-`));
  try {
    fs.writeFileSync(path.join(dir, 'other.ts'), 'export {};\n');
    fs.mkdirSync(path.join(dir, 'packages/nest-common/src/http'), { recursive: true });
    fs.symlinkSync(
      path.join(dir, 'other.ts'),
      path.join(dir, 'packages/nest-common/src/http/internal-http-client.ts'),
    );
    fs.symlinkSync(path.join(ROOT, CLIENT_FILE), path.join(dir, 'client-link.ts'));
    assert.equal(
      repoPath(path.join(dir, 'packages/nest-common/src/http/internal-http-client.ts')),
      path.relative(ROOT, path.join(dir, 'other.ts')).split(path.sep).join('/'),
    );
    assert.equal(repoPath(path.join(dir, 'client-link.ts')), CLIENT_FILE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The genuine client and each allowance, as they are, still pass.
  const byFile = lintFixtures(
    'packages/nest-common',
    {},
    {
      stdin: {
        file: 'src/http/internal-http-client.ts',
        text: fs.readFileSync(path.join(ROOT, CLIENT_FILE), 'utf8'),
      },
    },
  );
  assert.deepEqual(boundary(byFile.get('src/http/internal-http-client.ts'), CLIENT_FILE), []);
});

// ---------------------------------------------------------------------------
// D-088: the two capability extractions closed in production (the rest of the
// class is the documented residual, docs/internal-token-transport-scope.md).

test('D-088: process.getBuiltinModule(module) and a constructor read on a function value are refused in production', () => {
  lintMarked('services/economic-service', {
    [`${S}/d088.ts`]: lines(
      "import process from 'node:process';",
      "import { getBuiltinModule } from 'node:process'; // ✗ unresolved",
      'export const viaImport = getBuiltinModule;',
      "const name = 'createRequire';",
      "const load = process.getBuiltinModule('module')[name](__filename); // ✗ unresolved",
      "export const signer = () => load('jose');",
      "export const prefixed = () => process.getBuiltinModule('node:module'); // ✗ unresolved",
      "export const vm = () => process.getBuiltinModule('vm'); // ✗ unresolved",
      'export const named = (which: string) => process.getBuiltinModule(which); // ✗ unresolved',
      'export const kept = process.getBuiltinModule; // ✗ unresolved',
      'export const { getBuiltinModule: picked } = process; // ✗ unresolved',
      "export const fs = process.getBuiltinModule('node:fs');",
      "export const run = () => (function () {})['constructor']('return 123')(); // ✗ unresolved",
      "export const folded = () => (() => 0)['constr' + 'uctor']; // ✗ unresolved",
      'const C = (function () {}).constructor; // ✗ unresolved',
      "export const other = () => C('return 123')();",
      'export const asyncCtor = (async function () {}).constructor; // ✗ unresolved',
      'export const { constructor: D } = function* () {}; // ✗ unresolved',
      'export const ofClass = class {}.constructor; // ✗ unresolved',
      'export const fine = [new Date().constructor, ({}).constructor.name];',
    ),
    // Without types, the computed read and a literal function's are refused.
    [`${S}/d088.mjs`]: lines(
      "export const run = () => (function () {})['constructor']('return 123')(); // ✗ unresolved",
      'export const dot = (async () => 0).constructor; // ✗ unresolved',
      "export const load = () => process.getBuiltinModule('module'); // ✗ unresolved",
      'class InternalTokenService { constructor(secret) { this.secret = secret; } }',
      'export const t = new InternalTokenService(process.env.INTERNAL_TOKEN_SECRET); // ✗ signer',
    ),
    // Test-only code (an e2e/ tree; the rule is on there) is answered by the
    // run-time boundary, as for loaders.
    [`${S}/e2e/d088.ts`]: "export const run = () => (function () {})['constructor'];\n",
  });
});

// ---------------------------------------------------------------------------
// Every workspace with a lint script, every extension, every path it lints.

function lintWorkspaces() {
  const workspaces = [];
  // Membership is pnpm-workspace.yaml's (fails closed), not a list of four roots.
  for (const workspace of workspaceDirectories(ROOT)) {
    const manifest = path.join(ROOT, workspace, 'package.json');
    const lint = JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts?.lint;
    if (lint) workspaces.push({ workspace, lint });
  }
  return workspaces;
}

/** For each path (relative to `cwd`): null if ESLint lints nothing there, else the rule's level. */
function effectiveLevels(cwd, samples) {
  const script = `
    const { ESLint } = await import(${JSON.stringify(path.join(ROOT, 'node_modules/eslint/lib/api.js'))});
    const eslint = new ESLint({ cwd: process.cwd() });
    const out = {};
    for (const sample of JSON.parse(process.argv[1])) {
      const config = (await eslint.isPathIgnored(sample)) ? undefined : await eslint.calculateConfigForFile(sample);
      out[sample] = config ? {
        level: config.rules?.['${RULE}']?.[0] ?? 0,
        parser: config.languageOptions?.parser?.meta?.name,
      } : null;
    }
    process.stdout.write(JSON.stringify(out));`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify(samples)],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, `${cwd}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** The paths a workspace's `eslint <paths>` script names. */
function lintTargets(workspace, lint) {
  const match = /^eslint((?:\s+[^\s-][^\s]*)+)\s*$/.exec(lint);
  assert.ok(match, `${workspace}: lint script "${lint}" is not "eslint <paths>"`);
  return match[1].trim().split(/\s+/);
}

test('structural: the rule is on for every lintable file of every workspace lint script', () => {
  const workspaces = lintWorkspaces();
  assert.ok(workspaces.length >= 26, `found ${workspaces.length} lint workspaces`);
  for (const { workspace, lint } of workspaces) {
    const samples = [];
    for (const target of lintTargets(workspace, lint)) {
      if (/\.[cm]?[jt]sx?$/.test(target)) samples.push(target);
      else for (const extension of EXTENSIONS) samples.push(`${target}/${TAG}.${extension}`);
    }
    if (workspace === 'tests/e2e')
      samples.push('global-setup.ts', 'playwright.config.ts', 'src/actor.ts', 'src/http.ts');
    for (const [sample, config] of Object.entries(
      effectiveLevels(path.join(ROOT, workspace), samples),
    )) {
      assert.ok(config, `${workspace}/${sample} is not linted at all`);
      // Test token factories (test/ trees, specs) are the one exemption.
      const exempt = /(^|\/)test\//.test(sample);
      assert.equal(config.level, exempt ? 0 : 2, `${workspace}/${sample}: ${RULE} level`);
      assert.equal(
        config.parser,
        'internal-token-typed-or-untyped-parser',
        `${workspace}/${sample}`,
      );
    }
  }
});

/**
 * What the rule, run without types, cannot resolve in the portal's build scripts (PR #420
 * r9, R8-1), each reviewed: a `Reflect.get` forwarding Next's configuration module (no token,
 * no secret) and the coverage checker's two imports of test-only helpers (which the source
 * sweep refuses to any production file). Exact `file:line ruleId messageId: message` reports,
 * each allowing ONE report, and only while that line is still the reviewed source (the scripts
 * are byte-frozen, but no other check here pins them): anything else in those files, an edited
 * or moved line, or any other file in `apps/web/scripts` is held to the rule like every other
 * file no lint script reaches.
 */
const UNTYPED =
  'without type information through TypeScript types; the boundary fails closed. Keep this in a type-checked file or remove it.';
const REVIEWED_UNRESOLVED = [
  {
    report: `apps/web/scripts/capture-next-config.cjs:253 ${RULE} unresolved: internal-token source: cannot resolve \`Reflect\` in a file ${UNTYPED}`,
    source: "key === 'default' ? recording : Reflect.get(target, key, receiver),",
  },
  {
    report: `apps/web/scripts/check-server-action-coverage.mjs:40 ${RULE} unresolved: internal-token source: cannot resolve '../src/test/server-action-discovery.ts' from a file ${UNTYPED}`,
    source: "import('../src/test/server-action-discovery.ts'),",
  },
  {
    report: `apps/web/scripts/check-server-action-coverage.mjs:41 ${RULE} unresolved: internal-token source: cannot resolve '../src/test/server-action-manifest.ts' from a file ${UNTYPED}`,
    source: "import('../src/test/server-action-manifest.ts'),",
  },
];

/**
 * The reports `REVIEWED_UNRESOLVED` does not account for: an allowance applies only while its
 * line reads as reviewed, and to one report.
 */
function unreviewed(reports, read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')) {
  const left = REVIEWED_UNRESOLVED.filter(({ report, source }) => {
    const [, file, line] = /^(\S+?):(\d+) /.exec(report);
    return sourceLines(read(file))[line - 1]?.trim() === source;
  }).map(({ report }) => report);
  return reports.filter((report) => {
    const at = left.indexOf(report);
    if (at < 0) return true;
    left.splice(at, 1);
    return false;
  });
}

/**
 * Every tracked JS/TS file, classified by ESLint itself (ignores and configs
 * as each lint script sees them): linted with the rule on, linted with it off,
 * or reached by no lint script.
 */
function coverage(tracked = trackedFiles(ROOT).filter((file) => /\.[cm]?[jt]sx?$/.test(file))) {
  const owners = [{ workspace: '.', targets: ['scripts'] }];
  for (const { workspace, lint } of lintWorkspaces())
    owners.push({ workspace, targets: lintTargets(workspace, lint) });
  const on = new Set();
  const off = new Set();
  for (const { workspace, targets } of owners) {
    const prefix = workspace === '.' ? '' : `${workspace}/`;
    const reached = tracked
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length))
      .filter((file) =>
        targets.some(
          (target) => target === '.' || file === target || file.startsWith(`${target}/`),
        ),
      );
    if (reached.length === 0) continue;
    for (const [file, config] of Object.entries(
      effectiveLevels(path.join(ROOT, workspace), reached),
    )) {
      if (config) (config.level === 2 ? on : off).add(prefix + file);
    }
  }
  const unlinted = tracked.filter((file) => !on.has(file) && !off.has(file));
  return { tracked, on, off, unlinted };
}

test('coverage: the exemptions are test-only code, and the rest is held to the rule', async () => {
  const { tracked, on, off, unlinted } = coverage();
  // At #503 r2: 1435 on, the rest exempt (specs, test trees) or unreached.
  assert.ok(on.size > 1200, `only ${on.size} files linted with the rule`);
  assert.ok(
    unlinted.includes('eslint.config.mjs'),
    'root config files are reached by no lint script',
  );

  // Review F4: an exempt file must not be importable from production. Every
  // one is test-only (scripts/test-only-path.mjs), and the source sweep
  // (scripts/testing-dev-only-source.mjs) refuses any production import of a
  // test-only file.
  assert.deepEqual(
    [...off].filter((file) => !isTestOnlyPath(file)),
    [],
    'a file exempt from the rule that production code could import',
  );
  // …and every function the rule's allow-list names is test-only too, or a
  // lint rule in root tooling (scripts/) that only names what it checks.
  const { INTERNAL_TOKEN_SOURCE } = await import(path.join(ROOT, 'eslint.config.mjs'));
  const allow = INTERNAL_TOKEN_SOURCE.flatMap((block) => block.rules?.[RULE]?.[1]?.allow ?? []);
  assert.ok(allow.length >= 6, 'the allow-list was read');
  for (const { file } of allow) {
    assert.ok(tracked.includes(file), `${file} is allowed but does not exist`);
    assert.ok(
      isTestOnlyPath(file) || /^scripts\/[\w-]+-rule\.mjs$/.test(file),
      `${file}: an allowance in production code`,
    );
  }

  // Files no lint script reaches (root config files, anything an ignore pattern removes, the
  // portal's build scripts) are linted here with the rule itself, without types: fail closed,
  // not a spelling scan. Only the reviewed reports pass, and each must still be there.
  const reports = untypedReports(unlinted);
  assert.deepEqual(
    REVIEWED_UNRESOLVED.filter(({ report }) => !reports.includes(report)),
    [],
    'a reviewed allowance no longer matches: remove it, or review the change',
  );
  assert.deepEqual(unreviewed(reports), [], 'move this into a linted path or remove it');
});

/**
 * The rule's reports (and parse failures) on `files`, linted without types, ignores and inline
 * configuration off: `file:line ruleId messageId: message`.
 */
function untypedReports(files) {
  const script = `
    const { ESLint } = await import(${JSON.stringify(path.join(ROOT, 'node_modules/eslint/lib/api.js'))});
    const tseslint = (await import(${JSON.stringify(path.join(ROOT, 'node_modules/typescript-eslint/dist/index.js'))})).default;
    const rule = (await import(${JSON.stringify(path.join(ROOT, 'scripts/internal-token-source-rule.mjs'))})).default;
    const eslint = new ESLint({
      cwd: ${JSON.stringify(ROOT)},
      overrideConfigFile: true,
      ignore: false,
      overrideConfig: [{
        files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
        languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
        plugins: { internal: { rules: { 'token-source': rule } } },
        rules: { '${RULE}': 'error' },
      }],
    });
    const results = await eslint.lintFiles(JSON.parse(process.argv[1]));
    process.stdout.write(JSON.stringify(results.flatMap((r) => r.messages.filter((m) => m.ruleId === '${RULE}' || m.fatal).map((m) =>
      r.filePath.slice(${JSON.stringify(ROOT)}.length) + ':' + m.line + ' ' + (m.ruleId ?? 'fatal') + ' ' + m.messageId + ': ' + m.message))));`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify(files)],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('review F4: production importing an exempt helper is refused by the source sweep', (t) => {
  // The review's example: a test file exports a minting helper; the rule is
  // off there, and a production caller keeps the type, so the call passes the
  // rule. The import itself is what is refused.
  const files = {
    [`${S}/mint.test.ts`]: `${ISSUER}export const mintVia = (t: InternalTokenService) => t.issue('a', 'b');\n`,
    [`${S}/use.ts`]:
      `${ISSUER}import { mintVia } from './mint.test';\n` +
      'export const go = (t: InternalTokenService) => mintVia(t);\n',
  };
  lintMarked('services/economic-service', files);
  // The same two files in a service of a repository in miniature, swept by
  // scripts/testing-dev-only-source.mjs as CI sweeps this one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-source-f4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = path.join(root, 'services/svc');
  fs.mkdirSync(path.join(service, S), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"root","private":true}');
  fs.writeFileSync(path.join(service, 'package.json'), '{"name":"@rasta/svc"}');
  fs.writeFileSync(
    path.join(service, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'commonjs', moduleResolution: 'node', noEmit: true },
      include: ['src/**/*'],
      exclude: ['**/*.spec.ts', '**/*.test.ts'],
    }),
  );
  for (const [file, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(service, file), text.replace(ISSUER, ''));
  }
  const { problems } = sourceProblems(root);
  assert.deepEqual(problems, [
    `services/svc/${S}/use.ts:1 ./mint.test reaches test-only services/svc/${S}/mint.test.ts`,
  ]);
});

test('R8-1: a build-script helper a production page imports is held to the rule', (t) => {
  // The review's mutants: helpers in apps/web/scripts that build an internal-token header or
  // read the secret, imported by a portal page (which R8-1 found passes the portal's own lint:
  // the helpers' code is not its own). The helpers are reached by no lint script, so coverage
  // lints them with the rule wherever they sit, and neither report is a reviewed one.
  // Every fixture path is under a per-run name, so a real apps/web/scripts/nested (or any other
  // real file) is neither a collision nor something the cleanup can delete.
  const header = `apps/web/scripts/${TAG}-header.mjs`;
  const secret = `apps/web/scripts/${TAG}-nested/secret.mjs`;
  const page = `apps/web/src/app/${TAG}/page.tsx`;
  const files = {
    [header]: "export const makeHeaders = (token) => ({ 'x-internal-token': token });\n",
    [secret]: 'export const secret = () => process.env.INTERNAL_TOKEN_SECRET;\n',
    [page]:
      `import { makeHeaders } from '../../../scripts/${TAG}-header.mjs';\n` +
      `import { secret } from '../../../scripts/${TAG}-nested/secret.mjs';\n` +
      'export default function Page() { return String(makeHeaders(secret())); }\n',
  };
  t.after(placeFixtures(ROOT, files));
  const { on, unlinted } = coverage(Object.keys(files));
  assert.ok(on.has(page), 'the page is linted by the portal, with the rule on');
  assert.deepEqual(unlinted, [header, secret]);
  const problems = unreviewed(untypedReports(unlinted));
  assert.ok(
    problems.some((report) => report.startsWith(`${header}:1 ${RULE} header: `)),
    `the header helper must fail: ${problems}`,
  );
  assert.ok(
    problems.some((report) => report.startsWith(`${secret}:1 ${RULE} signer: `)),
    `the secret helper must fail: ${problems}`,
  );
});

test('R8-1: a reviewed allowance is one exact report on its reviewed line, used once', () => {
  const [{ report: reviewed }] = REVIEWED_UNRESOLVED;
  assert.deepEqual(unreviewed([reviewed]), []);
  // The same report from an edited line (a `Reflect.apply` of a signer, say) is not reviewed.
  const edited = (file) =>
    fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .replace('Reflect.get(target, key, receiver)', 'Reflect.apply(sign, target, [key])');
  assert.deepEqual(unreviewed([reviewed], edited), [reviewed]);
  // Twice on the same line, the same text on another line, or another report on that line.
  assert.deepEqual(unreviewed([reviewed, reviewed]), [reviewed]);
  const moved = reviewed.replace(':253 ', ':254 ');
  const header = reviewed.replace(/ unresolved: .*/, ' header: internal-token header');
  assert.deepEqual(unreviewed([moved, header]), [moved, header]);
});

test('reviewed source lines use ECMAScript boundaries for every allowance', () => {
  for (const { report, source } of REVIEWED_UNRESOLVED) {
    for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
      const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.deepEqual(
        unreviewed([report], (file) => read(file).replaceAll('\n', newline)),
        [],
      );
      const shifted = (file) =>
        read(file)
          .replace(/\n(?=[^\r\n])/, newline)
          .replace(source, `unreviewed();\n${source}`);
      assert.deepEqual(unreviewed([report], shifted), [report]);
    }
  }
});

test('lint:scripts runs this file on its own, after every other script test', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const steps = scripts['lint:scripts'].split('&&').map((step) => step.trim());
  assert.equal(steps.at(-1), 'node --test scripts/internal-token-source-workspace.test.mjs');
  assert.ok(
    steps.slice(0, -1).every((step) => !step.includes('internal-token-source-workspace')),
    'and in no concurrent step',
  );
});

test('token directive coverage refuses multiline comments on verbatim Git paths', () => {
  for (const file of ['scripts/café.mjs', 'scripts/line\nbreak.mjs']) {
    for (const newline of ['\n', '\r\n', '\r']) {
      const text = `/* ${'eslint'}-disable no-console,${newline} internal/token-source */`;
      assert.equal(transportDirectives([file], () => text).length, 1);
    }
    assert.deepEqual(
      transportDirectives(
        [file],
        () => `const text = "// ${'eslint'}-disable internal/token-source";`,
      ),
      [],
    );
  }
});

test('coverage: no inline directive switches the rule off outside test-only code', () => {
  const tracked = trackedFiles(ROOT).filter(
    (file) => /\.[cm]?[jt]sx?$/.test(file) && !isTestOnlyPath(file),
  );
  const offending = transportDirectives(tracked, (file) =>
    fs.readFileSync(path.join(ROOT, file), 'utf8'),
  );
  assert.ok(tracked.length > 1000, `only ${tracked.length} production files scanned`);
  assert.deepEqual(offending, []);
});

test(
  "each workspace's own lint script refuses a fixture",
  { skip: process.env.INTERNAL_TOKEN_LINT_SCRIPTS !== '1' && 'set INTERNAL_TOKEN_LINT_SCRIPTS=1' },
  () => {
    const placed = [];
    const removals = [];
    const reports = fs.mkdtempSync(path.join(os.tmpdir(), `${TAG}-reports-`));
    try {
      for (const { workspace, lint } of lintWorkspaces()) {
        const target = lint.trim().split(/\s+/)[1] === '.' ? '.' : 'src';
        const relative = `${target}/${TAG}.ts`;
        removals.push(
          placeFixtures(path.join(ROOT, workspace), {
            [relative]:
              "export const send = (token: string) => fetch('/x', { headers: { 'x-internal-token': token } });\n",
          }),
        );
        placed.push({ workspace, file: path.join(ROOT, workspace, relative) });
      }
      for (const { workspace, file } of placed) {
        const report = path.join(reports, `${workspace.replace('/', '-')}.json`);
        const result = spawnSync('pnpm', ['run', 'lint', '--format', 'json', '-o', report], {
          cwd: path.join(ROOT, workspace),
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
        });
        assert.equal(result.status, 1, `${workspace}: its lint script must fail`);
        const json = fs.readFileSync(report, 'utf8');
        fs.rmSync(report, { force: true });
        const entry = JSON.parse(json).find((candidate) => candidate.filePath === file);
        assert.ok(
          entry?.messages.some(
            (message) => message.ruleId === RULE && message.messageId === 'header',
          ),
          `${workspace}: the fixture must fail on ${RULE}`,
        );
        const others = JSON.parse(json).filter(
          (candidate) => candidate.filePath !== file && candidate.errorCount > 0,
        );
        assert.deepEqual(
          others.map((candidate) => candidate.filePath),
          [],
          `${workspace}: nothing else fails`,
        );
      }
    } finally {
      for (const remove of removals) remove();
      fs.rmSync(reports, { recursive: true, force: true });
    }
  },
);

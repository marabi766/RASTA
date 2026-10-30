import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestOnlyPath } from './test-only-path.mjs';
import { sourceProblems } from './testing-dev-only-source.mjs';

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

/** Writes `files` (workspace-relative path → text), lints them, removes them. */
function lintFixtures(workspace, files, { stdin } = {}) {
  const cwd = path.join(ROOT, workspace);
  const written = [];
  const directories = new Set();
  try {
    for (const [relative, text] of Object.entries(files)) {
      const absolute = path.join(cwd, relative);
      assert.ok(!fs.existsSync(absolute), `fixture would overwrite ${workspace}/${relative}`);
      for (let dir = path.dirname(absolute); !fs.existsSync(dir); dir = path.dirname(dir)) {
        directories.add(dir);
      }
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, text);
      written.push(absolute);
    }
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
    for (const file of written) fs.rmSync(file, { force: true });
    for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
  text.split('\n').forEach((line, index) => {
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
        `${file}:${line} must report ${id}, got [${actual.get(line) ?? []}]: ${text.split('\n')[line - 1]}`,
      );
    }
  }
  for (const [line, ids] of actual) {
    assert.ok(
      expected.has(line),
      `${file}:${line} reports [${ids}] on an unmarked line: ${text.split('\n')[line - 1]}`,
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
  const last = text.trimEnd().split('\n').length;
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
// Every workspace with a lint script, every extension, every path it lints.

function lintWorkspaces() {
  const workspaces = [];
  for (const group of ['apps', 'packages', 'services', 'tests']) {
    for (const name of fs.readdirSync(path.join(ROOT, group))) {
      const manifest = path.join(ROOT, group, name, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const lint = JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts?.lint;
      if (lint) workspaces.push({ workspace: `${group}/${name}`, lint });
    }
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
 * Every tracked JS/TS file, classified by ESLint itself (ignores and configs
 * as each lint script sees them): linted with the rule on, linted with it off,
 * or reached by no lint script.
 */
function coverage() {
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file));
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

  // Files no lint script reaches (root config files, anything an
  // ignore pattern removes) are linted here with the rule itself, without
  // types: fail closed, not a spelling scan.
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
      r.filePath.slice(${JSON.stringify(ROOT)}.length) + ':' + m.line + ' ' + (m.ruleId ?? 'fatal') + ' ' + m.message))));`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify(unlinted)],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [], 'move this into a linted path or remove it');
});

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

test('lint:scripts runs this file on its own, after every other script test', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const steps = scripts['lint:scripts'].split('&&').map((step) => step.trim());
  assert.equal(steps.at(-1), 'node --test scripts/internal-token-source-workspace.test.mjs');
  assert.ok(
    steps.slice(0, -1).every((step) => !step.includes('internal-token-source-workspace')),
    'and in no concurrent step',
  );
});

test('coverage: no inline directive switches the rule off outside test-only code', () => {
  // A directive is a comment that starts with one of ESLint's fixed keywords;
  // a blanket `eslint-disable` (no rule list) switches every rule off.
  const DIRECTIVE =
    /\/[/*]\s*(eslint-disable(?:-next-line|-line)?|eslint-enable|eslint)(?=\s|\*\/|$)([^\n]*?)(?:\*\/|$)/gm;
  const offending = [];
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !isTestOnlyPath(file));
  for (const file of tracked) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [, keyword, rest] of text.matchAll(DIRECTIVE)) {
      const rules = rest.split('--')[0].trim();
      const blanket = keyword.startsWith('eslint-disable') && rules === '';
      if (blanket || /internal\//.test(rules)) offending.push(`${file}: ${keyword} ${rules}`);
    }
  }
  assert.ok(tracked.length > 1000, `only ${tracked.length} production files scanned`);
  assert.deepEqual(offending, []);
});

test(
  "each workspace's own lint script refuses a fixture",
  { skip: process.env.INTERNAL_TOKEN_LINT_SCRIPTS !== '1' && 'set INTERNAL_TOKEN_LINT_SCRIPTS=1' },
  () => {
    const placed = [];
    try {
      for (const { workspace, lint } of lintWorkspaces()) {
        const target = lint.trim().split(/\s+/)[1] === '.' ? '.' : 'src';
        const file = path.join(ROOT, workspace, target, `${TAG}.ts`);
        fs.writeFileSync(
          file,
          "export const send = (token: string) => fetch('/x', { headers: { 'x-internal-token': token } });\n",
        );
        placed.push({ workspace, file });
      }
      for (const { workspace, file } of placed) {
        const report = path.join(os.tmpdir(), `${TAG}-${workspace.replace('/', '-')}.json`);
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
      for (const { file } of placed) fs.rmSync(file, { force: true });
    }
  },
);

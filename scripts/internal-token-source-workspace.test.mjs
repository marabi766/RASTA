import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The internal-token source boundary in real workspaces (PR #423 follow-up 1).
 *
 * Every fixture is a real file written into a real workspace and linted by the
 * real ESLint binary from that workspace's directory, with its own config and
 * TypeScript project — never a bare `Linter`. A fixture expected to fail must
 * fail with the intended `internal/token-source` message, and no fixture may
 * fail on a parser error instead. Fixture files are removed afterwards.
 *
 * `structural` holds every workspace with a `lint` script to the rule at
 * every extension ESLint lints and every path its script names.
 * INTERNAL_TOKEN_LINT_SCRIPTS=1 additionally runs each workspace's own `lint`
 * script over a fixture (a full lint of the repository; not part of CI).
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ESLINT = path.join(ROOT, 'node_modules/eslint/bin/eslint.js');
const RULE = 'internal/token-source';
const TAG = `__token_source_${process.pid}__`;
const EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];

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

function expectReported(byFile, file, expected) {
  const found = boundary(byFile.get(file), file).map((message) => message.messageId);
  for (const messageId of expected) {
    assert.ok(found.includes(messageId), `${file}: expected ${messageId}, got [${found}]`);
  }
}

function expectClean(byFile, file) {
  const found = boundary(byFile.get(file), file);
  assert.deepEqual(
    found.map((message) => `${message.line}: ${message.message}`),
    [],
    `${file} must pass`,
  );
}

// ---------------------------------------------------------------------------
// Fixtures for a NestJS service (economic-service: @rasta/nest-common, a test
// project that covers src/test/dev/seed).

const ISSUER = "import { InternalTokenService } from '@rasta/nest-common';\n";
const S = `src/${TAG}`;

const SERVICE_FIXTURES = {
  // 1. Headers/constants built in another file.
  [`${S}/e1-header-module.ts`]:
    `${ISSUER}export const INTERNAL = 'X-Internal-Token' as const;\n` +
    'export const minted = (tokens: InternalTokenService) => tokens.issue("a", "b", "SERVICE");\n' +
    'export const internalHeaders = (token: string) => ({ [INTERNAL]: token });\n' +
    'export const tokens = new InternalTokenService("x".repeat(32), "rasta-internal", 60);\n',
  [`${S}/e1-sender.ts`]:
    "import { INTERNAL, tokens } from './e1-header-module';\n" +
    'export async function send(url: string) {\n' +
    '  const token = await tokens.issue("a", "b", "SERVICE");\n' +
    '  return fetch(url, { headers: { [INTERNAL]: token } });\n}\n',
  // 2. Constructor parameter transport.
  [`${S}/e2-constructor.ts`]:
    `${ISSUER}export class Sender {\n` +
    '  constructor(private readonly tokens: InternalTokenService, private readonly http: typeof fetch = fetch) {}\n' +
    '  async go(url: string) {\n' +
    '    const token = await this.tokens.issue("a", "b", "SERVICE");\n' +
    "    return this.http(url, { headers: { 'x-internal-token': token } });\n  }\n}\n",
  // 3. Class field transport alias.
  [`${S}/e3-field.ts`]:
    `${ISSUER}export class Sender {\n` +
    '  private readonly send = fetch;\n' +
    '  private readonly mint = this.tokens.issue;\n' +
    "  constructor(private readonly tokens: Pick<InternalTokenService, 'issue'>) {}\n" +
    '  async go(url: string) { return this.send(url, { headers: { "x-internal-token": await this.mint("a", "b") } }); }\n}\n',
  // 4. Destructured transport and destructured issuance.
  [`${S}/e4-destructured.ts`]:
    `${ISSUER}export async function go(tokens: InternalTokenService, url: string) {\n` +
    '  const { fetch: f } = globalThis;\n' +
    '  const { issue } = tokens;\n' +
    "  return f(url, { headers: [['X-Internal-Token', await issue('a', 'b')]] });\n}\n",
  // 5. bind/call/Reflect.apply/Reflect.get.
  [`${S}/e5-indirect.ts`]:
    `${ISSUER}export async function go(tokens: InternalTokenService) {\n` +
    '  const bound = tokens.issue.bind(tokens);\n' +
    '  const called = await tokens.issue.call(tokens, "a", "b");\n' +
    '  const applied = await Reflect.apply(tokens.issue, tokens, ["a", "b"]);\n' +
    '  const got = Reflect.get(tokens, "is" + "sue");\n' +
    '  return [bound, called, applied, got];\n}\n',
  // 6. require/dynamic import, with no transport import at all.
  [`${S}/e6-dynamic.ts`]:
    'export async function go(name: string, url: string, token: string) {\n' +
    '  // eslint-disable-next-line @typescript-eslint/no-require-imports\n' +
    "  const common = require('@rasta/nest-common');\n" +
    '  const transport = await import(name);\n' +
    "  return [common, transport.request(url, { headers: { 'x-internal-token': token } })];\n}\n",
  // 7. http2/got/ky/superagent/XHR: refused at issuance and at the header.
  [`${S}/e7-alternates.ts`]:
    `${ISSUER}import http2 from 'node:http2';\n` +
    'declare const got: (url: string, options: object) => unknown;\n' +
    'declare const ky: { get(url: string, options: object): unknown };\n' +
    'declare const superagent: { get(url: string): { set(name: string, value: string): unknown } };\n' +
    'declare const xhr: { setRequestHeader(name: string, value: string): void };\n' +
    'export async function go(tokens: InternalTokenService, url: string) {\n' +
    '  const token = await tokens.issue("a", "b", "SERVICE");\n' +
    "  http2.connect(url).request({ ':path': '/', 'x-internal-token': token });\n" +
    "  got(url, { headers: { 'X-INTERNAL-TOKEN': token } });\n" +
    "  ky.get(url, { headers: new Headers([['x-internal-token', token]]) });\n" +
    "  superagent.get(url).set('X-Internal-Token', token);\n" +
    "  xhr.setRequestHeader('x-internal-token', token);\n}\n",
  // 8. A local internalFetch / InternalHttpClient grants nothing.
  [`${S}/e8-fake-client.ts`]:
    `${ISSUER}async function internalFetch(url: string, init: RequestInit) { return fetch(url, init); }\n` +
    'export class InternalHttpClient {\n' +
    '  constructor(private readonly tokens: InternalTokenService) {}\n' +
    '  async go(url: string) {\n' +
    '    const token = await this.tokens.issue("a", "b", "SERVICE");\n' +
    "    return internalFetch(url, { headers: { 'x-internal-token': token } });\n  }\n}\n",
  // Fail closed: structural Pick, structural stand-in, any, computed key.
  [`${S}/f-structural.ts`]:
    `${ISSUER}type Minter = { issue(caller: string, target: string): Promise<string> };\n` +
    "export const viaPick = (tokens: Pick<InternalTokenService, 'issue'>) => tokens['issue']('a', 'b');\n" +
    'export const standIn = (tokens: InternalTokenService) => { const m: Minter = tokens; return m; };\n' +
    'export const erased = (tokens: InternalTokenService) => (tokens as unknown as { issue(): string }).issue();\n' +
    'export const keyed = (tokens: InternalTokenService, key: keyof InternalTokenService) => tokens[key];\n' +
    'export const dynamic = (tokens: InternalTokenService & Record<string, unknown>, key: string) => tokens[key];\n' +
    "export const untyped = (value: any) => value.issue('a', 'b');\n" +
    "export const fromText = () => [eval('1'), Function('return 1')(), new Function('return 1')()];\n",
  // A re-export is the same method.
  [`${S}/f-reexport.ts`]: "export { InternalTokenService as Minter } from '@rasta/nest-common';\n",
  [`${S}/f-reexport-user.ts`]:
    "import { Minter } from './f-reexport';\n" +
    'export const go = (minter: Minter) => minter.issue("a", "b");\n',
  // Signing an internal token by hand, or reading its secret.
  [`${S}/f-signer.ts`]:
    "import { SignJWT } from 'jose';\n" +
    'export const sign = (env: { INTERNAL_TOKEN_SECRET: string }) =>\n' +
    '  new SignJWT({ svc: "a" }).sign(new TextEncoder().encode(env.INTERNAL_TOKEN_SECRET));\n',
  // Still valid: domain issue(), reading the header, redaction, OpenAPI,
  // and constructing the issuer for dependency injection.
  [`${S}/v-domain.ts`]:
    `${ISSUER}class Rfqs { issue(id: string) { return id; } }\n` +
    'class Reservations { issue(id: string, dto: object) { return { id, dto }; } }\n' +
    'export const rfq = new Rfqs().issue("RFQ-1");\n' +
    'export const reservation = new Reservations().issue("R-1", {});\n' +
    "export const read = (headers: Headers, raw: Record<string, string>) => [headers.get('X-Internal-Token'), raw['x-internal-token']];\n" +
    'export const redaction = (paths: string[]) => paths.push(\'req.headers["x-internal-token"]\');\n' +
    "export const openApi = { type: 'apiKey', in: 'header', name: 'X-Internal-Token' };\n" +
    'export const provider = { useFactory: (env: { INTERNAL_TOKEN_SECRET: string }) =>\n' +
    '  new InternalTokenService(env.INTERNAL_TOKEN_SECRET, "rasta-internal", 60) };\n',
  // 9. dev, a seed-like file and a file no project includes.
  [`dev/${TAG}.ts`]: `${ISSUER}export const go = (tokens: InternalTokenService) => tokens.issue('a', 'b');\n`,
  [`prisma/${TAG}.ts`]:
    "export const go = (tokens: { issue(a: string, b: string): unknown }) => tokens.issue('a', 'b');\n",
  // Test token factories: the same issuance and header in a spec and in test/.
  [`${S}/t-factory.spec.ts`]: `${ISSUER}export const factory = async (tokens: InternalTokenService) => ({ 'x-internal-token': await tokens.issue('a', 'b') });\n`,
  [`test/${TAG}/factory.ts`]: `${ISSUER}export const factory = async (tokens: InternalTokenService) => ({ 'x-internal-token': await tokens.issue('a', 'b') });\n`,
};

/** One fixture per extension ESLint lints: an untyped `issue`, a header object. */
function extensionFixtures(directory) {
  return Object.fromEntries(
    EXTENSIONS.map((extension) => [
      `${directory}/x-ext.${extension}`,
      extension === 'cjs'
        ? "module.exports = (t) => t.issue('a', 'b');\n"
        : extension.endsWith('x')
          ? "export const go = (t: any) => t.issue('a', 'b');\n"
          : "export const go = (t) => t.issue('a', 'b');\n",
    ]),
  );
}

test('economic-service: the nine evasions, fail-closed cases and exceptions', () => {
  const byFile = lintFixtures('services/economic-service', {
    ...SERVICE_FIXTURES,
    ...extensionFixtures(`${S}/ext`),
  });
  expectReported(byFile, `${S}/e1-header-module.ts`, ['issuance', 'header']);
  expectReported(byFile, `${S}/e1-sender.ts`, ['issuance', 'header']);
  expectReported(byFile, `${S}/e2-constructor.ts`, ['issuance', 'header']);
  expectReported(byFile, `${S}/e3-field.ts`, ['issuance', 'header']);
  expectReported(byFile, `${S}/e4-destructured.ts`, ['issuance', 'header']);
  expectReported(byFile, `${S}/e5-indirect.ts`, ['issuance', 'escape']);
  expectReported(byFile, `${S}/e6-dynamic.ts`, ['unresolved', 'header']);
  expectReported(byFile, `${S}/e7-alternates.ts`, ['issuance', 'header']);
  assert.equal(
    boundary(byFile.get(`${S}/e7-alternates.ts`), 'e7').filter((m) => m.messageId === 'header')
      .length,
    5,
    'http2, got, ky, superagent and XHR are each refused at the header',
  );
  expectReported(byFile, `${S}/e8-fake-client.ts`, ['issuance', 'header']);
  expectReported(byFile, `${S}/f-structural.ts`, ['issuance', 'escape', 'unresolved']);
  expectReported(byFile, `${S}/f-reexport-user.ts`, ['issuance']);
  expectReported(byFile, `${S}/f-signer.ts`, ['signer']);
  expectClean(byFile, `${S}/v-domain.ts`);
  expectClean(byFile, `${S}/f-reexport.ts`);
  expectReported(byFile, `dev/${TAG}.ts`, ['issuance']);
  // Outside every project: parsed without types, refused for the unresolved `issue`.
  expectReported(byFile, `prisma/${TAG}.ts`, ['unresolved']);
  expectClean(byFile, `${S}/t-factory.spec.ts`);
  expectClean(byFile, `test/${TAG}/factory.ts`);
  for (const extension of EXTENSIONS) {
    expectReported(byFile, `${S}/ext/x-ext.${extension}`, ['unresolved']);
  }
});

test('economic-service: the real seed is linted with the rule', () => {
  const seed = 'prisma/seed.ts';
  const text = `${fs.readFileSync(path.join(ROOT, 'services/economic-service', seed), 'utf8')}\nexport const leak = (headers: Record<string, string>, token: string) => { headers['X-Internal-Token'] = token; };\n`;
  const byFile = lintFixtures('services/economic-service', {}, { stdin: { file: seed, text } });
  expectReported(byFile, seed, ['header']);
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

test('nest-common: only InternalHttpClient may mint, not another nest-common file', () => {
  const byFile = lintFixtures('packages/nest-common', {
    [`src/${TAG}/mint.ts`]:
      "import type { InternalTokenService } from '../auth/token-verifier';\n" +
      "export const mint = (tokens: InternalTokenService) => tokens.issue('a', 'b');\n",
  });
  expectReported(byFile, `src/${TAG}/mint.ts`, ['issuance']);
});

test('apps/web: its own config carries the rule, on every extension it lints', () => {
  const byFile = lintFixtures('apps/web', {
    ...extensionFixtures(`src/${TAG}`),
    [`src/${TAG}/header.tsx`]:
      "export const send = (token: string) => fetch('/x', { headers: { 'X-Internal-Token': token } });\n",
    [`src/${TAG}/factory.spec.ts`]:
      "export const factory = (token: string) => ({ 'x-internal-token': token });\n",
  });
  for (const extension of EXTENSIONS) {
    expectReported(byFile, `src/${TAG}/x-ext.${extension}`, ['unresolved']);
  }
  expectReported(byFile, `src/${TAG}/header.tsx`, ['header']);
  expectClean(byFile, `src/${TAG}/factory.spec.ts`);
});

test('tests/e2e: src, root files and the two named exceptions', () => {
  const byFile = lintFixtures('tests/e2e', {
    [`src/${TAG}.ts`]:
      "export const send = (token: string) => fetch('/x', { headers: { 'x-internal-token': token } });\n",
    [`${TAG}.mjs`]:
      "export const send = (token) => fetch('/x', { headers: { 'x-internal-token': token } });\n",
  });
  expectReported(byFile, `src/${TAG}.ts`, ['header']);
  expectReported(byFile, `${TAG}.mjs`, ['header']);

  for (const file of ['global-setup.ts', 'playwright.config.ts']) {
    const text = `${fs.readFileSync(path.join(ROOT, 'tests/e2e', file), 'utf8')}\nexport const leak = (token: string) => new Headers([['x-internal-token', token]]);\n`;
    expectReported(lintFixtures('tests/e2e', {}, { stdin: { file, text } }), file, ['header']);
  }

  // send() is the E2E transport's one place for the header; nothing else in http.ts is.
  const http = fs.readFileSync(path.join(ROOT, 'tests/e2e/src/http.ts'), 'utf8');
  expectClean(
    lintFixtures('tests/e2e', {}, { stdin: { file: 'src/http.ts', text: http } }),
    'src/http.ts',
  );
  const widened = `${http}\nexport const other = (token: string) => ({ 'x-internal-token': token });\n`;
  expectReported(
    lintFixtures('tests/e2e', {}, { stdin: { file: 'src/http.ts', text: widened } }),
    'src/http.ts',
    ['header'],
  );
  // The token factory signs in mintInternalToken() only.
  const internal = fs.readFileSync(path.join(ROOT, 'tests/e2e/src/internal.ts'), 'utf8');
  expectClean(
    lintFixtures('tests/e2e', {}, { stdin: { file: 'src/internal.ts', text: internal } }),
    'src/internal.ts',
  );
  const signer = `${internal}\nexport const other = () => new SignJWT({});\n`;
  expectReported(
    lintFixtures('tests/e2e', {}, { stdin: { file: 'src/internal.ts', text: signer } }),
    'src/internal.ts',
    ['signer'],
  );
});

test('root scripts: plain JavaScript fails closed', () => {
  const byFile = lintFixtures('.', {
    [`scripts/${TAG}.mjs`]:
      "import { InternalTokenService } from '@rasta/nest-common';\n" +
      "export const go = async (t, name) => [t.issue('a', 'b'), await import(name), InternalTokenService];\n" +
      "const NAME = 'x-internal-' + 'token';\n" +
      'export const send = (token) => fetch(`/x`, { headers: { [`${NAME}`]: token } });\n',
  });
  expectReported(byFile, `scripts/${TAG}.mjs`, ['unresolved', 'header']);
  assert.ok(
    boundary(byFile.get(`scripts/${TAG}.mjs`), 'scripts').length >= 3,
    'the import, the untyped issue and the dynamic import are each refused',
  );
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

test('structural: the rule is on for every lintable file of every workspace lint script', () => {
  const workspaces = lintWorkspaces();
  assert.ok(workspaces.length >= 26, `found ${workspaces.length} lint workspaces`);
  for (const { workspace, lint } of workspaces) {
    const match = /^eslint((?:\s+[^\s-][^\s]*)+)\s*$/.exec(lint);
    assert.ok(match, `${workspace}: lint script "${lint}" is not "eslint <paths>"`);
    const samples = [];
    for (const target of match[1].trim().split(/\s+/)) {
      if (/\.[cm]?[jt]sx?$/.test(target)) samples.push(target);
      else for (const extension of EXTENSIONS) samples.push(`${target}/${TAG}.${extension}`);
    }
    if (workspace === 'tests/e2e')
      samples.push('global-setup.ts', 'playwright.config.ts', 'src/actor.ts', 'src/http.ts');
    const script = `
      const { ESLint } = await import(${JSON.stringify(path.join(ROOT, 'node_modules/eslint/lib/api.js'))});
      const eslint = new ESLint({ cwd: process.cwd() });
      const out = {};
      for (const sample of JSON.parse(process.argv[1])) {
        const config = await eslint.calculateConfigForFile(sample);
        out[sample] = config && {
          level: config.rules?.['${RULE}']?.[0],
          parser: config.languageOptions?.parser?.meta?.name,
        };
      }
      process.stdout.write(JSON.stringify(out));`;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, JSON.stringify(samples)],
      {
        cwd: path.join(ROOT, workspace),
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, `${workspace}: ${result.stderr}`);
    for (const [sample, config] of Object.entries(JSON.parse(result.stdout))) {
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

test('files no lint script reaches hold no internal-token construct (text guard)', () => {
  // ESLint never sees these (config files, apps/web/e2e): a plain text scan
  // stands in for the rule there, spelling-based by necessity.
  const targets = [['.', 'scripts']];
  for (const { workspace, lint } of lintWorkspaces()) {
    for (const target of lint.trim().split(/\s+/).slice(1)) targets.push([workspace, target]);
  }
  const covered = (file) =>
    targets.some(([workspace, target]) => {
      const base = path.posix.join(workspace, target === '.' ? '' : target);
      return base === '.' ? false : file === base || file.startsWith(`${base}/`);
    });
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split(
    '\n',
  );
  const unlinted = tracked.filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && !covered(file));
  assert.ok(unlinted.includes('apps/web/e2e/live-session.ts'), 'the scan must reach apps/web/e2e');
  const CONSTRUCT =
    /x-internal-token|InternalTokenService|InternalHttpClient|\.issue\b|['"`]issue['"`]|SignJWT|CompactSign|FlattenedSign|GeneralSign|INTERNAL_TOKEN_SECRET|@rasta\/nest-common/i;
  const offending = unlinted.filter((file) =>
    CONSTRUCT.test(fs.readFileSync(path.join(ROOT, file), 'utf8')),
  );
  assert.deepEqual(offending, [], 'move this into a linted path or remove the construct');
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

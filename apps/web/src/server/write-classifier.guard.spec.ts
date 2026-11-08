/**
 * @jest-environment node
 */

/**
 * Every write to the gateway is classified by the writer, and only by it (FU-189,
 * PR-880 F2, PR-921 F1; checklist A1, E11).
 *
 * `writeThroughGateway` (`write.ts`) is where an answer becomes an outcome, and
 * its one rule is that `UNAVAILABLE` — the kind every form renders as "failed,
 * nothing changed, you can resend" — is returned only on proof: a refusal the
 * platform proved, or a send that never left this portal. A `5xx` is
 * `UNKNOWN_OUTCOME` (`write.spec.ts` sweeps every status and body). That makes a
 * caller's `UNAVAILABLE → FAILED` right by construction — as long as no module
 * sends a write some other way and reads the status itself.
 *
 * So this holds the portal's import graph (`test/import-graph.ts`: every file
 * node or the bundler executes, every specifier resolved to the module it names,
 * checked wherever a non-test file reaches it) to permitted edges:
 *
 *   - the gateway: outside the writer and the gateway itself, only a named import
 *     of a reviewed export, and `callGateway` only ever called as a read — an
 *     object literal with no method other than `GET`, no body, no idempotency key
 *     and no replay deadline — and the gateway refuses anything else at run time
 *     (`callGateway` sends only GET, from a snapshot of own data properties;
 *     `callGatewayWrite` is the writer's entry and nobody else may import it);
 *   - a transport (`credentialFetch`, `putToSignedUrl`): only its reviewed
 *     importers, by a named import, used only as the callee of a call;
 *   - a package or node builtin: only the reviewed ones (a client library or
 *     `node:http` is a transport too);
 *   - the platform's network globals (`fetch`, XHR, sockets, `sendBeacon`): only
 *     the reviewed modules (aliases, reflection and computed names: `internal/raw-http`,
 *     which lints every file not named as a test — so no shipped module may import one).
 *
 * Anything it cannot prove is one of these is a finding (fail closed): a
 * namespace, a default, a re-export or a load of a capability, a load it cannot
 * name, a specifier that resolves to no file it reads.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isMetadataRouteFile } from 'next/dist/lib/metadata/is-metadata-route';
import ts from 'typescript';

import {
  COMPILER_OPTIONS,
  WEB_ROOT,
  WEB_ROOT_FILES,
  TEST_NAMED,
  importGraph,
  isRoot,
  isStylesheetFile,
} from '@/test/import-graph';

const GATEWAY = 'src/server/gateway.ts';
/** The writer, and the module that defines `callGateway`. */
const EXEMPT = new Set(['src/server/write.ts', GATEWAY]);
/** What a module may import from the gateway; any other name is a finding until reviewed. */
const GATEWAY_EXPORTS = new Set([
  'callGateway', // checked call by call below
  'GatewayCall',
  'GatewayResponse',
  'GatewayProblem',
  'gatewayProblemSchema',
  'GatewayOriginError',
  'GatewayRequestError',
  'GatewayOutcomeUnknownError',
  'GatewayNeverSentError',
  'neverSent',
  'gatewayUrl',
  'parseRetryAfter',
]);
/** All a read may name; anything else (`body`, `idempotencyKey`, an unknown key) is not proven a read. */
const READ_PROPERTIES = new Set(['baseUrl', 'path', 'credential', 'correlationId', 'timeoutMs']);

/** Each transport, and the only modules that may import it, with what they reach. */
const TRANSPORTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'src/server/credential-fetch.ts': {
    [GATEWAY]: 'the gateway transport the writer (and every read) uses',
    'src/server/oidc.ts': 'the identity provider’s token endpoint, not the gateway',
  },
  'src/server/signed-url-upload.ts': {
    'src/server/asset-documents.ts':
      'the bytes to object storage; the document is registered through the writer',
  },
};

/** The sending functions of the transports. */
const TRANSPORT_CALLS = new Set(['credentialFetch', 'putToSignedUrl']);

/**
 * Packages and builtins, by the whole specifier (`next/navigation`, never `next/dist/…`):
 * `'*'` reaches no network; otherwise the modules that may use it.
 */
const NO_NETWORK = '*';
const PACKAGES: Readonly<Record<string, '*' | Readonly<Record<string, string>>>> = {
  ...Object.fromEntries(
    [
      'react',
      'next/navigation',
      'next/link',
      'next/server',
      'next/headers',
      'next/font/google',
      'zod',
      '@rasta/contracts',
      '@rasta/config',
      'clsx',
      'tailwind-merge',
      'lucide-react',
      '@radix-ui/react-label',
      'react-hook-form',
      '@hookform/resolvers',
      'date-fns-jalali',
      'date-fns-jalali/locale',
      '@date-fns/tz',
    ].map((specifier) => [`pkg:${specifier}`, NO_NETWORK]),
  ),
  'node:crypto': NO_NETWORK,
  'node:async_hooks': NO_NETWORK,
  'pkg:ioredis': {
    'src/server/session-refresh.ts': 'Redis (session refresh lock), not the gateway',
    'src/server/unresolved-request.ts': 'Redis (unresolved-request store), not the gateway',
  },
  'pkg:jose': { 'src/server/oidc.ts': 'the identity provider’s signing keys (a read)' },
  'node:module': { 'next.config.mjs': 'loads upload-limit.cjs, itself a checked root' },
};

/** The modules that may reach the platform's network globals themselves, each with what it reaches. */
const RAW_FETCH: Readonly<Record<string, string>> = {
  [GATEWAY]: 'the gateway transport the writer (and every read) uses',
  'src/server/credential-fetch.ts': 'the raw credential boundary itself (Q-155)',
  'src/server/oidc.ts': 'the identity provider’s token endpoint, not the gateway',
  'src/server/signed-url-upload.ts': 'the bytes to object storage (ADR-014)',
  'src/lib/session-refusal.ts': 'the browser’s GET of this portal’s own /auth/session',
};
const RAW = new Set([
  'fetch',
  'credentialFetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
]);
const GLOBALS = new Set(['globalThis', 'window', 'self', 'global']);

type Graph = ReturnType<typeof importGraph>;

/** Every way a checked module could send a write without the writer. */
function findingsIn(graph: Graph): string[] {
  const findings: string[] = graph.twins
    .filter((ids) => ids.some((id) => graph.checked.includes(id)))
    .map((ids) => `${ids.join(' and ')} are one module to the bundler: which runs is unproven`);
  findings.push(...graph.refused);
  for (const id of graph.checked) {
    // `internal/raw-http` (lint: global aliases, reflection, computed names, string execution)
    // covers `src/` without its tests, and the portal's root files: whatever else ships is refused.
    if (TEST_NAMED.test(id))
      findings.push(
        `${id} is named as a test but ships: Next loads it or a checked module imports it`,
      );
    else if (!id.startsWith('src/') && WEB_ROOT_FILES[id] !== 'portal')
      findings.push(`${id} ships but internal/raw-http does not lint it: classify explicitly`);
    const facts = graph.facts.get(id);
    if (!facts) throw new Error(`no facts for ${id}`);
    findings.push(...facts.unprovable);
    const gatewayNames = new Set<string>();
    const transportNames = new Set<string>();
    for (const edge of facts.edges) {
      if (edge.typeOnly) continue;
      const at = `${id}:${edge.line}`;
      if (edge.to.startsWith('unresolved:')) {
        findings.push(`${at} imports ${edge.to.slice(11)}, which resolves to no module it reads`);
      } else if (edge.to.startsWith('pkg:') || edge.to.startsWith('node:')) {
        if (
          edge.to === 'node:module' &&
          (edge.how !== 'import' ||
            edge.whole ||
            edge.names.some((name) => name.imported !== 'createRequire'))
        )
          findings.push(`${at} reaches an unclassified module loader`);
        const allowed = PACKAGES[edge.to];
        if (allowed === undefined || (allowed !== NO_NETWORK && !Object.hasOwn(allowed, id)))
          findings.push(`${at} uses ${edge.to}, not reviewed for this module`);
      } else if (Object.hasOwn(TRANSPORTS, edge.to)) {
        if (!Object.hasOwn(TRANSPORTS[edge.to], id) || edge.how !== 'import' || edge.whole)
          findings.push(`${at} reaches the transport ${edge.to}`);
        for (const name of edge.names)
          if (TRANSPORT_CALLS.has(name.imported)) transportNames.add(name.local);
      } else if (edge.to === GATEWAY) {
        // The writer too: a named import, and `callGateway` only called — never handed on.
        if (edge.how !== 'import' || edge.whole)
          findings.push(`${at} reaches the gateway other than by a named import`);
        for (const name of edge.names) {
          if (
            !GATEWAY_EXPORTS.has(name.imported) &&
            !(id === 'src/server/write.ts' && name.imported === 'callGatewayWrite')
          )
            findings.push(`${at} imports ${name.imported} from the gateway, not reviewed`);
          if (name.imported === 'callGateway')
            (EXEMPT.has(id) ? transportNames : gatewayNames).add(name.local);
          // The write entry: only the writer imports it, and only calls it.
          if (name.imported === 'callGatewayWrite') transportNames.add(name.local);
        }
      }
    }
    findings.push(...callsIn(facts.file, id, gatewayNames, transportNames, EXEMPT.has(id)));
    if (!Object.hasOwn(RAW_FETCH, id)) findings.push(...rawFetchesIn(facts.file, id));
  }
  return findings;
}

/** `callGateway` only as a read; a transport only as a callee. */
function callsIn(
  file: ts.SourceFile,
  id: string,
  gateway: ReadonlySet<string>,
  transports: ReadonlySet<string>,
  exempt: boolean,
): string[] {
  const findings: string[] = [];
  const at = (node: ts.Node, what: string) =>
    findings.push(`${id}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${what}`);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
      const call = node.parent;
      const isCallee = ts.isCallExpression(call) && call.expression === node;
      if (transports.has(node.text) && !isCallee) at(node, 'uses a transport as a value');
      if (!exempt && node.text === 'callGateway' && !gateway.has(node.text))
        at(node, 'reaches callGateway other than through its import');
      if (!exempt && gateway.has(node.text)) {
        if (!isCallee) at(node, 'uses callGateway as a value');
        else {
          const [argument] = call.arguments;
          if (!argument || !ts.isObjectLiteralExpression(argument))
            at(call, 'calls callGateway with an argument that is not an object literal');
          else
            for (const property of argument.properties) {
              if (ts.isSpreadAssignment(property)) {
                at(property, 'spreads into a callGateway call');
                continue;
              }
              const name =
                property.name && ts.isIdentifier(property.name) ? property.name.text : null;
              if (name === null) {
                at(property, 'names a callGateway property it cannot be read from');
                continue;
              }
              if (
                !ts.isPropertyAssignment(property) &&
                !ts.isShorthandPropertyAssignment(property)
              ) {
                at(property, 'uses an accessor or method in a read request');
                continue;
              }
              if (READ_PROPERTIES.has(name)) continue;
              const isGet =
                name === 'method' &&
                ts.isPropertyAssignment(property) &&
                ts.isStringLiteral(property.initializer) &&
                property.initializer.text === 'GET';
              if (!isGet) at(property, `sends ${name} past the writer: not proven a read`);
            }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

/** Every place a module reaches the platform's network globals. */
function rawFetchesIn(file: ts.SourceFile, id: string): string[] {
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    const line = () => file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    // `globalThis['fetch']`, `Reflect.get(globalThis, 'fetch')`: the name as a string.
    if (ts.isStringLiteralLike(node) && RAW.has(node.text))
      findings.push(`${id}:${line()} names ${node.text} as a string`);
    if (ts.isIdentifier(node) && RAW.has(node.text)) {
      const parent = node.parent;
      const named =
        // A type (`typeof fetch`), or a name declared or read off something else.
        ts.isTypeQueryNode(parent) ||
        ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) &&
          (ts.isPropertyAccessExpression(parent) ? parent.name : parent.right) === node &&
          !(
            ts.isPropertyAccessExpression(parent) &&
            (!ts.isIdentifier(parent.expression) ||
              GLOBALS.has(parent.expression.text) ||
              node.text === 'sendBeacon')
          )) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isBindingElement(parent)) &&
          (parent as { name?: ts.Node }).name === node);
      if (!named) findings.push(`${id}:${line()} reaches the network with ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

const GRAPH = importGraph();

it('reads every executable file of the portal, the writer and the gateway among them', () => {
  expect(GRAPH.checked.length).toBeGreaterThan(300);
  for (const id of [...EXEMPT, ...Object.keys(TRANSPORTS), ...Object.keys(RAW_FETCH)])
    expect(GRAPH.checked).toContain(id);
  // Every file beside src/ is reviewed as the portal's or as tooling.
  expect(GRAPH.rootFiles.filter((file) => !Object.hasOwn(WEB_ROOT_FILES, file))).toEqual([]);
});

it('sends every gateway write through the writer, over every permitted edge', () => {
  expect(findingsIn(GRAPH)).toEqual([]);
});

it('sees the reads it lets through, and each reviewed module reaching what it reaches', () => {
  const readers = GRAPH.checked.filter(
    (id) =>
      !EXEMPT.has(id) && GRAPH.facts.get(id)?.edges.some((e) => e.to === GATEWAY && !e.typeOnly),
  );
  expect(readers.length).toBeGreaterThan(20);
  for (const [transport, importers] of Object.entries(TRANSPORTS))
    for (const importer of Object.keys(importers))
      expect(GRAPH.facts.get(importer)?.edges.map((e) => e.to)).toContain(transport);
  for (const id of [GATEWAY, 'src/server/oidc.ts', 'src/lib/session-refusal.ts']) {
    const facts = GRAPH.facts.get(id);
    expect(facts && rawFetchesIn(facts.file, id)).not.toEqual([]);
  }
});

/**
 * Each probe is a set of modules under its own directory, put on top of the real
 * tree, so the real gateway and transports resolve. `PR-921 F1` marks the escapes
 * the round-1 guard (20de2f10) let through.
 */
const PROBES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'a write method': {
    'a.ts':
      "import { callGateway } from '@/server/gateway';\ncallGateway({ path, method: 'POST' });",
  },
  'a computed method': {
    'a.ts': "import { callGateway } from '@/server/gateway';\ncallGateway({ path, method });",
  },
  'a body': {
    'a.ts': "import { callGateway } from '@/server/gateway';\ncallGateway({ path, body: {} });",
  },
  'an idempotency key': {
    'a.ts':
      "import { callGateway } from '@/server/gateway';\ncallGateway({ path, idempotencyKey: k });",
  },
  'a replay deadline': {
    'a.ts':
      "import { callGateway } from '@/server/gateway';\ncallGateway({ path, replayDeadline: d });",
  },
  'a spread': {
    'a.ts': "import { callGateway } from '@/server/gateway';\ncallGateway({ ...call });",
  },
  'a non-literal argument': {
    'a.ts': "import { callGateway } from '@/server/gateway';\ncallGateway(call);",
  },
  'a computed property': {
    'a.ts': "import { callGateway } from '@/server/gateway';\ncallGateway({ ['method']: 'POST' });",
  },
  'callGateway passed on': {
    'a.ts': "import { callGateway } from '@/server/gateway';\nexport const send = callGateway;",
  },
  'a gateway namespace': {
    'a.ts': "import * as g from '../server/gateway';\ng.callGateway({ path });",
  },
  'a gateway re-export': { 'a.ts': "export { callGateway } from './../server/gateway';" },
  'a dynamic gateway import': {
    'a.ts': "const { callGateway } = await import('@/server/gateway');",
  },
  'a gateway require': { 'a.js': "const g = require('../server/gateway.ts');" },
  'a load it cannot name': { 'a.ts': 'await import(where);' },
  'a property of something else': { 'a.ts': 'mod.callGateway({ path });' },
  'callGatewayWrite outside the writer': {
    'a.ts':
      "import { callGatewayWrite } from '@/server/gateway';\ncallGatewayWrite({ path, method: 'POST' });",
  },
  'callGatewayWrite aliased outside the writer': {
    'a.ts':
      "import { callGatewayWrite as get } from '../server/gateway.ts';\nget({ path, method: 'POST' });",
  },
  'callGatewayWrite re-exported': {
    'a.ts': "export { callGatewayWrite } from '../server/gateway';",
  },
  'an unreviewed gateway export': {
    'a.ts': "import { gatewayPost } from '@/server/gateway';\ngatewayPost();",
  },
  'PR-921 F1: an alias from ./gateway.ts': {
    'a.ts':
      "import { callGateway as send } from '../server/gateway.ts';\nsend({ path, method: 'POST' });",
  },
  'PR-921 F1: an alias from ./gateway.js': {
    'a.ts':
      "import { callGateway as send } from '../server/gateway.js';\nsend({ path, method: 'POST' });",
  },
  'PR-921 F1: export * from the gateway, then an alias': {
    'barrel.ts': "export * from '../server/gateway.ts';",
    'a.ts': "import { callGateway as send } from './barrel';\nsend({ path, method: 'POST' });",
  },
  'PR-921 F1: a credential-fetch namespace': {
    'a.ts':
      "import * as transport from '@/server/credential-fetch';\ntransport.credentialFetch(url, { method: 'POST' });",
  },
  'PR-921 F1: credential-fetch by import()': {
    'a.ts':
      "const transport = await import('@/server/credential-fetch');\ntransport.credentialFetch(url, { method: 'POST' });",
  },
  'PR-921 F1: credential-fetch by require': {
    'a.ts':
      "const transport = require('../server/credential-fetch.ts');\ntransport.credentialFetch(url, { method: 'POST' });",
  },
  'PR-921 F1: a namespace re-export of credential-fetch': {
    'barrel.ts': "export * as transport from '@/server/credential-fetch';",
    'a.ts':
      "import { transport } from './barrel';\ntransport.credentialFetch(url, { method: 'POST' });",
  },
  'PR-921 F1: putToSignedUrl outside its importer': {
    'a.ts':
      "import { putToSignedUrl } from '@/server/signed-url-upload';\nputToSignedUrl(url, { body });",
  },
  ...Object.fromEntries(
    ['js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].map((ext) => [
      `PR-921 F1: a .${ext} module`,
      { [`a.${ext}`]: "fetch('http://gateway.test/v1/x', { method: 'POST' });" },
    ]),
  ),
  ...Object.fromEntries(
    ['write-fixture.ts', 'send.test.ts', 'send.spec.tsx', 'test/send.ts', '__mocks__/send.ts'].map(
      (file) => [
        `${file.startsWith('__') ? 'sibling' : 'PR-921 F1'}: ${file} imported by a page`,
        {
          'page.tsx': `import './${file.replace(/\.tsx?$/, '')}';`,
          [file]: "fetch('http://gateway.test/v1/x', { method: 'POST' });",
        },
      ],
    ),
  ),
  'a client library': { 'a.ts': "import axios from 'axios';" },
  'a client library inside an allowed package': {
    'a.ts': "import { request } from 'next/dist/compiled/undici';",
  },
  'require handed on': { 'a.cjs': "const load = require;\nload('./x');" },
  'module.require': { 'a.cjs': "module.require('node:http');" },
  'a builtin without an import': { 'a.ts': "process.getBuiltinModule('node:https');" },
  'webpack’s own loader': { 'a.ts': "__non_webpack_require__('node:https');" },
  'a .js twin of a .ts module': { 'a.ts': 'export {};', 'a.js': 'export {};' },
  ...Object.fromEntries(
    ['baseUrl', 'path', 'credential', 'correlationId'].map((property) => [
      `FU-219: a ${property} getter`,
      {
        'a.ts': `import { callGateway } from '@/server/gateway'; callGateway({ get ${property}() { return value; } });`,
      },
    ]),
  ),
  'an unknown callGateway property': {
    'a.ts':
      "import { callGateway } from '@/server/gateway';\ncallGateway({ path, fetchImpl: send });",
  },
  'node:https': { 'a.ts': "import { request } from 'node:https';" },
  'http by require': { 'a.cjs': "const http = require('http');" },
  undici: { 'a.ts': "import { request } from 'undici';" },
  'ioredis outside its modules': { 'a.ts': "import Redis from 'ioredis';" },
  'a file outside src/': { 'a.ts': "import '../../scripts/build-run.mjs';" },
  'a global fetch': { 'a.ts': "globalThis.fetch('/v1/x', { method: 'POST' });" },
  'fetch by name': { 'a.ts': "globalThis['fetch']('/v1/x', { method: 'POST' });" },
  'fetch off any object': { 'a.ts': "(0, globalThis).fetch('/v1/x', { method: 'POST' });" },
  'fetch passed on': { 'a.ts': 'run({ fetch });' },
  sendBeacon: { 'a.ts': "navigator.sendBeacon('/v1/x', body);" },
  XMLHttpRequest: { 'a.ts': 'new XMLHttpRequest();' },
};
/** What is not a finding: reads, under any name, and a test nobody ships. */
const ALLOWED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  reads: {
    'a.ts':
      "import { callGateway } from '@/server/gateway';\ncallGateway<X>({ baseUrl, path: '/v1/x', credential });\ncallGateway({ path, method: 'GET' });",
  },
  'an aliased read from ./gateway.ts': {
    'a.ts': "import { callGateway as get } from '../server/gateway.ts';\nget({ path });",
  },
  'types and unrelated names': {
    'a.ts':
      "import type { GatewayCall } from '@/server/gateway';\ntype F = typeof fetch; const o = { fetch: 1 }; o.fetch; function f(fetch: F) {}",
  },
  'a spec nothing ships': { 'a.spec.ts': "fetch('http://gateway.test/v1/x', { method: 'POST' });" },
};

it('starts from every Next entry and every file not named as a test', () => {
  for (const id of ['src/app/test/page.tsx', 'src/app/fixture-x/route.ts', 'src/middleware.ts'])
    expect(isRoot(id)).toBe(true);
  // Next may load any dotless module under app/: a fixture there needs a dotted name (FU-219).
  for (const id of ['src/app/fixtures-admin/actions.ts', 'src/app/x/order-fixture.ts'])
    expect(isRoot(id)).toBe(true);
  for (const id of ['src/a.spec.ts', 'src/test/x.ts', 'src/app/x/order.fixture.ts'])
    expect(isRoot(id)).toBe(false);
});

it('lets a reviewed importer only call a transport, never hand it on', () => {
  const source = 'f(url, init);\nexport const send = f;\nrun(f);';
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  expect(callsIn(file, 'probe.ts', new Set(), new Set(['f']), false)).toEqual([
    'probe.ts:2 uses a transport as a value',
    'probe.ts:3 uses a transport as a value',
  ]);
});

/**
 * What the writer hands out: only callGatewayWrite's reviewed wrappers. An export the list does not
 * name (a declaration, a list, a re-export, a default) is refused, so write.ts cannot pass on an
 * unclassified write entry while the import rule above still holds (FU-219).
 */
const WRITER_VALUE_EXPORTS = [
  'GENERIC_REFUSAL_MESSAGE',
  'MAX_IN_PROGRESS_WAIT_SECONDS',
  'isProvenRefusal',
  'mapProblemToFields',
  'reportUnmappedMessage',
  'writeThroughGateway',
];

function valueExportsOf(source: string): string[] {
  const file = ts.createSourceFile('write.ts', source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      names.push(`export ${statement.getText(file)}`);
    } else if (ts.isExportAssignment(statement)) names.push('export default');
    else if (
      ts
        .getModifiers(statement as ts.HasModifiers)
        ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          names.push(declaration.name.getText(file));
      else
        names.push((statement as ts.DeclarationStatement).name?.getText(file) ?? 'export default');
    }
  }
  return names.sort();
}

it('lets the writer export only its reviewed wrappers of the write entry', () => {
  expect(valueExportsOf(readFileSync(join(WEB_ROOT, 'src/server/write.ts'), 'utf8'))).toEqual(
    [...WRITER_VALUE_EXPORTS].sort(),
  );
  for (const added of [
    'export const send = (c: never) => callGatewayWrite(c);',
    'export { callGatewayWrite as send };',
    'export * from "./gateway";',
    'export default dispatchWrite;',
    'export async function send() {}',
    'export class Send {}',
    'export enum Send { A }',
  ])
    expect(valueExportsOf(added)).not.toEqual([]);
  expect(
    valueExportsOf('export type T = 1;\nexport interface I {}\nexport type { X } from "./x";'),
  ).toEqual([]);
});

describe('the guard, on each way a write could bypass the writer', () => {
  const dirOf = (set: string, label: string) =>
    `src/zz-probe-${set}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const virtual = new Map<string, string>();
  for (const [set, probes] of [
    ['f', PROBES],
    ['ok', ALLOWED],
  ] as const)
    for (const [label, files] of Object.entries(probes))
      for (const [file, source] of Object.entries(files))
        virtual.set(join(WEB_ROOT, dirOf(set, label), file), source);
  const findings = findingsIn(importGraph(virtual));
  const inProbe = (set: string, label: string) =>
    findings.filter((finding) => finding.startsWith(`${dirOf(set, label)}/`));

  it('resolves every probe it means to: only the file outside src/ names no module', () => {
    const unresolved = findings.filter((finding) => / resolves to no module /.test(finding));
    expect(unresolved).toEqual([expect.stringMatching(/^src\/zz-probe-f-a-file-outside-src-\//)]);
  });

  it.each(Object.keys(PROBES))('finds %s', (label) => {
    expect(inProbe('f', label)).not.toEqual([]);
  });

  it.each(Object.keys(ALLOWED))('lets through %s', (label) => {
    expect(inProbe('ok', label)).toEqual([]);
  });
});

// FU-219 / PR-921 executed-review regressions, one graph: what Next and Node load
// and execute is checked, and anything the guard cannot model is refused.
describe('FU-219: what Next and Node actually load and execute', () => {
  const SEND =
    "import * as t from '@/server/credential-fetch'; t.credentialFetch(url, { method: 'POST' });";
  const RAW_SEND = "fetch('/v1/x', { method: 'POST' });";
  const ENTRIES = [
    ...['sitemap.ts', 'icon.tsx', 'apple-icon.tsx', 'opengraph-image.tsx', 'twitter-image.tsx'].map(
      (name) => `src/app/test/${name}`,
    ),
    'src/app/__tests__/icon2.tsx',
    'src/app/fixtures/robots.ts',
    'src/app/test/manifest.ts',
    'src/app/test/global-not-found.tsx',
    'src/instrumentation-client.ts',
    'src/pages/test/index.tsx',
    'src/pages/api/test/send.ts',
    'src/pages/order.fixture.tsx',
    'src/pages/order.spec.tsx',
    'pages/__tests__/index.jsx',
    'app/fixtures/icon.tsx',
  ];
  /** Every suffix Node's CommonJS loader was seen executing as JavaScript, and more. */
  const SUFFIXES = [
    ...['css', 'scss', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'md'],
    ...['txt', 'json', 'node', 'unknown'],
  ];
  const LOADER_ESCAPES = [
    "import { createRequire as factory } from 'node:module'; const load = factory(import.meta.url); load(target);",
    "import { createRequire } from 'node:module'; createRequire('/elsewhere/config.js')('./send.cjs');",
    "import * as m from 'node:module'; m['create' + 'Require'](import.meta.url)(target);",
    "const m = require('node:module'); m.createRequire(__filename)(target);",
    "process['getBuiltin' + 'Module']('node:http');",
    "process['getBuiltinModule']('node:http');",
    "const p = process; p['getBuiltinModule']('node:http');",
    "process.binding('tcp_wrap');",
    "module.constructor._load('node:http');",
  ];
  const at = (id: string) => join(WEB_ROOT, id);
  const virtual = new Map<string, string>([
    ...ENTRIES.map((id) => [at(id), SEND] as const),
    // The review's own probe: the root file Node runs, loading a text file.
    [at('upload-limit.cjs'), "require('./probe.txt');"],
    [at('probe.txt'), RAW_SEND],
    // The inline factory is followed to the module it loads, at the module's own base.
    [
      at('next.config.mjs'),
      "import { createRequire as factory } from 'node:module'; factory(import.meta.url)('./src/test/send.cjs');",
    ],
    [at('src/test/send.cjs'), RAW_SEND],
    // Node does not substitute .ts for .js.
    [at('src/zz-fu219-subst/a.cjs'), "require('./send.js');"],
    [at('src/zz-fu219-subst/send.ts'), 'export {};'],
    ...SUFFIXES.flatMap((ext) => [
      [at(`src/zz-fu219-load-${ext}/a.cjs`), `require('./send.${ext}');`] as const,
      [at(`src/zz-fu219-import-${ext}/a.ts`), `import './send.${ext}';`] as const,
    ]),
    ...LOADER_ESCAPES.map((source, n) => [at(`src/zz-fu219-loader-${n}/a.mjs`), source] as const),
    [at('src/zz-fu219-css/a.ts'), "import './globals.css';"],
    [at('src/zz-fu219-css/globals.css'), 'body {}'],
    // A tooling file beside src/ that a shipped module imports: checked, but never linted.
    [at('src/zz-fu219-tooling/a.ts'), "import '../../postcss.config.mjs';"],
  ]);
  const graph = importGraph(virtual);
  const findings = findingsIn(graph);
  const from = (prefix: string) => findings.filter((finding) => finding.startsWith(prefix));

  it.each(ENTRIES)('checks and refuses unclassified %s', (id) => {
    expect(isRoot(id)).toBe(true);
    expect(graph.checked).toContain(id);
    expect(from(`${id}`)).not.toEqual([]);
  });

  it('covers every name the installed Next metadata matcher accepts', () => {
    const exts = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'];
    for (const name of ['sitemap', 'robots', 'manifest', 'icon', 'icon2', 'apple-icon'])
      for (const ext of exts) {
        const id = `src/app/test/${name}.${ext}`;
        if (isMetadataRouteFile(id.slice(7), exts, true)) expect(isRoot(id)).toBe(true);
      }
    // Next's conventions hold only for its default page extensions.
    expect(readFileSync(join(WEB_ROOT, 'next.config.mjs'), 'utf8')).not.toMatch(/pageExtensions/);
  });

  it('follows the inline loader factory from next.config.mjs to what it loads', () => {
    expect(graph.checked).toContain('src/test/send.cjs');
    expect(from('src/test/send.cjs:')).not.toEqual([]);
    expect(from('next.config.mjs:')).toEqual([]);
  });

  it('refuses the text file upload-limit.cjs loads: Node executes it', () => {
    expect(from('upload-limit.cjs:')).toEqual([
      'upload-limit.cjs:1 imports ./probe.txt, which resolves to no module it reads',
    ]);
  });

  it('refuses TypeScript substitution for a Node load', () => {
    expect(graph.facts.get('src/zz-fu219-subst/a.cjs')?.edges[0]?.to).toBe('unresolved:./send.js');
  });

  // A static import of a stylesheet is the one asset: Next's CSS loader compiles it, nothing executes it.
  it.each(SUFFIXES)('refuses loading or importing .%s as an asset', (ext) => {
    for (const how of ext === 'css' ? ['load'] : ['load', 'import'])
      expect(from(`src/zz-fu219-${how}-${ext}/a.`)).toContainEqual(
        expect.stringMatching(/resolves to no module it reads/),
      );
  });

  it('refuses a shipped module that internal/raw-http does not lint', () => {
    expect(graph.checked).toContain('postcss.config.mjs');
    expect(from('postcss.config.mjs ')).toEqual([
      'postcss.config.mjs ships but internal/raw-http does not lint it: classify explicitly',
    ]);
  });

  it('lets a stylesheet import through, which Next compiles as CSS', () => {
    expect(from('src/zz-fu219-css/')).toEqual([]);
  });

  it.each(LOADER_ESCAPES.map((source, n) => [n, source]))('refuses loader escape %i: %s', (n) => {
    expect(from(`src/zz-fu219-loader-${n}/a.mjs:`)).toContainEqual(
      expect.stringMatching(
        /escapes a loader factory|unclassified module loader|names the loader|loader of process|other than as a named load/,
      ),
    );
  });
});

// PR-949 F1: the bundler reads request syntax and completes names that TypeScript does not, so a
// stylesheet is decided on the file webpack loads, and every request the guard cannot model is
// refused. Rows R1-R7 are the review's probes (each loaded and executed by a real webpack 5 build).
describe('PR-949 F1: what webpack loads, not what the specifier says', () => {
  const PAYLOAD = "fetch('/v1/x', { method: 'POST' });";
  const ROWS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    'R1 a query': { 'a.ts': "import './payload.txt?.css';", 'payload.txt': PAYLOAD },
    // webpack still reads the query when a file of that literal name exists: the syntax decides.
    'R1 a query, beside a file of that literal name': {
      'a.ts': "import './payload.txt?.css';",
      'payload.txt?.css': 'b {}',
      'payload.txt': PAYLOAD,
    },
    'R2 a fragment': { 'a.ts': "import './payload.txt#.css';", 'payload.txt': PAYLOAD },
    'R3 a query on a test module': { 'a.ts': "import '@/test/zz-949-send.ts?x.css';" },
    'R4 a query re-exported': {
      'a.ts': "export * from './payload.txt?.css';",
      'payload.txt': PAYLOAD,
    },
    'R5 an inline loader': { 'a.ts': "import '../test/zz-949-l.cjs!./a.css';", 'a.css': 'b {}' },
    'R6 a missing .css that webpack completes': { 'a.ts': "import '../test/zz-949.css';" },
    'R7 import.meta.webpackContext': {
      'a.ts':
        "const c = import.meta.webpackContext('../test', { recursive: true }); c.keys().forEach(c);",
    },
    'loader prefix !!': { 'a.ts': "import '!!../test/zz-949-l.cjs!./a.css';", 'a.css': 'b {}' },
    'loader prefix -!': { 'a.ts': "import '-!../test/zz-949-l.cjs!./a.css';", 'a.css': 'b {}' },
    'a match resource': { 'a.ts': "import './x.js!=!./a.css';", 'a.css': PAYLOAD },
    'a subpath import': { 'a.ts': "import '#send';" },
    'a query on a module TypeScript resolves': {
      'a.ts': "import './b?raw';",
      'b.ts': 'export {};',
    },
    'a query by require': { 'a.cjs': "require('./b.cjs?x');", 'b.cjs': '' },
    'require.context': {
      'a.js': "const c = require.context('../test', true); c.keys().forEach(c);",
    },
    'import.meta.webpackHot': { 'a.ts': 'import.meta.webpackHot?.accept();' },
    'a worker by new URL': { 'a.ts': "new Worker(new URL('../test/w.ts', import.meta.url));" },
    'import.meta held': { 'a.mjs': 'const meta = import.meta; meta.webpackContext(dir);' },
    'a webpack free variable': { 'a.ts': '__webpack_modules__[id]();' },
    'a magic comment': { 'a.ts': "await import(/* webpackIgnore: true */ './b');", 'b.ts': '' },
    // webpack's own order picks another file than TypeScript (#949 r2 self-review).
    'a file webpack tries first, by its exact name': {
      'a.ts': "import './payload';",
      payload: PAYLOAD,
      'payload.ts': 'export {};',
    },
    'a raw file beside its .ts completion': {
      'a.ts': "import './payload.txt';",
      'payload.txt': PAYLOAD,
      'payload.txt.ts': 'export {};',
    },
    'a stylesheet beside its .ts completion': {
      'a.ts': "import './p.css';",
      'p.css': PAYLOAD,
      'p.css.ts': 'export {};',
    },
    'an .mjs before a directory index': {
      'a.ts': "import './x.test';",
      'x.test.mjs': PAYLOAD,
      'x.test/index.ts': 'export {};',
    },
    'an extensionless directory index': {
      'a.ts': "import '@/zz-949-an-extensionless-directory-index/d';",
      'd/index': PAYLOAD,
      'd/index.ts': 'export {};',
    },
    'AMD define': { 'a.js': "define(['./payload.txt'], function () {});", 'payload.txt': PAYLOAD },
    'a jsxImportSource pragma': {
      'a.tsx': '/** @jsxImportSource @/test/zz-949-jsx */\nexport const x = <div />;',
    },
    'module.hot.accept': { 'a.js': "module.hot.accept('./payload.txt');", 'payload.txt': PAYLOAD },
    'a stylesheet by require': { 'a.cjs': "require('./a.css');", 'a.css': 'b {}' },
    'a stylesheet outside src/ by name': { 'a.ts': "import 'pkg/a.css';" },
  };
  const ALLOWED_ROWS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    'a stylesheet that exists': { 'a.ts': "import './a.css';", 'a.css': 'b {}' },
    'a directory index and a module.exports': {
      'a.ts': "import './d';",
      'd/index.ts': 'export {};',
      'b.cjs': 'module.exports = {};',
    },
    'a stylesheet by @/': { 'a.ts': "import '@/zz-949-a-stylesheet-by-/a.css';", 'a.css': 'b {}' },
  };
  const dirOf = (label: string) => `src/zz-949-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const at = (id: string) => join(WEB_ROOT, id);
  const virtual = new Map<string, string>([
    [at('src/test/zz-949-send.ts'), PAYLOAD],
    [at('src/test/zz-949-l.cjs'), `module.exports = () => ${JSON.stringify(PAYLOAD)};`],
    [at('src/test/zz-949.css.mjs'), PAYLOAD],
    [at('src/test/zz-949.css.cjs'), PAYLOAD],
    [at('src/test/send.js'), PAYLOAD],
    ...Object.entries({ ...ROWS, ...ALLOWED_ROWS }).flatMap(([label, files]) =>
      Object.entries(files).map(
        ([file, source]) => [at(`${dirOf(label)}/${file}`), source] as const,
      ),
    ),
  ]);
  const findings = findingsIn(importGraph(virtual));
  const from = (label: string) => findings.filter((f) => f.startsWith(`${dirOf(label)}/`));

  it.each(Object.keys(ROWS))('refuses %s', (label) => {
    expect(from(label)).not.toEqual([]);
  });

  it.each(Object.keys(ALLOWED_ROWS))('lets through %s', (label) => {
    expect(from(label)).toEqual([]);
  });

  it('takes a stylesheet only as a real file: a link is loaded as what it points to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w949-'));
    try {
      writeFileSync(join(dir, 'send.js'), PAYLOAD);
      writeFileSync(join(dir, 'real.css'), 'b {}');
      symlinkSync(join(dir, 'send.js'), join(dir, 'link.css'));
      expect([
        isStylesheetFile(join(dir, 'real.css')),
        isStylesheetFile(join(dir, 'link.css')),
      ]).toEqual([true, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('models the only alias Next adds to webpack from tsconfig: @/*, with no baseUrl', () => {
    expect([COMPILER_OPTIONS.baseUrl, Object.keys(COMPILER_OPTIONS.paths ?? {})]).toEqual([
      undefined,
      ['@/*'],
    ]);
  });

  it('refuses what the bundler serves or resolves around the graph', () => {
    const graph = importGraph(
      new Map([
        [at('public/send.js'), PAYLOAD],
        [at('public/icon.png'), ''],
        [at('src/zz-949-dir/package.json'), '{ "browser": "./send.txt" }'],
        [at('package.json'), '{ "name": "web", "browser": { "./src/a.ts": "./src/send.txt" } }'],
      ]),
    );
    expect(findingsIn(graph)).toEqual(expect.arrayContaining(graph.refused));
    expect(graph.refused).toEqual([
      'public/send.js is served as is from public/ and may execute: refused',
      'src/zz-949-dir/package.json can remap what the bundler resolves (main, browser, imports): refused',
      'package.json sets browser, which the bundler may resolve by: refused',
    ]);
  });
});

it('FU-219 runs transport lint on every executable root (aliases, reflection, computed loaders)', () => {
  const roots = Object.entries(WEB_ROOT_FILES)
    .filter(([, role]) => role === 'portal')
    .map(([id]) => id);
  const command = JSON.parse(readFileSync(join(WEB_ROOT, 'package.json'), 'utf8')).scripts.lint;
  for (const root of roots) expect(command.split(/\s+/)).toContain(root);
  const probes = [
    "const g = globalThis; g['fet' + 'ch']('/v1/x', { method: 'POST' });",
    "Reflect['g' + 'et'](globalThis, 'fet' + 'ch')('/v1/x');",
    "process['getBuiltin' + 'Module']('node:http').request('/v1/x');",
    "process['getBuiltinModule']('node:http').request('/v1/x');",
    "import * as m from 'node:module'; m['create' + 'Require'](import.meta.url)(target);",
    "eval('fet' + 'ch')('/v1/x');",
    "new Function('return fetch')()('/v1/x');",
  ];
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { ESLint } from 'eslint';
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const { roots, probes } = JSON.parse(input);
    const lint = new ESLint(); const counts = [];
    for (const root of roots) for (const probe of probes) {
      const [result] = await lint.lintText(probe, { filePath: root });
      counts.push(result.messages.filter(m => m.ruleId === 'internal/raw-http').length);
    }
    process.stdout.write(JSON.stringify(counts));
  `,
    ],
    { cwd: WEB_ROOT, input: JSON.stringify({ roots, probes }), encoding: 'utf8', timeout: 30000 },
  );
  expect(result.status).toBe(0);
  const counts = JSON.parse(result.stdout) as number[];
  expect(counts).toHaveLength(roots.length * probes.length);
  for (const count of counts) expect(count).toBeGreaterThan(0);
}, 35000);

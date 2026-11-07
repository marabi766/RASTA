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
 *     and no replay deadline;
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

import { join } from 'node:path';

import ts from 'typescript';

import { WEB_ROOT, WEB_ROOT_FILES, importGraph, isRoot } from '@/test/import-graph';

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
  for (const id of graph.checked) {
    // `internal/raw-http` (lint: global aliases, reflection, computed names) skips test files.
    if (!isRoot(id))
      findings.push(`${id} is named as a test but ships: a checked module imports it`);
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
          if (!GATEWAY_EXPORTS.has(name.imported))
            findings.push(`${at} imports ${name.imported} from the gateway, not reviewed`);
          if (name.imported === 'callGateway')
            (EXEMPT.has(id) ? transportNames : gatewayNames).add(name.local);
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
  'a gateway require': { 'a.js': "const g = require('../server/gateway');" },
  'a load it cannot name': { 'a.ts': 'await import(where);' },
  'a property of something else': { 'a.ts': 'mod.callGateway({ path });' },
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
  expect(isRoot('src/app/fixtures-admin/actions.ts')).toBe(true);
  for (const id of ['src/a.spec.ts', 'src/test/x.ts', 'src/app/x/order-fixture.ts'])
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

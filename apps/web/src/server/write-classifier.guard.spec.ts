/**
 * @jest-environment node
 */

/**
 * Every write to the gateway is classified by the writer, and only by it (FU-189,
 * PR-880 F2; checklist A1, E11).
 *
 * `writeThroughGateway` (`write.ts`) is where an answer becomes an outcome, and
 * its one rule is that `UNAVAILABLE` — the kind every form renders as "failed,
 * nothing changed, you can resend" — is returned only on proof: a refusal the
 * platform proved, or a send that never left this portal. A `5xx` is
 * `UNKNOWN_OUTCOME` (`write.spec.ts` sweeps every status and body). That makes a
 * caller's `UNAVAILABLE → FAILED` right by construction — as long as no module
 * sends a write some other way and reads the status itself.
 *
 * This holds every shipped module to that: outside `write.ts` (the writer) and
 * `gateway.ts` (which defines it), `callGateway` is only ever called as a read —
 * an object literal with no method other than `GET`, no body, no idempotency key
 * and no replay deadline. Anything it cannot prove is a read is a finding (fail
 * closed): a spread, an argument that is not a literal, the function passed on as
 * a value, imported under another name or through a namespace, or re-exported.
 */

import ts from 'typescript';

import { fileOf, kindOf, sourceModules, sourceOf } from '@/test/module-discovery';

/** The writer, and the module that defines `callGateway`. */
const EXEMPT = new Set(['server/write', 'server/gateway']);
/** Any of these makes a gateway call a write. */
const WRITE_PROPERTIES = new Set(['method', 'body', 'idempotencyKey', 'replayDeadline']);

const isGatewayModule = (specifier: string) => /(^|\/)gateway$/.test(specifier);

/** Every way `source` could send a write to the gateway without the writer. */
function gatewayWritesIn(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kindOf(fileName),
  );
  const findings: string[] = [];
  const at = (node: ts.Node, what: string) =>
    findings.push(
      `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${what}`,
    );

  // The names `callGateway` is bound to here.
  const local = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (!isGatewayModule(statement.moduleSpecifier.text)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        at(statement, 'imports the gateway as a namespace');
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text !== 'callGateway') continue;
          if (element.propertyName) at(element, 'imports callGateway under another name');
          local.add(element.name.text);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isGatewayModule(statement.moduleSpecifier.text)
    ) {
      at(statement, 're-exports from the gateway');
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [specifier] = node.arguments;
      if (!specifier || !ts.isStringLiteralLike(specifier) || isGatewayModule(specifier.text)) {
        at(node, 'loads the gateway (or a module it cannot name) at run time');
      }
    }
    if (
      ts.isIdentifier(node) &&
      node.text === 'callGateway' &&
      !local.has(node.text) &&
      !ts.isImportSpecifier(node.parent)
    ) {
      at(node, 'reaches callGateway other than through its import');
    }
    if (ts.isIdentifier(node) && local.has(node.text) && !ts.isImportSpecifier(node.parent)) {
      const call = node.parent;
      if (!ts.isCallExpression(call) || call.expression !== node) {
        at(node, 'uses callGateway as a value');
      } else {
        const [argument] = call.arguments;
        if (!argument || !ts.isObjectLiteralExpression(argument)) {
          at(call, 'calls callGateway with an argument that is not an object literal');
        } else {
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
            if (!WRITE_PROPERTIES.has(name)) continue;
            const isGet =
              name === 'method' &&
              ts.isPropertyAssignment(property) &&
              ts.isStringLiteral(property.initializer) &&
              property.initializer.text === 'GET';
            if (!isGet) at(property, `sends a write (${name}) past the writer`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

/**
 * The modules that may reach the network themselves, each with what it reaches. Any
 * other module that references `fetch` or `credentialFetch` as a value could send a
 * write that no writer classifies, so it is a finding (fail closed).
 */
const RAW_FETCH: Readonly<Record<string, string>> = {
  'server/gateway': 'the gateway transport the writer (and every read) uses',
  'server/credential-fetch': 'the raw credential boundary itself (Q-155)',
  'server/oidc': 'the identity provider’s token endpoint, not the gateway',
  'server/signed-url-upload':
    'the bytes to object storage; the document is registered through the writer (asset-documents.ts)',
  'lib/session-refusal': 'the browser’s GET of this portal’s own /auth/session',
};
const RAW = new Set(['fetch', 'credentialFetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);
/** Modules that open a connection without `fetch`. */
const NETWORK_MODULES =
  /^(node:)?(http|https|http2|net|tls|dgram)$|^(undici|axios|got|node-fetch|ky)(\/|$)/;
const GLOBALS = new Set(['globalThis', 'window', 'self', 'global']);

/** Every place `source` reaches the network without the gateway transport. */
function rawFetchesIn(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kindOf(fileName),
  );
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    const line = () => file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    // `globalThis['fetch']`, `Reflect.get(globalThis, 'fetch')`: the name as a string.
    if (
      ts.isStringLiteralLike(node) &&
      RAW.has(node.text) &&
      !ts.isImportDeclaration(node.parent)
    ) {
      findings.push(`${fileName}:${line()} names ${node.text} as a string`);
    }
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
            node.arguments[0] &&
            ts.isStringLiteralLike(node.arguments[0])
          ? node.arguments[0].text
          : null;
    if (specifier !== null && NETWORK_MODULES.test(specifier)) {
      findings.push(`${fileName}:${line()} opens connections with ${specifier}`);
    }
    if (ts.isIdentifier(node) && RAW.has(node.text)) {
      const parent = node.parent;
      const named =
        // A type (`typeof fetch`), or a name declared or read off something else.
        ts.isTypeQueryNode(parent) ||
        ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) &&
          (ts.isPropertyAccessExpression(parent) ? parent.name : parent.right) === node &&
          !(
            ts.isPropertyAccessExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            GLOBALS.has(parent.expression.text)
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
      if (!named) {
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        findings.push(`${fileName}:${line} reaches the network with ${node.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

const MODULES = sourceModules(['.']);

it('finds the portal’s modules, the writer and the gateway among them', () => {
  expect(MODULES.length).toBeGreaterThan(200);
  for (const exempt of EXEMPT) expect(MODULES).toContain(exempt);
});

it('sends every gateway write through the writer: outside it, callGateway only reads', () => {
  const findings = MODULES.filter((name) => !EXEMPT.has(name)).flatMap((name) =>
    gatewayWritesIn(sourceOf(name), fileOf(name)),
  );
  expect(findings).toEqual([]);
});

it('sees the reads it lets through (the detector is not blind)', () => {
  const readers = MODULES.filter(
    (name) => !EXEMPT.has(name) && /\bcallGateway\s*[<(]/.test(sourceOf(name)),
  );
  expect(readers.length).toBeGreaterThan(20);
});

it('reaches the network only through the gateway transport, outside a reviewed list', () => {
  for (const name of Object.keys(RAW_FETCH)) expect(MODULES).toContain(name);
  const findings = MODULES.filter((name) => RAW_FETCH[name] === undefined).flatMap((name) =>
    rawFetchesIn(sourceOf(name), fileOf(name)),
  );
  expect(findings).toEqual([]);
  // Not blind: each listed module is found reaching it.
  for (const name of Object.keys(RAW_FETCH)) {
    if (name === 'server/signed-url-upload' || name === 'server/credential-fetch') continue;
    expect(rawFetchesIn(sourceOf(name), fileOf(name))).not.toEqual([]);
  }
});

describe('the raw-fetch detector', () => {
  const findingsOf = (source: string) => rawFetchesIn(source, 'probe.ts');

  it('lets a type and an unrelated name through', () => {
    expect(
      findingsOf('type F = typeof fetch; const o = { fetch: 1 }; o.fetch; function f(fetch: F) {}'),
    ).toEqual([]);
  });

  it.each([
    ['a call', "fetch('http://gateway.test/v1/x', { method: 'POST' });"],
    ['a global call', "globalThis.fetch('/v1/x', { method: 'POST' });"],
    ['the boundary', "credentialFetch(url, { method: 'POST' });"],
    ['the function passed on', 'const send = fetch;'],
    ['a shorthand', 'run({ fetch });'],
    ['the name as a string', "globalThis['fetch']('/v1/x', { method: 'POST' });"],
    ['node:https', "import { request } from 'node:https';"],
    ['http by require', "const http = require('http');"],
    ['undici', "import { request } from 'undici';"],
    ['XMLHttpRequest', 'new XMLHttpRequest();'],
  ])('finds %s', (_label, source) => {
    expect(findingsOf(source)).not.toEqual([]);
  });
});

describe('the detector, on each way a write could bypass the writer', () => {
  const IMPORT = "import { callGateway } from '@/server/gateway';\n";
  const findingsOf = (source: string) => gatewayWritesIn(source, 'probe.ts');

  it('lets a read through', () => {
    expect(findingsOf(`${IMPORT}callGateway<X>({ baseUrl, path: '/v1/x', credential });`)).toEqual(
      [],
    );
    expect(findingsOf(`${IMPORT}callGateway({ baseUrl, path, method: 'GET' });`)).toEqual([]);
  });

  it.each([
    ['a write method', `${IMPORT}callGateway({ baseUrl, path, method: 'POST' });`],
    ['a computed method', `${IMPORT}callGateway({ baseUrl, path, method });`],
    ['a body', `${IMPORT}callGateway({ baseUrl, path, body: {} });`],
    ['an idempotency key', `${IMPORT}callGateway({ baseUrl, path, idempotencyKey: k });`],
    ['a replay deadline', `${IMPORT}callGateway({ baseUrl, path, replayDeadline: d });`],
    ['a spread', `${IMPORT}callGateway({ ...call });`],
    ['an argument that is not a literal', `${IMPORT}callGateway(call);`],
    ['a computed property', `${IMPORT}callGateway({ ['method']: 'POST' });`],
    ['the function passed on', `${IMPORT}const send = callGateway;`],
    ['another name', "import { callGateway as send } from './gateway';\nsend({ path });"],
    [
      'a namespace',
      "import * as gateway from '../server/gateway';\ngateway.callGateway({ path });",
    ],
    ['a re-export', "export { callGateway } from './gateway';"],
    ['a dynamic import', "const { callGateway } = await import('./gateway');"],
    ['a require', "const gateway = require('@/server/gateway');"],
    ['a computed import', 'await import(where);'],
    ['a property of something else', 'mod.callGateway({ path });'],
  ])('finds %s', (_label, source) => {
    expect(findingsOf(source)).not.toEqual([]);
  });
});

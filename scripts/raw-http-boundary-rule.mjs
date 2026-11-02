import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * The audited transport implementations: the only files that may reach a raw
 * HTTP primitive (Q-155 Follow-up 1). Exact repository-relative files, never a
 * directory or a pattern — `raw-http-boundary-rule.test.mjs` holds every entry
 * to an existing file and a reason. Everything else sends through one of them.
 */
export const AUDITED_TRANSPORTS = Object.freeze({
  'packages/nest-common/src/http/internal-fetch.ts':
    'internalFetch: refuses all five redirect statuses before reading the body (#423)',
  'apps/web/src/server/credential-fetch.ts':
    "credentialFetch: the portal's copy of internalFetch for bearer and token-endpoint calls (Q-155)",
  'apps/web/src/server/signed-url-upload.ts':
    "the signed storage URL PUT, sent with redirect: 'error' so the capability never moves",
  'apps/web/src/lib/session-refusal.ts':
    "browser same-origin GET /auth/session; the browser's own cookie, no credential set by code",
  'scripts/credential-fetch.mjs': 'credentialFetch for root scripts (the Grafana probe)',
  'packages/testing/src/guarded-http.ts':
    'guardedFetch and guardRequestContext: the E2E helper transport, refuses every redirect',
  'packages/testing/src/redirect-probe.ts':
    'test servers only; hands specs the real fetch before they stub the global (it sends nothing)',
  'tests/e2e/src/http.ts': "send(): redirect: 'manual' and the five statuses refused (Q-155)",
  'tests/e2e/src/expect.ts':
    "where Playwright's request API enters the harness, wrapped in guardRequestContext",
  'apps/web/e2e/expect.ts':
    "where Playwright's request API enters the browser suite, wrapped in guardRequestContext",
});

/** Globals that send HTTP themselves, or reach `fetch` from a string (`eval`, `Function`). */
const RAW_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'eval', 'Function']);
/** Names of the global object: any of them reaches `fetch` by member, alias or reflection. */
const GLOBAL_OBJECTS = new Set([
  'globalThis',
  'window',
  'self',
  'global',
  'frames',
  'parent',
  'top',
]);
/** Modules that are HTTP clients through and through: any value import is a raw sender. */
const CLIENT_MODULES =
  /^(?:undici|axios|node-fetch|got|superagent|ky|cross-fetch|isomorphic-fetch|make-fetch-happen|needle|phin|playwright|playwright-core)(?:\/|$)/;
/** Node's HTTP modules: their server half is not a sender, their client half is. */
const NODE_HTTP = /^(?:node:)?(?:http|https|http2)$/;
const NODE_HTTP_CLIENT = new Set([
  'request',
  'get',
  'connect',
  'Agent',
  'globalAgent',
  'ClientRequest',
]);
/** Playwright Test: only these value exports carry no unguarded API request context. */
const PLAYWRIGHT_TEST = /^@playwright\/test(?:\/|$)/;
const PLAYWRIGHT_SAFE = new Set(['expect', 'defineConfig', 'devices']);
/** Unambiguous module names: as the first argument of any call they load a client. */
const UNAMBIGUOUS =
  /^(?:node:(?:http|https|http2)|undici|axios|node-fetch|playwright-core)(?:\/|$)/;
const LOADER = /^(?:require|getBuiltinModule|_load|import)$/;
const TS_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ChainExpression',
]);

const staticKey = (member) => {
  if (!member.computed)
    return member.property.type === 'Identifier' ? member.property.name : undefined;
  const key = member.property;
  if (key.type === 'Literal') return String(key.value);
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
    return key.quasis[0].value.cooked;
  return undefined;
};
const literalText = (node) =>
  node?.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : node?.type === 'TemplateLiteral' && node.expressions.length === 0
      ? node.quasis[0].value.cooked
      : undefined;
const inTypePosition = (node) => {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === 'TSTypeQuery' || at.type === 'TSTypeReference') return true;
    if (at.type !== 'TSQualifiedName' && at.type !== 'MemberExpression') return false;
  }
  return false;
};
/** `Symbol.for('…')` or a well-known `Symbol.x`. */
const isSymbol = (node) =>
  (node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Symbol' &&
    staticKey(node.callee) === 'for') ||
  (node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.object.name === 'Symbol' &&
    !node.computed);
const PATH_BUILDERS = new Set(['join', 'resolve']);
/**
 * A loader argument that can only be a file: `join(ROOT, …)` / `resolve(dir, …)`
 * from a non-literal base, or `pathToFileURL(…).href` — directly or through a
 * `const`. Anything else computed (a variable holding `'undici'`, a
 * concatenation) may name a client module and is refused.
 */
const isFilePath = (node, scopeOf, seen = new Set()) => {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === 'MemberExpression' && staticKey(node) === 'href') {
    const url = node.object;
    return (
      url.type === 'CallExpression' &&
      (url.callee.name ?? staticKey(url.callee)) === 'pathToFileURL'
    );
  }
  if (node.type === 'CallExpression') {
    const callee =
      node.callee.type === 'MemberExpression' ? staticKey(node.callee) : node.callee.name;
    const [base] = node.arguments;
    return (
      PATH_BUILDERS.has(callee) &&
      base !== undefined &&
      literalText(base) === undefined &&
      base.type !== 'SpreadElement'
    );
  }
  if (node.type === 'Identifier') {
    let scope = scopeOf(node);
    while (scope) {
      const variable = scope.set.get(node.name);
      if (variable) {
        const [def] = variable.defs;
        return (
          variable.defs.length === 1 &&
          def.type === 'Variable' &&
          def.parent.kind === 'const' &&
          isFilePath(def.node.init, scopeOf, seen)
        );
      }
      scope = scope.upper;
    }
  }
  return false;
};
const isSenderModule = (name) =>
  CLIENT_MODULES.test(name) || NODE_HTTP.test(name) || PLAYWRIGHT_TEST.test(name);

/**
 * Q-155 Follow-up 1: the transport boundary, enforced independently of how a
 * credential is spelled. Outside {@link AUDITED_TRANSPORTS}, any reference to a
 * raw HTTP primitive is an error — the global `fetch`/`XMLHttpRequest` (bound,
 * called, reflected, returned or aliased), the global object by alias,
 * reflection or computed member, an HTTP client module (static, dynamic or
 * `require`d), Node's client `request`/`get`, and Playwright's unguarded API
 * request contexts (`playwright.request`, `page.request`, `context.request`).
 * Type positions (`typeof fetch`) and type-only imports are not references.
 */
export default {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { playwright: { type: 'boolean' } },
        additionalProperties: false,
      },
    ],
    messages: {
      raw: 'Raw HTTP primitive ({{what}}) outside an audited transport. Send through internalFetch (@rasta/nest-common), credentialFetch (apps/web, scripts), or guardedFetch / guardRequestContext (@rasta/testing) in E2E code; new transports join AUDITED_TRANSPORTS in scripts/raw-http-boundary-rule.mjs with a reason.',
    },
  },
  create(context) {
    const file = relative(ROOT, context.physicalFilename).split(sep).join('/');
    if (Object.hasOwn(AUDITED_TRANSPORTS, file)) return {};
    // In the E2E trees `request` is Playwright's API context; elsewhere it is a domain word.
    const playwright = context.options[0]?.playwright === true;
    const scopeOf = (node) => context.sourceCode.getScope(node);
    const report = (node, what) => context.report({ node, messageId: 'raw', data: { what } });
    const typeOnly = (declaration, specifier) =>
      declaration.importKind === 'type' ||
      declaration.exportKind === 'type' ||
      specifier?.importKind === 'type' ||
      specifier?.exportKind === 'type';

    /** An import or re-export of `source`, with its value specifiers' imported names. */
    const checkModule = (node, source, specifiers) => {
      if (!isSenderModule(source)) return;
      const values = specifiers.filter((specifier) => !typeOnly(node, specifier));
      if (typeOnly(node) || (specifiers.length > 0 && values.length === 0)) return;
      if (CLIENT_MODULES.test(source) || specifiers.length === 0) return report(node, source);
      for (const specifier of values) {
        const name =
          specifier.type === 'ImportSpecifier'
            ? (specifier.imported.name ?? specifier.imported.value)
            : specifier.type === 'ExportSpecifier'
              ? (specifier.local.name ?? specifier.local.value)
              : undefined; // default or namespace: the whole module
        const raw = NODE_HTTP.test(source)
          ? name === undefined || NODE_HTTP_CLIENT.has(name)
          : name === undefined || !PLAYWRIGHT_SAFE.has(name);
        if (raw) report(specifier, `${source} ${name ?? '(whole module)'}`);
      }
    };

    /** A reference to the global object: only `typeof`, `in` and a plain, safe member are inert. */
    const checkGlobalObject = (identifier) => {
      let node = identifier;
      while (TS_WRAPPERS.has(node.parent?.type) && node.parent.expression === node)
        node = node.parent;
      const parent = node.parent;
      if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return;
      if (parent.type === 'BinaryExpression' && parent.operator === 'in' && parent.right === node)
        return;
      if (parent.type === 'MemberExpression' && parent.object === node) {
        if (parent.computed && isSymbol(parent.property)) return; // a symbol never names `fetch`
        const key = staticKey(parent);
        if (key === undefined) return report(parent, `${identifier.name}[computed]`);
        if (RAW_GLOBALS.has(key) || GLOBAL_OBJECTS.has(key))
          return report(parent, `${identifier.name}.${key}`);
        return;
      }
      report(identifier, `${identifier.name} as a value`);
    };

    return {
      ImportDeclaration(node) {
        checkModule(node, node.source.value, node.specifiers);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkModule(node, node.source.value, node.specifiers);
      },
      ExportAllDeclaration(node) {
        if (isSenderModule(node.source.value) && node.exportKind !== 'type')
          report(node, node.source.value);
      },
      TSImportEqualsDeclaration(node) {
        const name = literalText(node.moduleReference.expression);
        if (node.moduleReference.type === 'TSExternalModuleReference' && node.importKind !== 'type')
          if (name === undefined || isSenderModule(name)) report(node, name ?? 'require(computed)');
      },
      ImportExpression(node) {
        const name = literalText(node.source);
        if (name === undefined) {
          if (!isFilePath(node.source, scopeOf)) report(node, 'import(computed)');
        } else if (isSenderModule(name)) report(node, `import('${name}')`);
      },
      CallExpression(node) {
        const callee =
          node.callee.type === 'MemberExpression' ? staticKey(node.callee) : node.callee.name;
        const name = literalText(node.arguments[0]);
        if (LOADER.test(callee ?? '')) {
          if (node.arguments.length > 0 && name === undefined) {
            if (!isFilePath(node.arguments[0], scopeOf)) report(node, `${callee}(computed)`);
          } else if (name !== undefined && isSenderModule(name))
            report(node, `${callee}('${name}')`);
        } else if (name !== undefined && UNAMBIGUOUS.test(name)) {
          // `createRequire(…)('undici')`, an aliased loader: the module name gives it away.
          report(node, `load '${name}'`);
        }
      },
      // Playwright's API request contexts that bypass the guarded fixture.
      MemberExpression(node) {
        if (!playwright || inTypePosition(node) || staticKey(node) !== 'request') return;
        if (node.parent.type === 'CallExpression' && node.parent.callee === node) return; // route.request()
        report(node, '.request (Playwright API context)');
      },
      VariableDeclarator(node) {
        if (!playwright || node.id.type !== 'ObjectPattern') return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const key = property.computed ? literalText(property.key) : property.key.name;
          if (key === undefined || key === 'request')
            report(property, `destructured ${key ?? '[computed]'} (may be .request)`);
        }
      },
      'Program:exit'() {
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const reference of scope.references) {
            const { identifier, resolved } = reference;
            // A binding the module itself declares is not the global.
            if (resolved && resolved.defs.length > 0) continue;
            if (inTypePosition(identifier)) continue;
            if (RAW_GLOBALS.has(identifier.name)) report(identifier, identifier.name);
            else if (GLOBAL_OBJECTS.has(identifier.name)) checkGlobalObject(identifier);
          }
        }
      },
    };
  },
};

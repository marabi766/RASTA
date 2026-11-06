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
  'scripts/test-stall-watchdog.mjs':
    'audited static local watchdog worker; telemetry only, no executable strings or HTTP sender',
  'scripts/workspace-module.mjs':
    'runtime-checked local workspace loads only; refuses dependency paths and escapes before loading',
  'scripts/credential-fetch.mjs': 'credentialFetch for root scripts (the Grafana probe)',
  'packages/testing/src/guarded-http.ts':
    'guardedFetch and guardRequestContext: the E2E helper transport, refuses every redirect',
  'packages/testing/src/redirect-probe.ts':
    'test servers only; the captured sender reaches only this active probe’s own loopback origins',
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
const NODE_HTTP_SAFE = new Set([
  'createServer',
  'createSecureServer',
  'Server',
  'ServerResponse',
  'IncomingMessage',
  'STATUS_CODES',
  'METHODS',
  'validateHeaderName',
  'validateHeaderValue',
  'maxHeaderSize',
  'getDefaultSettings',
  'getPackedSettings',
  'getUnpackedSettings',
  'constants',
  'sensitiveHeaders',
]);
/** Playwright Test: only these value exports carry no unguarded API request context. */
const PLAYWRIGHT_TEST = /^@playwright\/test(?:\/|$)/;
const PLAYWRIGHT_SAFE = new Set(['expect', 'defineConfig', 'devices']);
/** Unambiguous module names: as the first argument of any call they load a client. */
const UNAMBIGUOUS =
  /^(?:node:(?:http|https|http2)|undici|axios|node-fetch|playwright-core)(?:\/|$)/;
/** Global and imported process capabilities share this closed policy. */
const NODE_PROCESS = /^(?:node:)?process$/;
const PROCESS_LISTENERS = new Set(['on', 'once', 'off', 'removeListener']);
const PROCESS_SAFE = new Set([
  'getuid',
  'env',
  'argv',
  'execPath',
  'platform',
  'arch',
  'pid',
  'ppid',
  'cwd',
  'exit',
  'exitCode',
  'stdout',
  'stderr',
  'stdin',
  ...PROCESS_LISTENERS,
  'kill',
  'hrtime',
  'memoryUsage',
  'versions',
  'version',
  'uptime',
  'emitWarning',
]);
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
const isSenderModule = (source) => {
  let name = source;
  try {
    name = new URL(source).href;
  } catch {
    /* A bare module specifier. */
  }
  return (
    /^(?:file:|[\\/]|[A-Za-z]:)/i.test(name) ||
    CLIENT_MODULES.test(name) ||
    NODE_HTTP.test(name) ||
    NODE_PROCESS.test(name) ||
    PLAYWRIGHT_TEST.test(name) ||
    /^(?:(?:node:)?(?:vm|worker_threads|module)(?:\/|$)|(?:data|blob|https?):)/.test(name) ||
    /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(name)
  );
};

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
      if (NODE_PROCESS.test(source)) {
        for (const specifier of values) {
          if (['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(specifier.type)) {
            for (const variable of context.sourceCode.getDeclaredVariables(specifier))
              for (const reference of variable.references)
                if (!inTypePosition(reference.identifier)) checkProcessObject(reference.identifier);
            continue;
          }
          const name =
            specifier.type === 'ImportSpecifier'
              ? (specifier.imported.name ?? specifier.imported.value)
              : (specifier.local?.name ?? specifier.local?.value);
          if (!PROCESS_SAFE.has(name)) report(specifier, 'process loader export');
          else if (PROCESS_LISTENERS.has(name)) {
            // These functions return process: only direct calls with discarded results are safe.
            if (specifier.type !== 'ImportSpecifier') report(specifier, 'process listener export');
            else
              for (const variable of context.sourceCode.getDeclaredVariables(specifier))
                for (const reference of variable.references)
                  if (!inTypePosition(reference.identifier))
                    checkListenerCall(reference.identifier);
          }
        }
        return;
      }
      if (/^(?:node:)?module$/.test(source)) {
        for (const specifier of values) {
          if (
            specifier.type !== 'ImportSpecifier' ||
            !['createRequire', 'isBuiltin', 'builtinModules', 'syncBuiltinESMExports'].includes(
              specifier.imported.name,
            )
          )
            report(specifier, 'module loader export');
          else if (specifier.imported.name === 'createRequire')
            for (const variable of context.sourceCode.getDeclaredVariables(specifier))
              for (const reference of variable.references) {
                const call = reference.identifier.parent;
                if (call.type !== 'CallExpression' || call.callee !== reference.identifier)
                  report(reference.identifier, 'createRequire escaping');
                else
                  checkLoaderResult(
                    call,
                    context.sourceCode.getText(call.arguments[0] ?? call) === 'import.meta.url',
                  );
              }
        }
        return;
      }
      if (/^(?:node:)?worker_threads$/.test(source)) {
        for (const specifier of values)
          if (
            specifier.type !== 'ImportSpecifier' ||
            !['workerData', 'parentPort', 'isMainThread', 'threadId'].includes(
              specifier.imported.name,
            )
          )
            report(specifier, 'worker code execution');
        return;
      }
      if ((!NODE_HTTP.test(source) && !PLAYWRIGHT_TEST.test(source)) || specifiers.length === 0)
        return report(node, source);
      for (const specifier of values) {
        const name =
          specifier.type === 'ImportSpecifier'
            ? (specifier.imported.name ?? specifier.imported.value)
            : specifier.type === 'ExportSpecifier'
              ? (specifier.local.name ?? specifier.local.value)
              : undefined; // default or namespace: the whole module
        const raw = NODE_HTTP.test(source)
          ? name === undefined || !NODE_HTTP_SAFE.has(name)
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
        if (
          parent.computed &&
          registryKey(parent.property) &&
          cleanIntrinsics(node) &&
          slotUse(parent)
        )
          return;
        const key = staticKey(parent);
        if (key === undefined) return report(parent, `${identifier.name}[computed]`);
        if (
          RAW_GLOBALS.has(key) ||
          GLOBAL_OBJECTS.has(key) ||
          ['require', 'module', 'process'].includes(key)
        )
          return report(parent, `${identifier.name}.${key}`);
        return;
      }
      report(identifier, `${identifier.name} as a value`);
    };

    const checkListenerCall = (node) => {
      const call = node.parent;
      if (
        call.type !== 'CallExpression' ||
        call.callee !== node ||
        !(
          call.parent.type === 'ExpressionStatement' ||
          (call.parent.type === 'UnaryExpression' && call.parent.operator === 'void')
        )
      )
        report(node, 'process listener result exposes loaders');
    };
    const unwrap = (node) => {
      while (TS_WRAPPERS.has(node?.type)) node = node.expression;
      return node;
    };
    const variableFor = (identifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (scope && !scope.set.has(identifier.name)) scope = scope.upper;
      return scope?.set.get(identifier.name);
    };
    const nativeObject = (node, name) =>
      node?.type === 'Identifier' &&
      node.name === name &&
      !variableFor(node)?.defs.some((definition) => !erased(definition));
    // Refuse aliases, writes, reflection and indirect uses anywhere in this file.
    // Ordering is irrelevant: a patch after registration can run before a later read.
    const cleanIntrinsics = (node) => {
      for (const name of ['Symbol', 'Object']) {
        let scope = context.sourceCode.getScope(node);
        while (scope && !scope.set.has(name)) scope = scope.upper;
        if (scope?.set.get(name)?.defs.some((definition) => !erased(definition))) return false;
      }
      return context.sourceCode.scopeManager.scopes.every((scope) =>
        scope.references.every(({ identifier }) => {
          if (inTypePosition(identifier)) return true;
          if (identifier.name === 'WeakMap' && nativeObject(identifier, 'WeakMap')) {
            const parent = identifier.parent;
            return (
              (parent.type === 'NewExpression' &&
                parent.callee === identifier &&
                parent.arguments.length === 0) ||
              (parent.type === 'BinaryExpression' &&
                parent.operator === 'instanceof' &&
                parent.right === identifier)
            );
          }
          if (['Symbol', 'Object'].includes(identifier.name)) {
            if (!nativeObject(identifier, identifier.name)) return true;
            const member = identifier.parent;
            return (
              member.type === 'MemberExpression' &&
              member.object === identifier &&
              (identifier.name === 'Symbol'
                ? ['for', 'keyFor'].includes(staticKey(member))
                : [
                    'keys',
                    'values',
                    'entries',
                    'fromEntries',
                    'hasOwn',
                    'is',
                    'freeze',
                    'seal',
                    'isFrozen',
                    'isSealed',
                    'isExtensible',
                    'preventExtensions',
                    'create',
                    'assign',
                    'defineProperty',
                    'defineProperties',
                    'getOwnPropertyDescriptor',
                    'getOwnPropertyDescriptors',
                    'getOwnPropertyNames',
                    'getOwnPropertySymbols',
                    'getPrototypeOf',
                    'setPrototypeOf',
                  ].includes(staticKey(member))) &&
              member.parent.type === 'CallExpression' &&
              member.parent.callee === member
            );
          }
          if (GLOBAL_OBJECTS.has(identifier.name)) {
            const member = identifier.parent;
            if (
              member.type === 'MemberExpression' &&
              ((staticKey(member) === undefined && !registryKey(member.property)) ||
                ['Symbol', 'Object', 'WeakMap'].includes(staticKey(member)))
            )
              return false;
          }
          return true;
        }),
      );
    };
    const constInitializer = (node, seen) => {
      const variable = variableFor(node);
      if (!variable || seen.has(variable) || variable.defs.length !== 1) return;
      const definition = variable.defs[0];
      if (
        definition.parent?.kind !== 'const' ||
        definition.node.id !== definition.name ||
        variable.references.some((reference) => reference.isWrite() && !reference.init)
      )
        return;
      seen.add(variable);
      return definition.node.init;
    };
    // Literal Symbol.for strings only, optionally through immutable local keys.
    const registryKey = (input, seen = new Set()) => {
      const node = unwrap(input);
      if (node?.type === 'Identifier') return registryKey(constInitializer(node, seen), seen);
      return (
        node?.type === 'CallExpression' &&
        node.arguments.length === 1 &&
        node.arguments[0].type === 'Literal' &&
        typeof node.arguments[0].value === 'string' &&
        node.callee.type === 'MemberExpression' &&
        nativeObject(node.callee.object, 'Symbol') &&
        staticKey(node.callee) === 'for'
      );
    };
    // No unknown/callable values. WeakMap() is the existing refusal registry;
    // arbitrary constructors, factories, methods, accessors and spreads refuse.
    const plainValue = (input, seen = new Set()) => {
      const node = unwrap(input);
      if (node?.type === 'Identifier') return plainValue(constInitializer(node, seen), seen);
      if (node?.type === 'Literal') return true;
      if (node?.type === 'ArrayExpression')
        return node.elements.every((entry) => entry === null || plainValue(entry, new Set(seen)));
      if (node?.type === 'ObjectExpression')
        return node.properties.every(
          (property) =>
            property.type === 'Property' &&
            property.kind === 'init' &&
            !property.method &&
            !property.computed &&
            (property.key.name ?? property.key.value) !== '__proto__' &&
            plainValue(property.value, new Set(seen)),
        );
      return (
        node?.type === 'NewExpression' &&
        nativeObject(node.callee, 'WeakMap') &&
        node.arguments.length === 0
      );
    };
    const slotUse = (member) => {
      let node = member;
      while (TS_WRAPPERS.has(node.parent?.type)) node = node.parent;
      const parent = node.parent;
      if (parent.type === 'AssignmentExpression' && parent.left === node)
        return parent.operator === '=' && plainValue(parent.right);
      return (
        !(parent.type === 'CallExpression' && parent.callee === node) &&
        !(parent.type === 'TaggedTemplateExpression' && parent.tag === node) &&
        !(parent.type === 'UnaryExpression' && parent.operator === 'delete') &&
        ![
          'UpdateExpression',
          'Property',
          'ArrayPattern',
          'AssignmentPattern',
          'RestElement',
          'ForOfStatement',
          'ForInStatement',
        ].includes(parent.type)
      );
    };
    const plainDescriptor = (input) => {
      const node = unwrap(input);
      return (
        node?.type === 'ObjectExpression' &&
        node.properties.length === 1 &&
        node.properties[0].type === 'Property' &&
        node.properties[0].kind === 'init' &&
        !node.properties[0].method &&
        !node.properties[0].computed &&
        (node.properties[0].key.name ?? node.properties[0].key.value) === 'value' &&
        plainValue(node.properties[0].value)
      );
    };
    const checkProcessObject = (identifier) => {
      let node = identifier;
      while (TS_WRAPPERS.has(node.parent?.type) && node.parent.expression === node)
        node = node.parent;
      const parent = node.parent;
      if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return;
      if (
        parent.type === 'BinaryExpression' &&
        ['===', '!=='].includes(parent.operator) &&
        [parent.left, parent.right].some(
          (operand) => operand.type === 'Literal' && operand.value === null,
        )
      )
        return;
      if (
        parent.type === 'VariableDeclarator' &&
        parent.init === node &&
        parent.id.type === 'Identifier' &&
        parent.parent.kind === 'const' &&
        parent.parent.parent.type !== 'ExportNamedDeclaration'
      ) {
        for (const variable of context.sourceCode.getDeclaredVariables(parent))
          for (const reference of variable.references)
            if (reference.identifier !== parent.id && !inTypePosition(reference.identifier))
              checkProcessObject(reference.identifier);
        return;
      }
      if (
        parent.type === 'MemberExpression' &&
        parent.object === node &&
        parent.computed &&
        registryKey(parent.property) &&
        cleanIntrinsics(node) &&
        slotUse(parent)
      )
        return;
      if (
        parent.type === 'CallExpression' &&
        parent.arguments[0] === node &&
        parent.callee.type === 'MemberExpression' &&
        nativeObject(parent.callee.object, 'Object') &&
        staticKey(parent.callee) === 'defineProperty' &&
        parent.arguments.length === 3 &&
        registryKey(parent.arguments[1]) &&
        cleanIntrinsics(node) &&
        plainDescriptor(parent.arguments[2])
      ) {
        // defineProperty returns its target: retaining that result exposes process.
        checkListenerCall(parent.callee);
        return;
      }
      if (
        parent.type === 'MemberExpression' &&
        parent.object === node &&
        PROCESS_SAFE.has(staticKey(parent))
      ) {
        if (PROCESS_LISTENERS.has(staticKey(parent))) checkListenerCall(parent);
        return;
      }
      report(identifier, 'process loader capability');
    };

    // A loader may only be called in place with a literal, or used for resolution.
    // No alias/argument/return/bind escapes: unanalysable loader uses are refused.
    const checkLoaderResult = (node, trustedBase = true) => {
      const parent = node.parent;
      if (
        parent.type === 'MemberExpression' &&
        parent.object === node &&
        staticKey(parent) === 'resolve'
      )
        return;
      if (parent.type === 'CallExpression' && parent.callee === node) {
        if (trustedBase) checkLoaderCall(parent);
        else report(parent, 'unproven loader base');
        return;
      }
      if (
        parent.type === 'VariableDeclarator' &&
        parent.init === node &&
        parent.id.type === 'Identifier' &&
        parent.parent.kind === 'const' &&
        parent.parent.parent.type !== 'ExportNamedDeclaration'
      ) {
        for (const variable of context.sourceCode.getDeclaredVariables(parent))
          for (const reference of variable.references)
            if (reference.identifier !== parent.id)
              checkLoaderResult(reference.identifier, trustedBase);
        return;
      }
      if (
        parent.type === 'MemberExpression' &&
        staticKey(parent) === 'main' &&
        parent.parent.type === 'BinaryExpression' &&
        ['===', '!=='].includes(parent.parent.operator)
      )
        return;
      report(node, 'loader escaping');
    };
    const checkLoaderCall = (node) => {
      const name = literalText(node.arguments[0]);
      if (name === undefined || isSenderModule(name)) report(node, 'unproven module load');
    };
    const erased = (definition) => {
      if (
        definition.type === 'Type' ||
        definition.parent?.importKind === 'type' ||
        definition.node?.importKind === 'type'
      )
        return true;
      for (let at = definition.node; at; at = at.parent)
        if (at.declare || at.type === 'TSDeclareFunction') return true;
      return false;
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
          report(node, 'import(computed)');
        } else if (isSenderModule(name)) report(node, `import('${name}')`);
      },
      CallExpression(node) {
        const callee =
          node.callee.type === 'MemberExpression' ? staticKey(node.callee) : node.callee.name;
        const name = literalText(node.arguments[0]);
        if (LOADER.test(callee ?? '')) {
          if (node.arguments.length > 0 && name === undefined) {
            report(node, `${callee}(computed)`);
          } else if (name !== undefined && isSenderModule(name))
            report(node, `${callee}('${name}')`);
        } else if (name !== undefined && UNAMBIGUOUS.test(name)) {
          // `createRequire(…)('undici')`, an aliased loader: the module name gives it away.
          report(node, `load '${name}'`);
        }
      },
      // Playwright's API request contexts that bypass the guarded fixture.
      MemberExpression(node) {
        if (!inTypePosition(node) && staticKey(node) === 'constructor') {
          let at = node;
          while (TS_WRAPPERS.has(at.parent?.type)) at = at.parent;
          if (!(at.parent.type === 'MemberExpression' && staticKey(at.parent) === 'name'))
            report(node, 'constructor string execution');
        }
        if (!playwright || inTypePosition(node) || staticKey(node) !== 'request') return;
        if (node.parent.type === 'CallExpression' && node.parent.callee === node) return; // route.request()
        report(node, '.request (Playwright API context)');
      },
      ObjectPattern(node) {
        for (const property of node.properties)
          if (
            property.type === 'Property' &&
            (property.computed
              ? literalText(property.key)
              : (property.key.name ?? property.key.value)) === 'constructor'
          )
            report(property, 'constructor extraction');
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
            if (resolved?.defs.some((definition) => !erased(definition))) continue;
            if (inTypePosition(identifier)) continue;
            if (RAW_GLOBALS.has(identifier.name)) report(identifier, identifier.name);
            else if (GLOBAL_OBJECTS.has(identifier.name)) checkGlobalObject(identifier);
            else if (identifier.name === 'require') checkLoaderResult(identifier);
            else if (identifier.name === 'createRequire') {
              const call = identifier.parent;
              if (call.type === 'CallExpression' && call.callee === identifier)
                checkLoaderResult(
                  call,
                  context.sourceCode.getText(call.arguments[0] ?? call) === 'import.meta.url',
                );
              else report(identifier, 'unproven loader factory');
            } else if (identifier.name === 'process') checkProcessObject(identifier);
            else if (identifier.name === 'module') {
              const parent = identifier.parent;
              if (
                !(
                  parent.type === 'MemberExpression' &&
                  parent.object === identifier &&
                  staticKey(parent) === 'exports'
                ) &&
                !(parent.type === 'UnaryExpression' && parent.operator === 'typeof') &&
                parent.type !== 'BinaryExpression'
              )
                report(identifier, 'module loader capability');
            }
          }
        }
      },
    };
  },
};

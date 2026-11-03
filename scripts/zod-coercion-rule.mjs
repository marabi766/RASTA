import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Exact repository paths, independent of ESLint's cwd. No basename/test glob exemption.
export const REVIEWED_FILES = {
  'packages/config/src/env.ts': 'Shared startup schemas consume process.env strings.',
  'apps/web/src/server/env.ts': 'Portal startup loader consumes process.env strings.',
  'services/analytics-service/src/config/env.ts': 'Analytics startup environment strings.',
  'services/api-gateway/src/config/env.ts': 'Gateway startup environment strings.',
  'services/asset-service/src/config/env.ts': 'Asset startup environment strings.',
  'services/audit-service/src/config/env.ts': 'Audit startup environment strings.',
  'services/construction-service/src/config/env.ts': 'Construction startup environment strings.',
  'services/contract-service/src/config/env.ts': 'Contract startup environment strings.',
  'services/document-service/src/config/env.ts': 'Document startup environment strings.',
  'services/economic-service/src/config/env.ts': 'Economic startup environment strings.',
  'services/fleet-service/src/config/env.ts': 'Fleet startup environment strings.',
  'services/identity-service/src/config/env.ts': 'Identity startup environment strings.',
  'services/inventory-service/src/config/env.ts': 'Inventory startup environment strings.',
  'services/maintenance-service/src/config/env.ts': 'Maintenance startup environment strings.',
  'services/marketplace-service/src/config/env.ts': 'Marketplace startup environment strings.',
  'services/notification-service/src/config/env.ts': 'Notification startup environment strings.',
  'services/organization-service/src/config/env.ts': 'Organization startup environment strings.',
  'services/procurement-service/src/config/env.ts': 'Procurement startup environment strings.',
  'packages/config/src/env-issues.spec.ts':
    'Intentionally exercises environment coercion diagnostics.',
  'packages/config/src/boolean-env.spec.ts':
    'Proves why Boolean coercion is unsuitable for env flags.',
  'packages/contracts/src/common/number-input.spec.ts':
    'Compares guarded conversion with coercion.',
  'packages/nest-common/src/pipes/zod-validation.golden.spec.ts':
    'Historical coercion diagnostic oracle.',
};

const zodModule = (name) => typeof name === 'string' && /^(zod)(\/|$)/.test(name);
const capability = (name) =>
  ![
    'NEVER',
    'regexes',
    'ZodIssueCode',
    'ZodFirstPartyTypeKind',
    'ZodError',
    '$ZodError',
    '$ZodAsyncError',
    '$ZodEncodeError',
  ].includes(name);
// Zod 4 classic/mini/core signatures: only these slots can enable primitive coercion.
// Shapes, enum entries, parse input and metadata are deliberately absent.
const primitiveFactories = new Set(
  `string number bigint boolean date int float32 float64
  int32 uint32 int64 uint64 email guid uuid uuidv4 uuidv6 uuidv7 url httpUrl emoji nanoid
  cuid cuid2 ulid xid ksuid ipv4 mac ipv6 cidrv4 cidrv6 base64 base64url e164 creditCard iban
  hostname hex currencyCode jwt datetime date time duration isodatetime isodate isotime isoduration`
    .toLowerCase()
    .split(/\s+/),
);
const COERCING_API = -2;
// Namespace factories, core Class-first factories and derived definitions share one signature.
const optionsIndex = ({ name, raw, method, owner } = {}) => {
  if (!raw) return -1;
  const api = name?.replace(/^_/, '');
  const core = name?.startsWith('_') ? 1 : 0;
  if (raw && api?.startsWith('coerced')) return COERCING_API;
  const kind = api?.replace(/^\$?Zod(?:Mini)?/, '').toLowerCase();
  if (name === 'clone') return method ? 0 : raw ? 1 : 0;
  if (name === 'constructor') return 0;
  if (name === 'create') return owner ? optionsIndex({ name: owner, raw: true }) : 0;
  if (api === 'hash') return 1 + core;
  if (api === 'stringFormat') return 2 + core;
  return raw &&
    (primitiveFactories.has(kind) ||
      /^\$?Zod(?:Mini)?(?:String|CustomString|Number|BigInt|Boolean|Date|ISO)/.test(name))
    ? core
    : -1;
};
const unwrap = (node) => {
  while (
    node &&
    [
      'TSAsExpression',
      'TSTypeAssertion',
      'TSNonNullExpression',
      'TSSatisfiesExpression',
      'ChainExpression',
      'AwaitExpression',
    ].includes(node.type)
  ) {
    node = node.expression ?? node.argument;
  }
  return node;
};

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      boundary:
        'Unchecked zod coercion is forbidden. Use numberInput for numbers; use the money parser for bigint strings.',
      escape:
        'Do not export or pass raw zod capabilities through helpers. Export validated schemas instead.',
      preprocess:
        'Preprocessors must be inline; numeric conversion belongs in numberInput (Number only) or the money parser (bigint).',
    },
  },
  create(context) {
    const file = relative(ROOT, resolve(context.filename)).replaceAll('\\', '/');
    const source = context.sourceCode;
    const report = (node, messageId = 'boundary') => {
      if (messageId === 'escape' || !Object.hasOwn(REVIEWED_FILES, file))
        context.report({ node, messageId });
    };
    const variable = (node) => {
      for (let scope = source.getScope(node); scope; scope = scope.upper) {
        if (scope.set.has(node.name)) return scope.set.get(node.name);
      }
    };
    const globalName = (node, name) =>
      node?.type === 'Identifier' && node.name === name && !variable(node)?.defs.length;
    const constant = (raw, seen = new Set()) => {
      const node = unwrap(raw);
      if (!node) return undefined;
      if (node.type === 'Literal') return node.value;
      if (node.type === 'TemplateLiteral' && !node.expressions.length)
        return node.quasis[0].value.cooked;
      if (node.type === 'BinaryExpression' && node.operator === '+') {
        const a = constant(node.left, seen),
          b = constant(node.right, seen);
        if (typeof a === 'string' && typeof b === 'string') return a + b;
      }
      if (node.type === 'Identifier') {
        const v = variable(node),
          def = v?.defs[0];
        if (def?.type === 'Variable' && def.parent.kind === 'const' && !seen.has(v)) {
          return constant(def.node.init, new Set([...seen, v]));
        }
      }
    };
    const key = (node) =>
      !node.computed && node.key?.type === 'Identifier'
        ? node.key.name
        : !node.computed && node.property?.type === 'Identifier'
          ? node.property.name
          : constant(node.key ?? node.property);
    const imported = (def) =>
      def?.type === 'ImportBinding' &&
      zodModule(def.parent.source?.value) &&
      def.parent.importKind !== 'type' &&
      def.node.importKind !== 'type';
    const access = (result, name) => ({
      ...result,
      raw: (result.raw || ['constructor', 'clone'].includes(name)) && capability(name),
      method: !result.raw,
      owner: result.name,
      name,
    });
    // Follow binding definitions, not spellings: aliases, nested destructuring and const chains.
    // Call results are schemas, distinct from raw namespaces/factories which may not escape.
    const origin = (raw, seen = new Set()) => {
      const node = unwrap(raw);
      if (!node) return undefined;
      if (node.type === 'Identifier') {
        const v = variable(node);
        if (!v || seen.has(v)) return undefined;
        const next = new Set([...seen, v]);
        let resolved;
        for (const def of v.defs) {
          if (imported(def)) {
            const name = def.node.imported?.name ?? def.node.imported?.value;
            return { raw: capability(name), name };
          }
          if (def.type === 'Variable') {
            let result = origin(def.node.init, next);
            const path = [];
            let binding = def.name;
            while (binding && binding !== def.node.id) {
              if (binding.parent?.type === 'Property') path.unshift(key(binding.parent));
              binding = binding.parent;
            }
            for (const name of path) if (result) result = access(result, name);
            if (result?.raw) resolved = result;
            resolved ??= result;
          }
        }
        // Mutable aliases cannot erase provenance by being reassigned later.
        for (const ref of v.references) {
          if (ref.writeExpr && !ref.init) {
            let result = origin(ref.writeExpr, next);
            const path = [];
            for (
              let binding = ref.identifier;
              binding && binding.type !== 'AssignmentExpression';
              binding = binding.parent
            ) {
              if (binding.parent?.type === 'Property') path.unshift(key(binding.parent));
            }
            for (const name of path) if (result) result = access(result, name);
            if (result?.raw) resolved = result;
            resolved ??= result;
          }
        }
        return resolved?.raw && v.references.some((ref) => ref.isWrite() && !ref.init)
          ? { ...resolved, ambiguous: true }
          : resolved;
      }
      if (node.type === 'MemberExpression') {
        const result = origin(node.object, seen);
        if (result) return access(result, key(node));
      }
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        if (globalName(node.callee, 'require') && zodModule(constant(node.arguments[0])))
          return { raw: true };
        if (origin(node.callee, seen)) return { raw: false };
      }
      if (node.type === 'ImportExpression' && zodModule(constant(node.source)))
        return { raw: true };
    };
    const walk = (node, visit) => {
      if (!node) return;
      visit(node);
      for (const name of source.visitorKeys[node.type] ?? []) {
        const children = node[name];
        for (const child of Array.isArray(children) ? children : [children])
          if (child) walk(child, visit);
      }
    };
    const numeric = (raw, seen = new Set()) => {
      const node = unwrap(raw);
      if (!node) return false;
      if (['Number', 'BigInt', 'parseInt', 'parseFloat'].some((name) => globalName(node, name)))
        return true;
      if (node.type === 'MemberExpression') {
        if (['call', 'apply', 'bind'].includes(key(node))) return numeric(node.object, seen);
        return (
          ['globalThis', 'global', 'window', 'Number'].some((name) =>
            globalName(node.object, name),
          ) && ['Number', 'BigInt', 'parseInt', 'parseFloat'].includes(key(node))
        );
      }
      if (node.type === 'Identifier') {
        const v = variable(node),
          def = v?.defs[0];
        if (!seen.has(v) && def?.type === 'Variable')
          return numeric(def.node.init, new Set([...seen, v]));
      }
      return false;
    };
    const options = (raw, seen = new Set(), requireKnown = false) => {
      const node = unwrap(raw);
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.type === 'Identifier') {
        const binding = variable(node),
          def = binding?.defs[0];
        if (def?.type === 'Variable' && def.node.init) options(def.node.init, seen, requireKnown);
        else if (requireKnown) report(node);
        if (requireKnown)
          for (const ref of binding?.references ?? []) {
            if (ref.writeExpr && !ref.init) options(ref.writeExpr, seen, true);
            let read = ref.identifier;
            while (read.parent && unwrap(read.parent) === unwrap(read)) read = read.parent;
            const member = read.parent;
            if (
              member.type === 'MemberExpression' &&
              member.object === read &&
              (key(member) === 'coerce' || key(member) === undefined) &&
              ['AssignmentExpression', 'UpdateExpression'].includes(member.parent.type) &&
              (member.parent.left ?? member.parent.argument) === member &&
              constant(member.parent.right) !== false
            )
              report(member);
            // A helper/container could mutate an otherwise empty options object
            // (Object.assign, defineProperty, or an opaque alias). Do not guess
            // what happened there. Primitive message strings cannot be mutated.
            if (
              !ref.isRead() ||
              (constant(def?.node.init) !== undefined &&
                !binding.references.some((r) => r.isWrite() && !r.init))
            )
              continue;
            if (member.type === 'VariableDeclarator' && member.init === read) {
              options(member.id, seen, true);
            } else if (
              member.type === 'AssignmentExpression' &&
              member.right === read &&
              member.left.type === 'Identifier'
            ) {
              options(member.left, seen, true);
            } else if (
              (['CallExpression', 'NewExpression'].includes(member.type) &&
                member.arguments.includes(read) &&
                optionsIndex(origin(member.callee)) !== member.arguments.indexOf(read)) ||
              [
                'Property',
                'ArrayExpression',
                'ReturnStatement',
                'ExportSpecifier',
                'ExportDefaultDeclaration',
              ].includes(member.type) ||
              (member.type === 'MemberExpression' &&
                member.parent.type === 'CallExpression' &&
                member.parent.callee === member)
            )
              report(read);
          }
      } else if (requireKnown && !['ObjectExpression', 'Literal'].includes(node.type)) report(node);
      if (node.type === 'ObjectExpression')
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') options(prop.argument, seen, requireKnown);
          else if (
            (key(prop) === 'coerce' ||
              (requireKnown &&
                (key(prop) === undefined ||
                  key(prop) === '__proto__' ||
                  ['get', 'set'].includes(prop.kind)))) &&
            constant(prop.value) !== false
          )
            report(prop);
        }
    };
    const pattern = (node) => {
      if (node.type !== 'ObjectPattern') return;
      walk(node, (child) => {
        if (child.type === 'Property' && (key(child) === 'coerce' || key(child) === undefined))
          report(child);
        if (child.type === 'RestElement') report(child, 'escape');
      });
    };
    const escape = (raw) => {
      if (!origin(raw)?.raw) return;
      let node = raw;
      while (node.parent && unwrap(node.parent) === unwrap(node)) node = node.parent;
      const parent = node.parent;
      if (parent.type.startsWith('TS')) return;
      if (
        (parent.type === 'MemberExpression' && parent.object === node) ||
        (parent.type === 'BinaryExpression' &&
          parent.operator === 'instanceof' &&
          parent.right === node) ||
        (['CallExpression', 'NewExpression'].includes(parent.type) && parent.callee === node) ||
        (parent.type === 'VariableDeclarator' && parent.init === node) ||
        (parent.type === 'AssignmentExpression' && parent.right === node) ||
        ['ReturnStatement', 'ExportSpecifier', 'ExportDefaultDeclaration'].includes(parent.type)
      )
        return;
      // Known core factories keep their Class argument inside Zod's constructor boundary.
      const factory = origin(parent.callee);
      if (
        parent.type === 'CallExpression' &&
        /^\$?Zod/.test(origin(raw).name ?? '') &&
        factory?.raw &&
        factory.name?.startsWith('_') &&
        (optionsIndex(factory) > 0 || optionsIndex(factory) === COERCING_API) &&
        parent.arguments[0] === node
      )
        return;
      report(node, 'escape');
    };
    return {
      TSImportEqualsDeclaration(node) {
        if (
          node.importKind !== 'type' &&
          node.moduleReference.type === 'TSExternalModuleReference' &&
          zodModule(constant(node.moduleReference.expression))
        )
          report(node, 'escape');
      },
      ImportSpecifier(node) {
        if (
          imported({ type: 'ImportBinding', node, parent: node.parent }) &&
          (node.imported.name ?? node.imported.value) === 'coerce'
        )
          report(node);
      },
      MemberExpression(node) {
        escape(node);
        if (
          origin(node.object)?.raw &&
          (['coerce', 'call', 'apply', 'bind'].includes(key(node)) || key(node) === undefined)
        )
          report(node);
      },
      // Raw namespaces/factories may be used locally, but never handed to an
      // opaque helper or container which would erase their import provenance.
      'Program:exit'() {
        for (const scope of source.scopeManager.scopes)
          for (const binding of scope.variables) {
            for (const ref of binding.references) {
              if (ref.isRead() && !ref.isTypeReference) escape(ref.identifier);
            }
          }
      },
      VariableDeclarator(node) {
        if (origin(node.init)?.raw) pattern(node.id);
      },
      CallExpression(node) {
        escape(node);
        const factory = origin(node.callee);
        if (!factory) return;
        if (
          factory.raw &&
          factory.ambiguous &&
          origin(unwrap(node.callee)?.object)?.name !== 'coerce'
        ) {
          report(node, factory.name === 'preprocess' ? 'preprocess' : 'boundary');
          return;
        }
        const index = optionsIndex(factory);
        if (index === COERCING_API) report(node);
        if (index >= 0) options(node.arguments[index], new Set(), true);
        if (factory.name !== 'preprocess') return;
        const callback = unwrap(node.arguments[0]);
        if (
          !callback ||
          !['ArrowFunctionExpression', 'FunctionExpression'].includes(callback.type)
        ) {
          report(node, 'preprocess');
          return;
        }
        // Follow local helper bodies; opaque helpers cannot prove that conversion
        // is guarded. Only the audited Number helper may call Number itself.
        const stringValue = (raw, at, seen = new Set()) => {
          const value = unwrap(raw);
          if (value?.type === 'Literal') return typeof value.value === 'string';
          if (
            value?.type === 'CallExpression' &&
            value.callee.type === 'MemberExpression' &&
            ['trim', 'normalize', 'replace'].includes(key(value.callee))
          ) {
            return stringValue(value.callee.object, at, seen);
          }
          if (value?.type !== 'Identifier') return false;
          const binding = variable(value),
            def = binding?.defs[0];
          if (binding?.references.some((ref) => ref.isWrite() && !ref.init)) return false;
          if (def?.name.typeAnnotation?.typeAnnotation.type === 'TSStringKeyword') return true;
          if (
            def?.type === 'Variable' &&
            !seen.has(binding) &&
            stringValue(def.node.init, at, new Set([...seen, binding]))
          )
            return true;
          const guarded = (test) =>
            test?.type === 'LogicalExpression' && test.operator === '&&'
              ? guarded(test.left) || guarded(test.right)
              : test?.type === 'BinaryExpression' &&
                test.operator === '===' &&
                test.left.type === 'UnaryExpression' &&
                test.left.operator === 'typeof' &&
                test.left.argument.type === 'Identifier' &&
                variable(test.left.argument) === binding &&
                constant(test.right) === 'string';
          for (let child = at, parent = at.parent; parent; child = parent, parent = parent.parent) {
            if (
              ['ConditionalExpression', 'IfStatement'].includes(parent.type) &&
              parent.consequent === child &&
              guarded(parent.test)
            )
              return true;
          }
          return false;
        };
        const unsafe = (raw, seen = new Set()) => {
          const callee = unwrap(raw);
          if (numeric(callee)) {
            return !(
              file === 'packages/contracts/src/common/number-input.ts' &&
              globalName(callee, 'Number')
            );
          }
          if (['Promise', 'setTimeout'].some((name) => globalName(callee, name))) return false;
          if (callee?.type === 'Identifier') {
            const binding = variable(callee),
              def = binding?.defs[0];
            const fn = def?.type === 'FunctionName' ? def.node : unwrap(def?.node.init);
            if (
              seen.has(binding) ||
              binding?.references.some((ref) => ref.isWrite() && !ref.init) ||
              !['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
                fn?.type,
              )
            )
              return true;
            let result = false;
            walk(fn, (child) => {
              if (
                ['CallExpression', 'NewExpression'].includes(child.type) &&
                unsafe(child.callee, new Set([...seen, binding]))
              )
                result = true;
            });
            return result;
          }
          if (callee?.type === 'MemberExpression') {
            const name = key(callee);
            if (
              ['trim', 'normalize', 'replace'].includes(name) &&
              stringValue(callee.object, callee)
            )
              return false;
            const receiver =
              callee.object.type === 'Identifier' ? variable(callee.object)?.defs[0] : undefined;
            if (
              name === 'includes' &&
              receiver?.type === 'Variable' &&
              receiver.node.init?.type === 'ArrayExpression'
            )
              return false;
            if (
              (globalName(callee.object, 'Object') && name === 'keys') ||
              (globalName(callee.object, 'Array') && name === 'isArray')
            )
              return false;
            if (
              name === 'addIssue' &&
              callee.object.type === 'Identifier' &&
              variable(callee.object)?.defs.some(
                (def) =>
                  def.type === 'Parameter' &&
                  def.node === callback &&
                  def.name === callback.params[1],
              )
            )
              return false;
          }
          return true;
        };
        walk(callback, (child) => {
          if (['CallExpression', 'NewExpression'].includes(child.type) && unsafe(child.callee))
            report(child, 'preprocess');
        });
      },
      NewExpression(node) {
        const factory = origin(node.callee);
        if (factory?.raw && factory.ambiguous) {
          report(node);
          return;
        }
        const index = optionsIndex(factory);
        if (index === COERCING_API) report(node);
        if (index >= 0) options(node.arguments[index], new Set(), true);
      },
      ImportExpression: escape,
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type' && zodModule(node.source.value)) report(node, 'escape');
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return;
        if (
          zodModule(node.source?.value) &&
          node.specifiers.some(
            (s) => s.exportKind !== 'type' && capability(s.local?.name ?? s.local?.value),
          )
        )
          report(node, 'escape');
        for (const spec of node.specifiers)
          if (!node.source && spec.exportKind !== 'type' && origin(spec.local)?.raw)
            report(spec, 'escape');
        if (node.declaration?.type === 'VariableDeclaration')
          for (const decl of node.declaration.declarations) {
            if (origin(decl.init)?.raw) report(decl, 'escape');
          }
      },
      ExportDefaultDeclaration(node) {
        if (origin(node.declaration)?.raw) report(node, 'escape');
      },
      ReturnStatement(node) {
        if (origin(node.argument)?.raw) report(node, 'escape');
      },
      AssignmentExpression(node) {
        if (origin(node.right)?.raw && node.left.type === 'ObjectPattern') {
          pattern(node.left);
          return;
        }
        if (node.left.type !== 'Identifier' && origin(node.right)?.raw) report(node, 'escape');
      },
    };
  },
};

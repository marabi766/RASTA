import { dirname, relative, resolve } from 'node:path';
import { verifiedCallbackHelper } from './zod-callback-helpers.mjs';
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
const DATA_RESULTS = new Set(
  `parse safeParse parseAsync safeParseAsync spa encode decode
  encodeAsync decodeAsync safeEncode safeDecode safeEncodeAsync safeDecodeAsync validate
  validateAsync isOptional isNullable toJSONSchema config getErrorMap formatError flattenError
  treeifyError prettifyError registry get`.split(/\s+/),
);
const SCHEMA_FIELDS = new Set(['element', 'keyType', 'valueType', 'innerType', 'in', 'out']);
const DEFINITION_SCHEMA_FIELDS = new Set(
  'element keyType valueType innerType in out left right rest catchall type schema input output args returns'.split(
    ' ',
  ),
);
const SCHEMA_CONTAINERS = {
  shape: 'shape',
  options: 'list',
  items: 'list',
  optionsMap: 'map',
  def: 'definition',
  _def: 'definition',
  _zod: 'internals',
};
const SAFE_RESULTS = new Set(
  'safeParse safeParseAsync spa safeEncode safeDecode safeEncodeAsync safeDecodeAsync'.split(' '),
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
  if (name === 'init' && (owner === 'constructor' || /^\$?Zod/.test(owner ?? ''))) return 1;
  if (name === 'create') return owner ? optionsIndex({ name: owner, raw: true }) : 0;
  if (api === 'hash') return 1 + core;
  if (api === 'stringFormat') return 2 + core;
  return raw &&
    (primitiveFactories.has(kind) ||
      /^\$?Zod(?:Mini)?(?:String|CustomString|Number|BigInt|Boolean|Date|ISO)/.test(name))
    ? core
    : -1;
};
const FUNCTION_TYPES = new Set(
  'ArrowFunctionExpression FunctionExpression FunctionDeclaration'.split(' '),
);
const STRING_METHODS = new Set(
  'trim normalize replace split slice substring toUpperCase toLowerCase startsWith endsWith'.split(
    ' ',
  ),
);
const STRING_RESULTS = new Set(
  'trim normalize replace slice substring toUpperCase toLowerCase'.split(' '),
);
const SCHEMA_VALIDATORS = new Set(
  'min max length regex trim normalize toLowerCase toUpperCase refine describe meta brand readonly nonempty prefault'.split(
    ' ',
  ),
);
const CALLBACK_APIS = new Set(['preprocess', 'transform', 'overwrite']);
// Callback slots and definition fields are capabilities, independent of call/new syntax.
const callbackSignature = ({ name, owner, raw, receiverSchema } = {}) => {
  if (!raw && !receiverSchema) return {};
  const init = name === 'init';
  if (name === 'create' || init) name = owner;
  if (name === 'createWithPreprocess') return { slot: 0 };
  const api = name?.replace(/^_/, '');
  const offset = raw && name?.startsWith('_') && ['transform'].includes(api) ? 1 : 0;
  return {
    slot: CALLBACK_APIS.has(api) ? offset : undefined,
    guardOptions: receiverSchema
      ? { min: 1, max: 1, length: 1, regex: 1, refine: 1, nonempty: 0 }[api]
      : undefined,
    fields:
      api === 'codec'
        ? 2
        : ['clone', 'constructor'].includes(api)
          ? (name === 'clone' && !receiverSchema) || init
            ? 1
            : 0
          : /^\$?Zod(?:Mini)?(?:Transform|Preprocess|Effects|Codec|CheckOverwrite)/.test(api)
            ? init
              ? 1
              : 0
            : undefined,
  };
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
        'Schema callbacks must use verified conversions and helpers; use numberInput or the money parser.',
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
    const reviewedHelper = (raw) => {
      if (raw?.type !== 'Identifier') return undefined;
      const binding = variable(raw),
        def = binding?.defs[0];
      if (binding?.references.some((ref) => ref.isWrite() && !ref.init)) return undefined;
      let path = file,
        name = raw.name,
        spelling = file.split('/').pop();
      if (def?.type === 'ImportBinding') {
        const from = def.parent.source.value;
        path = from.startsWith('@/')
          ? `apps/web/src/${from.slice(2)}`
          : from.startsWith('.')
            ? relative(ROOT, resolve(dirname(context.filename), from))
            : from;
        name = def.node.imported?.name;
        spelling = from.split('/').pop();
      }
      return verifiedCallbackHelper(ROOT, path.replace(/\.[cm]?[jt]sx?$/, ''), name, {
        spelling,
        definition: def?.type,
      });
    };
    const imported = (def) =>
      def?.type === 'ImportBinding' &&
      zodModule(def.parent.source?.value) &&
      def.parent.importKind !== 'type' &&
      def.node.importKind !== 'type';
    const mergeOrigins = (...results) => {
      const variants = results.flatMap((result) => result?.variants ?? (result ? [result] : []));
      if (variants.length < 2) return variants[0];
      const primary =
        variants.find((result) => result.raw) ??
        variants.find((result) => result.opaque) ??
        variants.find((result) => result.schema) ??
        variants.find((result) => result.container) ??
        variants[0];
      return { ...primary, variants };
    };
    const access = (result, name, receiver) => {
      // Containers carry schema capability, never raw namespace capability. Their
      // children must survive aliases and patterns without tainting ordinary data.
      if (name?.rest || result.opaque) return result;
      if (result.variants)
        return mergeOrigins(
          ...result.variants.map((variant) =>
            access(
              { ...variant, ambiguous: result.ambiguous || variant.ambiguous },
              name,
              receiver,
            ),
          ),
        );
      if (name === undefined && result.container === 'literal')
        return mergeOrigins(
          ...result.children.values(),
          result.spread && access(result.spread, name),
        );
      if (name === undefined && result.container && !['shape', 'list'].includes(result.container))
        return { opaque: true };
      if (result.container) {
        if (result.container === 'literal')
          return mergeOrigins(
            result.children.get(name) ??
              result.children.get(String(name)) ??
              result.children.get(Number(name)),
            result.children.get(undefined),
            result.spread && access(result.spread, name),
          );
        if (result.container === 'map')
          return name === 'get' ? { elementMethod: true } : { opaque: true };
        if (result.container === 'definition' && name === 'getter') return { elementMethod: true };
        if (result.container === 'result') return name === 'data' ? result.data : undefined;
        if (['shape', 'list'].includes(result.container)) {
          if (result.container === 'list' && name === 'at')
            return { elementMethod: true, ambiguous: result.ambiguous };
          if (result.container === 'list' && name === 'length') return undefined;
          return { schema: true, ambiguous: result.ambiguous };
        }
        if (result.container === 'internals' && name === 'constr')
          return { raw: true, name: 'constructor', ambiguous: result.ambiguous };
        if (result.container === 'internals' && name === 'def') return { container: 'definition' };
        if (DEFINITION_SCHEMA_FIELDS.has(name))
          return { schema: true, ambiguous: result.ambiguous };
        const container = Object.hasOwn(SCHEMA_CONTAINERS, name)
          ? SCHEMA_CONTAINERS[name]
          : undefined;
        return container ? { container, ambiguous: result.ambiguous } : undefined;
      }
      return {
        receiver: result.schema ? receiver : undefined,
        raw:
          (result.raw ||
            (result.schema &&
              (['constructor', 'clone'].includes(name) || CALLBACK_APIS.has(name)))) &&
          capability(name),
        receiverSchema: !!result.schema,
        schema: !!result.schema && SCHEMA_FIELDS.has(name),
        container:
          result.schema && Object.hasOwn(SCHEMA_CONTAINERS, name)
            ? SCHEMA_CONTAINERS[name]
            : undefined,
        ambiguous: result.ambiguous,
        method: !result.raw,
        owner: result.name,
        name,
      };
    };
    const bindingPath = (binding, root) => {
      const path = [];
      for (
        ;
        binding &&
        binding !== root &&
        ![
          'AssignmentExpression',
          'VariableDeclarator',
          'ForOfStatement',
          'ForInStatement',
        ].includes(binding.type);
        binding = binding.parent
      ) {
        if (binding.type === 'RestElement') {
          path.unshift({ rest: true });
          continue;
        }
        if (binding.parent?.type === 'AssignmentPattern' && binding.parent.left === binding)
          path.unshift({ fallback: binding.parent.right });
        if (binding.parent?.type === 'Property') path.unshift(key(binding.parent));
        if (binding.type !== 'RestElement' && binding.parent?.type === 'ArrayPattern')
          path.unshift(binding.parent.elements.indexOf(binding));
      }
      return path;
    };
    const project = (result, path, seen, receiver) => {
      for (const name of path)
        result = name?.fallback
          ? (result ?? origin(name.fallback, seen))
          : result && access(result, name, receiver);
      return result;
    };
    const iterationOrigin = (result) => {
      if (result?.container === 'list') return { schema: true };
      if (result?.container !== 'literal') return result ? { opaque: true } : undefined;
      const children = [...result.children.values(), iterationOrigin(result.spread)].filter(
        Boolean,
      );
      if (children.some((child) => child.raw)) return { raw: true, ambiguous: true };
      return mergeOrigins(...children);
    };
    // Follow binding definitions, not spellings: aliases, nested destructuring and const chains.
    // Keep schema results distinct from parsed/metadata data and raw factories.
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
            const loop = def.parent.parent;
            if (loop?.type === 'ForOfStatement') result = iterationOrigin(origin(loop.right, next));
            const path = bindingPath(def.name, def.node.id);
            result = project(result, path, next, def.node.init);
            resolved = mergeOrigins(resolved, result);
          }
        }
        // Mutable aliases cannot erase provenance by being reassigned later.
        for (const ref of v.references) {
          if (ref.writeExpr && !ref.init) {
            let result = origin(ref.writeExpr, next);
            const write = writeTarget(ref.identifier);
            if (write?.type === 'ForOfStatement') result = iterationOrigin(result);
            if (write?.type === 'ForInStatement') result = undefined;
            const path = bindingPath(ref.identifier);
            result = project(result, path, next);
            resolved = mergeOrigins(resolved, result);
          }
        }
        return (resolved?.raw || resolved?.schema || resolved?.container) &&
          v.references.some((ref) => ref.isWrite() && !ref.init)
          ? { ...resolved, ambiguous: true }
          : resolved;
      }
      if (['ObjectExpression', 'ArrayExpression'].includes(node.type)) {
        const children = new Map();
        let spread;
        for (const [index, entry] of (node.properties ?? node.elements).entries()) {
          if (!entry) continue;
          const child = origin(entry.argument ?? entry.value ?? entry, seen);
          if (!child?.raw && !child?.schema && !child?.container) continue;
          if (entry.type === 'SpreadElement') spread = mergeOrigins(spread, child);
          else children.set(node.type === 'ObjectExpression' ? key(entry) : index, child);
        }
        if (children.size || spread) return { container: 'literal', children, spread };
      }
      if (node.type === 'MemberExpression') {
        const result = origin(node.object, seen);
        if (result) return access(result, key(node), node.object);
      }
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        if (globalName(node.callee, 'require') && zodModule(constant(node.arguments[0])))
          return { raw: true };
        const factory = origin(node.callee, seen);
        if (factory) {
          if (factory.elementMethod) return { schema: true, ambiguous: factory.ambiguous };
          // v3 exposes definition shapes as thunks; classic/mini expose objects.
          if (factory.container === 'shape') return factory;
          const input = origin(node.arguments[factory.receiverSchema ? 0 : 1], seen);
          if (SAFE_RESULTS.has(factory.name)) return { container: 'result', data: input };
          const data =
            DATA_RESULTS.has(factory.name) ||
            (factory.name === 'meta' && factory.receiverSchema && !node.arguments.length);
          const inputSchema =
            ['parse', 'parseAsync', 'decode', 'decodeAsync', 'encode', 'encodeAsync'].includes(
              factory.name,
            ) && input?.schema;
          return {
            raw: false,
            schema: !!inputSchema || (!data && !!(factory.raw || factory.receiverSchema)),
          };
        }
      }
      if (node.type === 'ImportExpression' && zodModule(constant(node.source)))
        return { raw: true };
    };
    const walk = (node, visit) => {
      if (!node) return;
      if (visit(node) === false) return;
      for (const name of source.visitorKeys[node.type] ?? []) {
        const children = node[name];
        for (const child of Array.isArray(children) ? children : [children])
          if (child) walk(child, visit);
      }
    };
    const numeric = (raw, seen = new Set()) => {
      const node = unwrap(raw);
      if (!node) return false;
      if (
        ['Number', 'BigInt', 'String', 'Boolean', 'Date', 'parseInt', 'parseFloat'].some((name) =>
          globalName(node, name),
        )
      )
        return node.name;
      if (node.type === 'MemberExpression') {
        if (['call', 'apply', 'bind'].includes(key(node))) {
          const convert = numeric(node.object, seen);
          return convert && `${convert}.${key(node)}`;
        }
        return (
          ['globalThis', 'global', 'window', 'Number'].some((name) =>
            globalName(node.object, name),
          ) &&
          ['Number', 'BigInt', 'String', 'Boolean', 'Date', 'parseInt', 'parseFloat'].includes(
            key(node),
          ) &&
          key(node)
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
    // Walk the target grammar, never the RHS/default expression. This covers
    // assignment, patterns and loop targets uniformly, including member writes.
    const writeTarget = (node) => {
      for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
        if (
          (['AssignmentExpression', 'ForOfStatement', 'ForInStatement'].includes(parent.type) &&
            parent.left === node) ||
          (parent.type === 'UpdateExpression' && parent.argument === node)
        )
          return parent;
        if (
          (parent.type === 'MemberExpression' && parent.object === node) ||
          (parent.type === 'Property' &&
            parent.value === node &&
            parent.parent.type === 'ObjectPattern') ||
          (parent.type === 'AssignmentPattern' && parent.left === node) ||
          ['ObjectPattern', 'ArrayPattern', 'RestElement'].includes(parent.type) ||
          unwrap(parent) === node
        )
          continue;
        break;
      }
    };
    const enclosingFunction = (node) => {
      while (node && !FUNCTION_TYPES.has(node.type)) node = node.parent;
      return node;
    };
    const stableReceiver = (raw, at, seen = new Set()) => {
      const node = unwrap(raw);
      if (node?.type !== 'Identifier') return node?.type === 'ArrayExpression';
      const binding = variable(node);
      if (!binding || seen.has(binding)) return true;
      seen.add(binding);
      return binding.references.every((ref) => {
        if (ref.init) return true;
        if (ref.isWrite() || writeTarget(ref.identifier)) return false;
        const parent = ref.identifier.parent;
        if (parent.type === 'VariableDeclarator' && parent.init === ref.identifier)
          return stableReceiver(parent.id, at, seen);
        // A fresh local value can be returned after this synchronous use. It
        // cannot have escaped to a caller before its own construction/use.
        if (
          parent.type === 'ReturnStatement' &&
          ref.identifier.range[0] > at.range[0] &&
          ['NewExpression', 'ArrayExpression', 'Literal'].includes(
            binding.defs[0]?.node.init?.type,
          ) &&
          enclosingFunction(binding.defs[0].node) === enclosingFunction(at) &&
          enclosingFunction(ref.identifier) === enclosingFunction(at)
        )
          return true;
        return parent.type === 'MemberExpression' && parent.object === ref.identifier;
      });
    };
    const options = (raw, seen = new Set(), requireKnown = false) => {
      const node = unwrap(raw);
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.type === 'Identifier') {
        const binding = variable(node),
          def = binding?.defs[0];
        if (requireKnown && def?.type === 'Variable' && def.node.id.type !== 'Identifier')
          report(node);
        else if (def?.type === 'Variable' && def.node.init)
          options(def.node.init, seen, requireKnown);
        else if (requireKnown) report(node);
        if (requireKnown)
          for (const ref of binding?.references ?? []) {
            if (ref.writeExpr && !ref.init) options(ref.writeExpr, seen, true);
            let read = ref.identifier;
            while (read.parent && unwrap(read.parent) === unwrap(read)) read = read.parent;
            const member = read.parent;
            const write = writeTarget(ref.identifier);
            if (
              write &&
              (!ref.isWrite() ||
                write.type !== 'AssignmentExpression' ||
                write.left !== ref.identifier)
            )
              report(ref.identifier);
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
        (optionsIndex(factory) > 0 ||
          optionsIndex(factory) === COERCING_API ||
          callbackSignature(factory).slot === 1) &&
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
          (origin(node.object)?.raw || (origin(node.object)?.schema && key(node) === undefined)) &&
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
      'CallExpression, NewExpression'(node) {
        escape(node);
        const factory = origin(node.callee);
        if (!factory) return;
        if (factory.schema || factory.opaque) report(node);
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
        const api = callbackSignature(factory);
        const classArgument =
          factory.name?.startsWith('_') && (api.slot === 1 || index > 0 || index === COERCING_API);
        if (classArgument) {
          const ctor = origin(node.arguments[0]);
          if (!ctor?.raw || ctor.ambiguous || !/^\$?Zod/.test(ctor.name ?? ''))
            report(node, 'preprocess');
          // Core factories may instantiate any supplied Zod class; inspect its capabilities too.
          if (index >= 0 && callbackSignature(ctor).fields !== undefined) api.fields ??= index;
        }
        const callbacks = [];
        const callbackInputs = new Map();
        if (api.slot !== undefined) callbacks.push(node.arguments[api.slot]);
        const fields = (raw, seen = new Set()) => {
          const definition = unwrap(raw);
          if (!definition || seen.has(definition)) return;
          seen.add(definition);
          if (definition.type === 'Identifier') {
            const binding = variable(definition),
              def = binding?.defs[0];
            if (
              def?.type !== 'Variable' ||
              binding.references.some(
                (ref) =>
                  (ref.isWrite() && !ref.init) ||
                  (ref.identifier.parent.type === 'MemberExpression' &&
                    ['AssignmentExpression', 'UpdateExpression'].includes(
                      ref.identifier.parent.parent.type,
                    )),
              )
            ) {
              report(definition, 'preprocess');
              return;
            }
            for (const ref of binding.references.filter((ref) => ref.isRead())) {
              const read = ref.identifier,
                parent = read.parent;
              if (parent.type === 'VariableDeclarator' && parent.init === read) {
                fields(parent.id, seen);
              } else if (
                ['CallExpression', 'NewExpression'].includes(parent.type) &&
                callbackSignature(origin(parent.callee)).fields === parent.arguments.indexOf(read)
              ) {
                // The same audited definition slot may read an immutable object again.
              } else report(read, 'preprocess');
            }
            fields(def.node.init, seen);
            return;
          }
          if (definition.type !== 'ObjectExpression') {
            if (api.fields !== index) report(definition, 'preprocess');
            return;
          }
          for (const prop of definition.properties) {
            if (
              prop.type === 'SpreadElement' ||
              key(prop) === undefined ||
              key(prop) === '__proto__' ||
              ['get', 'set'].includes(prop.kind)
            ) {
              report(prop, 'preprocess');
              continue;
            }
            if (
              ['transform', 'preprocess', 'tx', 'decode', 'encode', 'reverseTransform'].includes(
                key(prop),
              )
            ) {
              callbacks.push(prop.value);
              if (factory.name === 'codec')
                callbackInputs.set(prop.value, node.arguments[key(prop) === 'encode' ? 1 : 0]);
              if (/Zod(?:Mini)?Codec$/.test(factory.name ?? factory.owner ?? ''))
                callbackInputs.set(
                  prop.value,
                  definition.properties.find(
                    (p) => key(p) === (key(prop) === 'reverseTransform' ? 'out' : 'in'),
                  )?.value,
                );
            }
            if (key(prop) === 'effect') fields(prop.value, seen);
          }
        };
        if (api.fields !== undefined) fields(node.arguments[api.fields]);
        if (!callbacks.length) return;
        let callback;
        let callbackFn;
        let callbackInput;
        const localFunction = (raw) => {
          const value = unwrap(raw);
          if (value?.type !== 'Identifier') return value;
          const def = variable(value)?.defs[0];
          return def?.type === 'FunctionName' ? def.node : unwrap(def?.node.init);
        };
        // Follow local helper bodies; opaque helpers cannot prove that conversion
        // is guarded. Only the audited Number helper may call Number itself.
        const strict = factory.name === 'preprocess';
        // Only metadata may accompany a proof of a schema's output type.
        // Checks/when callbacks can rewrite a value after primitive validation.
        const proofOptions = (raw) => {
          const value = unwrap(raw);
          if (
            !value ||
            globalName(value, 'undefined') ||
            typeof constant(value) === 'string' ||
            value.type === 'TemplateLiteral' ||
            (value.type === 'CallExpression' &&
              reviewedHelper(value.callee) === 'string' &&
              (typeof constant(value.arguments[0]) === 'string' ||
                value.arguments[0]?.type === 'TemplateLiteral'))
          )
            return true;
          return (
            value.type === 'ObjectExpression' &&
            value.properties.every(
              (prop) =>
                prop.type === 'Property' &&
                prop.kind === 'init' &&
                ([
                  'error',
                  'errorMap',
                  'message',
                  'description',
                  'required_error',
                  'invalid_type_error',
                  'abort',
                  'path',
                  'params',
                ].includes(key(prop)) ||
                  (key(prop) === 'coerce' && constant(prop.value) === false)),
            )
          );
        };
        const stringInput = (
          raw = callbackInput ??
            (api.fields === undefined
              ? (factory.receiver ?? unwrap(node.callee)?.object)
              : undefined),
          seen = new Set(),
          kind = 'string',
        ) => {
          const schema = unwrap(raw);
          if (!schema || seen.has(schema)) return false;
          seen.add(schema);
          if (schema.type === 'Identifier') {
            const binding = variable(schema);
            if (binding?.references.some((r) => r.isWrite() && !r.init)) return false;
            return stringInput(binding?.defs[0]?.node.init, seen, kind);
          }
          if (schema.type !== 'CallExpression') return false;
          const api = origin(schema.callee);
          // Refinements may mutate array elements while returning true. A prior
          // string-element proof cannot survive an unreviewed refinement.
          if (api?.name === 'refine' && kind !== 'string') return false;
          if (
            api?.receiverSchema &&
            api.name === 'check' &&
            schema.arguments.every(
              (arg) => arg.type === 'CallExpression' && reviewedHelper(arg.callee) === 'check',
            )
          )
            return stringInput(unwrap(schema.callee)?.object, seen, kind);
          // A reviewed string-schema factory (`plainText()`): output is a string, no arguments.
          if (reviewedHelper(schema.callee) === 'string-schema')
            return kind === 'string' && !schema.arguments.length;
          const optionSlot =
            callbackSignature(api).guardOptions ??
            (api?.raw && api.name === 'array' ? 1 : optionsIndex(api));
          if (optionSlot >= 0 && !proofOptions(schema.arguments[optionSlot])) return false;
          if (api?.name === 'pipe')
            return stringInput(schema.arguments[api.receiverSchema ? 0 : 1], seen, kind);
          if (api?.raw && api.name === kind) return true;
          if (api?.raw && api.name === 'array' && kind === 'strings')
            return stringInput(schema.arguments[0]);
          return (
            api?.receiverSchema &&
            SCHEMA_VALIDATORS.has(api.name) &&
            stringInput(unwrap(schema.callee)?.object, seen, kind)
          );
        };
        const stringValue = (raw, at, seen = new Set(), parameters = new Map()) => {
          const value = unwrap(raw);
          if (value?.kind === 'string') return true;
          if (value?.type === 'TemplateLiteral') return true;
          if (
            value?.type === 'CallExpression' &&
            value.callee.type === 'MemberExpression' &&
            key(value.callee) === 'join' &&
            valueKind(value.callee.object, at, parameters) === 'strings'
          )
            return true;
          if (value?.type === 'CallExpression' && reviewedHelper(value.callee) === 'string')
            return true;
          if (value?.type === 'Literal') return typeof value.value === 'string';
          if (
            value?.type === 'CallExpression' &&
            value.callee.type === 'MemberExpression' &&
            STRING_RESULTS.has(key(value.callee))
          ) {
            return stringValue(value.callee.object, at, seen, parameters);
          }
          if (value?.type !== 'Identifier') return false;
          const binding = variable(value),
            def = binding?.defs[0];
          if (binding?.references?.some((ref) => ref.isWrite() && !ref.init)) return false;
          if (
            parameters.has(binding) &&
            !seen.has(binding) &&
            stringValue(parameters.get(binding), at, new Set([...seen, binding]), parameters)
          )
            return true;
          if (
            !strict &&
            def?.type === 'Parameter' &&
            def.node === callbackFn &&
            def.name === callbackFn.params[0] &&
            stringInput()
          )
            return true;
          if (
            def?.type === 'Variable' &&
            !seen.has(binding) &&
            stringValue(def.node.init, at, new Set([...seen, binding]), parameters)
          )
            return true;
          if (
            def?.type === 'Variable' &&
            def.node.id.type === 'ArrayPattern' &&
            valueKind(def.node.init, at, parameters) === 'strings'
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
        const valueKind = (raw, at, parameters, seen = new Set()) => {
          const value = unwrap(raw);
          if (!value || seen.has(value)) return undefined;
          seen.add(value);
          if (value.kind) return value.kind;
          if (stringValue(value, at, new Set(), parameters)) return 'string';
          if (value.type === 'Literal' && typeof value.value === 'bigint') return 'bigint';
          if (value.type === 'CallExpression' && reviewedHelper(value.callee) === 'bigint')
            return 'bigint';
          if (value.regex) return 'regex';
          if (value.type === 'ArrayExpression') return 'array';
          if (value.type === 'Identifier') {
            const binding = variable(value),
              def = binding?.defs[0];
            const writes = binding?.references.filter((r) => r.isWrite() && !r.init) ?? [];
            if (writes.length) {
              const kinds = writes.map((r) =>
                valueKind(r.writeExpr, at, parameters, new Set(seen)),
              );
              return kinds.every((kind) => kind === 'bigint') ? 'bigint' : undefined;
            }
            if (
              def?.type === 'Parameter' &&
              def.node === callbackFn &&
              def.name === callbackFn.params[0]
            ) {
              if (stringInput(undefined, new Set(), 'strings')) return 'strings';
              if (stringInput(undefined, new Set(), 'array')) return 'array';
            }
            return valueKind(parameters.get(binding) ?? def?.node.init, at, parameters, seen);
          }
          if (value.type === 'NewExpression')
            return ['Date', 'Set', 'Map'].find((name) => globalName(value.callee, name));
          if (value.type === 'CallExpression' && value.callee.type === 'MemberExpression') {
            const receiver = valueKind(value.callee.object, at, parameters, seen);
            const name = key(value.callee);
            if (receiver === 'string' && name === 'split') return 'strings';
            if (
              ['array', 'strings'].includes(receiver) &&
              ['map', 'filter', 'reverse', 'slice'].includes(name)
            )
              return name === 'map' ? 'array' : receiver;
          }
        };
        const unsafe = (raw, seen = new Set(), args = [], parameters = new Map()) => {
          const callee = unwrap(raw);
          if (callee?.kind === 'resolver') return false;
          const binding = callee?.type === 'Identifier' ? variable(callee) : undefined;
          if (binding?.references.some((ref) => ref.isWrite() && !ref.init)) return true;
          if (parameters.has(binding))
            return unsafe(parameters.get(binding), seen, args, parameters);
          if (origin(callee)) return false;
          const reviewed = reviewedHelper(callee);
          if (reviewed)
            return (
              ['money-limit', 'currency', 'string-schema'].includes(reviewed) ||
              (reviewed === 'money-message'
                ? reviewedHelper(args[1]) !== 'currency'
                : reviewed !== 'predicate' && !stringValue(args[0], callee, new Set(), parameters))
            );
          if (globalName(callee, 'Date') && !args.length && callee !== callback) return false;
          if ((numeric(callee) || '').includes('.')) return true;
          if (numeric(callee)) {
            if (
              !strict &&
              numeric(callee) === 'BigInt' &&
              (/^(?:-?\d+)$/.test(String(constant(args[0]) ?? '')) ||
                reviewedHelper(args[0]) === 'money-limit')
            )
              return false;
            return !(
              (file === 'packages/contracts/src/common/number-input.ts' &&
                globalName(callee, 'Number')) ||
              (!strict &&
                numeric(callee) !== 'BigInt' &&
                ((callee === callback && stringInput()) ||
                  stringValue(args[0], callee, new Set(), parameters)))
            );
          }
          if (callee?.type === 'CallExpression') {
            const fn = localFunction(callee.callee);
            if (!fn?.params || unsafe(callee.callee, seen, callee.arguments, parameters))
              return true;
            const bound = new Map(parameters);
            fn.params.forEach((param, i) => {
              if (param.type === 'Identifier' && callee.arguments[i])
                bound.set(variable(param), callee.arguments[i]);
            });
            if (fn.body.type !== 'BlockStatement') return unsafe(fn.body, seen, args, bound);
            if (fn.body.body.at(-1)?.type !== 'ReturnStatement') return true;
            const returns = [];
            walk(fn.body, (child) => {
              if (FUNCTION_TYPES.has(child.type)) return false;
              if (child.type === 'ReturnStatement') returns.push(child);
            });
            return (
              !returns.length || returns.some((child) => unsafe(child.argument, seen, args, bound))
            );
          }
          if (globalName(callee, 'Promise'))
            return (
              !args[0] ||
              unsafe(args[0], seen, [{ kind: 'resolver' }, { kind: 'resolver' }], parameters)
            );
          if (globalName(callee, 'setTimeout'))
            return !args[0] || unsafe(args[0], seen, [], parameters);
          if (globalName(callee, 'RegExp'))
            return !stringValue(args[0], callee, new Set(), parameters);
          if (
            ['Error', 'TypeError', 'RangeError'].some((name) => globalName(callee, name)) ||
            globalName(callee, 'Set') ||
            globalName(callee, 'Map')
          )
            return false;
          if (globalName(callee, 'Date'))
            return args.length > 0 && !stringValue(args[0], callee, new Set(), parameters);
          if (
            ['Identifier', 'ArrowFunctionExpression', 'FunctionExpression'].includes(callee?.type)
          ) {
            const binding = callee.type === 'Identifier' ? variable(callee) : callee,
              def = binding?.defs?.[0];
            const fn =
              callee.type !== 'Identifier'
                ? callee
                : def?.type === 'FunctionName'
                  ? def.node
                  : unwrap(def?.node.init);
            if (fn?.type === 'Identifier' || fn?.type === 'CallExpression')
              return seen.has(binding) || unsafe(fn, new Set([...seen, binding]), args, parameters);
            if (
              seen.has(binding) ||
              binding?.references?.some((ref) => ref.isWrite() && !ref.init) ||
              !FUNCTION_TYPES.has(fn?.type)
            )
              return true;
            const bound = new Map(parameters);
            fn.params.forEach((param, i) => {
              if (param.type === 'Identifier' && args[i])
                bound.set(
                  variable(param),
                  stringValue(args[i], callee, new Set(), parameters)
                    ? { kind: 'string' }
                    : args[i],
                );
            });
            let result = false;
            walk(fn, (child) => {
              if (child !== fn && FUNCTION_TYPES.has(child.type)) return false;
              if (
                ['CallExpression', 'NewExpression'].includes(child.type) &&
                unsafe(child.callee, new Set([...seen, binding]), child.arguments, bound)
              )
                result = true;
            });
            return result;
          }
          if (callee?.type === 'MemberExpression') {
            const name = key(callee);
            const kind = valueKind(callee.object, callee, parameters);
            if (
              callee.object.type === 'Identifier' &&
              ['array', 'strings', 'Date', 'regex'].includes(kind) &&
              !stableReceiver(callee.object, callee)
            )
              return true;
            if (
              (kind === 'string' && STRING_METHODS.has(name)) ||
              (kind === 'regex' && ['test', 'exec'].includes(name)) ||
              (kind === 'Date' && ['getTime', 'toISOString'].includes(name)) ||
              (kind === 'bigint' && name === 'toString') ||
              (['array', 'strings'].includes(kind) &&
                ['map', 'filter', 'reverse', 'slice', 'join'].includes(name))
            ) {
              const position =
                ['array', 'strings'].includes(kind) && ['map', 'filter'].includes(name)
                  ? 0
                  : kind === 'string' && name === 'replace'
                    ? 1
                    : undefined;
              return position !== undefined &&
                args[position] &&
                !['Literal'].includes(unwrap(args[position]).type)
                ? unsafe(
                    args[position],
                    seen,
                    [{ kind: kind === 'strings' ? 'string' : 'unknown' }],
                    parameters,
                  )
                : false;
            }
            if (
              globalName(callee.object, 'Number') &&
              ['isNaN', 'isFinite', 'isInteger', 'isSafeInteger'].includes(name)
            )
              return false;
            if (
              ['trim', 'normalize', 'replace'].includes(name) &&
              stringValue(callee.object, callee, new Set(), parameters)
            )
              return false;
            // Keep the original direct-array proof: a kind inferred through an
            // alias or helper parameter does not prove its source stayed stable.
            const receiver =
              callee.object.type === 'Identifier' ? variable(callee.object)?.defs[0] : undefined;
            if (
              name === 'includes' &&
              receiver?.type === 'Variable' &&
              receiver.node.init?.type === 'ArrayExpression' &&
              stableReceiver(callee.object, callee)
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
                  def.node === callbackFn &&
                  def.name === callbackFn.params[1],
              )
            )
              return false;
          }
          return true;
        };
        for (const raw of callbacks) {
          callback = unwrap(raw);
          callbackFn = localFunction(callback);
          callbackInput = callbackInputs.get(raw);
          if (!callback) {
            report(node, 'preprocess');
            continue;
          }
          if (
            (strict &&
              !['ArrowFunctionExpression', 'FunctionExpression'].includes(callback.type)) ||
            unsafe(callback, new Set(), [{ kind: !strict && stringInput() ? 'string' : 'unknown' }])
          )
            report(callback, 'preprocess');
        }
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

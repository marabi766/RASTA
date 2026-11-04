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
    fields: ['clone', 'constructor'].includes(api)
      ? name === 'clone' && !receiverSchema
        ? 1
        : 0
      : /^\$?Zod(?:Mini)?(?:Transform|Preprocess|Effects|CheckOverwrite)/.test(api)
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
        name = raw.name;
      if (def?.type === 'ImportBinding') {
        const from = def.parent.source.value;
        path = from.startsWith('@/')
          ? `apps/web/src/${from.slice(2)}`
          : from.startsWith('.')
            ? relative(ROOT, resolve(dirname(context.filename), from))
            : from;
        name = def.node.imported?.name;
      }
      return verifiedCallbackHelper(ROOT, path.replace(/\.[cm]?[jt]sx?$/, ''), name);
    };
    const imported = (def) =>
      def?.type === 'ImportBinding' &&
      zodModule(def.parent.source?.value) &&
      def.parent.importKind !== 'type' &&
      def.node.importKind !== 'type';
    const access = (result, name, receiver) => ({
      ...result,
      receiver: result.schema ? receiver : undefined,
      raw:
        (result.raw ||
          (result.schema &&
            (['constructor', 'clone'].includes(name) || CALLBACK_APIS.has(name)))) &&
        capability(name),
      receiverSchema: !!result.schema,
      schema: !!result.schema && SCHEMA_FIELDS.has(name),
      method: !result.raw,
      owner: result.name,
      name,
    });
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
            const path = [];
            let binding = def.name;
            while (binding && binding !== def.node.id) {
              if (binding.parent?.type === 'Property') path.unshift(key(binding.parent));
              binding = binding.parent;
            }
            for (const name of path) if (result) result = access(result, name, def.node.init);
            if (result?.raw) resolved = result;
            else if (result?.schema && !resolved?.raw) resolved = result;
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
            else if (result?.schema && !resolved?.raw) resolved = result;
            resolved ??= result;
          }
        }
        return (resolved?.raw || resolved?.schema) &&
          v.references.some((ref) => ref.isWrite() && !ref.init)
          ? { ...resolved, ambiguous: true }
          : resolved;
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
          const data =
            DATA_RESULTS.has(factory.name) ||
            (factory.name === 'meta' && factory.receiverSchema && !node.arguments.length);
          const inputSchema =
            ['parse', 'parseAsync', 'decode', 'decodeAsync', 'encode', 'encodeAsync'].includes(
              factory.name,
            ) && origin(node.arguments[factory.receiverSchema ? 0 : 1], seen)?.schema;
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
        const callbacks = [];
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
            if (['transform', 'preprocess', 'tx'].includes(key(prop))) callbacks.push(prop.value);
            if (key(prop) === 'effect') fields(prop.value, seen);
          }
        };
        if (api.fields !== undefined) fields(node.arguments[api.fields]);
        if (!callbacks.length) return;
        let callback;
        let callbackFn;
        const localFunction = (raw) => {
          const value = unwrap(raw);
          if (value?.type !== 'Identifier') return value;
          const def = variable(value)?.defs[0];
          return def?.type === 'FunctionName' ? def.node : unwrap(def?.node.init);
        };
        // Follow local helper bodies; opaque helpers cannot prove that conversion
        // is guarded. Only the audited Number helper may call Number itself.
        const strict = factory.name === 'preprocess';
        const stringInput = (
          raw = api.fields === undefined
            ? (factory.receiver ?? unwrap(node.callee)?.object)
            : undefined,
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
          if (api?.receiverSchema && api.name === 'refine' && schema.arguments[1]) {
            const opts = unwrap(schema.arguments[1]);
            if (
              opts.type !== 'Literal' &&
              (opts.type !== 'ObjectExpression' ||
                opts.properties.some(
                  (prop) =>
                    prop.type === 'SpreadElement' ||
                    key(prop) === 'when' ||
                    key(prop) === '__proto__' ||
                    key(prop) === undefined ||
                    ['get', 'set'].includes(prop.kind),
                ))
            )
              return false;
          }
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
              reviewed === 'money-limit' ||
              (reviewed !== 'predicate' && !stringValue(args[0], callee, new Set(), parameters))
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
            const returns = fn.body.body.filter((child) => child.type === 'ReturnStatement');
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

import path from 'node:path';
import ts from 'typescript';
import { isTestOnlyPath, REPO_ROOT } from './testing-dev-only.mjs';

/**
 * The internal-token source boundary, lint layer (PR #423 follow-up 1; #503 r2).
 *
 * The boundary itself holds at run time: `InternalTokenService.issue` throws,
 * the signing key is in a WeakMap private to
 * packages/nest-common/src/http/internal-http-client.ts, and only
 * `InternalHttpClient.authorize` mints (docs/internal-token-transport-scope.md).
 * This rule is the second layer: it refuses, at review time, code that tries.
 * Outside that one file nothing may obtain an internal token or put the
 * internal-token header on an outbound request. Decided through TypeScript's
 * symbols and types, not names:
 *
 * - issuance: any read of `InternalTokenService.issue` — `.issue`, `['issue']`,
 *   a constant, folded or computed key, destructuring, `super.issue`,
 *   `bind`/`call` on it — resolved to the method's declaration in nest-common,
 *   so a `Pick<…>`, a re-export or an alias is the same method and a domain
 *   `issue()` (RFQ, inventory reservations) is not;
 * - escape: a value that carries the issuer — itself, or inside a container,
 *   an array, a function's return, a promise — flowing where that is lost
 *   (`any`, `unknown`, `object`, a structural stand-in, a generic parameter,
 *   `Reflect`/`Object.*`, a type assertion). The one allowance is a verified
 *   DI factory: `new InternalTokenService(…)` returned from the `useFactory` of
 *   a provider whose `provide` is `InternalTokenService`;
 * - header: the header name — literal, template, folded (`+`, `join`, letter
 *   case) or a constant of that literal type, in any letter case — as an object
 *   key, an assigned key, a `[name, value]` pair or a name followed by a value
 *   in a call;
 * - signer: jose's signing classes from `jose` or any `jose/…` subpath,
 *   through any alias of its namespace, and `INTERNAL_TOKEN_SECRET` named
 *   anywhere (as a property, a string, a folded or computed key) but as the
 *   first argument of `new InternalTokenService`.
 *
 * Fail closed: without a program (JavaScript, a file no project includes) or
 * on an `any`, an `issue` and a computed key on the issuer or on a value
 * holding the secret are reported. In production code — every path
 * `isTestOnlyPath` (scripts/testing-dev-only.mjs) does not name — so is
 * everything else that would need a type to be cleared: any import of
 * nest-common or of TypeScript source without types, any module loader
 * (`require`, `module.require`, `createRequire`, `import()`) whose specifier
 * is not a constant or that is used other than by calling it, code generation
 * (`eval`, `Function`, `vm`, a `.constructor(…)` call, string timers, any
 * alias of them) and, without types, a method called by a computed name or
 * through `Reflect`. Test-only code (root scripts/, tests/, test trees,
 * packages/testing) is never in an image and no production file may import
 * it (testing/dev-only); there the run-time boundary alone answers loaders.
 */

const CLIENT_FILE = /(?:^|\/)packages\/nest-common\/src\/http\/internal-http-client\.ts$/;
/** Where `InternalTokenService` is declared: its source, or nest-common's emitted types. */
const ISSUER_FILE =
  /(?:^|\/)packages\/nest-common\/(?:src\/http\/internal-http-client\.ts|dist\/http\/internal-http-client\.d\.ts)$/;
const HEADER = 'x-internal-token';
const SECRET = secretName();
const SIGNERS = new Set(['SignJWT', 'CompactSign', 'FlattenedSign', 'GeneralSign']);
const ISSUANCE_MODULE = /^@rasta\/nest-common(?:\/|$)|(?:^|\/)packages\/nest-common(?:\/|$)/;
const JOSE_MODULE = /^jose(?:\/|$)/;
const JOSE_DECLARATION = /(?:^|\/)jose\//;
const CODEGEN_MODULE = /^(?:node:)?vm$/;
const LOADER_MODULE = /^(?:node:)?module$/;
const TYPESCRIPT_SOURCE = /\.[cm]?tsx?$/;
/** Names that reach the global object, where `eval` and `Function` live. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);
const CODEGEN_NAMES = new Set(['eval', 'Function']);
/** Declarations whose members are the language's or Node's own, never the issuer. */
const LIBRARY_DECLARATION = /\/typescript\/lib\/|\/@types\/node\//;
/** The calls a module path is built with; any other call's result is unknown. */
const PATH_BUILDERS = new Set([
  'join',
  'resolve',
  'dirname',
  'normalize',
  'pathToFileURL',
  'fileURLToPath',
  'URL',
  'concat',
]);

const posix = (file) => file.split(path.sep).join('/');

/** The secret's name. This rule names what it refuses; its one allowance is here (eslint.config.mjs). */
function secretName() {
  return 'INTERNAL_TOKEN_SECRET';
}

export default {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allow: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'function', 'kinds'],
              properties: {
                file: { type: 'string' },
                function: { type: 'string' },
                kinds: { type: 'array', items: { enum: ['header', 'signer'] } },
              },
            },
          },
        },
      },
    ],
    messages: {
      issuance:
        'internal-token source: InternalTokenService.issue is reachable here (it throws at run time). Only InternalHttpClient (@rasta/nest-common) mints; use its authorize().',
      escape:
        'internal-token source: an InternalTokenService flows into {{target}}, where its type is lost and issuance could no longer be seen. Pass it to InternalHttpClient instead.',
      unresolved:
        'internal-token source: cannot resolve {{what}} through TypeScript types; the boundary fails closed. Keep this in a type-checked file or remove it.',
      header:
        'internal-token source: only InternalHttpClient (@rasta/nest-common) puts the internal-token header on an outbound request.',
      signer:
        'internal-token source: internal tokens are signed only inside InternalHttpClient; {{what}} is not allowed here.',
    },
  },
  create(context) {
    const filename = posix(context.physicalFilename ?? context.filename);
    if (CLIENT_FILE.test(filename)) return {};
    const services = context.sourceCode.parserServices;
    const program = services?.program ?? null;
    const typed = Boolean(program && services.esTreeNodeToTSNodeMap);
    const checker = typed ? program.getTypeChecker() : null;
    const tsNode = (node) => services.esTreeNodeToTSNodeMap.get(node);
    const allowances = (context.options[0]?.allow ?? []).filter(
      (allowance) => filename === allowance.file || filename.endsWith(`/${allowance.file}`),
    );

    const enclosingFunctionNames = (node) => {
      const names = [];
      for (const ancestor of context.sourceCode.getAncestors(node)) {
        if (ancestor.type === 'FunctionDeclaration' && ancestor.id) names.push(ancestor.id.name);
        if (ancestor.type === 'MethodDefinition' && ancestor.key.type === 'Identifier')
          names.push(ancestor.key.name);
        if (
          ancestor.type === 'VariableDeclarator' &&
          ancestor.id.type === 'Identifier' &&
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(ancestor.init?.type)
        )
          names.push(ancestor.id.name);
      }
      return names;
    };
    const allowed = (node, kind) =>
      allowances.some(
        (allowance) =>
          allowance.kinds.includes(kind) &&
          enclosingFunctionNames(node).includes(allowance.function),
      );
    const unresolved = (node, what) =>
      context.report({ node, messageId: 'unresolved', data: { what } });
    const relativePath = path.relative(REPO_ROOT, filename);
    const production =
      relativePath.startsWith('..') || path.isAbsolute(relativePath)
        ? true
        : !isTestOnlyPath(relativePath);
    /** Loaders and code generation: refused in production code (see above). */
    const failClosed = (node, what) => {
      if (production) unresolved(node, what);
    };

    // ---- types -------------------------------------------------------------

    const resolveAlias = (symbol) =>
      symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const isOriginalIssue = (symbol) =>
      (resolveAlias(symbol)?.declarations ?? []).some(
        (declaration) =>
          ts.isMethodDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'issue' &&
          ts.isClassDeclaration(declaration.parent) &&
          declaration.parent.name?.text === 'InternalTokenService' &&
          ISSUER_FILE.test(posix(declaration.getSourceFile().fileName)),
      );
    /** 'original' | 'unknown' | 'other' — what `.issue` on a value of this type is. */
    const issueOf = (type, seen = new Set()) => {
      if (!type || seen.has(type)) return 'other';
      seen.add(type);
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return 'unknown';
      if (type.isUnion() || type.isIntersection()) {
        const verdicts = type.types.map((part) => issueOf(part, seen));
        if (verdicts.includes('original')) return 'original';
        return verdicts.includes('unknown') && type.isUnion() ? 'unknown' : 'other';
      }
      const property = checker.getPropertyOfType(checker.getApparentType(type), 'issue');
      return property && isOriginalIssue(property) ? 'original' : 'other';
    };
    const capable = (type) => issueOf(type) === 'original';

    const isPublic = (symbol) =>
      (symbol.declarations ?? []).every(
        (declaration) =>
          !(declaration.name && ts.isPrivateIdentifier(declaration.name)) &&
          !(
            ts.getCombinedModifierFlags(declaration) &
            (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)
          ),
      );
    const fromLibrary = (symbol) =>
      (symbol.declarations ?? []).some((declaration) =>
        LIBRARY_DECLARATION.test(posix(declaration.getSourceFile().fileName)),
      );
    /**
     * Whether a value of this type holds the issuer where a caller can reach it:
     * the issuer itself, or in a public property, an element, a type argument
     * (a promise, a map) or a function's return — three levels deep. Private
     * members are not followed: reaching them takes reflection on a value that
     * holds no capability of its own, and the run-time boundary refuses that.
     */
    const carriedCache = new Map();
    const carries = (type, depth = 0) => {
      if (!type || depth > 3) return false;
      const cached = carriedCache.get(type);
      if (cached !== undefined) return cached;
      carriedCache.set(type, false); // cycles
      let verdict = capable(type);
      if (!verdict && (type.isUnion() || type.isIntersection())) {
        verdict = type.types.some((part) => carries(part, depth));
      } else if (!verdict && !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
        verdict =
          type
            .getCallSignatures()
            .some((signature) => carries(signature.getReturnType(), depth + 1)) ||
          (type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Reference
            ? checker.getTypeArguments(type).some((argument) => carries(argument, depth + 1))
            : false) ||
          checker.getPropertiesOfType(type).some(
            (property) =>
              // A class's `prototype` is no instance: the constructor needs the secret.
              property.escapedName !== 'prototype' &&
              isPublic(property) &&
              !fromLibrary(property) &&
              carries(checker.getTypeOfSymbol(property), depth + 1),
          );
      }
      carriedCache.set(type, verdict);
      return verdict;
    };
    const mentionsTypeParameter = (type) =>
      Boolean(
        type &&
        (type.flags & ts.TypeFlags.TypeParameter ||
          ((type.isUnion() || type.isIntersection()) && type.types.some(mentionsTypeParameter))),
      );

    /** The literal property names a key can take, or null when it can take any. */
    const keyNames = (keyNode) => {
      const folded = constantString(keyNode);
      if (folded !== null) return [folded];
      if (keyNode.type === 'Literal') return [String(keyNode.value)];
      if (!typed) return null;
      const type = checker.getTypeAtLocation(tsNode(keyNode));
      const parts = type.isUnion() ? type.types : [type];
      if (parts.every((part) => part.isStringLiteral() || part.isNumberLiteral()))
        return parts.map((part) => String(part.value));
      if (parts.every((part) => part.flags & (ts.TypeFlags.ESSymbolLike | ts.TypeFlags.NumberLike)))
        return [];
      return null;
    };
    const CASE_METHODS = new Set([
      'toLowerCase',
      'toUpperCase',
      'toLocaleLowerCase',
      'toLocaleUpperCase',
      'trim',
    ]);
    /**
     * A string the expression always evaluates to, folded through `+`,
     * templates, `const`, `[…].join(…)`, `concat` and letter-case methods.
     */
    const constantString = (node, depth = 0) => {
      if (!node || depth > 16) return null;
      switch (node.type) {
        case 'Literal':
          return typeof node.value === 'string' ? node.value : null;
        case 'TemplateLiteral': {
          let text = node.quasis[0].value.cooked;
          for (const [index, expression] of node.expressions.entries()) {
            const part = constantString(expression, depth + 1);
            if (part === null) return null;
            text += part + node.quasis[index + 1].value.cooked;
          }
          return text;
        }
        case 'BinaryExpression': {
          if (node.operator !== '+') return null;
          const left = constantString(node.left, depth + 1);
          const right = left === null ? null : constantString(node.right, depth + 1);
          return right === null ? null : left + right;
        }
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
        case 'TSNonNullExpression':
          return constantString(node.expression, depth + 1);
        case 'Identifier': {
          const init = constInit(node);
          return init ? constantString(init, depth + 1) : null;
        }
        case 'CallExpression': {
          const callee = node.callee;
          if (callee.type !== 'MemberExpression' || callee.computed) return null;
          const method = callee.property.name;
          if (CASE_METHODS.has(method) && node.arguments.length === 0) {
            const base = constantString(callee.object, depth + 1);
            if (base === null) return null;
            switch (method) {
              case 'toLowerCase':
              case 'toLocaleLowerCase':
                return base.toLowerCase();
              case 'toUpperCase':
              case 'toLocaleUpperCase':
                return base.toUpperCase();
              default:
                return base.trim();
            }
          }
          if (method === 'concat') {
            const parts = [callee.object, ...node.arguments].map((part) =>
              constantString(part, depth + 1),
            );
            return parts.includes(null) ? null : parts.join('');
          }
          if (method === 'join') {
            const array =
              callee.object.type === 'Identifier' ? constInit(callee.object) : callee.object;
            if (array?.type !== 'ArrayExpression') return null;
            const parts = array.elements.map((element) => constantString(element, depth + 1));
            const separator =
              node.arguments.length === 0 ? ',' : constantString(node.arguments[0], depth + 1);
            return parts.includes(null) || separator === null ? null : parts.join(separator);
          }
          return null;
        }
        default:
          return null;
      }
    };
    const isHeaderName = (node) => {
      if (!node) return false;
      if (constantString(node)?.toLowerCase() === HEADER) return true;
      if (!typed || !['Identifier', 'MemberExpression', 'TSAsExpression'].includes(node.type))
        return false;
      const type = checker.getTypeAtLocation(tsNode(node));
      const parts = type.isUnion() ? type.types : [type];
      return parts.some((part) => part.isStringLiteral() && part.value.toLowerCase() === HEADER);
    };
    const holdsSecret = (type) => {
      if (!type) return false;
      const parts = type.isUnion() || type.isIntersection() ? type.types : [type];
      return parts.some((part) =>
        Boolean(checker.getPropertyOfType(checker.getApparentType(part), SECRET)),
      );
    };

    // ---- reports -----------------------------------------------------------

    /** A read of `issue` (by name or key) on a value of `type`. */
    const checkIssueRead = (node, type, names) => {
      if (names === null) {
        // A key that can be anything, on something that can mint.
        if (typed && issueOf(type) === 'original')
          unresolved(node, 'a computed key on an InternalTokenService');
        return;
      }
      if (!names.includes('issue')) return;
      if (!typed) {
        unresolved(node, '`issue` in a file without type information');
        return;
      }
      const verdict = issueOf(type);
      if (verdict === 'original') context.report({ node, messageId: 'issuance' });
      else if (verdict === 'unknown') unresolved(node, '`issue` on a value of unknown type');
    };

    /**
     * `node` (an expression) lands in a place typed by its contextual type, or
     * — `erased` — in a generic parameter, which keeps no capability.
     */
    const checkEscape = (node, { erased = false } = {}) => {
      if (!typed || !node) return;
      if (node.type === 'SpreadElement' || node.type === 'Literal') return;
      const tsExpression = tsNode(node);
      if (!tsExpression) return;
      const contextual = erased ? null : checker.getContextualType(tsExpression);
      if (!erased && !contextual) return;
      // A function lands where a function type is expected: what it returns is
      // checked where it returns it, against that type's return.
      if (
        !erased &&
        ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type) &&
        contextual.getCallSignatures().length > 0
      )
        return;
      const type = checker.getTypeAtLocation(tsExpression);
      if (!carries(type)) return;
      if (!erased && carries(contextual)) return;
      if (node.type === 'NewExpression' && isIssuerClass(node.callee) && isVerifiedFactory(node))
        return;
      // The provider object itself; its `useFactory` is held to the rule above.
      if (node.type === 'ObjectExpression' && providesIssuer(node)) return;
      context.report({
        node,
        messageId: 'escape',
        data: { target: erased ? 'a generic parameter' : checker.typeToString(contextual) },
      });
    };
    const isIssuerClass = (callee) =>
      (resolveAlias(checker.getSymbolAtLocation(tsNode(callee)))?.declarations ?? []).some(
        (declaration) =>
          ts.isClassDeclaration(declaration) &&
          declaration.name?.text === 'InternalTokenService' &&
          ISSUER_FILE.test(posix(declaration.getSourceFile().fileName)),
      );
    const propertyName = (property) =>
      property.type === 'Property' && !property.computed
        ? property.key.type === 'Identifier'
          ? property.key.name
          : String(property.key.value)
        : null;
    /**
     * `new InternalTokenService(…)` returned from the `useFactory` of a provider
     * object whose `provide` is `InternalTokenService` — the one place the
     * issuer is handed to dependency injection, whose factories are typed `any`.
     */
    const isVerifiedFactory = (node) => {
      let factory = null;
      if (node.parent.type === 'ArrowFunctionExpression' && node.parent.body === node)
        factory = node.parent;
      else if (node.parent.type === 'ReturnStatement')
        factory = context.sourceCode
          .getAncestors(node)
          .findLast((ancestor) =>
            ['ArrowFunctionExpression', 'FunctionExpression'].includes(ancestor.type),
          );
      const property = factory?.parent;
      if (property?.type !== 'Property' || propertyName(property) !== 'useFactory') return false;
      return property.parent.type === 'ObjectExpression' && providesIssuer(property.parent);
    };
    /** `{ provide: InternalTokenService, … }` */
    const providesIssuer = (object) => {
      const provide = object.properties.find((candidate) => propertyName(candidate) === 'provide');
      return Boolean(provide) && isIssuerClass(provide.value);
    };
    /** Whether argument `index` of `call` is declared as a type parameter (`<T>(t: T)`). */
    const genericArgument = (call, index) => {
      if (!typed) return false;
      const signature = checker.getResolvedSignature(tsNode(call));
      const declaration = signature?.getDeclaration();
      const parameters = declaration?.parameters;
      if (!parameters?.length) return false;
      const parameter = parameters[Math.min(index, parameters.length - 1)];
      if (index >= parameters.length && !parameter.dotDotDotToken) return false;
      let declared = checker.getTypeAtLocation(parameter);
      if (parameter.dotDotDotToken && checker.isArrayType(declared))
        declared = checker.getTypeArguments(declared)[0];
      return mentionsTypeParameter(declared);
    };

    const checkHeaderConstruction = (node, nameNode) => {
      if (isHeaderName(nameNode) && !allowed(node, 'header'))
        context.report({ node, messageId: 'header' });
    };
    const reportSecret = (node) => {
      if (!allowed(node, 'signer'))
        context.report({ node, messageId: 'signer', data: { what: `reading ${SECRET}` } });
    };

    /**
     * The string pieces a module specifier is built from — literals, template
     * parts, `const` bindings, arguments of the calls that build paths (`join`,
     * `resolve`, `pathToFileURL(…).href`, `new URL`) — or null when any piece is
     * not a constant (a parameter, a `let`, any other call's result).
     */
    const piecesOf = (node, depth = 0) => {
      if (!node || depth > 16) return null;
      switch (node.type) {
        case 'Literal':
          return typeof node.value === 'string' ? [node.value] : null;
        case 'TemplateLiteral': {
          const parts = node.expressions.map((expression) => piecesOf(expression, depth + 1));
          if (parts.includes(null)) return null;
          const pieces = [];
          node.quasis.forEach((quasi, index) => {
            pieces.push(quasi.value.cooked);
            if (index < parts.length) pieces.push(...parts[index]);
          });
          return pieces;
        }
        case 'BinaryExpression': {
          if (node.operator !== '+') return null;
          const parts = [node.left, node.right].map((operand) => piecesOf(operand, depth + 1));
          return parts.includes(null) ? null : parts.flat();
        }
        case 'CallExpression':
        case 'NewExpression': {
          const callee = node.callee;
          const name =
            callee.type === 'Identifier'
              ? callee.name
              : callee.type === 'MemberExpression' && !callee.computed
                ? callee.property.name
                : null;
          if (!PATH_BUILDERS.has(name)) return null;
          const operands =
            name === 'concat' && callee.type === 'MemberExpression'
              ? [callee.object, ...node.arguments]
              : node.arguments;
          const parts = operands.map((operand) => piecesOf(operand, depth + 1));
          return parts.includes(null) ? null : parts.flat();
        }
        case 'MemberExpression':
          // `import.meta.url`, `pathToFileURL(dist).href`
          return node.computed ? null : piecesOf(node.object, depth + 1);
        case 'MetaProperty':
          return [];
        case 'Identifier': {
          const init = constInit(node);
          return init ? piecesOf(init, depth + 1) : null;
        }
        default:
          return null;
      }
    };
    /**
     * The module names a specifier can be: exact names, or — for a built path —
     * the whole path joined both ways and each piece, so a name split across
     * pieces (`'@rasta/' + 'nest-' + 'common'`) is seen whole.
     */
    const specifiersOf = (specifierNode) => {
      const folded = constantString(specifierNode);
      if (folded !== null) return { names: [folded], built: false };
      if (typed && specifierNode) {
        const type = checker.getTypeAtLocation(tsNode(specifierNode));
        const parts = type.isUnion() ? type.types : [type];
        if (parts.every((part) => part.isStringLiteral()))
          return { names: parts.map((part) => part.value), built: false };
      }
      const pieces = piecesOf(specifierNode);
      return pieces && pieces.length > 0
        ? { names: [pieces.join(''), pieces.join('/'), ...pieces], built: true }
        : null;
    };

    const checkModule = (node, specifierNode, typeOnly) => {
      if (typeOnly) return;
      const specifiers = specifiersOf(specifierNode);
      if (specifiers === null) {
        // Typed `import(expr)` is still unresolvable: its result is `any`.
        failClosed(node, 'a module named by an expression');
        return;
      }
      for (const specifier of specifiers.names) checkSpecifier(node, specifier, specifiers.built);
    };

    const checkSpecifier = (node, specifier, built) => {
      const jose = built ? /(?:^|\/)jose(?:\/|$)/.test(specifier) : JOSE_MODULE.test(specifier);
      if (jose) {
        if (node.type === 'ImportDeclaration') {
          for (const specifierPart of node.specifiers) {
            if (specifierPart.type === 'ImportSpecifier' && specifierPart.importKind === 'type')
              continue;
            const imported =
              specifierPart.type === 'ImportSpecifier'
                ? (specifierPart.imported.name ?? specifierPart.imported.value)
                : null;
            const uses = context.sourceCode
              .getDeclaredVariables(specifierPart)
              .flatMap((variable) => variable.references);
            if (imported === null) {
              // A namespace or default binding: only `ns.Name` with a fixed,
              // non-signing name is clear; any other use (an alias, a computed
              // member, an argument) could reach a signer.
              for (const reference of uses) checkJoseNamespaceUse(reference.identifier);
            } else if (
              SIGNERS.has(imported) ||
              (specifier !== 'jose' && !(typed && !isJoseSigner(specifierPart.local)))
            ) {
              // A signer, or anything from a signing subpath. Allowed only where
              // used: the import itself grants nothing.
              for (const reference of uses) {
                if (!allowed(reference.identifier, 'signer'))
                  context.report({
                    node: reference.identifier,
                    messageId: 'signer',
                    data: { what: `jose ${imported}` },
                  });
              }
            }
          }
        } else if (!allowed(node, 'signer')) {
          context.report({
            node,
            messageId: 'signer',
            data: { what: 'loading or re-exporting jose other than by a static import' },
          });
        }
      }
      if (CODEGEN_MODULE.test(specifier)) failClosed(node, 'code built from a string (vm)');
      if (LOADER_MODULE.test(specifier) && node.type === 'ImportDeclaration') {
        for (const specifierPart of node.specifiers) {
          if (specifierPart.type !== 'ImportSpecifier') {
            failClosed(specifierPart, 'the module loader namespace');
            continue;
          }
          const imported = specifierPart.imported.name ?? specifierPart.imported.value;
          if (imported === 'createRequire') loaderFactories.add(specifierPart.local.name);
        }
      }
      const issuance = built ? /nest-common/.test(specifier) : ISSUANCE_MODULE.test(specifier);
      if (!typed && (issuance || TYPESCRIPT_SOURCE.test(specifier))) {
        failClosed(node, `'${specifier}' from a file without type information`);
      }
      if (typed && (built || node.type === 'CallExpression') && issuance) {
        // `require` in TypeScript yields `any`.
        failClosed(node, `require('${specifier}')`);
      }
    };
    const checkJoseNamespaceUse = (identifier) => {
      const parent = identifier.parent;
      const member =
        parent.type === 'MemberExpression' && parent.object === identifier && !parent.computed
          ? parent.property.name
          : null;
      if (member !== null && !SIGNERS.has(member)) return;
      if (allowed(identifier, 'signer')) return;
      context.report({
        node: identifier,
        messageId: 'signer',
        data: {
          what: member ? `jose ${member}` : 'jose used other than by a fixed member name',
        },
      });
    };
    /** Whether a typed binding resolves to one of jose's signing classes. */
    const isJoseSigner = (identifier) =>
      (resolveAlias(checker.getSymbolAtLocation(tsNode(identifier)))?.declarations ?? []).some(
        (declaration) =>
          JOSE_DECLARATION.test(posix(declaration.getSourceFile().fileName)) &&
          SIGNERS.has(declaration.name?.text),
      );
    /** Local names bound to `createRequire` from node:module. */
    const loaderFactories = new Set();

    /** The initializer of the `const` an identifier names, if it names one. */
    function constInit(identifier) {
      let variable;
      for (
        let scope = context.sourceCode.getScope(identifier);
        scope && !variable;
        scope = scope.upper
      ) {
        variable = scope.set.get(identifier.name);
      }
      const definition = variable?.defs[0];
      return variable?.defs.length === 1 &&
        definition.type === 'Variable' &&
        definition.parent.kind === 'const' &&
        definition.node.id.type === 'Identifier'
        ? (definition.node.init ?? null)
        : null;
    }

    /** `name` as the global binding: declared nowhere in this module's scopes. */
    const isGlobal = (node, name) => {
      if (node?.type !== 'Identifier' || node.name !== name) return false;
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        if (scope.set.get(name)?.defs.length) return false;
      }
      return true;
    };
    /** `createRequire(…)` from node:module. */
    const isLoaderFactoryCall = (node) =>
      node?.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      loaderFactories.has(node.callee.name);
    /**
     * A callee that loads a module: `require`, `module.require`, the result of
     * `createRequire(…)`, or a `const` bound to any of them.
     */
    const isLoader = (callee, depth = 0) => {
      if (!callee || depth > 8) return false;
      if (isGlobal(callee, 'require')) return true;
      if (isLoaderFactoryCall(callee)) return true;
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.name === 'require' &&
        isGlobal(callee.object, 'module')
      )
        return true;
      if (callee.type === 'Identifier') return isLoader(constInit(callee), depth + 1);
      return false;
    };
    const isCodegen = (node) =>
      isGlobal(node, 'eval') ||
      isGlobal(node, 'Function') ||
      (node?.type === 'MemberExpression' &&
        node.object.type === 'Identifier' &&
        GLOBAL_OBJECTS.has(node.object.name) &&
        isGlobal(node.object, node.object.name) &&
        (node.computed
          ? (keyNames(node.property) ?? ['eval']).some((name) => CODEGEN_NAMES.has(name))
          : CODEGEN_NAMES.has(node.property.name)));
    /**
     * A reference to a loader or to code generation that is not a direct call
     * (an alias, an argument, a property): from here on its calls are unseen.
     */
    const checkLoaderReference = (node) => {
      const parent = node.parent;
      const called =
        (parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
        parent.callee === node;
      if (called) return;
      // `require.resolve(…)`, `createRequire(…).resolve(…)`: resolves, loads nothing.
      if (
        parent.type === 'MemberExpression' &&
        parent.object === node &&
        !parent.computed &&
        parent.property.name === 'resolve'
      )
        return;
      // `require.main === module`: compared, never called.
      if (
        parent.type === 'MemberExpression' &&
        parent.object === node &&
        !parent.computed &&
        parent.property.name === 'main' &&
        parent.parent.type === 'BinaryExpression' &&
        ['===', '!=='].includes(parent.parent.operator)
      )
        return;
      // `const load = require`, `const req = createRequire(…)`: followed to
      // their calls by isLoader. An alias of code generation is not.
      if (
        parent.type === 'VariableDeclarator' &&
        parent.init === node &&
        parent.id.type === 'Identifier' &&
        parent.parent.kind === 'const' &&
        (isGlobal(node, 'require') || isLoaderFactoryCall(node) || isLoader(constInit(node)))
      )
        return;
      failClosed(node, 'a module loader or code generator used other than by calling it');
    };

    const STRING_TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);

    return {
      ImportDeclaration(node) {
        checkModule(node, node.source, node.importKind === 'type');
      },
      ImportExpression(node) {
        checkModule(node, node.source, false);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference')
          checkModule(node, node.moduleReference.expression, node.importKind === 'type');
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkModule(node, node.source, node.exportKind === 'type');
      },
      ExportAllDeclaration(node) {
        checkModule(node, node.source, node.exportKind === 'type');
      },
      Identifier(node) {
        const parent = node.parent;
        if (parent.type === 'VariableDeclarator' && parent.id === node) return;
        if (
          isGlobal(node, 'require') ||
          isGlobal(node, 'eval') ||
          isGlobal(node, 'Function') ||
          loaderFactories.has(node.name) ||
          (!isGlobal(node, node.name) && isLoader(constInit(node)))
        ) {
          // Not a reference: a property key, a member name, an import binding.
          if (
            (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
            (parent.type === 'Property' && parent.key === node && !parent.computed) ||
            parent.type === 'ImportSpecifier' ||
            parent.type.startsWith('TS')
          )
            return;
          if (loaderFactories.has(node.name) && !isGlobal(node, node.name)) {
            // createRequire itself: calling it makes a loader, followed by isLoader.
            if (parent.type === 'CallExpression' && parent.callee === node) {
              checkLoaderReference(parent);
              return;
            }
          }
          checkLoaderReference(node);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (isLoader(callee)) checkModule(node, node.arguments[0], false);
        else if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.name === 'require'
        )
          failClosed(node, 'a module loader reached through a property');
        if (isCodegen(callee)) failClosed(node, 'code built from a string');
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.name === 'constructor'
        )
          failClosed(node, 'code built from a string (a `.constructor(…)` call)');
        if (
          STRING_TIMERS.has(callee.type === 'Identifier' ? callee.name : null) &&
          node.arguments[0] &&
          (node.arguments[0].type === 'Literal' || node.arguments[0].type === 'TemplateLiteral')
        )
          failClosed(node, 'code built from a string (a string timer)');
        if (!typed && callee.type === 'MemberExpression') {
          // Without types, a method reached by a name that is not a constant
          // could be issue(); so could `Reflect.get(…)`/`apply`/`construct`.
          const target =
            !callee.computed &&
            ['call', 'apply', 'bind'].includes(callee.property.name) &&
            callee.object.type === 'MemberExpression'
              ? callee.object
              : callee;
          if (target.computed && keyNames(target.property) === null)
            failClosed(
              node,
              'a method called by a computed name in a file without type information',
            );
          if (
            isGlobal(callee.object, 'Reflect') &&
            !callee.computed &&
            ['get', 'apply', 'construct'].includes(callee.property.name)
          )
            failClosed(node, '`Reflect` in a file without type information');
        }
        node.arguments.forEach((argument, index) => {
          checkEscape(argument, { erased: genericArgument(node, index) });
          if (index < node.arguments.length - 1) checkHeaderConstruction(node, argument);
        });
      },
      NewExpression(node) {
        if (isCodegen(node.callee)) failClosed(node, 'code built from a string');
        if (
          node.callee.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.property.name === 'constructor'
        )
          failClosed(node, 'code built from a string (a `.constructor(…)` call)');
        node.arguments.forEach((argument, index) => {
          checkEscape(argument, { erased: genericArgument(node, index) });
          if (index < node.arguments.length - 1) checkHeaderConstruction(node, argument);
        });
      },
      MemberExpression(node) {
        if (isCodegen(node)) checkLoaderReference(node);
        const names = node.computed ? keyNames(node.property) : [node.property.name];
        const objectType = typed ? checker.getTypeAtLocation(tsNode(node.object)) : null;
        if (names === null || names.includes('issue')) checkIssueRead(node, objectType, names);
        if (
          names?.some((name) => SIGNERS.has(name)) &&
          typed &&
          (checker.getSymbolAtLocation(tsNode(node.property))?.declarations ?? []).some(
            (declaration) => JOSE_DECLARATION.test(posix(declaration.getSourceFile().fileName)),
          ) &&
          !allowed(node, 'signer')
        )
          context.report({
            node,
            messageId: 'signer',
            data: { what: `jose ${names.find((name) => SIGNERS.has(name))}` },
          });
        if (names?.includes(SECRET)) {
          const parent = node.parent;
          const isIssuerSecret =
            parent?.type === 'NewExpression' &&
            parent.arguments[0] === node &&
            (typed
              ? isIssuerClass(parent.callee)
              : parent.callee.type === 'Identifier' &&
                parent.callee.name === 'InternalTokenService');
          if (!isIssuerSecret) reportSecret(node);
        } else if (names === null && typed && holdsSecret(objectType)) {
          unresolved(node, `a computed key on a value holding ${SECRET}`);
        }
      },
      'Literal, TemplateLiteral, BinaryExpression, CallExpression'(node) {
        // The secret's name as a string, however it is built — a read by name
        // (`Reflect.get(env, …)`, `env[…]`, `required(…)`). Defining it (an
        // object literal's key) and the member forms above are not this.
        if (constantString(node) !== SECRET) return;
        const parent = node.parent;
        if (
          ['TemplateLiteral', 'BinaryExpression', 'CallExpression', 'MemberExpression'].includes(
            parent.type,
          ) &&
          constantString(parent) === SECRET
        )
          return;
        if (parent.type === 'MemberExpression' && parent.property === node) return;
        if (
          parent.type === 'Property' &&
          parent.key === node &&
          parent.parent.type === 'ObjectExpression'
        )
          return;
        if (parent.type.startsWith('TS') || parent.type === 'ImportExpression') return;
        if (parent.type === 'Property' && parent.key === node) return; // ObjectPattern: reported there
        reportSecret(node);
      },
      ObjectPattern(node) {
        let sourceType = null;
        if (typed) {
          const parent = node.parent;
          sourceType =
            parent?.type === 'AssignmentExpression' && parent.left === node
              ? checker.getTypeAtLocation(tsNode(parent.right))
              : checker.getTypeAtLocation(tsNode(node));
        }
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          const names = property.computed
            ? keyNames(property.key)
            : [property.key.type === 'Identifier' ? property.key.name : String(property.key.value)];
          if (names === null || names.includes('issue'))
            checkIssueRead(property, sourceType, names);
          if (names?.includes(SECRET)) reportSecret(property);
          else if (names === null && typed && holdsSecret(sourceType))
            unresolved(property, `a computed key on a value holding ${SECRET}`);
          if (names?.some((name) => SIGNERS.has(name)) && !allowed(property, 'signer')) {
            const fromJose = typed
              ? (checker.getSymbolAtLocation(tsNode(property.key))?.declarations ?? []).some(
                  (declaration) =>
                    JOSE_DECLARATION.test(posix(declaration.getSourceFile().fileName)),
                )
              : true;
            if (fromJose)
              context.report({
                node: property,
                messageId: 'signer',
                data: { what: `jose ${names.find((name) => SIGNERS.has(name))}` },
              });
          }
        }
      },
      Property(node) {
        if (node.parent.type !== 'ObjectExpression') return;
        checkEscape(node.value);
        if (node.kind === 'init' && !node.method)
          checkHeaderConstruction(
            node,
            node.computed ? node.key : node.key.type === 'Literal' ? node.key : null,
          );
      },
      AssignmentExpression(node) {
        checkEscape(node.right);
        if (node.left.type === 'MemberExpression' && node.left.computed)
          checkHeaderConstruction(node, node.left.property);
      },
      VariableDeclarator(node) {
        if (node.init && node.id.typeAnnotation) checkEscape(node.init);
      },
      PropertyDefinition(node) {
        if (node.value && node.typeAnnotation) checkEscape(node.value);
      },
      AssignmentPattern(node) {
        checkEscape(node.right);
      },
      ReturnStatement(node) {
        checkEscape(node.argument);
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== 'BlockStatement') checkEscape(node.body);
      },
      ArrayExpression(node) {
        node.elements.forEach((element) => checkEscape(element));
        if (node.elements.length >= 2) checkHeaderConstruction(node, node.elements[0]);
      },
      'TSAsExpression, TSTypeAssertion, TSSatisfiesExpression'(node) {
        checkEscape(node.expression);
      },
      JSXExpressionContainer(node) {
        if (node.expression.type !== 'JSXEmptyExpression') checkEscape(node.expression);
      },
    };
  },
};

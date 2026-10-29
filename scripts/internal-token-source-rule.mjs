import path from 'node:path';
import ts from 'typescript';

/**
 * The internal-token source boundary (PR #423 follow-up 1, review F3).
 *
 * Outside `InternalHttpClient` (packages/nest-common/src/http/internal-http-client.ts)
 * nothing may obtain an internal token or put the internal-token header on an
 * outbound request. Decided through TypeScript's symbols and types, not names:
 *
 * - issuance: any read of `InternalTokenService.issue` — `.issue`, `['issue']`,
 *   a constant or computed key, destructuring, `super.issue`, `bind`/`call` on
 *   it — resolved to the method's declaration in nest-common, so a `Pick<…>`,
 *   a re-export or an alias is the same method and a domain `issue()` (RFQ,
 *   inventory reservations) is not;
 * - escape: an issuance-capable value flowing where its type is lost (`any`,
 *   `unknown`, `object`, a structural stand-in, `Reflect`/`Object.*`), after
 *   which the read could no longer be attributed;
 * - header: the header name — literal, template or a constant of that literal
 *   type, in any letter case — as an object key, an assigned key, a `[name,
 *   value]` pair or a name followed by a value in a call;
 * - signer: jose's signing classes (an internal token is an HS256 JWT) and the
 *   signing secret read anywhere but `new InternalTokenService(secret, …)`.
 *
 * Fail closed: without a program (JavaScript, a file no project includes) or
 * on an `any`, everything that would need a type to be cleared is reported,
 * including any import of nest-common or of TypeScript source and any
 * `require`/`import()` that is not a literal.
 */

const CLIENT_FILE = /(?:^|\/)packages\/nest-common\/src\/http\/internal-http-client\.ts$/;
const ISSUER_FILE =
  /(?:^|\/)packages\/nest-common\/(?:src\/auth\/token-verifier\.ts|dist\/auth\/token-verifier\.d\.ts)$/;
const HEADER = 'x-internal-token';
const SECRET = 'INTERNAL_TOKEN_SECRET';
const SIGNERS = new Set(['SignJWT', 'CompactSign', 'FlattenedSign', 'GeneralSign']);
const ISSUANCE_MODULE = /^@rasta\/nest-common(?:\/|$)|(?:^|\/)packages\/nest-common(?:\/|$)/;
const TYPESCRIPT_SOURCE = /\.[cm]?tsx?$/;

const posix = (file) => file.split(path.sep).join('/');

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
        'internal-token source: InternalTokenService.issue is reachable here. Only InternalHttpClient (@rasta/nest-common) mints; use its authorize().',
      escape:
        'internal-token source: an InternalTokenService flows into {{target}}, where its type is lost and issuance could no longer be seen. Pass it to InternalHttpClient instead.',
      unresolved:
        'internal-token source: cannot resolve {{what}} through TypeScript types; the boundary fails closed. Keep this in a type-checked file or remove it.',
      header:
        'internal-token source: only InternalHttpClient (@rasta/nest-common) puts the internal-token header on an outbound request.',
      signer:
        'internal-token source: internal tokens are signed only by InternalTokenService; {{what}} is not allowed here.',
    },
  },
  create(context) {
    const filename = posix(context.physicalFilename ?? context.filename);
    if (CLIENT_FILE.test(filename)) return {};
    const isIssuer = ISSUER_FILE.test(filename);
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

    // ---- types -------------------------------------------------------------

    const isOriginalIssue = (symbol) => {
      if (!symbol) return false;
      const resolved =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return (resolved.declarations ?? []).some(
        (declaration) =>
          ts.isMethodDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'issue' &&
          ts.isClassDeclaration(declaration.parent) &&
          declaration.parent.name?.text === 'InternalTokenService' &&
          ISSUER_FILE.test(posix(declaration.getSourceFile().fileName)),
      );
    };
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
    /** The literal property names a key can take, or null when it can take any. */
    const keyNames = (keyNode) => {
      if (keyNode.type === 'Literal') return [String(keyNode.value)];
      if (keyNode.type === 'TemplateLiteral' && keyNode.expressions.length === 0)
        return [keyNode.quasis[0].value.cooked];
      if (!typed) return null;
      const type = checker.getTypeAtLocation(tsNode(keyNode));
      const parts = type.isUnion() ? type.types : [type];
      if (parts.every((part) => part.isStringLiteral() || part.isNumberLiteral()))
        return parts.map((part) => String(part.value));
      if (parts.every((part) => part.flags & (ts.TypeFlags.ESSymbolLike | ts.TypeFlags.NumberLike)))
        return [];
      return null;
    };
    /** A string the expression always evaluates to, folded through `+`, templates and `const`. */
    const constantString = (node, depth = 0) => {
      if (!node || depth > 16) return null;
      if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
      if (node.type === 'TemplateLiteral') {
        let text = node.quasis[0].value.cooked;
        for (const [index, expression] of node.expressions.entries()) {
          const part = constantString(expression, depth + 1);
          if (part === null) return null;
          text += part + node.quasis[index + 1].value.cooked;
        }
        return text;
      }
      if (node.type === 'BinaryExpression' && node.operator === '+') {
        const left = constantString(node.left, depth + 1);
        const right = left === null ? null : constantString(node.right, depth + 1);
        return right === null ? null : left + right;
      }
      if (['TSAsExpression', 'TSSatisfiesExpression'].includes(node.type))
        return constantString(node.expression, depth + 1);
      if (node.type === 'Identifier') {
        const init = constInit(node);
        return init ? constantString(init, depth + 1) : null;
      }
      return null;
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

    // ---- reports -----------------------------------------------------------

    /** A read of `issue` (by name or key) on a value of `type`. */
    const checkIssueRead = (node, type, names) => {
      if (isIssuer) return;
      if (names === null) {
        // A key that can be anything, on something that can mint.
        const verdict = typed ? issueOf(type) : 'other';
        if (verdict === 'original')
          context.report({
            node,
            messageId: 'unresolved',
            data: { what: 'a computed key on an InternalTokenService' },
          });
        return;
      }
      if (!names.includes('issue')) return;
      if (!typed) {
        context.report({
          node,
          messageId: 'unresolved',
          data: { what: '`issue` in a file without type information' },
        });
        return;
      }
      const verdict = issueOf(type);
      if (verdict === 'original') context.report({ node, messageId: 'issuance' });
      else if (verdict === 'unknown')
        context.report({
          node,
          messageId: 'unresolved',
          data: { what: '`issue` on a value of unknown type' },
        });
    };

    const checkEscape = (node) => {
      if (!typed || isIssuer || !node) return;
      if (node.type === 'SpreadElement' || node.type === 'Literal') return;
      const tsExpression = tsNode(node);
      if (!tsExpression) return;
      const type = checker.getTypeAtLocation(tsExpression);
      if (!capable(type)) return;
      const contextual = checker.getContextualType(tsExpression);
      if (!contextual) return;
      if (capable(contextual)) return;
      // A service constructed and handed to dependency injection (whose
      // factories are typed `any`) is typed again where it is injected.
      if (
        contextual.flags & ts.TypeFlags.Any &&
        node.type === 'NewExpression' &&
        isIssuerClass(node.callee)
      )
        return;
      context.report({
        node,
        messageId: 'escape',
        data: { target: checker.typeToString(contextual) },
      });
    };
    const isIssuerClass = (callee) => {
      const symbol = checker.getSymbolAtLocation(tsNode(callee));
      const resolved =
        symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return (resolved?.declarations ?? []).some(
        (declaration) =>
          ts.isClassDeclaration(declaration) &&
          declaration.name?.text === 'InternalTokenService' &&
          ISSUER_FILE.test(posix(declaration.getSourceFile().fileName)),
      );
    };

    const checkHeaderConstruction = (node, nameNode) => {
      if (isHeaderName(nameNode) && !allowed(node, 'header'))
        context.report({ node, messageId: 'header' });
    };

    /**
     * The string pieces a module specifier is built from — literals, template
     * parts, `const` bindings, arguments of the calls that join them (`join`,
     * `resolve`, `pathToFileURL(…).href`) — or null when any piece is not a
     * constant (a parameter, a `let`, a value read at run time).
     */
    const piecesOf = (node, depth = 0) => {
      if (!node || depth > 16) return null;
      switch (node.type) {
        case 'Literal':
          return typeof node.value === 'string' ? [node.value] : null;
        case 'TemplateLiteral': {
          const parts = node.expressions.map((expression) => piecesOf(expression, depth + 1));
          if (parts.includes(null)) return null;
          return [...node.quasis.map((quasi) => quasi.value.cooked), ...parts.flat()];
        }
        case 'BinaryExpression':
        case 'CallExpression':
        case 'NewExpression': {
          const operands =
            node.type === 'BinaryExpression' ? [node.left, node.right] : node.arguments;
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
    /** The module names a specifier can be: exact names, or the pieces of a built path. */
    const specifiersOf = (specifierNode) => {
      if (specifierNode?.type === 'Literal' && typeof specifierNode.value === 'string')
        return { names: [specifierNode.value], built: false };
      if (typed && specifierNode) {
        const type = checker.getTypeAtLocation(tsNode(specifierNode));
        const parts = type.isUnion() ? type.types : [type];
        if (parts.every((part) => part.isStringLiteral()))
          return { names: parts.map((part) => part.value), built: false };
      }
      const pieces = piecesOf(specifierNode);
      return pieces && pieces.length > 0 ? { names: pieces, built: true } : null;
    };

    const checkModule = (node, specifierNode, typeOnly) => {
      if (typeOnly) return;
      const specifiers = specifiersOf(specifierNode);
      if (specifiers === null) {
        // Typed `import(expr)` is still unresolvable: its result is `any`.
        context.report({
          node,
          messageId: 'unresolved',
          data: { what: 'a module named by an expression' },
        });
        return;
      }
      for (const specifier of specifiers.names) checkSpecifier(node, specifier, specifiers.built);
    };

    const checkSpecifier = (node, specifier, built) => {
      if (specifier === 'jose' && !isIssuer) {
        if (node.type === 'ImportDeclaration') {
          for (const specifierPart of node.specifiers) {
            if (specifierPart.type === 'ImportSpecifier' && specifierPart.importKind === 'type')
              continue;
            const imported =
              specifierPart.type === 'ImportSpecifier'
                ? (specifierPart.imported.name ?? specifierPart.imported.value)
                : null;
            if (
              specifierPart.type === 'ImportNamespaceSpecifier' ||
              specifierPart.type === 'ImportDefaultSpecifier'
            ) {
              namespaces.add(specifierPart.local.name);
            } else if (SIGNERS.has(imported)) {
              // Allowed only where it is used: every reference must sit in an
              // allowed function, so the import itself grants nothing.
              const uses = context.sourceCode
                .getDeclaredVariables(specifierPart)
                .flatMap((variable) => variable.references);
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
          context.report({ node, messageId: 'signer', data: { what: 'loading jose dynamically' } });
        }
      }
      const issuance = built ? /nest-common/.test(specifier) : ISSUANCE_MODULE.test(specifier);
      if (!typed && (issuance || TYPESCRIPT_SOURCE.test(specifier))) {
        context.report({
          node,
          messageId: 'unresolved',
          data: { what: `'${specifier}' from a file without type information` },
        });
      }
      if (typed && (built || node.type === 'CallExpression') && issuance) {
        // `require` in TypeScript yields `any`.
        context.report({
          node,
          messageId: 'unresolved',
          data: { what: `require('${specifier}')` },
        });
      }
    };
    const namespaces = new Set();

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
      if (node.type !== 'Identifier' || node.name !== name) return false;
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        if (scope.set.get(name)?.defs.length) return false;
      }
      return true;
    };
    const isRequire = (callee) => isGlobal(callee, 'require');

    return {
      ImportDeclaration(node) {
        checkModule(node, node.source, node.importKind === 'type');
      },
      ImportExpression(node) {
        checkModule(node, node.source, false);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkModule(node, node.source, node.exportKind === 'type');
      },
      ExportAllDeclaration(node) {
        checkModule(node, node.source, node.exportKind === 'type');
      },
      CallExpression(node) {
        if (isRequire(node.callee)) checkModule(node, node.arguments[0], false);
        if (isGlobal(node.callee, 'eval') || isGlobal(node.callee, 'Function'))
          context.report({
            node,
            messageId: 'unresolved',
            data: { what: 'code built from a string' },
          });
        node.arguments.forEach((argument, index) => {
          checkEscape(argument);
          if (index < node.arguments.length - 1) checkHeaderConstruction(node, argument);
        });
      },
      NewExpression(node) {
        if (isGlobal(node.callee, 'Function'))
          context.report({
            node,
            messageId: 'unresolved',
            data: { what: 'code built from a string' },
          });
        node.arguments.forEach((argument, index) => {
          checkEscape(argument);
          if (index < node.arguments.length - 1) checkHeaderConstruction(node, argument);
        });
      },
      MemberExpression(node) {
        const names = node.computed ? keyNames(node.property) : [node.property.name];
        if (names === null || names.includes('issue')) {
          const type = typed ? checker.getTypeAtLocation(tsNode(node.object)) : null;
          checkIssueRead(node, type, names);
        }
        if (
          names?.some((name) => SIGNERS.has(name)) &&
          node.object.type === 'Identifier' &&
          namespaces.has(node.object.name) &&
          !allowed(node, 'signer')
        )
          context.report({
            node,
            messageId: 'signer',
            data: { what: `jose ${names.find((name) => SIGNERS.has(name))}` },
          });
        if (names?.includes(SECRET) && !isIssuer) {
          const parent = node.parent;
          const isIssuerSecret =
            parent?.type === 'NewExpression' &&
            parent.arguments[0] === node &&
            (typed
              ? isIssuerClass(parent.callee)
              : parent.callee.type === 'Identifier' &&
                parent.callee.name === 'InternalTokenService');
          if (!isIssuerSecret)
            context.report({ node, messageId: 'signer', data: { what: `reading ${SECRET}` } });
        }
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
          if (names?.includes(SECRET) && !isIssuer)
            context.report({
              node: property,
              messageId: 'signer',
              data: { what: `reading ${SECRET}` },
            });
          if (names?.some((name) => SIGNERS.has(name)) && !allowed(property, 'signer')) {
            const fromJose = typed
              ? (checker.getSymbolAtLocation(tsNode(property.key))?.declarations ?? []).some(
                  (declaration) => /\/jose\//.test(posix(declaration.getSourceFile().fileName)),
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

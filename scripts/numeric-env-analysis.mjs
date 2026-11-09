import ts from 'typescript';
import { resolve, relative, dirname } from 'node:path';

const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST = /(?:^|\/)(?:__tests__|test|e2e)\/|\.(?:spec|int-spec|test)\.[cm]?[jt]sx?$/;
const unwrap = (node) => {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
};
const key = (node) =>
  node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    ? node.text
    : undefined;

// Tokenize instead of stripping whitespace: spaces inside literals remain significant.
export function normalized(node) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    node.getText(),
  );
  const tokens = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    tokens.push(scanner.getTokenText());
  return tokens.join(' ');
}

export function envRoots(files) {
  return [...files]
    .filter(
      ([path, source]) =>
        SOURCE.test(path) &&
        !TEST.test(path) &&
        (/\/(?:config|server)\/env\.[cm]?[jt]sx?$/.test(path) ||
          path === 'packages/config/src/env.ts' ||
          /\bexport\s+(?:const|let|function)\s+\w*EnvSchema\b/.test(source)),
    )
    .map(([path]) => path)
    .sort();
}

/** Inspect authored source, never build output or code executed from a base revision. */
export function analyzeNumericEnv(root, files, roots = envRoots(files)) {
  if (!roots.length) throw new Error('numeric env guard: no schema roots');
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: true,
    baseUrl: root,
    paths: {},
  };
  for (const [path, source] of files) {
    if (!/^packages\/[^/]+\/package\.json$/.test(path)) continue;
    const pkg = JSON.parse(source);
    if (typeof pkg.name !== 'string') throw new Error(`invalid workspace ${path}`);
    options.paths[pkg.name] = [path.replace(/package\.json$/, 'src/index.ts')];
    options.paths[`${pkg.name}/*`] = [path.replace(/package\.json$/, 'src/*')];
  }
  const absolute = new Map([...files].map(([path, source]) => [resolve(root, path), source]));
  const host = ts.createCompilerHost(options);
  const diskRead = host.readFile;
  const diskExists = host.fileExists;
  host.readFile = (path) =>
    absolute.get(resolve(path)) ?? (path.includes('/node_modules/') ? diskRead(path) : undefined);
  host.fileExists = (path) =>
    absolute.has(resolve(path)) || (path.includes('/node_modules/') && diskExists(path));
  const diskDirectory = host.directoryExists;
  const directories = new Set();
  for (const file of absolute.keys()) {
    for (let dir = dirname(file); !directories.has(dir); dir = dirname(dir)) directories.add(dir);
  }
  host.directoryExists = (path) => directories.has(resolve(path)) || diskDirectory(path);
  host.getSourceFile = (path, target) => {
    const text = host.readFile(path);
    return text === undefined ? undefined : ts.createSourceFile(path, text, target, true);
  };
  const program = ts.createProgram(
    roots.map((path) => resolve(root, path)),
    options,
    host,
  );
  const checker = program.getTypeChecker();
  const scoped = program
    .getSourceFiles()
    .filter((tree) => absolute.has(resolve(tree.fileName)) && SOURCE.test(tree.fileName));
  const errors = [];
  const sites = [];
  const authored = (node) =>
    node &&
    absolute.has(resolve(node.getSourceFile().fileName)) &&
    !node.getSourceFile().isDeclarationFile;
  const typeHasNumber = (type) =>
    (type.isUnion() ? type.types : [type]).some(
      (part) => !!(part.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)),
    );
  const symbol = (node) => {
    let result = checker.getSymbolAtLocation(node);
    if (result?.flags & ts.SymbolFlags.Alias) result = checker.getAliasedSymbol(result);
    return result;
  };
  const fail = (node, reason) =>
    errors.push(
      `${relative(root, node.getSourceFile().fileName)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${reason}`,
    );
  for (const tree of scoped) {
    if (tree.parseDiagnostics.length)
      throw new Error(`numeric env guard: unreadable ${tree.fileName}`);
    const imports = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const target = node.moduleSpecifier;
        // node: modules have no TypeScript source module; their declarations are ambient.
        if (!ts.isStringLiteralLike(target)) fail(node, 'unknown import');
        else if (
          !target.text.startsWith('node:') &&
          !ts.resolveModuleName(target.text, tree.fileName, options, host).resolvedModule
        )
          fail(node, `unresolved import ${target.text}`);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        (node.arguments.length !== 1 ||
          !ts.isStringLiteralLike(node.arguments[0]) ||
          !node.arguments[0].text.startsWith('node:'))
      )
        fail(node, 'dynamic module edge');
      ts.forEachChild(node, imports);
    };
    imports(tree);
  }

  // Follow value symbols from the schema/loader roots. Importing a barrel does not
  // make its unrelated business parsers env parsers; passing a schema callback or
  // calling a helper DOES visit that declaration, including its function body.
  const relevant = new Set();
  const follow = (node, selected = relevant) => {
    if (
      !node ||
      selected.has(node) ||
      !authored(node) ||
      ts.isTypeNode(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    )
      return;
    selected.add(node);
    if (ts.isIdentifier(node))
      for (const declaration of symbol(node)?.declarations ?? []) follow(declaration, selected);
    ts.forEachChild(node, (child) => follow(child, selected));
  };
  for (const path of roots) follow(program.getSourceFile(resolve(root, path)));
  const construction = new Set();
  for (const path of roots) {
    const discover = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        /Schema$/i.test(node.name.getText()) &&
        checker.getPropertyOfType(checker.getTypeAtLocation(node.initializer), '_output')
      )
        follow(node.initializer, construction);
      ts.forEachChild(node, discover);
    };
    discover(program.getSourceFile(resolve(root, path)));
  }

  // Resolve aliases by declarations, including renamed imports, namespace and
  // destructuring aliases. A spelling such as Number or z alone grants nothing.
  const origin = (input, seen = new Set()) => {
    const node = unwrap(input);
    if (!node || seen.has(node)) return '';
    seen = new Set(seen).add(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const argument = ts.isElementAccessExpression(node) && unwrap(node.argumentExpression);
      const argumentType = argument && checker.getTypeAtLocation(argument);
      const member = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(argument)
          ? argument.text
          : argumentType?.isStringLiteral()
            ? argumentType.value
            : undefined;
      const base = origin(node.expression, seen);
      if (base && member) return `${base}.${member}`.replace(/^zod\.(?:z|default)\./, 'zod.');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['bind', 'call', 'apply'].includes(node.expression.name.text)
    )
      return origin(node.expression.expression, seen);
    if (ts.isConditionalExpression(node)) {
      const choices = [origin(node.whenTrue, seen), origin(node.whenFalse, seen)];
      return choices[0] && choices[0] === choices[1] ? choices[0] : 'unknown';
    }
    const resolved = symbol(node);
    for (const declaration of resolved?.declarations ?? []) {
      const file = declaration.getSourceFile().fileName;
      const name = resolved.name;
      if (
        /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(file) &&
        ['Number', 'BigInt', 'parseInt', 'parseFloat', 'String', 'JSON', 'globalThis'].includes(
          name,
        )
      )
        return `builtin.${name}`;
      if (/\/@types\/node\/.*\.d\.ts$/.test(file) && ['process', 'env'].includes(name))
        return name === 'env' ? 'process.env' : 'process';
      if (/\/zod\//.test(file)) {
        if (ts.isSourceFile(declaration)) return /\/coerce\.d\./.test(file) ? 'zod.coerce' : 'zod';
        if (['z', 'default'].includes(name)) return 'zod';
        return `zod.${/\/coerce\.d\./.test(file) ? 'coerce.' : ''}${name}`;
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer)
        return declaration.parent.flags & ts.NodeFlags.Const
          ? origin(declaration.initializer, seen)
          : 'unknown';
      if (ts.isBindingElement(declaration)) {
        const binding = declaration.parent;
        if (ts.isVariableDeclaration(binding.parent) && binding.parent.initializer) {
          const base = origin(binding.parent.initializer, seen);
          const member = key(declaration.propertyName ?? declaration.name);
          if (base && member) return `${base}.${member}`;
        }
      }
    }
    return '';
  };
  const builtin = (node) =>
    origin(node)
      .replace(/^builtin\.(?:globalThis\.)?/, '')
      .replace(/^Number\./, '');
  const reviewed = (node) => {
    for (let parent = node; parent; parent = parent.parent) {
      if (
        ts.isFunctionDeclaration(parent) &&
        ['wholeNumberEnv', 'wholeBigintEnv', 'parseWholeNumber'].includes(parent.name?.text)
      )
        return relative(root, parent.getSourceFile().fileName) === 'packages/config/src/env.ts';
    }
    return false;
  };
  const numeric = (node) => {
    const type = checker.getTypeAtLocation(node);
    const parts = type.isUnion() ? type.types : [type];
    return parts.every(
      (part) =>
        !!(
          part.flags &
          (ts.TypeFlags.NumberLike |
            ts.TypeFlags.BigIntLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined |
            ts.TypeFlags.Void |
            ts.TypeFlags.Never)
        ),
    );
  };
  const constant = (input, seen = new Set()) => {
    const node = unwrap(input);
    if (!node || seen.has(node)) return false;
    if (
      ts.isLiteralExpression(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    )
      return true;
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node))
      return (symbol(node)?.declarations ?? []).some(
        (decl) =>
          ts.isVariableDeclaration(decl) &&
          !!(decl.parent.flags & ts.NodeFlags.Const) &&
          decl.initializer &&
          constant(decl.initializer, seen),
      );
    return ts.isPrefixUnaryExpression(node) && constant(node.operand, seen);
  };
  // Numeric diagnostic bounds may have been formatted before conversion back
  // to a Date. Prove that formatting from the implementation, not its name.
  const writes = new Map();
  for (const tree of scoped) {
    const collect = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const target = symbol(node.left);
        if (target) writes.set(target, [...(writes.get(target) ?? []), node.right]);
      }
      ts.forEachChild(node, collect);
    };
    collect(tree);
  }
  const taintedParameters = new Set();
  const nonEnv = (input, seen = new Set()) => {
    const node = unwrap(input);
    if (!node || seen.has(node)) return false;
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const declarations = symbol(node)?.declarations ?? [];
      if (
        numeric(node) &&
        declarations.some(
          (decl) =>
            (ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isBindingElement(decl)) &&
            !numeric(decl.name),
        )
      )
        return true;
      if (declarations.some((decl) => taintedParameters.has(decl))) return false;
      const initializers = declarations.filter(
        (decl) => ts.isVariableDeclaration(decl) && decl.initializer,
      );
      if (initializers.length)
        return (
          initializers.every((decl) => nonEnv(decl.initializer, seen)) &&
          (writes.get(symbol(node)) ?? []).every((value) => nonEnv(value, seen))
        );
      for (const decl of declarations)
        if (
          ts.isBindingElement(decl) &&
          ts.isVariableDeclaration(decl.parent.parent) &&
          decl.parent.parent.initializer &&
          readsEnv(decl.parent.parent.initializer)
        )
          return false;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'length' &&
      (symbol(node.name)?.declarations ?? []).some(
        (decl) =>
          /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(decl.getSourceFile().fileName) &&
          ['Array', 'ReadonlyArray', 'String'].includes(decl.parent?.name?.text),
      )
    )
      return true;
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      readsEnv(node)
    )
      return false;
    if (ts.isConditionalExpression(node))
      return nonEnv(node.whenTrue, seen) && nonEnv(node.whenFalse, seen);
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.CommaToken,
      ].includes(node.operatorToken.kind)
    )
      return nonEnv(node.left, seen) && nonEnv(node.right, seen);
    if (!ts.isCallExpression(node) && (numeric(node) || constant(node))) return true;
    if (ts.isCallExpression(node)) {
      if (
        builtin(node.expression) === 'String' &&
        node.arguments.length === 1 &&
        numeric(node.arguments[0]) &&
        nonEnv(node.arguments[0], seen)
      )
        return true;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'toString' &&
        numeric(node.expression.expression) &&
        nonEnv(node.expression.expression, seen)
      )
        return true;
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (reviewed(declaration) && declaration.name?.text === 'parseWholeNumber') return true;
      if (
        declaration &&
        /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(declaration.getSourceFile().fileName) &&
        ['Array', 'ReadonlyArray', 'String'].includes(declaration.parent?.name?.text) &&
        ['indexOf', 'lastIndexOf', 'findIndex', 'findLastIndex', 'push', 'unshift'].includes(
          declaration.name?.getText(),
        )
      )
        return true;
      if (authored(declaration) && declaration.body) {
        const returns = ts.isBlock(declaration.body) ? [] : [declaration.body];
        const collect = (child) => {
          if (child !== declaration.body && ts.isFunctionLike(child)) return;
          if (ts.isReturnStatement(child)) returns.push(child.expression);
          ts.forEachChild(child, collect);
        };
        collect(declaration.body);
        return (
          returns.length > 0 &&
          returns.every((expression) => expression && nonEnv(expression, seen))
        );
      }
      return (
        numeric(node) &&
        node.arguments.every((argument) => nonEnv(argument, seen)) &&
        !(ts.isPropertyAccessExpression(node.expression) && readsEnv(node.expression.expression))
      );
    }
    return false;
  };
  const envMemo = new Map();
  const readsEnv = (input, seen = new Set()) => {
    const node = unwrap(input);
    if (!node || seen.has(node)) return false;
    seen = new Set(seen).add(node);
    if (
      ts.isCallExpression(node) &&
      (symbol(node.expression)?.declarations ?? []).some(
        (decl) =>
          ts.isFunctionDeclaration(decl) &&
          ((decl.name?.text === 'loadEnv' &&
            relative(root, decl.getSourceFile().fileName) === 'packages/config/src/env.ts') ||
            (decl.name?.text === 'legacyParse' &&
              relative(root, decl.getSourceFile().fileName) ===
                'packages/contracts/src/common/zod-issues.ts')),
      )
    )
      return false;
    if (
      ts.isIdentifier(node) &&
      (symbol(node)?.declarations ?? []).some(
        (decl) =>
          ts.isParameter(decl) &&
          (taintedParameters.has(decl) ||
            checker.getTypeAtLocation(decl).symbol?.name === 'ProcessEnv'),
      )
    )
      return true;
    if (envMemo.has(node)) return envMemo.get(node);
    if (origin(node).startsWith('process.env')) {
      envMemo.set(node, true);
      return true;
    }
    if (
      ts.isIdentifier(node) &&
      (symbol(node)?.declarations ?? []).some(
        (decl) =>
          ts.isVariableDeclaration(decl) && decl.initializer && readsEnv(decl.initializer, seen),
      )
    )
      return true;
    let result = false;
    ts.forEachChild(node, (child) => {
      if (readsEnv(child, seen)) result = true;
    });
    envMemo.set(node, result);
    return result;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const tree of scoped) {
      const propagate = (node) => {
        if (relevant.has(node) && ts.isCallExpression(node)) {
          const target = checker.getResolvedSignature(node)?.declaration;
          if (authored(target) && target.body && !reviewed(target))
            for (const [index, argument] of node.arguments.entries()) {
              const parameter = target.parameters[index];
              const type = checker.getTypeAtLocation(unwrap(argument));
              const parts = type.isUnion() ? type.types : [type];
              const textInput =
                parts.some(
                  (part) =>
                    !!(
                      part.flags &
                      (ts.TypeFlags.StringLike | ts.TypeFlags.Unknown | ts.TypeFlags.Any)
                    ),
                ) ||
                !!(
                  checker.getIndexTypeOfType(type, ts.IndexKind.String)?.flags &
                  ts.TypeFlags.StringLike
                );
              if (
                parameter &&
                !taintedParameters.has(parameter) &&
                !nonEnv(argument) &&
                (textInput || readsEnv(argument))
              ) {
                taintedParameters.add(parameter);
                envMemo.clear();
                changed = true;
              }
            }
        }
        ts.forEachChild(node, propagate);
      };
      propagate(tree);
    }
  }
  const callbacks = new Set();
  const followCallback = (node) => {
    if (!node || callbacks.has(node) || !authored(node) || ts.isTypeNode(node)) return;
    callbacks.add(node);
    if (ts.isIdentifier(node))
      for (const declaration of symbol(node)?.declarations ?? []) followCallback(declaration);
    ts.forEachChild(node, followCallback);
  };
  for (const tree of scoped) {
    const discover = (node) => {
      if (
        relevant.has(node) &&
        ts.isCallExpression(node) &&
        /^zod\.(?:preprocess|transform|overwrite)$/.test(origin(node.expression))
      ) {
        for (const signature of checker.getTypeAtLocation(node.arguments[0]).getCallSignatures())
          followCallback(signature.declaration);
      }
      ts.forEachChild(node, discover);
    };
    discover(tree);
  }
  // A numeric schema whose input can be text must have a proved parser origin.
  // This also refuses opaque imported schemas/factories, even when no converter
  // syntax is visible in this repository.
  const schemaOrigin = (input, seen = new Set()) => {
    const node = unwrap(input);
    if (!node || seen.has(node)) return false;
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const declarations = symbol(node)?.declarations ?? [];
      const values = declarations.filter(
        (decl) => ts.isVariableDeclaration(decl) && decl.initializer,
      );
      if (values.length) return values.every((decl) => schemaOrigin(decl.initializer, seen));
    }
    if (ts.isConditionalExpression(node))
      return schemaOrigin(node.whenTrue, seen) && schemaOrigin(node.whenFalse, seen);
    if (!ts.isCallExpression(node)) return false;
    const callee = origin(node.expression);
    if (/^zod\.coerce\.(?:number|bigint)$/.test(callee)) return true;
    if (callee === 'zod.union' && ts.isArrayLiteralExpression(node.arguments[0]))
      return node.arguments[0].elements.every((branch) => {
        const output = checker.getPropertyOfType(checker.getTypeAtLocation(branch), '_output');
        return (
          output &&
          (!typeHasNumber(checker.getTypeOfSymbolAtLocation(output, branch)) ||
            schemaOrigin(branch, seen))
        );
      });
    if (
      (symbol(node.expression)?.declarations ?? []).some(
        (decl) =>
          ts.isFunctionDeclaration(decl) &&
          ['wholeNumberEnv', 'wholeBigintEnv'].includes(decl.name?.text) &&
          relative(root, decl.getSourceFile().fileName) === 'packages/config/src/env.ts',
      )
    )
      return true;
    if (ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (['catch', 'default'].includes(method)) return false;
      if (method === 'pipe')
        return (
          schemaOrigin(node.expression.expression, seen) || schemaOrigin(node.arguments[0], seen)
        );
      const receiver = checker.getTypeAtLocation(node.expression.expression);
      if (checker.getPropertyOfType(receiver, '_output'))
        return schemaOrigin(node.expression.expression, seen);
    }
    const target = checker.getResolvedSignature(node)?.declaration;
    if (authored(target) && target.body) {
      const returns = ts.isBlock(target.body) ? [] : [target.body];
      const collect = (child) => {
        if (child !== target.body && ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child)) returns.push(child.expression);
        ts.forEachChild(child, collect);
      };
      collect(target.body);
      return returns.length > 0 && returns.every((value) => schemaOrigin(value, seen));
    }
    return false;
  };
  const checkSchema = (node) => {
    const type = checker.getTypeAtLocation(node);
    if (construction.has(node) && type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      const owner =
        ts.isPropertyAssignment(node.parent) || ts.isSpreadAssignment(node.parent)
          ? node.parent.parent
          : node.parent;
      const call = owner?.parent;
      if (
        call &&
        ts.isCallExpression(call) &&
        /^zod\.(?:object|strictObject|looseObject|extend|safeExtend)$/.test(origin(call.expression))
      )
        fail(node, 'unknown schema field or shape');
    }
    const input = checker.getPropertyOfType(type, '_input');
    const output = checker.getPropertyOfType(type, '_output');
    if (!input || !output) return;
    if (
      construction.has(node) &&
      ts.isCallExpression(node) &&
      !origin(node.expression).startsWith('zod.')
    ) {
      const target = checker.getResolvedSignature(node)?.declaration;
      if (!authored(target) || !target.body) fail(node, 'opaque schema factory');
    }

    if (construction.has(node) && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))) {
      const declarations = symbol(node)?.declarations ?? [];
      if (
        !declarations.length ||
        declarations.some(
          (decl) =>
            !authored(decl) ||
            ((ts.isVariableDeclaration(decl) || ts.isParameter(decl)) && !decl.initializer),
        )
      )
        fail(node, 'unknown schema provider');
    }
    const inType = checker.getTypeOfSymbolAtLocation(input, node);
    const outType = checker.getTypeOfSymbolAtLocation(output, node);
    const parts = inType.isUnion() ? inType.types : [inType];
    const text = parts.some(
      (part) =>
        !!(part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Unknown | ts.TypeFlags.Any)),
    );
    if (text && typeHasNumber(outType) && !schemaOrigin(node))
      fail(node, 'unknown numeric schema provenance');
    if (
      (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
      (symbol(node)?.declarations ?? []).some((decl) => !authored(decl))
    )
      fail(node, 'opaque imported schema');
  };
  const fingerprint = (node) => {
    let field = node;
    while (field && !ts.isPropertyAssignment(field)) field = field.parent;
    return [
      relative(root, node.getSourceFile().fileName),
      field ? key(field.name) : '',
      normalized(field?.initializer ?? node),
    ];
  };
  const visit = (node) => {
    if (reviewed(node)) return;
    if (relevant.has(node)) {
      if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) && node.initializer)
        checkSchema(node.initializer);
      if (ts.isReturnStatement(node) && node.expression) checkSchema(node.expression);
      if (ts.isSpreadAssignment(node)) checkSchema(node.expression);
      if (ts.isCallExpression(node)) node.arguments.forEach(checkSchema);
    }
    const active =
      relevant.has(node) ||
      ((ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isPrefixUnaryExpression(node) ||
        ts.isPostfixUnaryExpression(node) ||
        ts.isBinaryExpression(node)) &&
        readsEnv(node));
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = origin(node.expression);
      if (active && /^zod\.(?:codec|ZodNumber|ZodBigInt|\$ZodNumber|\$ZodBigInt)$/.test(callee))
        fail(node, 'unreviewed numeric schema implementation');
      if (active && /^(?:zod\.)?(?:preprocess|transform|overwrite)$/.test(callee)) {
        const callback = node.arguments?.[0];
        const signatures = callback && checker.getTypeAtLocation(callback).getCallSignatures();
        if (
          !signatures?.length ||
          signatures.some(
            (signature) => !authored(signature.declaration) || !signature.declaration.body,
          )
        )
          fail(node, 'unknown schema callback');
        const receiver = ts.isPropertyAccessExpression(node.expression)
          ? checker.getTypeAtLocation(node.expression.expression)
          : undefined;
        const output = receiver && checker.getPropertyOfType(receiver, '_output');
        const inputNumber =
          output &&
          checker.getTypeOfSymbolAtLocation(output, node).flags &
            (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike);
        if (
          !inputNumber &&
          signatures?.some((signature) =>
            typeHasNumber(checker.getReturnTypeOfSignature(signature)),
          )
        )
          fail(node, 'unreviewed numeric schema callback');
      }
      const member = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isElementAccessExpression(node.expression)
          ? key(node.expression.argumentExpression)
          : '';
      if (
        active &&
        ['number', 'bigint'].includes(member) &&
        !callee.startsWith('zod.') &&
        (checker.getTypeAtLocation(node.expression).flags &
          (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
          !checker.getResolvedSignature(node)?.declaration?.body)
      )
        fail(node, 'unknown numeric schema factory');
      if (/^zod\.coerce\.(number|bigint)$/.test(callee)) {
        sites.push({ fingerprint: fingerprint(node), kind: callee.slice(4) });
      } else if (/^zod\.(?:number|bigint)$/.test(callee) && node.arguments?.length) {
        // Numeric constructors' options may hide coercion behind spreads or aliases.
        fail(node, 'numeric schema options are unreviewed');
      }
      if (active) {
        const name = builtin(node.expression);
        if (['Number', 'BigInt', 'parseInt', 'parseFloat'].includes(name)) {
          if (
            name === 'parseFloat' ||
            !node.arguments?.length ||
            node.arguments.some((argument) => !nonEnv(argument))
          )
            fail(node, `unreviewed ${name} conversion`);
        } else {
          // A callable returning a numeric primitive from env text needs a known
          // implementation. External/unknown parsers cannot silently become safe.
          const signature = checker.getResolvedSignature(node);
          const output = signature && checker.getReturnTypeOfSignature(signature);
          const primitiveNumber =
            output && !!(output.flags & (ts.TypeFlags.Number | ts.TypeFlags.BigInt));
          const unknownOutput =
            output && !!(output.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
          const declaration = signature?.declaration;
          const libraryCollection =
            declaration &&
            /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(declaration.getSourceFile().fileName) &&
            ['Array', 'ReadonlyArray'].includes(declaration.parent?.name?.text);
          const ipClassifier =
            declaration &&
            /\/@types\/node\/net\.d\.ts$/.test(declaration.getSourceFile().fileName) &&
            declaration.name?.text === 'isIP';
          if (
            (primitiveNumber &&
              node.arguments?.some((argument) => !nonEnv(argument)) &&
              (!authored(declaration) || !declaration.body) &&
              !libraryCollection &&
              !ipClassifier) ||
            (unknownOutput &&
              !declaration?.body &&
              (callbacks.has(node) ||
                (relevant.has(node) && node.arguments?.some((argument) => readsEnv(argument)))))
          )
            fail(node, 'unknown numeric conversion of env input');
        }
      }
    }
    if (
      active &&
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.TildeToken,
        ts.SyntaxKind.PlusPlusToken,
        ts.SyntaxKind.MinusMinusToken,
      ].includes(node.operator) &&
      !nonEnv(node.operand)
    )
      fail(node, 'unreviewed unary numeric conversion');
    if (active && ts.isCallExpression(node)) {
      for (const argument of node.arguments) {
        if (['Number', 'BigInt', 'parseInt', 'parseFloat'].includes(builtin(argument)))
          fail(node, 'unreviewed numeric callback');
      }
    }
    if (
      active &&
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.BarToken,
        ts.SyntaxKind.AmpersandToken,
        ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        ts.SyntaxKind.MinusEqualsToken,
        ts.SyntaxKind.AsteriskEqualsToken,
        ts.SyntaxKind.SlashEqualsToken,
        ts.SyntaxKind.PercentEqualsToken,
        ts.SyntaxKind.BarEqualsToken,
        ts.SyntaxKind.AmpersandEqualsToken,
        ts.SyntaxKind.CaretEqualsToken,
        ts.SyntaxKind.LessThanLessThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.AsteriskAsteriskEqualsToken,
      ].includes(node.operatorToken.kind) &&
      (node.operatorToken.kind !== ts.SyntaxKind.PlusToken || numeric(node)) &&
      (!nonEnv(node.left) || !nonEnv(node.right))
    )
      fail(node, 'unreviewed arithmetic conversion');
    if (
      relevant.has(node) &&
      (ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      ['Number', 'BigInt', 'parseInt', 'parseFloat'].includes(builtin(node)) &&
      ((ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) ||
        ts.isArrayLiteralExpression(node.parent) ||
        (ts.isBinaryExpression(node.parent) && node.parent.right === node))
    )
      fail(node, 'unreviewed stored numeric parser');
    ts.forEachChild(node, visit);
  };
  scoped.forEach(visit);
  return {
    errors: [...new Set(errors)].sort(),
    sites,
    scope: scoped.map((tree) => relative(root, tree.fileName)).sort(),
    roots,
  };
}

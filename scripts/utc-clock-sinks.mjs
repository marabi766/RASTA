// SQL is checked where it is executed, after composing its text. Unknown text refuses.
import ts from 'typescript';
import { dirname, resolve as pathResolve } from 'node:path';
import { PLACEHOLDER, lex } from './eligibility-clock-sql.mjs';
import { files as authoredFiles, productionFiles, walk } from './eligibility-clock-derive.mjs';

export const SQL_SINKS = new Set([
  '$queryRaw', '$executeRaw', 'queryRaw', 'executeRaw',
  '$queryRawUnsafe', '$executeRawUnsafe', 'queryRawUnsafe', 'executeRawUnsafe',
  'query', 'execute',
]);
const unwrap = (n) => {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) || ts.isAwaitExpression(n) ||
    ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n))) n = n.expression;
  return n;
};
const nameOf = (n) => ts.isIdentifier(n) ? n.text :
  ts.isPropertyAccessExpression(n) ? n.name.text :
    ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)
      ? n.argumentExpression.text : null;

export function sqlSinkTexts(repository, files = productionFiles(repository)) {
  const authored = authoredFiles(repository);
  // Execution sites are authored source; generated declarations only prove bound values.
  const options = { allowJs: true, strict: true, moduleDetection: ts.ModuleDetectionKind.Force,
    moduleResolution: ts.ModuleResolutionKind.Node10, target: ts.ScriptTarget.Latest,
    baseUrl: repository, paths: { '@rasta/*': ['packages/*/src/index.ts'] } };
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const sources = files.map((p) => program.getSourceFile(p));
  const symbol = (n) => {
    let s = checker.getSymbolAtLocation(n);
    if (s?.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  };
  const declaration = (n) => {
    n = unwrap(n);
    if (ts.isPropertyAccessExpression(n)) n = n.name;
    if (ts.isElementAccessExpression(n)) n = n.argumentExpression;
    return symbol(n)?.valueDeclaration;
  };
  const calls = [];
  for (const ast of sources) walk(ast, (n) => {
    if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) calls.push(n);
  });
  const targetOf = (n) => unwrap(ts.isTaggedTemplateExpression(n) ? n.tag : n.expression);
  const argumentsOf = (n) => ts.isTaggedTemplateExpression(n) ? [n.template] : n.arguments;
  // TypeScript's `this` parameter has no runtime argument slot.
  const parametersOf = (fn) => fn.parameters.filter((p) => !ts.parameterIsThisKeyword(p));
  const ordinaryCall = (fn, call) => ts.isCallExpression(call) &&
    !call.arguments.some(ts.isSpreadElement);
  const argumentFor = (fn, param, call) => ordinaryCall(fn, call) && !param.dotDotDotToken
    ? call.arguments[parametersOf(fn).indexOf(param)] ?? param.initializer : undefined;
  const callers = new Map();
  for (const c of calls) {
    const d = declaration(targetOf(c));
    if (d) callers.set(d, [...(callers.get(d) ?? []), c]);
  }
  const functionOf = (n) => {
    while (n && !ts.isFunctionLike(n)) n = n.parent;
    return n;
  };
  const refs = new Map(), bindings = new Map();
  for (const ast of sources) walk(ast, (n) => {
    if (ts.isElementAccessExpression(n) && unwrap(n.expression).kind === ts.SyntaxKind.ThisKeyword &&
      !ts.isStringLiteralLike(n.argumentExpression)) {
      let owner = n.parent;
      while (owner && !ts.isClassDeclaration(owner)) owner = owner.parent;
      for (const member of owner?.members ?? []) refs.set(member, [...(refs.get(member) ?? []), n]);
    }
    if (!ts.isIdentifier(n) && !ts.isStringLiteralLike(n)) return;
    const d = declaration(n);
    if (d && n !== d.name) refs.set(d, [...(refs.get(d) ?? []), n]);
    const s = checker.getSymbolAtLocation(n);
    if (s) bindings.set(s, [...(bindings.get(s) ?? []), n]);
  });
  // Mutable bindings cannot prove executed text. Even a const array may be mutated.
  const mutable = new Set();
  for (const ast of sources) walk(ast, (n) => {
    if ((ts.isBinaryExpression(n) && ts.isAssignmentOperator(n.operatorToken.kind)) ||
      ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) {
      for (let lhs = n.left ?? n.operand; lhs; lhs = ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs) ? lhs.expression : null)
        if (declaration(lhs)) mutable.add(declaration(lhs));
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text !== 'join' && declaration(n.expression.expression)) mutable.add(declaration(n.expression.expression));
  });
  const combine = (a, b, sep = '') => !a || !b || a.length * b.length > 128 ? null :
    a.flatMap((x) => b.map((y) => x + sep + y));
  const arrayMethod = (n, name) => {
    const d = declaration(n);
    return ts.isPropertyAccessExpression(n) && n.name.text === name && d &&
      !mutable.has(d) && program.isSourceFileDefaultLibrary(d.getSourceFile());
  };
  const scalarType = (t) => t.isUnion() ? t.types.every(scalarType) :
    !!(t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike |
      ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) ||
    (t.symbol?.name === 'Date' && t.symbol.declarations?.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile())));
  const scalar = (n) => {
    const t = checker.getTypeAtLocation(unwrap(n));
    const native = ['Buffer', 'Uint8Array'].includes(t.symbol?.name) && t.symbol?.declarations?.every((d) =>
      program.isSourceFileDefaultLibrary(d.getSourceFile()) || /\/@types\/node\//.test(d.getSourceFile().fileName));
    const item = checker.isArrayType(t) || checker.isTupleType(t) || native
      ? checker.getIndexTypeOfType(t, ts.IndexKind.Number) : null;
    return scalarType(t) || (item && scalarType(item));
  };
  const prisma = (n, name) => {
    n = unwrap(n);
    if (!ts.isPropertyAccessExpression(n) || n.name.text !== name || !ts.isIdentifier(n.expression)) return false;
    const binding = checker.getSymbolAtLocation(n.expression);
    const d = binding?.declarations?.[0];
    if (!d || !ts.isImportSpecifier(d) || (d.propertyName ?? d.name).text !== 'Prisma') return false;
    const source = d.parent.parent.parent;
    const target = pathResolve(dirname(n.getSourceFile().fileName), source.moduleSpecifier.text);
    return /\/services\/[^/]+\/src\/generated\/prisma$/.test(target) &&
      !authored.some((p) => p === target + '.ts' || p.startsWith(target + '/')) &&
      !mutable.has(declaration(n)) && (name !== 'empty' || safeRefs(declaration(n), new Set(), true)) && (bindings.get(binding) ?? []).every((r) =>
        r === d.name || ts.isQualifiedName(r.parent) ||
        (ts.isPropertyAccessExpression(r.parent) && r.parent.expression === r));
  };
  const stable = (d) => d && !mutable.has(d) &&
    ((ts.isVariableDeclaration(d) && (d.parent.flags & ts.NodeFlags.Const)) ||
      (ts.isPropertyDeclaration(d) && d.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) &&
        d.modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)));
  // join's separator/prefix/suffix are raw SQL, never bound values. Only
  // immutable literal aliases are accepted, independently of fragment mode.
  const rawJoinText = (input, seen = new Set()) => {
    const n = unwrap(input);
    if (!n || seen.has(n) || seen.size > 64) return null;
    if (ts.isStringLiteralLike(n)) return n.text;
    const d = declaration(n);
    return stable(d) && d.initializer
      ? rawJoinText(d.initializer, new Set([...seen, n])) : null;
  };
  const exported = (d) => (ts.isVariableDeclaration(d) ? d.parent.parent : d).modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const safeMemo = new Map();
  const safeRefs = (d, seen = new Set(), library = false) => {
    if (!d || mutable.has(d) || seen.has(d) || seen.size > 64 || (!library && exported(d))) return false;
    if (safeMemo.has(d)) return safeMemo.get(d);
    const next = new Set([...seen, d]);
    const array = checker.isArrayType(checker.getTypeAtLocation(d));
    const result = (refs.get(d) ?? []).every((r) => {
      let value = ts.isPropertyAccessExpression(r.parent) && r.parent.name === r ? r.parent : r;
      while (ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent) ||
        (ts.isConditionalExpression(value.parent) && value.parent.condition !== value)) value = value.parent;
      const p = value.parent;
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)) return true;
      if (ts.isTemplateSpan(p) && ts.isTaggedTemplateExpression(p.parent.parent))
        return prisma(p.parent.parent.tag, 'sql') || /^\$?(?:query|execute)Raw$/.test(nameOf(p.parent.parent.tag));
      if (ts.isVariableDeclaration(p) && p.initializer === value && stable(p)) return safeRefs(p, next);
      if (ts.isArrayLiteralExpression(p) && ts.isCallExpression(p.parent) && prisma(p.parent.expression, 'join') && p.parent.arguments[0] === p) return true;
      if (!ts.isCallExpression(p) || !p.arguments.includes(value)) return false;
      const index = p.arguments.indexOf(value);
      if (array && index === 0 && prisma(p.expression, 'join')) return true;
      let fn = declaration(p.expression);
      if (fn && ts.isVariableDeclaration(fn)) fn = stable(fn) ? unwrap(fn.initializer) : null;
      if (fn && ts.isFunctionLike(fn) && fn.body)
        return !mutable.has(fn) && ordinaryCall(fn, p) && !!parametersOf(fn)[index] && !parametersOf(fn)[index].dotDotDotToken && safeRefs(parametersOf(fn)[index], next);
      return index === 0 && SQL_SINKS.has(nameOf(p.expression));
    });
    safeMemo.set(d, result);
    return result;
  };
  // An object adapter may only travel into known functions. Every use of their
  // receiving parameter must be a direct dispatch; storing/returning it refuses.
  const dispatches = (owner, method) => {
    if (!stable(owner) || exported(owner)) return null;
    let escaped = false;
    if (ts.isPropertyDeclaration(owner)) walk(owner.parent, (n) => {
      if (n.kind === ts.SyntaxKind.ThisKeyword &&
        !((ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) && n.parent.expression === n)) escaped = true;
    });
    if (escaped) return null;
    const result = [];
    for (const ref of refs.get(owner) ?? []) {
      const value = ts.isPropertyAccessExpression(ref.parent) || ts.isElementAccessExpression(ref.parent) ? ref.parent : ref;
      const call = value.parent;
      if (!ts.isCallExpression(call) || !call.arguments.includes(value)) return null;
      const fn = declaration(call.expression), index = call.arguments.indexOf(value);
      if (!fn || mutable.has(fn) || !ts.isFunctionLike(fn) || !fn.body || !ordinaryCall(fn, call) || !parametersOf(fn)[index] || parametersOf(fn)[index].dotDotDotToken) return null;
      for (const use of refs.get(parametersOf(fn)[index]) ?? []) {
        const access = use.parent, invocation = access.parent;
        if (!ts.isPropertyAccessExpression(access) || access.expression !== use ||
          access.name.text !== method || !ts.isCallExpression(invocation) || invocation.expression !== access) return null;
        result.push(invocation);
      }
    }
    return result.length ? result : null;
  };
  const parameterCalls = (d) => {
    const fn = d.parent, property = fn.parent;
    if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.parent)) {
      const owner = property.parent.parent;
      return owner.initializer === property.parent ? dispatches(owner, property.name.getText()) : null;
    }
    const owner = ts.isVariableDeclaration(property) ? property : fn;
    if (exported(owner)) return null;
    if (mutable.has(owner) || (ts.isVariableDeclaration(owner) && !stable(owner))) return null;
    if (ts.isMethodDeclaration(owner) && !owner.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return null;
    if (ts.canHaveDecorators(fn) && ts.getDecorators(fn)?.length) return null;
    const sites = callers.get(owner) ?? callers.get(fn) ?? [];
    if (sites.some((c) => !ordinaryCall(fn, c))) return null;
    if ((refs.get(owner) ?? []).some((r) => {
      const target = ts.isPropertyAccessExpression(r.parent) && r.parent.name === r ? r.parent : r;
      return ts.isElementAccessExpression(target) || !ts.isCallExpression(target.parent) ||
        target.parent.expression !== target || !sites.includes(target.parent);
    })) return null;
    return sites;
  };
  const resolve = (input, seen = new Set(), env = new Map(), raw = false, asFragment = false) => {
    const n = unwrap(input);
    if (!n || seen.has(n) || seen.size > 64) return null;
    if (asFragment && scalar(n)) return [PLACEHOLDER(0)];
    const next = new Set([...seen, n]);
    const go = (x) => resolve(x, next, env, raw, asFragment);
    if (env.has(n)) return resolve(env.get(n), next, env, raw, asFragment);
    if (ts.isStringLiteralLike(n)) return [raw ? n.rawText ?? n.text : n.text];
    if (ts.isNumericLiteral(n)) return [n.text];
    if (ts.isTemplateExpression(n)) {
      let out = [raw ? n.head.rawText ?? n.head.text : n.head.text];
      for (const s of n.templateSpans) {
        if (!scalarType(checker.getTypeAtLocation(unwrap(s.expression)))) return null;
        out = combine(combine(out, resolve(s.expression, next, env, false, asFragment)), [raw ? s.literal.rawText ?? s.literal.text : s.literal.text]);
      }
      return out;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (checker.getTypeAtLocation(n).flags & ts.TypeFlags.StringLike) &&
      scalarType(checker.getTypeAtLocation(unwrap(n.left))) && scalarType(checker.getTypeAtLocation(unwrap(n.right))))
      return combine(go(n.left), go(n.right));
    if (ts.isConditionalExpression(n)) {
      const a = go(n.whenTrue), b = go(n.whenFalse);
      return a && b && a.length + b.length <= 128 ? [...a, ...b] : null;
    }
    if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
      if (prisma(n, 'empty')) return [''];
      const d = declaration(n);
      if (!d || mutable.has(d)) return null;
      if (stable(d) && d.initializer) return scalarType(checker.getTypeAtLocation(n)) || safeRefs(d) ? go(d.initializer) : null;
      if (ts.isParameter(d)) {
        if (env.has(d)) return resolve(env.get(d), next, env, raw, asFragment);
        const fn = d.parent;
        const sites = parameterCalls(d);
        if (!sites?.length) return null;
        if ((refs.get(d) ?? []).some((r) => {
          const c = r.parent;
          if (ts.isTemplateSpan(c)) {
            const use = c.parent.parent;
            if (ts.isTaggedTemplateExpression(use) &&
              (prisma(use.tag, 'sql') || SQL_SINKS.has(nameOf(use.tag)))) return false;
            if (ts.isCallExpression(use) && SQL_SINKS.has(nameOf(use.expression)) && use.arguments[0] === c.parent) return false;
          }
          return !ts.isCallExpression(c) || !SQL_SINKS.has(nameOf(c.expression)) || c.arguments[0] !== r;
        })) return null;
        const values = sites.map((c) => go(argumentFor(fn, d, c)));
        return values.every(Boolean) ? values.flat() : null;
      }
      return null;
    }
    if (ts.isTaggedTemplateExpression(n)) {
      const d = declaration(n.tag);
      if (n.tag.getText() === 'String.raw' && d && !mutable.has(d) &&
        program.isSourceFileDefaultLibrary(d.getSourceFile())) return resolve(n.template, next, env, true);
      if (prisma(n.tag, 'sql')) return template(n.template, next, env);
      return null; // An arbitrary tag can transform or replace its input.
    }
    if (ts.isCallExpression(n)) {
      if (prisma(n.expression, 'join')) {
        let list = unwrap(n.arguments[0]);
        const d = declaration(list);
        if (stable(d) && d.initializer) {
          if (!safeRefs(d)) return null;
          list = unwrap(d.initializer);
        }
        if (n.arguments.length > 4 || n.arguments.some(ts.isSpreadElement)) return null;
        const [sep, prefix, suffix] = [',', '', ''].map((fallback, i) =>
          n.arguments[i + 1] ? rawJoinText(n.arguments[i + 1]) : fallback);
        if ([sep, prefix, suffix].includes(null)) return null;
        const wrap = (texts) => texts?.map((text) => prefix + text + suffix) ?? null;
        // A spread has unknown multiplicity. Collapse only scalar bindings with
        // a comma separator; raw separators and Sql elements must refuse.
        const elementText = (value) => {
          if (ts.isOmittedExpression(value)) return null;
          if (!ts.isSpreadElement(value)) return fragment(value, next, env);
          const item = checker.getIndexTypeOfType(checker.getTypeAtLocation(value.expression), ts.IndexKind.Number);
          return /^\s*,\s*$/.test(sep) && item && scalarType(item) ? [PLACEHOLDER(0)] : null;
        };
        // Local push-only fragment lists: enumerate every subset, including
        // conditional pushes. No alias, escape, replacement or other mutator.
        if (d && mutable.has(d) && functionOf(d) && ts.isVariableDeclaration(d) &&
          (d.parent.flags & ts.NodeFlags.Const) && ts.isArrayLiteralExpression(d.initializer) && !d.initializer.elements.length) {
          let out = [''];
          for (const ref of refs.get(d) ?? []) {
            const access = ref.parent, call = access.parent;
            if (ts.isPropertyAccessExpression(access) && access.expression === ref && access.name.text === 'length') {
              if (ts.isBinaryExpression(call) && call.left === access && ts.isAssignmentOperator(call.operatorToken.kind)) return null;
              continue;
            }
            if (ts.isCallExpression(access) && prisma(access.expression, 'join') && access.arguments[0] === ref) continue;
            if (!arrayMethod(access, 'push') ||
              !ts.isCallExpression(call) || call.expression !== access || functionOf(call) !== functionOf(d)) return null;
            for (let ancestor = call.parent; ancestor && ancestor !== functionOf(d); ancestor = ancestor.parent)
              if (ts.isIterationStatement(ancestor, false)) return null;
            for (const value of call.arguments) {
              const pushed = elementText(value);
              if (!pushed) return null;
              const added = combine(out, pushed, sep);
              if (!added || out.length + added.length > 128) return null;
              out = [...out, ...added];
            }
          }
          return wrap(out.map((s) => s.startsWith(sep) ? s.slice(sep.length) : s));
        }
        if (ts.isArrayLiteralExpression(list))
          return wrap(list.elements.reduce((out, e, i) => combine(out, elementText(e), i ? sep : ''), ['']));
        if (!/^\s*,\s*$/.test(sep)) return null;
        if (ts.isCallExpression(list) && arrayMethod(list.expression, 'map') &&
          list.arguments.length === 1 && ts.isArrowFunction(list.arguments[0])) {
          const tuples = fragment(list.arguments[0].body, next, env);
          return tuples?.every((text) => {
            const tokens = lex(text); let depth = 0;
            if (tokens.length === 1 && tokens[0].type === 'placeholder') return true;
            return tokens[0]?.value === '(' && tokens.at(-1)?.value === ')' && tokens.every((t, i) => {
              if (t.type === 'op' && t.value === '(') depth += 1;
              if (t.type === 'op' && t.value === ')') depth -= 1;
              return i === tokens.length - 1 ? depth === 0 : depth > 0;
            });
          }) ? wrap(tuples) : null;
        }
        const element = checker.getIndexTypeOfType(checker.getTypeAtLocation(list), ts.IndexKind.Number);
        return element && scalarType(element) ? wrap([PLACEHOLDER(0)]) : null;
      }
      if (arrayMethod(n.expression, 'join')) {
        let array = unwrap(n.expression.expression);
        if (!ts.isArrayLiteralExpression(array)) {
          const d = declaration(array);
          if (!d || mutable.has(d) || !(d.parent.flags & ts.NodeFlags.Const)) return null;
          if ((refs.get(d) ?? []).some((r) => !ts.isPropertyAccessExpression(r.parent) ||
            r.parent.expression !== r || r.parent.name.text !== 'join')) return null;
          array = unwrap(d.initializer);
        }
        if (!array || !ts.isArrayLiteralExpression(array)) return null;
        const sep = n.arguments[0] ? go(n.arguments[0]) : [','];
        if (!sep || sep.length !== 1) return null;
        return array.elements.every((e) => scalarType(checker.getTypeAtLocation(unwrap(e))))
          ? array.elements.reduce((out, e, i) => combine(out, go(e), i ? sep[0] : ''), ['']) : null;
      }
      let fn = declaration(n.expression);
      if (!fn || mutable.has(fn)) return null;
      if (ts.isVariableDeclaration(fn)) fn = stable(fn) ? unwrap(fn.initializer) : null;
      if (!fn || !ts.isFunctionLike(fn) || !fn.body) return null;
      let opaque = false;
      walk(fn.body, (r) => {
        if (ts.isNewExpression(r) || ts.isDeleteExpression(r) ||
          (ts.isBinaryExpression(r) && ts.isAssignmentOperator(r.operatorToken.kind))) opaque = true;
        if (ts.isCallExpression(r) && !prisma(r.expression, 'join') &&
          !['map', 'join', 'push'].some((name) => arrayMethod(r.expression, name))) opaque = true;
        if (ts.isCallExpression(r) && arrayMethod(r.expression, 'push')) {
          const local = declaration(r.expression.expression);
          if (!local || !ts.isVariableDeclaration(local) || functionOf(local) !== fn ||
            !local.initializer || !ts.isArrayLiteralExpression(local.initializer) || local.initializer.elements.length) opaque = true;
        }
      });
      if (opaque) return null;
      const bound = new Map(env);
      if (!ordinaryCall(fn, n) || fn.parameters.some((p) => p.dotDotDotToken)) return null;
      parametersOf(fn).forEach((p) => bound.set(p, argumentFor(fn, p, n)));
      const returns = [];
      if (!ts.isBlock(fn.body)) returns.push(fn.body);
      else walk(fn.body, (r) => {
        if (ts.isReturnStatement(r) && functionOf(r) === fn) returns.push(r.expression);
      });
      const values = returns.map((r) => asFragment ? fragment(r, next, bound) : resolve(r, next, bound, raw));
      return values.length && values.every(Boolean) ? values.flat() : null;
    }
    return null;
  };
  const fragment = (n, seen, env, index = 0) => scalar(n) ? [PLACEHOLDER(index)] : resolve(n, seen, env, false, true);
  const template = (n, seen, env) => {
    if (ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
    return n.templateSpans.reduce((out, s, i) => combine(combine(out, fragment(s.expression, seen, env, i)), [s.literal.text]), [n.head.text]);
  };
  return calls.flatMap((call) => {
    const target = targetOf(call), name = nameOf(target);
    if (!SQL_SINKS.has(name)) return [];
    const d = declaration(target);
    // A locally implemented method called execute/query is a domain command or a
    // wrapper. Its body is scanned for real SQL sinks, not treated as SQL itself.
    if ((name === 'execute' || name === 'query') && d &&
      ((ts.isFunctionLike(d) && d.body) || (ts.isBindingElement(d) &&
        functionOf(d)?.name?.getText() === '$allOperations'))) return [];
    const node = argumentsOf(call)[0] ?? call;
    const tagged = ts.isTaggedTemplateExpression(call);
    // Safe tags bind scalars; nested SQL fragments still need complete proof.
    // Raw calls require complete text; a placeholder cannot stand for a SELECT.
    const safe = tagged && /^\$?(?:query|execute)Raw$/.test(name);
    const texts = safe ? template(node, new Set(), new Map()) : resolve(node);
    return (texts?.length ? texts : [null]).map((text) => ({ node, text,
      file: node.getSourceFile().fileName, sink: name }));
  });
}

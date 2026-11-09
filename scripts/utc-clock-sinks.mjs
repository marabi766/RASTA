// SQL is checked where it is executed, after composing its text. Unknown text refuses.
import ts from 'typescript';
import { dirname, resolve as pathResolve } from 'node:path';
import { PLACEHOLDER } from './eligibility-clock-sql.mjs';
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

export function sqlSinkTexts(repository) {
  const files = productionFiles(repository);
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
  const refs = new Map(), bindings = new Map();
  for (const ast of sources) walk(ast, (n) => {
    if (!ts.isIdentifier(n)) return;
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
  const scalarType = (t) => t.isUnion() ? t.types.every(scalarType) :
    !!(t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike |
      ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) ||
    (t.symbol?.name === 'Date' && t.symbol.declarations?.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile())));
  const scalar = (n) => {
    const t = checker.getTypeAtLocation(unwrap(n));
    const native = t.symbol?.declarations?.every((d) =>
      program.isSourceFileDefaultLibrary(d.getSourceFile()) || /\/@types\/node\/buffer[^/]*\.d\.ts$/.test(d.getSourceFile().fileName));
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
        return !mutable.has(fn) && !!fn.parameters[index] && safeRefs(fn.parameters[index], next);
      return index === 0 && SQL_SINKS.has(nameOf(p.expression));
    });
    safeMemo.set(d, result);
    return result;
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
        return null;
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
          const element = checker.getIndexTypeOfType(checker.getTypeAtLocation(list), ts.IndexKind.Number);
          if (!(element && scalarType(element)) && !safeRefs(d)) return null;
          list = unwrap(d.initializer);
        }
        const sep = n.arguments[1] ? go(n.arguments[1]) : [','];
        if (!sep || sep.length !== 1) return null;
        if (ts.isArrayLiteralExpression(list))
          return list.elements.reduce((out, e, i) => combine(out, fragment(e, next, env), i ? sep[0] : ''), ['']);
        if (!/^\s*,\s*$/.test(sep[0])) return null;
        const element = checker.getIndexTypeOfType(checker.getTypeAtLocation(list), ts.IndexKind.Number);
        return element && scalarType(element) ? [PLACEHOLDER(0)] : null;
      }
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
      ((ts.isFunctionLike(d) && d.body) || ts.isParameter(d) || ts.isBindingElement(d))) return [];
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

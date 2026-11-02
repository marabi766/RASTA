// Product side of the eligibility-clock guard: which (table, column) pairs
// does product code compare against the database clock?
//
// Every SQL literal in production source (see PRODUCTION below) is read,
// whatever the method or file name. Every comparison with a clock source
// must classify, or derivation throws:
//   - a clock function or keyword (now(), CURRENT_TIMESTAMP, clock_timestamp(),
//     statement_timestamp(), transaction_timestamp(), LOCALTIMESTAMP, …),
//     with or without arithmetic, casts or AT TIME ZONE;
//   - a clock projected under an alias in the same statement (`t.now`);
//   - a JavaScript value spliced or bound into the SQL that was read from the
//     database clock in the same flow (transactionNow(tx), databaseNow(tx),
//     `SELECT now() AS now` rows, through local variables, arithmetic and
//     callers' arguments).
// Prisma `where` filters (lt/lte/gt/gte) on a DateTime field are read the
// same way: a DB-clock value there gates the column too.
// A comparison of a DateTime column with a value whose origin cannot be
// proved, and every clock use outside a comparison, assignment, VALUES list
// or projection, throws unless a reviewed SITE entry classifies it.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { PLACEHOLDER, analyse, columnsIn, projectionAliases } from './eligibility-clock-sql.mjs';

export function files(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (
      ['node_modules', 'generated', 'dist', '.git', 'coverage', '.turbo', '.next'].includes(
        entry.name,
      )
    )
      return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

export const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
export const SPEC = /\.(?:spec|test|int-spec|e2e-spec)\.[cm]?[jt]sx?$|\.pg\.test\.[cm]?js$/;

/**
 * PRODUCTION: non-spec source under services/<name>/src and packages/<name>/src,
 * except packages/testing (test support by definition) and declaration files.
 */
export function productionFiles(repository) {
  return ['services', 'packages'].flatMap((base) =>
    files(join(repository, base)).filter((path) => {
      const local = relative(repository, path);
      return (
        SOURCE.test(local) &&
        !local.endsWith('.d.ts') &&
        /^(?:services|packages)\/[^/]+\/src\//.test(local) &&
        !local.startsWith('packages/testing/') &&
        !SPEC.test(local)
      );
    }),
  );
}

export function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const lineOf = (ast, pos) => ast.getLineAndCharacterOfPosition(pos).line + 1;

/** Prisma schemas: tables by service, columns with field name and type. */
export function readSchemas(repository) {
  const tables = new Map(); // table -> [{service, model, delegate, columns: Map(column -> {field,type,location})}]
  const delegates = new Map(); // delegate -> [{table, fields: Map(field -> column)}]
  for (const path of files(join(repository, 'services')).filter((p) =>
    p.endsWith('/prisma/schema.prisma'),
  )) {
    const service = relative(repository, path).split('/')[1];
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const head = /^\s*model\s+(\w+)\s*\{/.exec(lines[i]);
      if (!head) continue;
      const model = head[1];
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !/^\s*\}\s*$/.test(lines[j]); j += 1) body.push([j, lines[j]]);
      if (j >= lines.length)
        throw new Error(`unterminated model ${model} in ${relative(repository, path)}`);
      const map = body.map(([, l]) => /^\s*@@map\("([^"]+)"\)/.exec(l)).find(Boolean);
      const table = map?.[1] ?? model;
      const columns = new Map();
      const fields = new Map();
      for (const [n, l] of body) {
        const f = /^\s*(\w+)\s+(\w+)(\?|\[\])?(?:\s|$)/.exec(l);
        if (!f || l.trim().startsWith('//') || l.trim().startsWith('@@')) continue;
        const column = /@map\("([^"]+)"\)/.exec(l)?.[1] ?? f[1];
        columns.set(column, {
          field: f[1],
          type: f[2],
          location: `${relative(repository, path)}:${n + 1}`,
        });
        fields.set(f[1], column);
      }
      const delegate = model[0].toLowerCase() + model.slice(1);
      const entry = { service, model, delegate, table, columns, fields };
      tables.set(table, [...(tables.get(table) ?? []), entry]);
      delegates.set(delegate, [...(delegates.get(delegate) ?? []), entry]);
    }
  }
  if (!tables.size) throw new Error('no Prisma schema found');
  return { tables, delegates };
}

const serviceOf = (local) => (local.startsWith('services/') ? local.split('/')[1] : null);

// ---------------------------------------------------------------------------
// Value flow: is an expression a reading of the database clock?

const BOOLEAN_OPERATORS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
]);

const unwrap = (node) => {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isTypeAssertionExpression?.(node) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)))
  )
    node = node.expression;
  return node;
};

const calleeName = (call) => {
  const e = unwrap(call.expression);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
    return e.argumentExpression.text;
  return null;
};

const functionName = (fn) => {
  // The nearest NAMED enclosing function: callbacks report their owner.
  while (fn && !ownName(fn)) {
    let p = fn.parent;
    while (p && !ts.isFunctionLike(p)) p = p.parent;
    fn = p;
  }
  return fn ? ownName(fn) : null;
};
const ownName = (fn) => {
  if (!fn) return null;
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteralLike(fn.name))) return fn.name.text;
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  return null;
};

const enclosingFunction = (node) => {
  let p = node.parent;
  while (p && !ts.isFunctionLike(p)) p = p.parent;
  return p ?? null;
};

/** The text of a SQL literal with placeholders, and the span expressions. */
export function sqlOf(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node))
    return { text: node.text, spans: [] };
  if (ts.isTemplateExpression(node)) {
    const spans = node.templateSpans.map((s) => s.expression);
    return {
      text:
        node.head.text + node.templateSpans.map((s, i) => PLACEHOLDER(i) + s.literal.text).join(''),
      spans,
    };
  }
  return null;
}

const CLOCK_TEXT =
  /(?:\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(\s*\)|\b(?:current_timestamp|localtimestamp|current_date|current_time|localtime)\b)/i;

export function createFlow(repository) {
  const sources = new Map(); // local -> {ast, path}
  const declarations = new Map(); // name -> [{local, node}]
  const calls = new Map(); // name -> [{local, node}]
  const readers = new Map(); // DB-clock reader name -> [{service, arity}]
  for (const path of productionFiles(repository)) {
    const local = relative(repository, path);
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    sources.set(local, ast);
    walk(ast, (node) => {
      if (ts.isFunctionLike(node) && node.body) {
        const name = functionName(node);
        if (name) declarations.set(name, [...(declarations.get(name) ?? []), { local, node }]);
      }
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name) calls.set(name, [...(calls.get(name) ?? []), { local, node }]);
      }
    });
  }
  // Declarations per file, looked up by name and innermost enclosing scope.
  const declarationIndex = new Map();
  const indexOf = (file) => {
    let index = declarationIndex.get(file);
    if (index) return index;
    index = new Map();
    const add = (name, entry) => index.set(name, [...(index.get(name) ?? []), entry]);
    walk(file, (n) => {
      if (ts.isFunctionLike(n))
        for (const p of n.parameters) {
          if (ts.isIdentifier(p.name))
            add(p.name.text, { kind: 'parameter', node: p, fn: n, scope: n });
          else
            walk(p.name, (b) => {
              if (ts.isBindingElement(b) && ts.isIdentifier(b.name))
                add(b.name.text, { kind: 'destructured-parameter', node: p, fn: n, scope: n });
            });
        }
      if (ts.isVariableDeclaration(n)) {
        let scope = n.parent;
        while (
          scope &&
          !ts.isBlock(scope) &&
          !ts.isSourceFile(scope) &&
          !ts.isFunctionLike(scope) &&
          !ts.isForOfStatement(scope) &&
          !ts.isForStatement(scope) &&
          !ts.isForInStatement(scope) &&
          !ts.isCatchClause(scope)
        )
          scope = scope.parent;
        if (ts.isIdentifier(n.name)) add(n.name.text, { kind: 'variable', node: n, scope });
        else
          walk(n.name, (b) => {
            if (ts.isBindingElement(b) && ts.isIdentifier(b.name))
              add(b.name.text, { kind: 'binding', node: b, declaration: n, scope });
          });
      }
    });
    declarationIndex.set(file, index);
    return index;
  };
  // A call is a reader call when a reader of that name is declared in the
  // caller's service (or in a shared package) and the call supplies its
  // required arguments: `performance.now()` is not `DatabaseClock.now(tx)`.
  const isReaderCall = (call, name) => {
    const caller = serviceOf(relative(repository, call.getSourceFile().fileName));
    return (readers.get(name) ?? []).some(
      (r) =>
        (r.service === null || r.service === caller) &&
        call.arguments.length >= r.arity &&
        (r.arity > 0 ||
          ts.isIdentifier(unwrap(call.expression)) ||
          r.local === relative(repository, call.getSourceFile().fileName)),
    );
  };

  const scopeDeclaration = (identifier) => {
    const candidates = (indexOf(identifier.getSourceFile()).get(identifier.text) ?? []).filter(
      (c) => c.scope && c.scope.pos <= identifier.pos && identifier.end <= c.scope.end,
    );
    if (!candidates.length) return null;
    return candidates.reduce((best, c) => (c.scope.pos >= best.scope.pos ? c : best));
  };

  // Does a SQL query call project a clock under the property `prop`?
  const queryProjectsClock = (call, prop) => {
    const target = call && unwrap(call);
    let sqlNode = null;
    if (target && ts.isTaggedTemplateExpression(target)) sqlNode = target.template;
    else if (target && ts.isCallExpression(target) && target.arguments[0])
      sqlNode = unwrap(target.arguments[0]);
    const sql = sqlNode && sqlOf(sqlNode);
    if (!sql || !CLOCK_TEXT.test(sql.text)) return false;
    const a = analyse(sql.text);
    if (prop === null) return a.aliases.size > 0;
    if (a.aliases.has(prop.toLowerCase())) return true;
    const proj = projectionAliases(a.tokens);
    const source = proj.get(prop.toLowerCase());
    return Boolean(source && a.aliases.has(source.name));
  };

  // 'clock' | 'js' | 'const' | 'unknown'
  const combine = (kinds) =>
    kinds.includes('clock')
      ? 'clock'
      : kinds.includes('unknown')
        ? 'unknown'
        : kinds.includes('js')
          ? 'js'
          : kinds.length
            ? 'const'
            : 'unknown';

  // `{ p } = f(...)` / `f(...).p`: what f's returned object literals put in p.
  const returnedProperty = (call, prop, depth, seen) => {
    const target = unwrap(call);
    if (!ts.isCallExpression(target)) return 'unknown';
    const name = calleeName(target);
    const caller = serviceOf(relative(repository, target.getSourceFile().fileName));
    const kinds = [];
    for (const { local, node } of declarations.get(name) ?? []) {
      if (serviceOf(local) !== null && serviceOf(local) !== caller) continue;
      const bodies = ts.isBlock(node.body) ? [] : [node.body];
      if (ts.isBlock(node.body))
        walk(node.body, (n) => {
          if (ts.isReturnStatement(n) && n.expression && enclosingFunction(n) === node)
            bodies.push(n.expression);
        });
      for (const b of bodies) {
        const object = unwrap(b);
        if (!ts.isObjectLiteralExpression(object)) continue;
        for (const p of object.properties) {
          if (ts.isShorthandPropertyAssignment(p) && p.name.text === prop)
            kinds.push(resolve(p.name, depth + 1, seen));
          if (ts.isPropertyAssignment(p) && p.name.getText().replaceAll(/['"]/g, '') === prop)
            kinds.push(resolve(p.initializer, depth + 1, seen));
        }
      }
    }
    return kinds.length ? combine(kinds) : 'unknown';
  };

  let taint = false;
  const memo = new Map();
  const resolve = (expression, depth = 0, seen = new Set()) => {
    const node = unwrap(expression);
    if (!node || depth > 6) return 'unknown';
    if (seen.has(node)) return 'const';
    if (memo.has(node)) return memo.get(node);
    const kind = resolveUncached(node, depth, new Set(seen).add(node));
    if (!seen.size) memo.set(node, kind);
    return kind;
  };
  const resolveUncached = (node, depth, seen) => {
    if (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteralLike(node) ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword
    )
      return 'const';
    if (ts.isIdentifier(node) && node.text === 'undefined') return 'const';
    if (ts.isTemplateExpression(node))
      return combine(node.templateSpans.map((s) => resolve(s.expression, depth + 1, seen)));
    if (ts.isNewExpression(node) && unwrap(node.expression).getText() === 'Date') {
      if (!node.arguments?.length) return 'js';
      return combine(
        node.arguments
          .map((a) => resolve(a, depth + 1, seen))
          .map((k) => (k === 'const' ? 'const' : k)),
      );
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const text = unwrap(node.expression).getText();
      if (text === 'Date.now') return 'js';
      if (name && isReaderCall(node, name)) return 'clock';
      if (
        ts.isPropertyAccessExpression(unwrap(node.expression)) &&
        ['getTime', 'valueOf', 'toISOString', 'toJSON'].includes(name)
      )
        return resolve(unwrap(node.expression).expression, depth + 1, seen);
      if (/^(?:Math\.\w+|Number|BigInt|String)$/.test(text))
        return combine(node.arguments.map((a) => resolve(a, depth + 1, seen)));
      // Anything computed from a clock reading is treated as a clock reading
      // (not while deriving the readers themselves: that would spread).
      if (taint && node.arguments.some((a) => resolve(a, depth + 1, seen) === 'clock'))
        return 'clock';
      return 'unknown';
    }
    if (ts.isBinaryExpression(node)) {
      // A comparison or logical test yields a boolean, never an instant.
      if (BOOLEAN_OPERATORS.has(node.operatorToken.kind)) return 'const';
      if (
        [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
          node.operatorToken.kind,
        )
      )
        return combine([resolve(node.left, depth + 1, seen), resolve(node.right, depth + 1, seen)]);
      return combine([resolve(node.left, depth + 1, seen), resolve(node.right, depth + 1, seen)]);
    }
    if (ts.isConditionalExpression(node))
      return combine([
        resolve(node.whenTrue, depth + 1, seen),
        resolve(node.whenFalse, depth + 1, seen),
      ]);
    if (ts.isPrefixUnaryExpression(node))
      return node.operator === ts.SyntaxKind.ExclamationToken
        ? 'const'
        : resolve(node.operand, depth + 1, seen);
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      const prop = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : null;
      // rows[0].now / row.now / rows[0]?.now for a query projecting a clock as `now`.
      let base = unwrap(node.expression);
      while (
        ts.isElementAccessExpression(base) ||
        (ts.isPropertyAccessExpression(base) &&
          ts.isElementAccessExpression(unwrap(base.expression)))
      )
        base = unwrap(base.expression);
      if (prop && ts.isIdentifier(base)) {
        const d = scopeDeclaration(base);
        if (
          d?.kind === 'variable' &&
          d.node.initializer &&
          queryProjectsClock(d.node.initializer, prop)
        )
          return 'clock';
        if (
          d?.kind === 'binding' &&
          d.declaration.initializer &&
          queryProjectsClock(d.declaration.initializer, prop)
        )
          return 'clock';
        if (d?.kind === 'variable' && d.node.initializer) {
          const returned = returnedProperty(d.node.initializer, prop, depth, seen);
          if (returned !== 'unknown') return returned;
          if (taint && resolve(d.node.initializer, depth + 1, seen) === 'clock') return 'clock';
        }
      }
      if (prop && ts.isCallExpression(base)) return returnedProperty(base, prop, depth, seen);
      return 'unknown';
    }
    if (ts.isIdentifier(node)) {
      const d = scopeDeclaration(node);
      if (!d) return 'unknown';
      if (d.kind === 'variable') {
        const kinds = [d.node.initializer ? resolve(d.node.initializer, depth + 1, seen) : 'const'];
        // Later assignments to a `let`.
        const fn = enclosingFunction(d.node) ?? d.node.getSourceFile();
        walk(fn, (n) => {
          if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(n.left) &&
            n.left.text === node.text
          )
            kinds.push(resolve(n.right, depth + 1, seen));
        });
        return combine(kinds);
      }
      if (d.kind === 'binding') {
        const init = d.declaration.initializer;
        const prop = d.node.propertyName?.getText() ?? d.node.name.text;
        if (init && queryProjectsClock(init, prop)) return 'clock';
        if (init && ts.isObjectBindingPattern(d.node.parent)) {
          const returned = returnedProperty(init, prop, depth, seen);
          if (returned !== 'unknown') return returned;
        }
        if (taint && init && resolve(init, depth + 1, seen) === 'clock') return 'clock';
        return 'unknown';
      }
      if (d.kind === 'parameter') {
        const name = ownName(d.fn);
        const index = d.fn.parameters.indexOf(d.node);
        const own = d.fn.getSourceFile().fileName;
        const service = own.includes('/services/')
          ? own.split('/services/')[1].split('/')[0]
          : null;
        const sites = ((name && calls.get(name)) ?? []).filter(
          ({ local, node: call }) =>
            call.arguments.length > index && (!service || local.startsWith(`services/${service}/`)),
        );
        // Arrow callbacks passed inline: the caller is the call they are an argument of.
        if (!sites.length) {
          if (d.node.initializer) return resolve(d.node.initializer, depth + 1, seen);
          return 'unknown';
        }
        return combine(
          sites.map(({ node: call }) =>
            call.arguments[index]
              ? resolve(call.arguments[index], depth + 1, seen)
              : d.node.initializer
                ? resolve(d.node.initializer, depth + 1, seen)
                : 'const',
          ),
        );
      }
      return 'unknown';
    }
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) return 'const';
    return 'unknown';
  };

  // A reader is a function that RETURNS a database-clock value: `SELECT now()
  // AS now` read back (`rows[0].now`, `[row] … row.now`), or another reader's
  // result. Fixpoint, so wrappers of wrappers are readers too.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, decls] of declarations) {
      for (const { local, node } of decls) {
        const service = serviceOf(local);
        if ((readers.get(name) ?? []).some((r) => r.node === node)) continue;
        const returns = [];
        if (!ts.isBlock(node.body)) returns.push(node.body);
        else
          walk(node.body, (n) => {
            if (ts.isReturnStatement(n) && n.expression && enclosingFunction(n) === node)
              returns.push(n.expression);
          });
        memo.clear();
        if (returns.some((r) => resolve(r) === 'clock')) {
          const arity = node.parameters.filter(
            (p) => !p.initializer && !p.questionToken && !p.dotDotDotToken,
          ).length;
          readers.set(name, [...(readers.get(name) ?? []), { service, arity, node, local }]);
          changed = true;
        }
      }
    }
  }
  memo.clear();
  taint = true;
  return {
    sources,
    declarations,
    calls,
    readers: new Set(readers.keys()),
    readerSites: readers,
    resolve,
    functionName,
    enclosingFunction,
  };
}

// ---------------------------------------------------------------------------
// Sites.

/** Raw-query entry points whose first argument is SQL and the rest are `$N` values. */
const UNSAFE = new Set([
  '$queryRawUnsafe',
  '$executeRawUnsafe',
  'queryRawUnsafe',
  'executeRawUnsafe',
  'query',
]);

function sqlLiterals(ast) {
  const out = [];
  walk(ast, (node) => {
    if (!(ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))) return;
    if (ts.isTemplateSpan(node.parent) || ts.isTemplateHead?.(node)) return;
    if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) return;
    if (ts.isLiteralTypeNode?.(node.parent)) return;
    const sql = sqlOf(node);
    if (!sql) return;
    out.push({ node, ...sql });
  });
  return out;
}

/** The `$N` arguments of the raw call a SQL literal is handed to, if provable. */
function positionalArguments(node) {
  let target = node;
  while (
    ts.isParenthesizedExpression(target.parent) ||
    (ts.isBinaryExpression(target.parent) &&
      target.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
  )
    target = target.parent;
  const parent = target.parent;
  if (
    parent &&
    ts.isCallExpression(parent) &&
    parent.arguments[0] === target &&
    UNSAFE.has(calleeName(parent))
  )
    return parent.arguments.slice(1);
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const uses = [];
    const fn = enclosingFunction(parent) ?? parent.getSourceFile();
    walk(fn, (n) => {
      if (
        ts.isCallExpression(n) &&
        UNSAFE.has(calleeName(n)) &&
        n.arguments[0] &&
        ts.isIdentifier(unwrap(n.arguments[0])) &&
        unwrap(n.arguments[0]).text === parent.name.text
      )
        uses.push(n.arguments.slice(1));
    });
    if (uses.length === 1) return uses[0];
  }
  return null;
}

function resolveColumn(ref, statementTables, statementAliases, schemas, service, depth = 0) {
  // CTE output aliases resolve to the column they project.
  const candidates = [];
  const scoped = (table) =>
    (schemas.tables.get(table) ?? []).filter((e) => !service || e.service === service);
  if (ref.qualifier) {
    const t = statementTables.find((r) => r.alias === ref.qualifier || r.table === ref.qualifier);
    if (t && !t.cte && t.table)
      for (const e of scoped(t.table))
        if (e.columns.has(ref.name)) candidates.push({ e, column: ref.name });
  } else {
    for (const t of statementTables)
      if (t.table && !t.cte)
        for (const e of scoped(t.table))
          if (e.columns.has(ref.name)) candidates.push({ e, column: ref.name });
  }
  if (!candidates.length && statementAliases.has(ref.name) && depth < 3)
    return resolveColumn(
      { ...statementAliases.get(ref.name), qualifier: statementAliases.get(ref.name).qualifier },
      statementTables,
      statementAliases,
      schemas,
      service,
      depth + 1,
    );
  if (!candidates.length && ref.qualifier && depth < 3)
    return resolveColumn(
      { name: ref.name, qualifier: null },
      statementTables,
      statementAliases,
      schemas,
      service,
      depth + 1,
    );
  return candidates.map(({ e, column }) => ({
    table: e.table,
    column,
    field: e.columns.get(column).field,
    delegate: e.delegate,
    type: e.columns.get(column).type,
    schema: e.columns.get(column).location,
  }));
}

const ORM_RANGE = new Set(['lt', 'lte', 'gt', 'gte']);

/**
 * All product clock sites. Each: {file, line, fn, table, column, source, verdict?}.
 * Throws on any unclassifiable comparison unless `reviewed` (SITE entries) covers it.
 */
export function clockSites(
  repository,
  schemas = readSchemas(repository),
  flow = createFlow(repository),
) {
  const sites = [];
  const problems = [];
  for (const [local, ast] of flow.sources) {
    const service = serviceOf(local);
    for (const literal of sqlLiterals(ast)) {
      if (
        !/\b(?:select|update|insert|delete|where|set|returning|values|filter)\b/i.test(literal.text)
      )
        continue;
      const fnNode = flow.enclosingFunction(literal.node);
      const fn = flow.functionName(fnNode) ?? '<module>';
      const positional = positionalArguments(literal.node);
      const cache = new Map();
      const kinds = new Proxy([], {
        get: (_, i) => {
          if (i === 'length') return literal.spans.length;
          const n = Number(i);
          if (!cache.has(n))
            cache.set(n, literal.spans[n] ? flow.resolve(literal.spans[n]) : undefined);
          return cache.get(n);
        },
      });
      const placeholderKind = (i) =>
        kinds[i] === 'clock' ? 'clock' : kinds[i] === 'unknown' ? 'unknown' : 'value';
      const a = analyse(literal.text, placeholderKind);
      const statementAliases = projectionAliases(a.tokens);
      const at = (index) =>
        lineOf(ast, literal.node.getStart(ast)) +
        (literal.text.slice(0, a.tokens[index]?.start ?? 0).split('\n').length - 1);
      const record = (comparison, refs, source) => {
        for (const ref of refs) {
          const entries = resolveColumn(ref, a.tables, statementAliases, schemas, service);
          if (!entries.length) {
            problems.push(
              `${local}:${at(comparison.op)}: unclassified clock column ${ref.qualifier ? ref.qualifier + '.' : ''}${ref.name} (${fn})`,
            );
            continue;
          }
          for (const e of entries) {
            // A value read from the clock can only be compared with a timestamp;
            // a text column here means the flow over-approximated, not a gate.
            if (e.type !== 'DateTime' && source === 'db-clock value') continue;
            if (e.type !== 'DateTime') {
              problems.push(
                `${local}:${at(comparison.op)}: clock compared with non-DateTime ${e.table}.${e.column} (${fn})`,
              );
              continue;
            }
            sites.push({ file: local, line: at(comparison.op), fn, ...e, source });
          }
        }
      };
      for (const c of a.comparisons) {
        const refs = [
          ...columnsIn(a.tokens, c.left, a.aliases),
          ...columnsIn(a.tokens, c.right, a.aliases),
        ].filter((r) => !a.clockTokens.has(r.index));
        if (c.clock) {
          if (!refs.length) {
            problems.push(`${local}:${at(c.op)}: clock comparison without a column (${fn})`);
            continue;
          }
          const viaValue = [...a.clockTokens].some(
            (k) =>
              a.tokens[k].type === 'placeholder' &&
              ((k >= c.left[0] && k <= c.left[1]) || (k >= c.right[0] && k <= c.right[1])),
          );
          record(c, refs, viaValue ? 'db-clock value' : 'sql clock');
          continue;
        }
        // No clock: a DateTime column against a JavaScript value of unproven origin.
        const values = [];
        for (const [s, e] of [c.left, c.right])
          for (let k = s; k <= e; k += 1) {
            const t = a.tokens[k];
            if (t.type === 'placeholder') values.push(kinds[Number(t.value)] ?? 'unknown');
            if (t.type === 'param') {
              const arg = positional?.[Number(t.value) - 1];
              values.push(arg ? flow.resolve(arg) : 'unknown');
            }
          }
        if (!values.length) continue;
        const dated = refs
          .flatMap((ref) => resolveColumn(ref, a.tables, statementAliases, schemas, service))
          .filter((e) => e.type === 'DateTime');
        if (!dated.length) continue;
        if (values.includes('clock')) {
          for (const e of dated)
            sites.push({ file: local, line: at(c.op), fn, ...e, source: 'db-clock value' });
        } else if (values.includes('unknown')) {
          for (const e of dated)
            sites.push({ file: local, line: at(c.op), fn, ...e, source: 'unresolved value' });
        } else if (values.includes('js')) {
          for (const e of dated)
            sites.push({ file: local, line: at(c.op), fn, ...e, source: 'application clock' });
        }
      }
      for (const s of a.stray)
        problems.push(
          `${local}:${at(s.index)}: clock use outside a comparison, assignment, VALUES or projection (${s.clause}) (${fn})`,
        );
    }
    // Prisma where filters.
    walk(ast, (node) => {
      if (!ts.isPropertyAssignment(node) || !ORM_RANGE.has(node.name.getText?.(ast))) return;
      const filter = node.parent;
      if (!ts.isObjectLiteralExpression(filter) || !ts.isPropertyAssignment(filter.parent)) return;
      const field = filter.parent.name.getText(ast).replaceAll(/['"]/g, '');
      const kind = flow.resolve(node.initializer);
      if (kind === 'const') return;
      // Which model? The call that receives the enclosing `where`.
      let p = filter.parent;
      let delegate = null;
      while (p && !ts.isSourceFile(p)) {
        if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(unwrap(p.expression))) {
          const recv = unwrap(unwrap(p.expression).expression);
          if (ts.isPropertyAccessExpression(recv) && schemas.delegates.has(recv.name.text)) {
            delegate = recv.name.text;
            break;
          }
        }
        p = p.parent;
      }
      const entries = [...(delegate ? [delegate] : [...schemas.delegates.keys()])]
        .flatMap((d) => schemas.delegates.get(d))
        .filter((e) => (!service || e.service === service) && e.fields.has(field))
        .map((e) => ({ e, column: e.fields.get(field) }))
        .filter(({ e, column }) => e.columns.get(column).type === 'DateTime');
      if (!entries.length) return;
      const fn = flow.functionName(flow.enclosingFunction(node)) ?? '<module>';
      const source =
        kind === 'clock'
          ? 'db-clock value'
          : kind === 'unknown'
            ? 'unresolved value'
            : 'application clock';
      for (const { e, column } of entries)
        sites.push({
          file: local,
          line: lineOf(ast, node.getStart(ast)),
          fn,
          table: e.table,
          column,
          field,
          delegate: e.delegate,
          type: 'DateTime',
          schema: e.columns.get(column).location,
          source: `${source} (Prisma ${delegate ? delegate : 'unresolved model'} ${node.name.getText(ast)})`,
        });
    });
  }
  return { sites, problems, readers: flow.readers };
}

export { dirname };

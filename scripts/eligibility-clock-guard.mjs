import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';

export function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'generated', 'dist', '.git'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function literal(node) {
  return ts.isStringLiteralLike(node) || ts.isTemplateExpression(node);
}

const clock = String.raw`(?:(?:pg_catalog\.)?(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(\s*\)|CURRENT_TIMESTAMP)`;
const identifier = String.raw`(?:[a-z_][\w]*\.)?"?([a-z_][\w]*)"?`;

// Sources, not suffixes, define the guarded columns. Conservatively include all
// SQL clock comparisons in claim/due queries, then require a DateTime schema field.
export function deriveColumns(repository) {
  const schema = new Map();
  for (const path of files(join(repository, 'services')).filter((p) =>
    p.endsWith('schema.prisma'),
  )) {
    const source = readFileSync(path, 'utf8');
    for (const model of source.matchAll(/model\s+(\w+)\s*\{([^}]+)\}/g)) {
      const table = /@@map\("([^"]+)"\)/.exec(model[2])?.[1] ?? model[1];
      for (const match of model[2].matchAll(/^\s*(\w+)\s+(\w+)\??[^\n]*$/gm)) {
        const column = /@map\("([^"]+)"\)/.exec(match[0])?.[1] ?? match[1];
        const entries = schema.get(column) ?? [];
        entries.push({
          field: match[1],
          type: match[2],
          table,
          model: model[1][0].toLowerCase() + model[1].slice(1),
          location: `${relative(repository, path)}:${source.slice(0, model.index + model[0].indexOf(model[2]) + match.index + match[0].indexOf(match[1])).split('\n').length}`,
        });
        schema.set(column, entries);
      }
    }
  }
  const columns = new Map();
  for (const base of ['services', 'packages']) {
    for (const path of files(join(repository, base)).filter(
      (p) => /\/src\/.*\.ts$/.test(p) && !/\.spec\.ts$|\/testing\//.test(p),
    )) {
      const source = readFileSync(path, 'utf8');
      if (!/claim|DueParkedInsurance|findParkedInsurance/i.test(source)) continue;
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      walk(ast, (node) => {
        if (!literal(node)) return;
        let owner = node.parent;
        while (owner && !ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner))
          owner = owner.parent;
        if (!/claim|DueParkedInsurance|findParkedInsurance/i.test(owner?.name?.getText(ast) ?? ''))
          return;
        const sql = node.getText(ast);
        const tables = new Set(
          [...sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?(\w+)"?/gi)].map((m) => m[1]),
        );
        const comparison = new RegExp(
          `(?:${identifier}|GREATEST\\(([^)]+)\\))\\s*(?:<=|>=|<|>)\\s*${clock}`,
          'gi',
        );
        const comparisons = [...sql.matchAll(comparison)];
        const operators = [...sql.matchAll(new RegExp(`(?:<=|>=|<|>)\\s*${clock}`, 'gi'))];
        if (
          operators.length !== comparisons.length ||
          new RegExp(`${clock}\\s*(?:<=|>=|<|>)`, 'i').test(sql)
        )
          throw new Error(`unclassified clock comparison in ${relative(repository, path)}`);
        for (const match of comparisons) {
          const names = match[1]
            ? [match[1]]
            : match[2].split(',').map((s) => s.trim().replaceAll('"', '').split('.').at(-1));
          for (const name of names) {
            const entries = schema.get(name)?.filter((e) => tables.has(e.table));
            if (!entries?.length || entries.some((e) => e.type !== 'DateTime')) {
              throw new Error(`unclassified clock column ${name} in ${relative(repository, path)}`);
            }
            const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast) + match.index);
            const current = columns.get(name) ?? {
              fields: new Set(),
              models: new Set(),
              tables: new Set(),
              evidence: [],
            };
            entries.forEach((entry) => {
              current.fields.add(entry.field);
              current.models.add(entry.model);
              current.tables.add(entry.table);
              current.evidence.push(entry.location);
            });
            current.evidence.push(`${relative(repository, path)}:${line + 1}`);
            columns.set(name, current);
          }
        }
      });
    }
  }
  if (!columns.size) throw new Error('no classified clock columns');
  return columns;
}

function name(node, ast) {
  if (!node) return '';
  return ts.isStringLiteralLike(node) || ts.isIdentifier(node) ? node.text : node.getText(ast);
}

function zero(node) {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node) || ts.isPrefixUnaryExpression(node))
    return zero(node.operand ?? node.expression);
  return ts.isNumericLiteral(node) && Number(node.text) === 0;
}

// Resolve lease arguments from declared parameter names, rather than assuming
// that every claim API puts its lease at the same positional index.
export function leaseSignatures(repository) {
  const result = new Map();
  for (const base of ['services', 'packages'])
    for (const path of files(join(repository, base)).filter((p) => /\.[cm]?[jt]s$/.test(p))) {
      const source = readFileSync(path, 'utf8');
      if (!/claim/i.test(source) || !/lease|backoff|delay/i.test(source)) continue;
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      walk(ast, (node) => {
        if (!node.parameters || !/claim/i.test(node.name?.getText(ast) ?? '')) return;
        for (const [index, param] of node.parameters.entries())
          if (/lease|backoff|delay/i.test(param.name.getText(ast))) {
            const key = node.name.getText(ast);
            const indices = result.get(key) ?? new Set();
            indices.add(index);
            result.set(key, indices);
          }
      });
    }
  return result;
}

function sqlText(node) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return sqlText(node.left) + sqlText(node.right);
  if (ts.isParenthesizedExpression(node)) return sqlText(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text + node.templateSpans.map((span) => '${value}' + span.literal.text).join('')
    );
  return '${value}';
}

export function reviewedTemplates(repository) {
  const source = readFileSync(
    join(repository, 'packages/testing/src/eligibility-clock.ts'),
    'utf8',
  );
  const ast = ts.createSourceFile('helper.ts', source, ts.ScriptTarget.Latest, true);
  let result;
  walk(ast, (node) => {
    if (!ts.isVariableDeclaration(node) || node.name.getText(ast) !== 'reviewedClockTemplates')
      return;
    const value = ts.isAsExpression(node.initializer)
      ? node.initializer.expression
      : node.initializer;
    if (!ts.isArrayLiteralExpression(value) || value.elements.some((e) => !ts.isStringLiteral(e)))
      throw new Error('malformed clock template allowlist');
    result = new Set(value.elements.map((e) => e.text));
  });
  if (!result?.size) throw new Error('missing clock template allowlist');
  let expressions;
  walk(ast, (node) => {
    if (!ts.isVariableDeclaration(node) || node.name.getText(ast) !== 'reviewedClockExpressions')
      return;
    const value = ts.isAsExpression(node.initializer)
      ? node.initializer.expression
      : node.initializer;
    if (!ts.isArrayLiteralExpression(value) || value.elements.some((e) => !ts.isStringLiteral(e)))
      throw new Error('malformed clock expression allowlist');
    expressions = new Set(value.elements.map((e) => e.text));
  });
  if (!expressions) throw new Error('missing clock expression allowlist');
  result.expressions = expressions;
  return result;
}

export function templateHash(node) {
  const raw = ts.isTemplateExpression(node)
    ? [node.head.rawText, ...node.templateSpans.map((s) => s.literal.rawText)]
    : [node.rawText];
  return createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}

export function expressionHash(node, ast) {
  const printer = ts.createPrinter({ removeComments: true });
  const expressions = ts.isTemplateExpression(node)
    ? node.templateSpans.map((s) => printer.printNode(ts.EmitHint.Expression, s.expression, ast))
    : [];
  return createHash('sha256').update(JSON.stringify(expressions)).digest('hex');
}

export function hazards(source, file, columns, reviewed = new Set(), signatures = new Map()) {
  const errors = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const fields = new Set([...columns.values()].flatMap((c) => [...c.fields]));
  const variables = new Map();
  walk(ast, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      variables.set(node.name.text, node.initializer);
  });
  const imports = new Map();
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !['@rasta/testing', '../packages/testing/src/eligibility-clock.ts'].includes(
        statement.moduleSpecifier.text,
      )
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        imports.set(item.name.text, (item.propertyName ?? item.name).text);
  }
  walk(ast, (node) => {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      imports.has(node.name.getText(ast))
    )
      imports.delete(node.name.getText(ast));
  });
  if (ast.parseDiagnostics.length) return [`${file}:1: unparseable test source`];
  const report = (node, reason) => {
    const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    errors.push(`${file}:${line + 1}: ${reason}`);
  };
  walk(ast, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      /^(?:(?:.*lease|.*backoff|.*delay).*Seconds|baseSeconds)$/i.test(name(node.name, ast)) &&
      zero(node.initializer)
    )
      report(node, 'zero lease/backoff option');
    if (ts.isCallExpression(node)) {
      const method = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isElementAccessExpression(node.expression)
          ? name(node.expression.argumentExpression, ast)
          : name(node.expression, ast);
      // Explicit signatures: claimDue(limit, lease, fence) and the local
      // outbox wrapper claim(store, limit, lease); object options checked above.
      const indices =
        signatures.get(method) ??
        (method === 'claimDue'
          ? new Set([1])
          : /^(claim|claimPending|claimSendable|claimReady|claimBatch)$/.test(method)
            ? new Set([2])
            : new Set());
      if (
        [...indices].some(
          (index) =>
            zero(node.arguments[index]) ||
            (ts.isIdentifier(node.arguments[index] ?? {}) &&
              zero(variables.get(node.arguments[index].text))),
        )
      )
        report(node, 'zero positional lease');
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      if (!fields.has(name(node.name, ast))) return;
      let parent = node.parent;
      while (parent && !ts.isCallExpression(parent) && !ts.isSourceFile(parent))
        parent = parent.parent;
      if (
        parent &&
        ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression)
      ) {
        const receiver = parent.expression.expression;
        if (ts.isPropertyAccessExpression(receiver)) {
          const models = [...columns.values()]
            .filter((c) => c.fields.has(name(node.name, ast)))
            .flatMap((c) => [...c.models]);
          if (
            !models.includes(receiver.name.text) &&
            /^(?:notificationDedupe)$/.test(receiver.name.text)
          )
            return;
        }
      }
      // Only ORM writes, never expectations or plain value objects.
      if (
        parent &&
        ts.isCallExpression(parent) &&
        /(?:create|update|upsert)(?:Many)?$/.test(parent.expression.getText(ast)) &&
        (() => {
          let p = node.parent;
          while (p && p !== parent) {
            if (
              ts.isPropertyAssignment(p) &&
              ['data', 'create', 'update'].includes(name(p.name, ast))
            )
              return true;
            p = p.parent;
          }
          return false;
        })()
      )
        report(node, 'direct ORM eligibility write');
    }
    if (
      literal(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      if (
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
        return;
      if (ts.isTaggedTemplateExpression(node.parent)) {
        const tag = node.parent.tag;
        const binding = imports.get(
          ts.isCallExpression(tag) ? tag.expression.getText(ast) : tag.getText(ast),
        );
        if (
          ['eligibilityClockSql', 'eligibilityClockWrite', 'eligibilityClockTag'].includes(
            binding,
          ) &&
          reviewed.has(templateHash(node)) &&
          (!ts.isTemplateExpression(node) || reviewed.expressions?.has(expressionHash(node, ast)))
        )
          return;
      }
      const sql = sqlText(node).replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, ' ');
      if (/^\s*SELECT\b/i.test(sql) && !/\b(?:UPDATE|INSERT|DELETE)\b/i.test(sql)) return;
      const assignments = [...sql.matchAll(/(?<![\w])([a-z_][\w]*|"[a-z_][\w]*")\s*=(?!=)/gi)];
      const insert = /\bINSERT\s+INTO\s+[^()]+\(([^)]+)\)/gi;
      const written = assignments.map((m) => m[1].replaceAll('"', '').toLowerCase());
      for (const match of sql.matchAll(insert))
        written.push(...match[1].split(',').map((s) => s.trim().replaceAll('"', '').toLowerCase()));
      if (written.some((column) => columns.has(column)))
        report(node, 'direct SQL eligibility write');
      else if (
        [...sql.matchAll(/\b(?:UPDATE|INTO)\s+"?(\w+)"?/gi)].some((m) =>
          [...columns.values()].some((c) => c.tables.has(m[1])),
        ) &&
        /\b(?:SET\s*\$\{value\}|INSERT\s+INTO[^()]*\([^)]*\$\{value\})/i.test(sql)
      )
        report(node, 'unclassified SQL write columns');
    }
  });
  return errors;
}

export function testFiles(repository) {
  return ['services', 'packages', 'scripts']
    .flatMap((base) => files(join(repository, base)))
    .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path))
    .filter((path) => {
      const local = relative(repository, path);
      if (local.startsWith('scripts/'))
        return /(?:\.pg\.test\.|^scripts\/verify-.*migration)/.test(local);
      return /\/test\//.test(local) || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(local);
    });
}

export function repositoryHazards(
  repository,
  columns = deriveColumns(repository),
  reviewed = reviewedTemplates(repository),
  signatures = leaseSignatures(repository),
) {
  return testFiles(repository).flatMap((path) =>
    hazards(readFileSync(path, 'utf8'), relative(repository, path), columns, reviewed, signatures),
  );
}

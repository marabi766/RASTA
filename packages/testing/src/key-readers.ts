import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Every place a service reads, compares or searches a uniqueness-compared field (FU-084 r2), so a
 * spec can hold each one to the canonical function and fail on a reader nobody reviewed.
 *
 * A site is any of:
 *   * `filter` — a Prisma filter on the field: the property inside a `where`, or the property whose
 *     value is a filter object (`{ username: { contains } }`, wherever the object is built);
 *   * `sql` — raw SQL (`$queryRaw`, `$executeRaw`, their `Unsafe` forms) naming the column;
 *   * `compare` — an equality whose operand names the field.
 * The reader is the enclosing function, `Class.method` or the function's name.
 */
export interface KeyReaderSite {
  /** Relative to `root`, with `/`. */
  file: string;
  reader: string;
  kind: 'filter' | 'sql' | 'compare';
  /** The enclosing function's source, for the spec to check what it calls. */
  body: string;
}

export interface KeyReaderOptions {
  /** The service directory; `src` below it is scanned, specs and generated code left out. */
  root: string;
  /** Model fields, as Prisma and the code name them. */
  fields: readonly string[];
  /** The same fields as SQL columns. */
  columns: readonly string[];
}

const FILTER_OPERATORS = new Set([
  'equals',
  'contains',
  'startsWith',
  'endsWith',
  'in',
  'notIn',
  'not',
  'gt',
  'gte',
  'lt',
  'lte',
  'search',
]);
/** Where a bare `{ field: value }` is a filter: Prisma's `where` and `cursor`, or a `where` variable. */
const FILTER_HOLDERS = /^(where|cursor)$/i;
/** Methods that compare their receiver with their argument. */
const COMPARING_METHODS = new Set([
  'includes',
  'has',
  'indexOf',
  'localeCompare',
  'startsWith',
  'endsWith',
]);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.(spec|int-spec|test)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

function propertyName(node: ts.Node): string | undefined {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return undefined;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at)) return at;
    if (
      (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      (ts.isVariableDeclaration(at.parent) || ts.isPropertyDeclaration(at.parent))
    ) {
      return at.parent;
    }
  }
  return undefined;
}

function readerName(fn: ts.Node | undefined): string {
  if (!fn) return '<module>';
  const own = (fn as { name?: ts.Node }).name;
  const name = own && ts.isIdentifier(own) ? own.text : '<anonymous>';
  const owner = ts.isMethodDeclaration(fn) || ts.isPropertyDeclaration(fn) ? fn.parent : undefined;
  return owner && ts.isClassDeclaration(owner) && owner.name ? `${owner.name.text}.${name}` : name;
}

function insideWhere(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    // A filter built in a callback inside `where` (`OR: names.map((n) => ({ username: n }))`) is
    // still the filter, so function boundaries do not stop the walk.
    if (FILTER_HOLDERS.test(propertyName(at) ?? '')) return true;
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && /where/i.test(at.name.text)) {
      return true;
    }
  }
  return false;
}

function isRawSql(node: ts.Node): string | undefined {
  // `$queryRaw`…`, `$executeRaw`…` and `Prisma.sql`…` fragments; `$queryRaw(…)` and the `Unsafe`
  // forms in call form.
  if (
    ts.isTaggedTemplateExpression(node) &&
    /\$(queryRaw|executeRaw)(Unsafe)?$|(^|\.)sql$/.test(node.tag.getText())
  ) {
    return node.template.getText();
  }
  if (
    ts.isCallExpression(node) &&
    /\$(queryRaw|executeRaw)(Unsafe)?$|(^|\.)sql$/.test(node.expression.getText())
  ) {
    return node.arguments.map((argument) => argument.getText()).join('\n');
  }
  return undefined;
}

/** `x.field`, `field`, `x.field.method()`, or `fold(x.field)` with that one argument. */
function namesField(node: ts.Expression, fields: readonly string[]): boolean {
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (ts.isIdentifier(inner)) return fields.includes(inner.text);
  if (ts.isPropertyAccessExpression(inner)) return fields.includes(inner.name.text);
  if (ts.isCallExpression(inner)) {
    if (ts.isPropertyAccessExpression(inner.expression)) {
      if (namesField(inner.expression.expression, fields)) return true;
    }
    return inner.arguments.length === 1 && namesField(inner.arguments[0]!, fields);
  }
  return false;
}

/** A presence check (`=== undefined`, `!== null`) compares no value. */
function isAbsence(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined')
  );
}

export function findKeyReaders(options: KeyReaderOptions): KeyReaderSite[] {
  const column = new RegExp(`\\b(${options.columns.join('|')})\\b`);
  const sites = new Map<string, KeyReaderSite>();

  for (const path of sourceFiles(join(options.root, 'src'))) {
    const file = relative(options.root, path).split('\\').join('/');
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      let kind: KeyReaderSite['kind'] | undefined;
      const name = propertyName(node);
      if (name !== undefined && options.fields.includes(name)) {
        const value = ts.isPropertyAssignment(node) ? node.initializer : undefined;
        const filterObject =
          value !== undefined &&
          ts.isObjectLiteralExpression(value) &&
          value.properties.some((p) => FILTER_OPERATORS.has(propertyName(p) ?? ''));
        if (filterObject || insideWhere(node)) kind = 'filter';
      }
      const sql = isRawSql(node);
      if (sql !== undefined && column.test(sql)) kind = 'sql';
      if (
        ts.isBinaryExpression(node) &&
        EQUALITY.has(node.operatorToken.kind) &&
        !isAbsence(node.left) &&
        !isAbsence(node.right) &&
        (namesField(node.left, options.fields) || namesField(node.right, options.fields))
      ) {
        kind = 'compare';
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        COMPARING_METHODS.has(node.expression.name.text) &&
        node.arguments.length === 1 &&
        (namesField(node.expression.expression, options.fields) ||
          namesField(node.arguments[0]!, options.fields))
      ) {
        kind = 'compare';
      }
      if (kind) {
        const fn = enclosingFunction(node);
        const reader = readerName(fn);
        sites.set(`${file}#${reader}#${kind}`, {
          file,
          reader,
          kind,
          body: (fn ?? source).getText(),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...sites.values()].sort((a, b) =>
    `${a.file}#${a.reader}#${a.kind}`.localeCompare(`${b.file}#${b.reader}#${b.kind}`),
  );
}

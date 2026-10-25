import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * The structural guard of the fenced forms (PR 405 review 4, R5): every form
 * whose request is kept in a `fencedSlot` store submits through the one
 * boundary (`lib/fenced-submission.ts` `submitThroughSlot`) and is drawn the
 * one way (`UnresolvedForm`: the gate, and a restore on every mount).
 *
 * Discovery is by what the code does, not by a list: a store module is one
 * that calls `fencedSlot(` or imports such a module (the marker stores); a
 * form is any file under `app/` that imports a store module and calls
 * `useActionState`. A future form is found the same way.
 *
 * For each form:
 *
 * 1. its action callback returns only `submitThroughSlot(...)` — no other
 *    return (an early `HELD` or `UNCONFIRMED`), no `await` of its own;
 * 2. no `try`, `.catch(` or `.then(` anywhere in it, and no `isRedirect` or
 *    `sessionHasEnded`: a completion is never handled outside the boundary;
 * 3. its server action is called only inside the boundary's `send`;
 * 4. a store's `save*`, `answer*` and `settle*` are called only inside the
 *    boundary's argument (the person's own `clear*` and any `restore*` may be
 *    called elsewhere);
 * 5. it renders `<UnresolvedForm>` and never `<QuarantineGate>` directly.
 *
 * And `<QuarantineGate>` is drawn nowhere but by `UnresolvedForm`.
 */

export interface Violation {
  readonly file: string;
  readonly rule: string;
  readonly detail: string;
}

export type Sources = ReadonlyMap<string, string>;

const SKIP = /(\.spec\.tsx?|\.test\.tsx?|\.d\.ts)$/;

/** Every non-spec `.ts`/`.tsx` file under `root`, by its path relative to `root` (`lib/x.ts`). */
export function readSources(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !SKIP.test(name)) {
        out.set(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'));
      }
    }
  };
  walk(root);
  return out;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Where an import specifier points, as a source path (`lib/x.ts`), when it is one of ours. */
function resolve(from: string, specifier: string, sources: Sources): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = specifier.slice(2);
  else if (specifier.startsWith('.')) {
    const parts = from.split('/').slice(0, -1);
    for (const part of specifier.split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    }
    base = parts.join('/');
  } else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (sources.has(candidate)) return candidate;
  }
  return null;
}

interface ImportInfo {
  /** Local name → resolved module (or the raw specifier for packages). */
  readonly names: Map<string, string>;
  readonly modules: Set<string>;
}

function importsOf(file: string, source: ts.SourceFile, sources: Sources): ImportInfo {
  const names = new Map<string, string>();
  const modules = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const target = resolve(file, specifier, sources) ?? specifier;
    modules.add(target);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.set(element.name.text, target);
    }
    if (statement.importClause?.name) names.set(statement.importClause.name.text, target);
  }
  return { names, modules };
}

function callsNamed(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  walk(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found.push(node);
    }
  });
  return found;
}

/** The store modules: those calling `fencedSlot(`, and those built on them. */
export function fencedModules(sources: Sources): Set<string> {
  const parsed = new Map<string, ts.SourceFile>();
  for (const [file, text] of sources)
    if (file.startsWith('lib/')) parsed.set(file, parse(file, text));
  const fenced = new Set<string>();
  for (const [file, source] of parsed)
    if (callsNamed(source, 'fencedSlot').length > 0) fenced.add(file);
  for (let grew = true; grew;) {
    grew = false;
    for (const [file, source] of parsed) {
      if (fenced.has(file) || file === 'lib/unresolved-tenancy.ts') continue;
      const { modules } = importsOf(file, source, sources);
      if ([...modules].some((module) => fenced.has(module))) {
        fenced.add(file);
        grew = true;
      }
    }
  }
  return fenced;
}

/** The forms built on a store module: a file under `app/` that imports one and calls `useActionState`. */
export function fencedForms(sources: Sources): string[] {
  const fenced = fencedModules(sources);
  const forms: string[] = [];
  for (const [file, text] of sources) {
    if (!file.startsWith('app/')) continue;
    const source = parse(file, text);
    const { modules } = importsOf(file, source, sources);
    if (![...modules].some((module) => fenced.has(module))) continue;
    if (callsNamed(source, 'useActionState').length > 0) forms.push(file);
  }
  return forms.sort();
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

function isBoundaryCall(node: ts.Node | undefined): node is ts.CallExpression {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'submitThroughSlot'
  );
}

/** Whether `node` lies inside the argument of a `submitThroughSlot(...)` call — in its `property`, when named. */
function insideBoundary(node: ts.Node, property?: string): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (
      ts.isPropertyAssignment(parent) &&
      ts.isObjectLiteralExpression(parent.parent) &&
      isBoundaryCall(parent.parent.parent) &&
      parent.initializer === child
    ) {
      return property === undefined || parent.name.getText() === property;
    }
  }
  return false;
}

/** The function an action state is built from: `useActionState(fn)` or `useActionState(name)` of `useCallback(fn)`. */
function reducerOf(
  call: ts.CallExpression,
  source: ts.SourceFile,
): ts.FunctionLikeDeclaration | null {
  let argument: ts.Expression | undefined = call.arguments[0];
  if (argument && ts.isIdentifier(argument)) {
    const name = argument.text;
    let initializer: ts.Expression | undefined;
    walk(source, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        initializer = node.initializer;
      }
    });
    argument = initializer;
  }
  if (
    argument &&
    ts.isCallExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === 'useCallback'
  ) {
    argument = argument.arguments[0];
  }
  return argument && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
    ? argument
    : null;
}

/** Returns and awaits of `fn` itself, not of the functions inside it. */
function ownNodes(fn: ts.FunctionLikeDeclaration): {
  returns: ts.ReturnStatement[];
  awaits: ts.Node[];
} {
  const returns: ts.ReturnStatement[] = [];
  const awaits: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (node !== fn && isFunction(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    if (ts.isAwaitExpression(node)) awaits.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return { returns, awaits };
}

function checkForm(file: string, sources: Sources, fenced: Set<string>): Violation[] {
  const text = sources.get(file) ?? '';
  const source = parse(file, text);
  const out: Violation[] = [];
  const flag = (rule: string, node: ts.Node | null, detail: string) =>
    out.push({
      file,
      rule,
      detail: node
        ? `${detail} (line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1})`
        : detail,
    });
  const { names } = importsOf(file, source, sources);

  if (names.get('submitThroughSlot') !== 'lib/fenced-submission.ts') {
    flag('boundary', null, 'does not import submitThroughSlot from @/lib/fenced-submission');
  }
  for (const name of ['isRedirect', 'sessionHasEnded']) {
    if (names.has(name))
      flag('completion', null, `imports ${name}: completions are the boundary's`);
  }

  // 1. The action callback returns only the boundary, and awaits nothing itself.
  const actionStates = callsNamed(source, 'useActionState');
  for (const call of actionStates) {
    const fn = reducerOf(call, source);
    if (fn === null) {
      flag('callback', call, 'useActionState is not given a function (or useCallback of one)');
      continue;
    }
    if (fn.body && !ts.isBlock(fn.body)) {
      if (!isBoundaryCall(fn.body))
        flag('callback', fn.body, 'returns something other than submitThroughSlot(...)');
    } else {
      const { returns, awaits } = ownNodes(fn);
      if (returns.length === 0) flag('callback', fn, 'never returns submitThroughSlot(...)');
      for (const statement of returns) {
        if (!isBoundaryCall(statement.expression)) {
          flag('callback', statement, 'returns something other than submitThroughSlot(...)');
        }
      }
      for (const node of awaits) flag('callback', node, 'awaits outside the boundary');
    }
  }

  walk(source, (node) => {
    // 2. No completion handled here.
    if (ts.isTryStatement(node)) flag('completion', node, 'a try statement');
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['catch', 'then', 'finally'].includes(node.expression.name.text)
    ) {
      flag('completion', node, `.${node.expression.name.text}(...)`);
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const name = node.expression.text;
    const from = names.get(name);
    if (from === undefined) return;
    // 3. The server action only inside the boundary's `send`.
    if (/(^|\/)[\w-]*actions(\.tsx?)?$/.test(from) && !insideBoundary(node, 'send')) {
      flag('transport', node, `${name}(...) outside the boundary's send`);
    }
    // 4. A store's writes only inside the boundary.
    if (fenced.has(from) && /^(save|answer|settle)/.test(name) && !insideBoundary(node)) {
      flag('store', node, `${name}(...) outside the boundary`);
    }
  });

  // 5. Drawn the one way.
  let unresolvedForm = false;
  walk(source, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName)
    ) {
      if (node.tagName.text === 'UnresolvedForm') unresolvedForm = true;
      if (node.tagName.text === 'QuarantineGate')
        flag('drawn', node, 'draws QuarantineGate directly');
    }
  });
  if (!unresolvedForm) flag('drawn', null, 'never draws <UnresolvedForm>');
  return out;
}

/** Every violation in `sources`; empty when every fenced form keeps to the boundary. */
export function fencedFormViolations(sources: Sources): Violation[] {
  const fenced = fencedModules(sources);
  const out: Violation[] = [];
  for (const file of fencedForms(sources)) out.push(...checkForm(file, sources, fenced));
  for (const [file, text] of sources) {
    if (file === 'app/UnresolvedQuarantine.tsx' || !text.includes('QuarantineGate')) continue;
    walk(parse(file, text), (node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        node.tagName.text === 'QuarantineGate'
      ) {
        out.push({ file, rule: 'drawn', detail: 'draws QuarantineGate outside UnresolvedForm' });
      }
    });
  }
  return out;
}

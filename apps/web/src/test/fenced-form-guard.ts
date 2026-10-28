import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * The structural guard of the fenced forms (PR 405 reviews 4 and 5, R5 and
 * R7): every form whose request is kept in a `fencedSlot` store submits
 * through the one boundary (`lib/fenced-submission.ts` `submitThroughSlot`),
 * holds its state through the one hook (`useSlotActionState`) and is drawn the
 * one way (`UnresolvedForm`: the gate, and a restore on every mount).
 *
 * ## Names are resolved, not spelled
 *
 * Every name the rules look for is resolved to where it is defined, so the
 * spelling does not matter: a named import under another name
 * (`useActionState as uas`), a namespace or default import and its member
 * (`React.useActionState`, `store.saveThing`, `<Q.UnresolvedForm>`), a
 * re-export barrel within `src/` (`export { x as y } from`, `export * from`,
 * `export * as ns from`, an `import` then `export { }` — followed through any
 * number of barrels, cycle-safe), and a local `const` alias or destructuring
 * of one of those. A valid form written any of these ways passes; a bypass
 * written any of these ways is refused.
 *
 * ## Discovery is by what the code does, not by a list
 *
 * - A **slot factory** is `fencedSlot`, and any function whose body calls a
 *   slot factory (the marker stores' `markerStore`).
 * - A **store module** is any file — under `lib/` or `app/` — that calls a slot
 *   factory.
 * - A **form** is any file that refers to something a store module defines
 *   (directly or through a barrel; a namespace import of a module that is, or
 *   re-exports, a store module) and calls an action-state hook (React's
 *   `useActionState` or `useSlotActionState`). A future form is found the same
 *   way.
 *
 * ## For each form
 *
 * 0. its state is held by `useSlotActionState`, never React's `useActionState`
 *    (the session verdict of a failed call reaches the view only through it);
 * 1. its action callback returns only `submitThroughSlot(...)` — no other
 *    return (an early `HELD` or `UNCONFIRMED`), no `await` of its own;
 * 2. no `try`, `.catch(`, `.then(` or `.finally(` anywhere in it, and no
 *    reference to `isRedirect` or `sessionHasEnded`: a completion is never
 *    handled outside the boundary;
 * 3. its server action (a `'use server'` module, or an `…actions` module) is
 *    called only inside the boundary's `send`;
 * 4. a store's `save*`, `answer*` and `settle*` — and a slot's `start`,
 *    `answer`, `settle` — are called only inside the boundary's argument (the
 *    person's own `clear*` and any `restore*` may be called elsewhere), and no
 *    slot is made in the form itself;
 * 5. it renders `<UnresolvedForm>` and never `<QuarantineGate>` directly.
 *
 * And `<QuarantineGate>` is drawn nowhere but by `UnresolvedForm`.
 *
 * ## Review boundaries (not proved here)
 *
 * The guard is a tripwire for an accidental bypass, not a proof against a
 * deliberate one (`docs/23` D-074/D-075: arbitrary dynamic behaviour is
 * not statically proved). A reviewer checks, by reading, any form that:
 *
 * - loads a store, the boundary or an action dynamically (`import()`,
 *   `require`), or reaches one through a computed member (`ns[name]`);
 * - holds its state through a hook of its own that wraps `useActionState` in a
 *   file that does not itself refer to a store (a **wrapper hook**): the form
 *   then calls no action-state hook the guard can see;
 * - passes the boundary, a store writer or an action through a parameter, a
 *   reassigned `let`, an object property or another function's return value;
 * - shadows an imported name with a local one (resolution is by name).
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
  const walkDir = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walkDir(path);
      else if (/\.tsx?$/.test(name) && !SKIP.test(name)) {
        out.set(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'));
      }
    }
  };
  walkDir(root);
  return out;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Where an import specifier points, as a source path (`lib/x.ts`), when it is one of ours. */
function resolvePath(from: string, specifier: string, sources: Sources): string | null {
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
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (/\.tsx?$/.test(candidate) && sources.has(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Symbols: where a name is defined

/** An expression that only names something defined elsewhere (`x`, `ns.x`, `(x as T)`). */
function isAlias(node: ts.Expression): boolean {
  return (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ((ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)) &&
      isAlias(node.expression))
  );
}

/** A definition: a module (a source path, or a package specifier) and an export name; `*` is the module itself. */
interface Sym {
  readonly module: string;
  readonly name: string;
}

const NAMESPACE = '*';
const key = (sym: Sym) => `${sym.module}#${sym.name}`;
const is = (sym: Sym | null, module: string, ...names: string[]) =>
  sym !== null && sym.module === module && names.includes(sym.name);

const REACT = 'react';
const BOUNDARY_MODULE = 'lib/fenced-submission.ts';
const TENANCY = 'lib/unresolved-tenancy.ts';
const SESSION = 'lib/session-refusal.ts';
const GATE_MODULE = 'app/UnresolvedQuarantine.tsx';

type Imported = { readonly module: string; readonly name: string };
type Exported =
  | { readonly kind: 'LOCAL'; readonly local: string }
  | { readonly kind: 'FROM'; readonly module: string; readonly name: string };

interface Module {
  readonly file: string;
  readonly source: ts.SourceFile;
  /** Local name → what it imports (`*` for a namespace import; `default` for a default one). */
  readonly imports: Map<string, Imported>;
  /** Export name → where it comes from. */
  readonly exports: Map<string, Exported>;
  /** `export * from` targets. */
  readonly stars: string[];
  /** Every module named by an import or export declaration. */
  readonly refers: Set<string>;
  /** Whether the file is a `'use server'` module. */
  readonly server: boolean;
  /** Local `const` names → what they alias: an expression, or a member of one (destructuring). */
  readonly locals: Map<string, { readonly from: ts.Expression; readonly member?: string }>;
}

class Program {
  private readonly modules = new Map<string, Module>();

  constructor(readonly sources: Sources) {}

  files(): string[] {
    return [...this.sources.keys()];
  }

  module(file: string): Module {
    const cached = this.modules.get(file);
    if (cached) return cached;
    const text = this.sources.get(file) ?? '';
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = new Map<string, Imported>();
    const exports = new Map<string, Exported>();
    const stars: string[] = [];
    const refers = new Set<string>();
    const target = (specifier: ts.Expression) =>
      ts.isStringLiteral(specifier)
        ? (resolvePath(file, specifier.text, this.sources) ?? specifier.text)
        : null;
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const from = target(statement.moduleSpecifier);
        if (from === null) continue;
        refers.add(from);
        const clause = statement.importClause;
        if (clause?.name) imports.set(clause.name.text, { module: from, name: 'default' });
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          imports.set(bindings.name.text, { module: from, name: NAMESPACE });
        } else if (bindings) {
          for (const element of bindings.elements) {
            imports.set(element.name.text, {
              module: from,
              name: (element.propertyName ?? element.name).text,
            });
          }
        }
      } else if (ts.isExportDeclaration(statement)) {
        const from = statement.moduleSpecifier ? target(statement.moduleSpecifier) : null;
        if (from !== null) refers.add(from);
        const clause = statement.exportClause;
        if (!clause) {
          if (from !== null) stars.push(from);
        } else if (ts.isNamespaceExport(clause)) {
          if (from !== null)
            exports.set(clause.name.text, { kind: 'FROM', module: from, name: NAMESPACE });
        } else {
          for (const element of clause.elements) {
            const name = (element.propertyName ?? element.name).text;
            exports.set(
              element.name.text,
              from !== null ? { kind: 'FROM', module: from, name } : { kind: 'LOCAL', local: name },
            );
          }
        }
      } else if (
        ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const isDefault = ts
          .getModifiers(statement)
          ?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              exports.set(declaration.name.text, { kind: 'LOCAL', local: declaration.name.text });
            }
          }
        } else if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
          statement.name
        ) {
          exports.set(isDefault ? 'default' : statement.name.text, {
            kind: 'LOCAL',
            local: statement.name.text,
          });
        }
      } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
        exports.set('default', { kind: 'LOCAL', local: statement.expression.text });
      }
    }
    const first = source.statements[0];
    const server =
      first !== undefined &&
      ts.isExpressionStatement(first) &&
      ts.isStringLiteral(first.expression) &&
      first.expression.text === 'use server';
    const locals = new Map<string, { readonly from: ts.Expression; readonly member?: string }>();
    walk(source, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      if (ts.isIdentifier(node.name)) {
        if (!locals.has(node.name.text)) locals.set(node.name.text, { from: node.initializer });
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const member = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(element.name) &&
            ts.isIdentifier(member) &&
            !locals.has(element.name.text)
          ) {
            locals.set(element.name.text, { from: node.initializer, member: member.text });
          }
        }
      }
    });
    const parsed = { file, source, imports, exports, stars, refers, server, locals };
    this.modules.set(file, parsed);
    return parsed;
  }

  /** What `module` exports as `name`, followed to its definition; null when it does not export it. */
  exported(module: string, name: string, seen = new Set<string>()): Sym | null {
    if (!this.sources.has(module)) return { module, name };
    if (name === NAMESPACE) return { module, name };
    const id = `${module}#${name}`;
    // A cycle — through barrels, or an alias that leads back to itself — names nothing.
    if (seen.has(id) || this.following.has(id)) return null;
    seen.add(id);
    this.following.add(id);
    try {
      return this.follow(module, name, seen);
    } finally {
      this.following.delete(id);
    }
  }

  /** Exports being followed right now, across `resolve` and `exported`. */
  private readonly following = new Set<string>();

  private follow(module: string, name: string, seen: Set<string>): Sym | null {
    const parsed = this.module(module);
    const entry = parsed.exports.get(name);
    if (entry?.kind === 'FROM') return this.exported(entry.module, entry.name, seen);
    if (entry?.kind === 'LOCAL') {
      const imported = parsed.imports.get(entry.local);
      if (imported) return this.imported(imported, seen);
      // `export const keep = answerThing`: the alias's own definition.
      const local = parsed.locals.get(entry.local);
      const aliased =
        local && isAlias(local.from)
          ? this.resolve(module, ts.factory.createIdentifier(entry.local))
          : null;
      return aliased ?? { module, name: entry.local };
    }
    if (name === 'default') return null;
    for (const star of parsed.stars) {
      const found = this.exported(star, name, seen);
      if (found !== null) return found;
    }
    return null;
  }

  private imported(imported: Imported, seen = new Set<string>()): Sym | null {
    if (imported.name === NAMESPACE) return { module: imported.module, name: NAMESPACE };
    // A package's default import (`import React from 'react'`) is its namespace.
    if (imported.name === 'default' && !this.sources.has(imported.module)) {
      return { module: imported.module, name: NAMESPACE };
    }
    return this.exported(imported.module, imported.name, seen);
  }

  /** Every module `module` re-exports, itself included, followed through barrels (cycle-safe). */
  reexported(module: string, seen = new Set<string>()): Set<string> {
    if (seen.has(module) || !this.sources.has(module)) return seen;
    seen.add(module);
    const parsed = this.module(module);
    for (const star of parsed.stars) this.reexported(star, seen);
    for (const entry of parsed.exports.values()) {
      if (entry.kind === 'FROM') this.reexported(entry.module, seen);
    }
    return seen;
  }

  /** Where the expression `node` in `file` is defined, when it is a name the guard can follow. */
  resolve(file: string, node: ts.Node, depth = 0): Sym | null {
    if (depth > 16) return null;
    const parsed = this.module(file);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return this.resolve(file, node.expression, depth + 1);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = this.resolve(file, node.expression, depth + 1);
      if (base === null || base.name !== NAMESPACE) return null;
      return this.exported(base.module, node.name.text);
    }
    if (!ts.isIdentifier(node)) return null;
    const name = node.text;
    const imported = parsed.imports.get(name);
    if (imported) return this.imported(imported);
    // A local alias: `const x = name`, `const x = ns.member`, `const { member: x } = ns`.
    const local = parsed.locals.get(name);
    if (local && local.member === undefined && !isAlias(local.from)) return { module: file, name };
    if (local) {
      const base = this.resolve(file, local.from, depth + 1);
      if (local.member === undefined) return base;
      return base !== null && base.name === NAMESPACE
        ? this.exported(base.module, local.member)
        : null;
    }
    // Defined in this file at the top level.
    for (const statement of parsed.source.statements) {
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === name
      ) {
        return { module: file, name };
      }
    }
    return null;
  }

  /** Whether `sym` is defined in a `'use server'` module, or in an `…actions` module. */
  isServerAction(sym: Sym | null): boolean {
    if (sym === null || sym.name === NAMESPACE || !this.sources.has(sym.module)) return false;
    return this.module(sym.module).server || /(^|\/)[\w-]*actions\.tsx?$/.test(sym.module);
  }
}

// ---------------------------------------------------------------------------
// Discovery

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

function calls(source: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  walk(source, (node) => {
    if (ts.isCallExpression(node)) found.push(node);
  });
  return found;
}

/** The function a declaration or `const` defines under `name` at the top level of `source`. */
function topLevelFunction(source: ts.SourceFile, name: string): ts.Node | null {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer &&
          isFunction(declaration.initializer)
        ) {
          return declaration.initializer;
        }
      }
    }
  }
  return null;
}

interface Discovery {
  readonly program: Program;
  /** `fencedSlot` and every function built on it (`markerStore`). */
  readonly factories: Set<string>;
  readonly stores: Set<string>;
}

function discover(sources: Sources): Discovery {
  const program = new Program(sources);
  const factories = new Set<string>([key({ module: TENANCY, name: 'fencedSlot' })]);
  const callsFactory = (file: string, within: ts.Node) => {
    let found = false;
    walk(within, (node) => {
      if (!found && ts.isCallExpression(node)) {
        const callee = program.resolve(file, node.expression);
        found = callee !== null && factories.has(key(callee));
      }
    });
    return found;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const file of program.files()) {
      const parsed = program.module(file);
      for (const [name, entry] of parsed.exports) {
        if (entry.kind !== 'LOCAL' || factories.has(key({ module: file, name: entry.local })))
          continue;
        const fn = topLevelFunction(parsed.source, entry.local);
        if (fn !== null && callsFactory(file, fn)) {
          factories.add(key({ module: file, name: entry.local }));
          if (name !== entry.local) factories.add(key({ module: file, name }));
          grew = true;
        }
      }
    }
  }
  const stores = new Set<string>();
  for (const file of program.files()) {
    if (file !== TENANCY && callsFactory(file, program.module(file).source)) stores.add(file);
  }
  return { program, factories, stores };
}

/** The store modules: every file that calls `fencedSlot`, or a function built on it. */
export function fencedModules(sources: Sources): Set<string> {
  return discover(sources).stores;
}

/** Whether `file` refers to something a store module defines (through any barrel). */
function refersToStore(file: string, { program, stores }: Discovery): boolean {
  const parsed = program.module(file);
  for (const imported of parsed.imports.values()) {
    if (
      imported.name === NAMESPACE ||
      (imported.name === 'default' && !program.sources.has(imported.module))
    ) {
      if ([...program.reexported(imported.module)].some((module) => stores.has(module)))
        return true;
      continue;
    }
    const sym = program.exported(imported.module, imported.name);
    if (sym !== null && stores.has(sym.module)) return true;
    // A barrel that names a store but whose export cannot be followed: fail closed.
    if (sym === null && [...program.reexported(imported.module)].some((m) => stores.has(m)))
      return true;
  }
  return false;
}

function actionStateCalls(file: string, program: Program) {
  return calls(program.module(file).source).flatMap((call) => {
    const callee = program.resolve(file, call.expression);
    if (is(callee, REACT, 'useActionState')) return [{ call, raw: true }];
    if (is(callee, BOUNDARY_MODULE, 'useSlotActionState')) return [{ call, raw: false }];
    return [];
  });
}

function formsOf(discovery: Discovery): string[] {
  const forms: string[] = [];
  for (const file of discovery.program.files()) {
    if (file === BOUNDARY_MODULE) continue;
    // A store module that holds a form's state is a form too (a slot made in the form).
    if (!discovery.stores.has(file) && !refersToStore(file, discovery)) continue;
    if (actionStateCalls(file, discovery.program).length > 0) forms.push(file);
  }
  return forms.sort();
}

/** The forms built on a store module: a file that refers to one and calls an action-state hook. */
export function fencedForms(sources: Sources): string[] {
  return formsOf(discover(sources));
}

// ---------------------------------------------------------------------------
// The rules

function checkForm(file: string, discovery: Discovery): Violation[] {
  const { program, stores, factories } = discovery;
  const { source } = program.module(file);
  const out: Violation[] = [];
  const flag = (rule: string, node: ts.Node | null, detail: string) =>
    out.push({
      file,
      rule,
      detail: node
        ? `${detail} (line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1})`
        : detail,
    });
  const resolve = (node: ts.Node) => program.resolve(file, node);
  const isBoundaryCall = (node: ts.Node | undefined): node is ts.CallExpression =>
    node !== undefined &&
    ts.isCallExpression(node) &&
    is(resolve(node.expression), BOUNDARY_MODULE, 'submitThroughSlot');

  /** Whether `node` lies inside the argument of a boundary call — in its `property`, when named. */
  const insideBoundary = (node: ts.Node, property?: string): boolean => {
    let child: ts.Node = node;
    for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
      const member =
        (ts.isPropertyAssignment(parent) && parent.initializer === child) ||
        (ts.isMethodDeclaration(parent) && parent.body === child)
          ? (parent as ts.PropertyAssignment | ts.MethodDeclaration)
          : null;
      if (
        member !== null &&
        ts.isObjectLiteralExpression(member.parent) &&
        isBoundaryCall(member.parent.parent)
      ) {
        return property === undefined || member.name.getText() === property;
      }
    }
    return false;
  };

  /** The function a state hook is given: a function, or a name for one, or `useCallback` of one. */
  const reducerOf = (call: ts.CallExpression): ts.FunctionLikeDeclaration | null => {
    let argument: ts.Expression | undefined = call.arguments[0];
    if (argument && ts.isIdentifier(argument)) {
      const name = argument.text;
      let initializer: ts.Expression | undefined;
      walk(source, (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === name
        ) {
          initializer = node.initializer;
        }
      });
      argument = initializer;
    }
    if (
      argument &&
      ts.isCallExpression(argument) &&
      is(resolve(argument.expression), REACT, 'useCallback')
    ) {
      argument = argument.arguments[0];
    }
    return argument && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
      ? argument
      : null;
  };

  // 0, 1. The state is the slot hook's; its callback returns only the boundary and awaits nothing.
  let boundary = false;
  for (const { call, raw } of actionStateCalls(file, program)) {
    if (raw)
      flag('state', call, "React's useActionState: hold the state through useSlotActionState");
    const fn = reducerOf(call);
    if (fn === null) {
      flag('callback', call, 'the state hook is not given a function (or useCallback of one)');
      continue;
    }
    if (fn.body && !ts.isBlock(fn.body)) {
      if (!isBoundaryCall(fn.body))
        flag('callback', fn.body, 'returns something other than submitThroughSlot(...)');
      else boundary = true;
      continue;
    }
    const returns: ts.ReturnStatement[] = [];
    const awaits: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (node !== fn && isFunction(node)) return;
      if (ts.isReturnStatement(node)) returns.push(node);
      if (ts.isAwaitExpression(node)) awaits.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    if (returns.length === 0) flag('callback', fn, 'never returns submitThroughSlot(...)');
    for (const statement of returns) {
      if (!isBoundaryCall(statement.expression)) {
        flag('callback', statement, 'returns something other than submitThroughSlot(...)');
      } else boundary = true;
    }
    for (const node of awaits) flag('callback', node, 'awaits outside the boundary');
  }
  if (!boundary) flag('boundary', null, 'no state callback returns submitThroughSlot(...)');

  let drawn = false;
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
    if (
      (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      is(resolve(node), SESSION, 'isRedirect', 'sessionHasEnded')
    ) {
      flag('completion', node, `${node.getText()}: completions are the boundary's`);
    }

    if (ts.isCallExpression(node)) {
      const callee = resolve(node.expression);
      // 3. The server action only inside the boundary's `send`.
      if (program.isServerAction(callee) && !insideBoundary(node, 'send')) {
        flag('transport', node, `${node.expression.getText()}(...) outside the boundary's send`);
      }
      // 4. A store's writes only inside the boundary; no slot made here.
      if (callee !== null && factories.has(key(callee))) {
        flag('store', node, `${node.expression.getText()}(...): a slot made in the form`);
      }
      const writer =
        callee !== null && stores.has(callee.module) && /^(save|answer|settle)/.test(callee.name);
      const slotWrite =
        ts.isPropertyAccessExpression(node.expression) &&
        /^(start|answer|settle)$/.test(node.expression.name.text) &&
        (() => {
          const base = resolve(node.expression.expression);
          return base !== null && base.name !== NAMESPACE && stores.has(base.module);
        })();
      if ((writer || slotWrite) && !insideBoundary(node)) {
        flag('store', node, `${node.expression.getText()}(...) outside the boundary`);
      }
    }

    // 5. Drawn the one way.
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = resolve(node.tagName);
      if (is(tag, GATE_MODULE, 'UnresolvedForm')) drawn = true;
      if (is(tag, GATE_MODULE, 'QuarantineGate'))
        flag('drawn', node, 'draws QuarantineGate directly');
    }
  });
  if (!drawn) flag('drawn', null, 'never draws <UnresolvedForm>');
  return out;
}

/** Every violation in `sources`; empty when every fenced form keeps to the boundary. */
export function fencedFormViolations(sources: Sources): Violation[] {
  const discovery = discover(sources);
  const out: Violation[] = [];
  for (const file of formsOf(discovery)) out.push(...checkForm(file, discovery));
  const { program } = discovery;
  for (const file of program.files()) {
    if (file === GATE_MODULE) continue;
    const { source, refers } = program.module(file);
    // Only a file that imports the gate's module, or a barrel re-exporting it, can draw the gate.
    if (![...refers].some((module) => program.reexported(module).has(GATE_MODULE))) continue;
    walk(source, (node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        is(program.resolve(file, node.tagName), GATE_MODULE, 'QuarantineGate')
      ) {
        out.push({ file, rule: 'drawn', detail: 'draws QuarantineGate outside UnresolvedForm' });
      }
    });
  }
  return out;
}

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
 * FU-037: one normalizer (`bare`) reads every expression, binding and
 * definition through parentheses, `as`, `satisfies`, `<T>x`, `!` and a generic
 * instantiation (`uas<S, F>`); `ns['x']` is `ns.x`; inline export
 * destructuring is an export; a member of an object literal (also a default
 * export: `D.saveThing`) is followed to its value, and any other member keeps
 * its origin. A name whose resolution is exhausted — a missing export, a
 * cycle, the depth limit — keeps where it stopped and is **refused** where it
 * is called or drawn (`unresolved`), never read as "not ours".
 *
 * An invocation adapter — `f.call(t, …)`, `f.apply(t, args)`, `f.bind(t)(…)`,
 * `Reflect.apply(f, t, args)` — invokes `f`: every rule reads the call as a
 * call of `f`, with `f`'s own identity and member path (PR 698 r1 F1).
 *
 * FU-071: provenance, not spelling. The adapters are definitions of their own
 * (`INTRINSIC`: `call`, `apply`, `bind`, `Reflect`, `Reflect.apply`,
 * `Function`), so they compose and alias like any name — `f.call.bind(f)`,
 * `Reflect.apply.apply(…)`, `const run = Reflect.apply`, `const { apply } = R`,
 * a kept `call` invoked through `.call` — and a bound function carries its
 * target, receiver and bound arguments. `x.call` is the adapter only when `x`
 * has no own `call`: an object literal's own `call`/`apply`/`bind` member is
 * itself. An adapter whose function or arguments cannot be read (a kept `call`
 * with no receiver, `Reflect.apply(...xs)`, another `Reflect` member) is
 * `unresolved`: refused. Bound identities use that same adapter traversal in
 * import/barrel discovery, completion and JSX checks. Argument-sensitive rules
 * read effective arguments with their source module, never an ignored receiver.
 * Commas normalize before alias, function-definition and reducer discovery.
 *
 * ## Discovery is by what the code does, not by a list
 *
 * - A **slot factory** is `fencedSlot`, and any function whose body calls a
 *   slot factory (the marker stores' `markerStore`), found at its definition
 *   (a declaration, a `const`, a default export, an object literal's member)
 *   so every alias of it resolves there.
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
 * 2. no `try`, and no `.catch`, `.then` or `.finally` (called or not) anywhere in it, and no
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
 *   `require`), or reaches one through a computed member (`ns[name]`, not a
 *   literal `ns['x']`);
 * - holds its state through a hook of its own that wraps `useActionState` in a
 *   file that does not itself refer to a store (a **wrapper hook**): the form
 *   then calls no action-state hook the guard can see;
 * - passes the boundary, a store writer or an action through a parameter, a
 *   reassigned `let`, an array element, a spread, an object made at run time
 *   or another function's return value;
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

type Wrapper =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.TypeAssertion
  | ts.NonNullExpression
  | ts.ExpressionWithTypeArguments
  | ts.PartiallyEmittedExpression;

/** Syntax that names nothing of its own: `(x)`, `x as T`, `x satisfies T`, `<T>x`, `x!`, `f<T>`. */
const wraps = (node: ts.Node): node is Wrapper =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isTypeAssertionExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isExpressionWithTypeArguments(node) ||
  ts.isPartiallyEmittedExpression(node);

/**
 * The one normalizer (FU-037): every rule, every binding and every definition
 * reads an expression through it, so a wrapper never hides what it wraps.
 */
function bare(node: ts.Expression): ts.Expression;
function bare(node: ts.Node): ts.Node;
function bare(node: ts.Node): ts.Node {
  for (;;) {
    if (wraps(node)) node = node.expression;
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken)
      node = node.right;
    else return node;
  }
}

/** `ns.x`, or `ns['x']`: a member named by a literal. */
function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
  return null;
}

/** A property's static name; null for a computed one. */
function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** An expression that only names something defined elsewhere (`x`, `ns.x`, `(x as T)`, `f<T>`). */
function isAlias(node: ts.Expression): boolean {
  const inner = bare(node);
  return ts.isIdentifier(inner) || memberName(inner) !== null;
}

/**
 * A definition: a module (a source path, or a package specifier) and an export
 * name; `*` is the module itself. `unresolved` keeps where resolution stopped
 * (a cycle, a missing export, the depth limit): such a name is refused.
 */
interface Sym {
  readonly module: string;
  readonly name: string;
  readonly member?: string;
  readonly unresolved?: true;
  /** `target.bind(receiver, ...args)` (`INTRINSIC#bound`): invoking it invokes `target`, `args` first. */
  readonly bound?: {
    readonly target: Sym | null;
    readonly receiver?: Arg;
    readonly args: readonly Arg[] | null;
  };
}

/** An argument, where it is written (a bound argument comes from the module that bound it). */
type Arg = { readonly file: string; readonly node: ts.Expression };

/** What a call invokes, read through every adapter; `args: null` — not known one by one. */
interface Invocation {
  readonly sym: Sym | null;
  readonly receiver?: Arg;
  readonly args: readonly Arg[] | null;
}

/** The language's own functions and objects: never one of ours, never a store's. */
const INTRINSIC = '%intrinsic%';
const GLOBALS = new Set(['Reflect', 'Function', 'globalThis']);
const ADAPTERS = new Set(['call', 'apply', 'bind']);
const intrinsic = (name: string): Sym => ({ module: INTRINSIC, name });
const isIntrinsic = (sym: Sym | null, name: string) =>
  sym !== null && !sym.unresolved && sym.module === INTRINSIC && sym.name === name;

const NAMESPACE = '*';
const key = (sym: Sym) => `${sym.module}#${sym.name}${sym.member ? `.${sym.member}` : ''}`;
const is = (sym: Sym | null, module: string, ...names: string[]) =>
  sym !== null &&
  !sym.unresolved &&
  sym.member === undefined &&
  sym.module === module &&
  names.includes(sym.name);

const REACT = 'react';
const BOUNDARY_MODULE = 'lib/fenced-submission.ts';
const TENANCY = 'lib/unresolved-tenancy.ts';
const SESSION = 'lib/session-refusal.ts';
const GATE_MODULE = 'app/UnresolvedQuarantine.tsx';

type Imported = { readonly module: string; readonly name: string };
type Exported =
  | { readonly kind: 'LOCAL'; readonly local: string; readonly expression?: ts.Expression }
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
  /** Whether the file is a `'use server'` module. */
  readonly server: boolean;
  /** Local `const` names → what they alias: an expression, or a member of one (destructuring). */
  readonly locals: Map<string, { readonly from: ts.Expression; readonly member?: string }>;
}

/** The arguments an `apply` list gives, when written out (`[a, b]`, or none); null otherwise. */
function listed(arg: Arg | undefined): Arg[] | null {
  if (!arg) return [];
  const list = bare(arg.node);
  if (
    list.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(list) && list.text === 'undefined')
  )
    return [];
  if (!ts.isArrayLiteralExpression(list) || list.elements.some(ts.isSpreadElement)) return null;
  return list.elements.map((node) => ({ file: arg.file, node }));
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
    // By extension: a `.ts` file read as TSX takes `<T>x` for JSX and loses the rest of the file.
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const imports = new Map<string, Imported>();
    const exports = new Map<string, Exported>();
    const stars: string[] = [];
    const target = (specifier: ts.Expression) =>
      ts.isStringLiteral(specifier)
        ? (resolvePath(file, specifier.text, this.sources) ?? specifier.text)
        : null;
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const from = target(statement.moduleSpecifier);
        if (from === null) continue;
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
            // `export const x =`, and inline destructuring `export const { a: x } = ns`.
            const names = ts.isIdentifier(declaration.name)
              ? [declaration.name]
              : declaration.name.elements.flatMap((element) =>
                  ts.isBindingElement(element) && ts.isIdentifier(element.name)
                    ? [element.name]
                    : [],
                );
            for (const name of names) exports.set(name.text, { kind: 'LOCAL', local: name.text });
          }
        } else if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
          (statement.name ||
            (isDefault &&
              (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))))
        ) {
          const name = statement.name?.text ?? 'default';
          exports.set(isDefault ? 'default' : name, {
            kind: 'LOCAL',
            local: name,
          });
        }
      } else if (ts.isExportAssignment(statement)) {
        // `export default (x as T)` is `x`; any other expression is kept to be read.
        const expression = bare(statement.expression);
        exports.set(
          'default',
          ts.isIdentifier(expression)
            ? { kind: 'LOCAL', local: expression.text }
            : { kind: 'LOCAL', local: 'default', expression },
        );
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
    const parsed = { file, source, imports, exports, stars, server, locals };
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
      // `export default store.saveThing` / `f.bind(t)`: the alias's own definition.
      if (entry.expression)
        return this.resolve(module, entry.expression) ?? { module, name: entry.local };
      const imported = parsed.imports.get(entry.local);
      if (imported) return this.imported(imported, seen);
      // `export const keep = answerThing`: the alias's own definition.
      return (
        this.resolve(module, ts.factory.createIdentifier(entry.local)) ?? {
          module,
          name: entry.local,
        }
      );
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
    // A name our module does not export (or a cycle): kept, and refused where used.
    return (
      this.exported(imported.module, imported.name, seen) ?? {
        module: imported.module,
        name: imported.name,
        unresolved: true,
      }
    );
  }

  /** Every module `module` re-exports, itself included, followed through barrels (cycle-safe). */
  reexported(module: string, seen = new Set<string>()): Set<string> {
    if (seen.has(module) || !this.sources.has(module)) return seen;
    seen.add(module);
    const parsed = this.module(module);
    for (const star of parsed.stars) this.reexported(star, seen);
    for (const [name, entry] of parsed.exports) {
      const sym = this.provenance(this.exported(module, name));
      if (sym !== null) this.reexported(sym.module, seen);
      // Preserve the fail-closed dependency even when a FROM name is missing.
      if (entry.kind === 'FROM') this.reexported(entry.module, seen);
    }
    return seen;
  }

  /** Where the expression `node` in `file` is defined, when it is a name the guard can follow. */
  resolve(file: string, node: ts.Node, depth = 0): Sym | null {
    // Exhausted: refused where used, never read as "not one of ours".
    if (depth > 64) return { module: file, name: '', unresolved: true };
    const parsed = this.module(file);
    node = bare(node);
    const memberOf = memberName(node);
    if (memberOf !== null) {
      const base = this.resolve(file, (node as Access).expression, depth + 1);
      return this.member(base, memberOf, depth + 1);
    }
    // A call names what it makes only when it invokes `bind`: a bound function.
    if (ts.isCallExpression(node)) {
      const made = this.invoked(file, node, depth);
      if (made.sym?.unresolved) return made.sym;
      if (!isIntrinsic(made.sym, 'bind')) return null;
      const target = made.receiver
        ? this.resolve(made.receiver.file, made.receiver.node, depth + 1)
        : { module: file, name: 'bind', unresolved: true as const };
      const bound = { target, receiver: made.args?.[0], args: made.args && made.args.slice(1) };
      return { module: INTRINSIC, name: 'bound', bound };
    }
    if (!ts.isIdentifier(node)) return null;
    const name = node.text;
    const imported = parsed.imports.get(name);
    if (imported) return this.imported(imported);
    // A local alias: `const x = name`, `const x = ns.member`, `const { member: x } = ns`,
    // `const x = f.bind(t)`; any other value is its own definition.
    const local = parsed.locals.get(name);
    if (local) {
      const from = bare(local.from);
      if (local.member !== undefined)
        return this.member(this.resolve(file, from, depth + 1), local.member, depth + 1);
      if (isAlias(from)) return this.resolve(file, from, depth + 1);
      const made = ts.isCallExpression(from) ? this.resolve(file, from, depth + 1) : null;
      return made ?? { module: file, name };
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
    return GLOBALS.has(name) ? intrinsic(name) : null;
  }

  /**
   * Namespace exports and object members retain their origin through every
   * alias: an object literal's property is followed to its own definition, and
   * any other member — nested too — keeps the module and name it came from.
   */
  private member(base: Sym | null, name: string, depth: number): Sym | null {
    // FU-071: a function's `call`/`apply`/`bind` is the adapter — unless the value has its own.
    const adapter = ADAPTERS.has(name) ? intrinsic(name) : null;
    if (base === null) return adapter;
    if (base.unresolved) return { ...base, member: name };
    if (base.module === INTRINSIC) {
      if (base.name === 'globalThis') return GLOBALS.has(name) ? intrinsic(name) : null;
      if (base.name === 'Function' && name === 'prototype') return intrinsic('Function.prototype');
      // `Reflect.construct`, `Reflect.get`, …: not followed, so refused.
      if (base.name === 'Reflect')
        return name === 'apply'
          ? intrinsic('Reflect.apply')
          : { module: INTRINSIC, name: `Reflect.${name}`, unresolved: true };
      return adapter;
    }
    if (base.name === NAMESPACE) {
      return this.exported(base.module, name) ?? { module: base.module, name, unresolved: true };
    }
    if (base.member === undefined) {
      const own = this.property(base, name);
      // An object literal's own member, followed to its value.
      if (own)
        return (
          (own.value && this.resolve(base.module, own.value, depth)) ?? { ...base, member: name }
        );
    }
    return adapter ?? { ...base, member: name };
  }

  /**
   * The own member `name` of the object literal `sym` is defined as: its value
   * (`{ name: value }`, `{ name }`; null for a method or accessor); null when the
   * literal has no such member; undefined when `sym` is not an object literal.
   */
  private property(sym: Sym, name: string): { readonly value: ts.Node | null } | null | undefined {
    if (!this.sources.has(sym.module)) return undefined;
    const parsed = this.module(sym.module);
    const local = parsed.locals.get(sym.name);
    const exported = parsed.exports.get(sym.name);
    const definition =
      local?.member === undefined && local
        ? local.from
        : exported?.kind === 'LOCAL'
          ? exported.expression
          : undefined;
    const literal = definition && bare(definition);
    if (!literal || !ts.isObjectLiteralExpression(literal)) return undefined;
    for (const element of literal.properties) {
      if (element.name === undefined || propertyName(element.name) !== name) continue;
      if (ts.isPropertyAssignment(element)) return { value: element.initializer };
      if (ts.isShorthandPropertyAssignment(element)) return { value: element.name };
      return { value: null };
    }
    return null;
  }

  /**
   * What `call` invokes, read through every adapter (FU-071): `call` and
   * `apply` invoke their receiver, `Reflect.apply` its first argument, a bound
   * function its target with the bound arguments first — composed to any
   * depth. The target keeps its own identity and member path; the arguments it
   * receives are kept when they are written out one by one.
   */
  invoked(file: string, call: ts.CallExpression, depth = 0): Invocation {
    const fn = bare(call.expression);
    const receiver =
      memberName(fn) !== null ? { file, node: (fn as Access).expression } : undefined;
    const args = call.arguments.some(ts.isSpreadElement)
      ? null
      : call.arguments.map((node) => ({ file, node }));
    return this.invoke(this.resolve(file, fn, depth), receiver, args, depth);
  }

  private invoke(
    sym: Sym | null,
    receiver: Arg | undefined,
    args: readonly Arg[] | null,
    depth: number,
  ): Invocation {
    const refused = { sym: { module: INTRINSIC, name: sym?.name ?? '', unresolved: true }, args };
    if (depth > 64) return refused as Invocation;
    if (sym?.bound) {
      const { target, receiver: bound, args: first } = sym.bound;
      return this.invoke(target, bound, first && args ? [...first, ...args] : null, depth + 1);
    }
    if (sym === null || sym.unresolved || sym.module !== INTRINSIC) return { sym, receiver, args };
    const value = (arg: Arg | undefined) =>
      arg ? this.resolve(arg.file, arg.node, depth + 1) : null;
    if (sym.name === 'call' || sym.name === 'apply') {
      // The function is the receiver; a kept `call` invoked without one is not followed.
      if (!receiver) return refused as Invocation;
      const rest = sym.name === 'call' ? args && args.slice(1) : listed(args?.[1]);
      return this.invoke(value(receiver), args?.[0], args && rest, depth + 1);
    }
    if (sym.name === 'Reflect.apply') {
      if (!args?.[0]) return refused as Invocation;
      return this.invoke(value(args[0]), args[1], listed(args[2]), depth + 1);
    }
    return { sym, receiver, args };
  }

  /** Bound identity follows the same adapter semantics as invocation, without discarding arguments. */
  provenance(sym: Sym | null): Sym | null {
    return sym?.bound
      ? (this.invoke(sym, undefined, [], 0).sym ?? { ...sym, unresolved: true })
      : sym;
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

/**
 * Every function `source` defines at the top level, under the name a resolved
 * reference to it carries: `make`, `default`, or `api.make` for a member of an
 * object literal. Wrappers are read through (`(() => …) as Factory`).
 */
function definitions(source: ts.SourceFile): [string, ts.Node][] {
  const out: [string, ts.Node][] = [];
  const define = (name: string, value: ts.Expression) => {
    const inner = bare(value);
    if (isFunction(inner)) out.push([name, inner]);
    else if (ts.isObjectLiteralExpression(inner)) {
      for (const element of inner.properties) {
        const member = element.name && propertyName(element.name);
        if (!member) continue;
        if (ts.isMethodDeclaration(element)) out.push([`${name}.${member}`, element]);
        else if (ts.isPropertyAssignment(element)) {
          const fn = bare(element.initializer);
          if (isFunction(fn)) out.push([`${name}.${member}`, fn]);
        }
      }
    }
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement))
      out.push([statement.name?.text ?? 'default', statement]);
    else if (ts.isExportAssignment(statement)) define('default', statement.expression);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          define(declaration.name.text, declaration.initializer);
      }
    }
  }
  return out;
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
        const callee = program.invoked(file, node).sym;
        // A callee the guard cannot follow may be a factory: fail closed.
        found = callee !== null && (callee.unresolved === true || factories.has(key(callee)));
      }
    });
    return found;
  };
  // A factory is found at its definition; every alias of it resolves there.
  for (let grew = true; grew;) {
    grew = false;
    for (const file of program.files()) {
      for (const [name, fn] of definitions(program.module(file).source)) {
        const id = `${file}#${name}`;
        if (!factories.has(id) && callsFactory(file, fn)) {
          factories.add(id);
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
  for (const [name, imported] of parsed.imports) {
    const sym = program.provenance(program.resolve(file, ts.factory.createIdentifier(name)));
    if (sym !== null && stores.has(sym.module)) return true;
    // A namespace exposes all its exports; an unresolved name keeps its whole provenance gated.
    const open =
      sym === null || sym.unresolved
        ? [imported.module, ...(sym ? [sym.module] : [])]
        : sym.name === NAMESPACE
          ? [sym.module]
          : [];
    for (const module of open) {
      if ([...program.reexported(module)].some((m) => stores.has(m))) return true;
    }
  }
  return false;
}

/** The action-state hook calls; a callee the guard cannot follow may be one (fail closed). */
type Hook = {
  readonly call: ts.CallExpression;
  readonly args: readonly Arg[] | null;
  readonly hook: 'REACT' | 'SLOT' | 'UNRESOLVED';
};

function actionStateCalls(file: string, program: Program): Hook[] {
  return calls(program.module(file).source).flatMap((call): Hook[] => {
    const { sym: callee, args } = program.invoked(file, call);
    if (is(callee, REACT, 'useActionState')) return [{ call, args, hook: 'REACT' }];
    if (is(callee, BOUNDARY_MODULE, 'useSlotActionState')) return [{ call, args, hook: 'SLOT' }];
    if (callee?.unresolved) return [{ call, args, hook: 'UNRESOLVED' }];
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
  const resolve = (node: ts.Node) => program.provenance(program.resolve(file, node));
  const isBoundaryCall = (node: ts.Node | undefined): boolean => {
    const call = node && bare(node);
    return (
      call !== undefined &&
      ts.isCallExpression(call) &&
      is(program.invoked(file, call).sym, BOUNDARY_MODULE, 'submitThroughSlot')
    );
  };

  // Only the effective options argument grants protection, never an adapter receiver.
  // Bound options need not be ancestors of the eventual invocation.
  const boundaryOptions = new Set(
    calls(source).flatMap((call) => {
      const invoked = program.invoked(file, call);
      const options = invoked.args?.[0];
      return is(invoked.sym, BOUNDARY_MODULE, 'submitThroughSlot') && options?.file === file
        ? [bare(options.node)]
        : [];
    }),
  );

  /** Whether `node` lies inside the effective options — in its `property`, when named. */
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
        boundaryOptions.has(member.parent)
      ) {
        return property === undefined || member.name.getText() === property;
      }
    }
    return false;
  };

  /** The function a state hook is given: a function, or a name for one, or `useCallback` of one. */
  const reducerOf = (args: readonly Arg[] | null): ts.FunctionLikeDeclaration | null => {
    // A reducer bound in another module is not read here: refused as not a function.
    const first = args?.[0];
    let argument: ts.Expression | undefined = first?.file === file ? bare(first.node) : undefined;
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
      argument = initializer && bare(initializer);
    }
    if (
      argument &&
      ts.isCallExpression(argument) &&
      is(program.invoked(file, argument).sym, REACT, 'useCallback')
    ) {
      const reducer = program.invoked(file, argument).args?.[0];
      argument = reducer?.file === file ? bare(reducer.node) : undefined;
    }
    return argument && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
      ? argument
      : null;
  };

  // 0, 1. The state is the slot hook's; its callback returns only the boundary and awaits nothing.
  let boundary = false;
  for (const { call, args, hook } of actionStateCalls(file, program)) {
    // An unresolved hook is refused by the call scan below.
    if (hook === 'UNRESOLVED') continue;
    if (hook === 'REACT')
      flag('state', call, "React's useActionState: hold the state through useSlotActionState");
    const fn = reducerOf(args);
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
    // Any reach for a completion handler — called, parenthesized, `['then']` or kept aside.
    const handler = memberName(node);
    if (handler !== null && ['catch', 'then', 'finally'].includes(handler)) {
      flag('completion', node, `.${handler}`);
    }
    if (
      (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      is(resolve(node), SESSION, 'isRedirect', 'sessionHasEnded')
    ) {
      flag('completion', node, `${node.getText()}: completions are the boundary's`);
    }

    if (ts.isCallExpression(node)) {
      // Through `.call`, `.apply`, `.bind(…)()` and `Reflect.apply`: the target, not the adapter.
      const callee = program.invoked(file, node).sym;
      if (callee?.unresolved)
        flag('unresolved', node, `${node.expression.getText()}(...): the guard cannot follow it`);
      // 3. The server action only inside the boundary's `send`.
      if (program.isServerAction(callee) && !insideBoundary(node, 'send')) {
        flag('transport', node, `${node.expression.getText()}(...) outside the boundary's send`);
      }
      // 4. A store's writes only inside the boundary; no slot made here.
      if (callee !== null && factories.has(key(callee))) {
        flag('store', node, `${node.expression.getText()}(...): a slot made in the form`);
      }
      // A store's writer, also as a member (`D.saveThing` of a default-exported object).
      const writer =
        callee !== null &&
        stores.has(callee.module) &&
        /^(save|answer|settle)/.test(callee.member ?? callee.name);
      const slotWrite =
        callee !== null &&
        stores.has(callee.module) &&
        callee.member !== undefined &&
        /^(start|answer|settle)$/.test(callee.member);
      if ((writer || slotWrite) && !insideBoundary(node)) {
        flag('store', node, `${node.expression.getText()}(...) outside the boundary`);
      }
    }

    // 5. Drawn the one way.
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = resolve(node.tagName);
      if (tag?.unresolved) flag('unresolved', node, `<${node.tagName.getText()}>: cannot follow`);
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
  const forms = formsOf(discovery);
  for (const file of forms) out.push(...checkForm(file, discovery));
  const { program } = discovery;
  for (const file of program.files()) {
    if (file === GATE_MODULE) continue;
    const { source } = program.module(file);
    // Resolve every JSX tag through the same graph used by form discovery.
    walk(source, (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const tag = program.provenance(program.resolve(file, node.tagName));
      if (is(tag, GATE_MODULE, 'QuarantineGate')) {
        out.push({ file, rule: 'drawn', detail: 'draws QuarantineGate outside UnresolvedForm' });
      } else if (tag?.unresolved && !forms.includes(file)) {
        // It may be the gate: a tag the guard cannot follow is refused everywhere (a form's, above).
        out.push({
          file,
          rule: 'unresolved',
          detail: `<${node.tagName.getText()}>: cannot follow`,
        });
      }
    });
  }
  return out;
}

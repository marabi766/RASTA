import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import * as ts from 'typescript';

export interface ServerActionScan {
  /** `line` of a `'use server'` directive in the file's own directive prologue. */
  readonly fileLevel: number | null;
  /** `line` of every `'use server'` directive inside a function body. */
  readonly inline: readonly number[];
}

function hasDirective(statements: readonly ts.Statement[]): ts.StringLiteral | undefined {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return undefined;
    }
    if (statement.expression.text === 'use server') return statement.expression;
  }
  return undefined;
}

/**
 * Finds `'use server'` directives by parsing, not by matching text: quote style,
 * comments, blank lines, a missing semicolon, escapes and line continuations do not
 * matter (the parser hands over the cooked string, as Next's does), and only a
 * directive in a prologue counts (a string in the middle of a file is not one).
 * This is the ONE place a directive is recognised; no text filter runs before it.
 *
 * Scope: a fast local early warning. The authority on which modules define server
 * actions is the compiler's own manifest; holding the cases to it follows in a stacked change.
 */
export function scanServerActions(source: string, fileName: string): ServerActionScan {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  const inline: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body)) {
      const directive = hasDirective(node.body.statements);
      if (directive) {
        inline.push(file.getLineAndCharacterOfPosition(directive.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const top = hasDirective(file.statements);
  return {
    fileLevel: top ? file.getLineAndCharacterOfPosition(top.getStart(file)).line + 1 : null,
    inline,
  };
}

/**
 * The ONE list of extensions Next's webpack rule compiles as application code
 * (`next/dist/build/webpack-config.js`, `codeCondition.test`). Discovery, the
 * collision check and the spec all read it; `server-action-boundary.spec.ts`
 * fails when the installed Next compiles an extension this list lacks.
 */
export const COMPILED_EXTENSIONS = ['ts', 'tsx', 'js', 'cjs', 'mjs', 'jsx'] as const;
const SOURCE = new RegExp(`\\.(${COMPILED_EXTENSIONS.join('|')})$`);
const DECLARATION = /\.d\.(ts|cts|mts)$/;
/** Never source: dependencies and build output. */
const OUTPUT_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  '.turbo',
  'coverage',
]);
/** Files a production build never ships on purpose: a server action in one is a defect. */
const TEST_ONLY = /(\.(spec|test)\.[a-z]+$|(^|\/)(test|tests|__tests__|__mocks__|fixtures|e2e)\/)/;

export interface Discovery {
  /** Real paths from the real `repoRoot`, extension included, of every non-test module with a file-level directive. */
  readonly modules: string[];
  /** Static runtime export names of each of those modules (`'*'` for `export *`, `'default'` for the default). */
  readonly exports: Record<string, string[]>;
  /** `file:line` of every function-scoped directive. */
  readonly inline: string[];
  /** `file:line` of every directive of either kind in a test-only file. */
  readonly inTestFiles: string[];
  /** Directories where one basename has several compilable extensions: Jest and Next may load different files. */
  readonly ambiguous: string[];
  /** Source files read and parsed (cost report). */
  reads: number;
}

/**
 * Export names this code accepts: a plain ASCII identifier, which includes `default`.
 * Anything else is refused (fail closed), not escaped: a legal-but-exotic string name
 * (`export { x as 'a b/c.ts d' }`) has no business in an action module and is exactly
 * what an ambiguous identity would need. Module PATHS are ordinary paths (separators,
 * extensions, spaces are fine); only control characters are refused in them.
 */
const PLAIN_EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Text for a diagnostic: every control character shown as an escape, never raw. */
export function printable(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function isPlainExportName(name: unknown): name is string {
  return typeof name === 'string' && PLAIN_EXPORT_NAME.test(name);
}

/** Throws when an export name is not a plain identifier or `default`. */
export function assertPlainExportName(name: unknown, where: string): asserts name is string {
  if (!isPlainExportName(name)) {
    throw new Error(
      `${printable(where)}: export name ${printable(String(name))} is not a plain identifier or default`,
    );
  }
}

/** Throws when a module path contains a control character (before it is shown anywhere). */
export function assertPlainModulePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path === '' || CONTROL_CHARACTER.test(path)) {
    throw new Error(
      `module path ${printable(String(path))} is empty or contains a control character`,
    );
  }
}

/**
 * THE identity of one server action, everywhere it is built or compared (discovery, the
 * refusal spec, the compiler-manifest check): the JSON of `[module, exportedName]`.
 * JSON array encoding is injective for strings, so two different pairs never share a key
 * whatever characters a path or an alias contains. Keys are compared, never displayed.
 */
export function actionKey(module: string, exportedName: string): string {
  return JSON.stringify([module, exportedName]);
}

/** Display text for a pair (messages, test titles). Never compared. */
export function actionLabel(module: string, exportedName: string): string {
  return `${printable(module)} ${printable(exportedName)}`;
}

export interface RuntimeExport {
  readonly key: string;
  readonly label: string;
  readonly exported: string;
  readonly value: unknown;
}

/** Every runtime export of one loaded module, identified by `actionKey`; refuses a name that is not plain. */
export function runtimeExports(
  module: string,
  record: Readonly<Record<string, unknown>>,
): RuntimeExport[] {
  assertPlainModulePath(module);
  return Object.entries(record).map(([exported, value]) => {
    assertPlainExportName(exported, module);
    return {
      key: actionKey(module, exported),
      label: actionLabel(module, exported),
      exported,
      value,
    };
  });
}

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, into);
  }
}

/** Runtime export names of a module, from its syntax (types do not exist at runtime). */
export function exportedNames(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  const names = new Set<string>();
  const add = (name: string): void => {
    assertPlainExportName(name, fileName);
    names.add(name);
  };
  for (const statement of file.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const has = (kind: ts.SyntaxKind): boolean => !!modifiers?.some((m) => m.kind === kind);
    if (ts.isExportAssignment(statement)) {
      names.add(statement.isExportEquals ? '=' : 'default');
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (!clause) names.add('*');
      else if (ts.isNamespaceExport(clause)) add(clause.name.text);
      else {
        for (const element of clause.elements) if (!element.isTypeOnly) add(element.name.text);
      }
    } else if (!has(ts.SyntaxKind.ExportKeyword)) {
      continue;
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const bound = new Set<string>();
        bindingNames(declaration.name, bound);
        bound.forEach(add);
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      (ts.isEnumDeclaration(statement) && !has(ts.SyntaxKind.ConstKeyword))
    ) {
      add(has(ts.SyntaxKind.DefaultKeyword) ? 'default' : (statement.name?.text ?? 'default'));
    }
  }
  return [...names].sort();
}

/** Every (module, export) the refusal cases must cover: the one set the compiler manifest is held to. */
export function coveredActions(discovery: Discovery): Set<string> {
  return new Set(
    discovery.modules.flatMap((module) =>
      (discovery.exports[module] ?? []).map((name) => actionKey(module, name)),
    ),
  );
}

/** The web app is walked with only dependencies and `.next` skipped; a package also skips build output. */
const APP_SKIPPED = new Set(['node_modules', '.next']);

function walkSources(
  dir: string,
  skipped: ReadonlySet<string>,
  visit: (file: string) => void,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) walkSources(full, skipped, visit);
    } else if (SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) {
      visit(full);
    }
  }
}

/**
 * The whole directory (not only `src`) of every workspace package the web app depends
 * on, transitively, by any dependency field and any version range that names a workspace
 * package: the package manager decides how it is linked, discovery does not.
 */
export function workspacePackageDirs(repoRoot: string, appDir: string): string[] {
  const byName = new Map<string, string>();
  for (const name of readdirSync(join(repoRoot, 'packages'))) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, 'packages', name, 'package.json'), 'utf8'),
      );
      byName.set(manifest.name as string, join(repoRoot, 'packages', name));
    } catch {
      // not a package
    }
  }
  const dirs = new Set<string>();
  const pending = [appDir];
  while (pending.length > 0) {
    const manifest = JSON.parse(
      readFileSync(join(pending.pop() as string, 'package.json'), 'utf8'),
    );
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    } as Record<string, string>;
    for (const dep of Object.keys(deps)) {
      const dir = byName.get(dep);
      if (dir && !dirs.has(dir)) {
        dirs.add(dir);
        pending.push(dir);
      }
    }
  }
  return [...dirs].sort();
}

/**
 * Every source Next can compile for the web app — all of `appDir` and the whole directory
 * of each workspace package it depends on — with no exclusion for a file name or directory
 * a production import could still reach. Test-only files are not skipped: a directive in
 * one is reported, so it cannot hide from the cases. What else the build could reach is
 * fenced off by `server-action-boundary.spec.ts`.
 */
export function discoverServerActions(repoRoot: string, appDir: string): Discovery {
  const root = realpathSync(repoRoot);
  const modules: string[] = [];
  const exports: Record<string, string[]> = {};
  const inline: string[] = [];
  const inTestFiles: string[] = [];
  const ambiguous: string[] = [];
  let reads = 0;
  const roots: Array<[string, ReadonlySet<string>]> = [
    [appDir, APP_SKIPPED],
    ...workspacePackageDirs(repoRoot, appDir).map((dir): [string, ReadonlySet<string>] => [
      dir,
      OUTPUT_DIRECTORIES,
    ]),
  ];
  for (const [scanRoot, skipped] of roots) {
    const byBase = new Map<string, string[]>();
    walkSources(scanRoot, skipped, (visited) => {
      const full = realpathSync(visited);
      const rel = relative(root, full);
      assertPlainModulePath(rel);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`${visited}: resolves outside the repository`);
      }
      const key = full.replace(SOURCE, '');
      byBase.set(key, [...(byBase.get(key) ?? []), rel]);
      const text = readFileSync(full, 'utf8');
      reads += 1;
      const scan = scanServerActions(text, full);
      if (TEST_ONLY.test(rel)) {
        if (scan.fileLevel) inTestFiles.push(`${rel}:${scan.fileLevel}`);
        for (const line of scan.inline) inTestFiles.push(`${rel}:${line}`);
        return;
      }
      if (scan.fileLevel) {
        modules.push(rel);
        exports[rel] = exportedNames(text, full);
      }
      for (const line of scan.inline) inline.push(`${rel}:${line}`);
    });
    for (const files of byBase.values()) {
      if (files.length > 1) ambiguous.push(files.sort().join(' + '));
    }
  }
  return {
    modules: modules.sort(),
    exports,
    inline: inline.sort(),
    inTestFiles: inTestFiles.sort(),
    ambiguous: ambiguous.sort(),
    reads,
  };
}

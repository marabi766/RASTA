import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

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
 * comments, blank lines and a missing semicolon do not matter, and only a
 * directive in a prologue counts (a string in the middle of a file is not one).
 */
export function scanServerActions(source: string, fileName: string): ServerActionScan {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
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

/** What Next's compiler turns into a module: `.d.ts` is types only. */
const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
const DECLARATION = /\.d\.ts$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next']);
/** Files a production build never ships on purpose: a server action in one is a defect. */
const TEST_ONLY = /(\.(spec|test)\.[a-z]+$|(^|\/)(test|tests|__tests__|__mocks__|fixtures|e2e)\/)/;

export interface Discovery {
  /** Paths from `repoRoot`, extension included, of every non-test module with a file-level directive. */
  readonly modules: string[];
  /** `file:line` of every function-scoped directive. */
  readonly inline: string[];
  /** `file:line` of every directive of either kind in a test-only file. */
  readonly inTestFiles: string[];
  /** Directories where one basename has several compilable extensions: Jest and Next may load different files. */
  readonly ambiguous: string[];
}

function walkSources(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walkSources(full, visit);
    } else if (SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) {
      visit(full);
    }
  }
}

/** `src` of every workspace package the web app depends on, transitively (`workspace:` in package.json). */
export function workspacePackageSources(repoRoot: string, appDir: string): string[] {
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
  const sources = new Set<string>();
  const pending = [appDir];
  while (pending.length > 0) {
    const manifest = JSON.parse(
      readFileSync(join(pending.pop() as string, 'package.json'), 'utf8'),
    );
    const deps = { ...manifest.dependencies, ...manifest.devDependencies } as Record<
      string,
      string
    >;
    for (const [dep, range] of Object.entries(deps)) {
      const dir = byName.get(dep);
      if (range.startsWith('workspace:') && dir && !sources.has(join(dir, 'src'))) {
        sources.add(join(dir, 'src'));
        pending.push(dir);
      }
    }
  }
  return [...sources].sort();
}

/**
 * Every source Next can compile for the web app — all of `appDir` (not only `src`) and
 * the `src` of each workspace package it depends on — with no exclusion for a file name
 * or directory a production import could still reach. Test-only files are not skipped:
 * a directive in one is reported, so it cannot hide from the cases.
 */
export function discoverServerActions(repoRoot: string, appDir: string): Discovery {
  const modules: string[] = [];
  const inline: string[] = [];
  const inTestFiles: string[] = [];
  const ambiguous: string[] = [];
  const roots = [appDir, ...workspacePackageSources(repoRoot, appDir)];
  for (const root of roots) {
    const byBase = new Map<string, string[]>();
    walkSources(root, (full) => {
      const rel = relative(repoRoot, full);
      const key = full.replace(SOURCE, '');
      byBase.set(key, [...(byBase.get(key) ?? []), rel]);
      const scan = scanServerActions(readFileSync(full, 'utf8'), full);
      if (TEST_ONLY.test(rel)) {
        if (scan.fileLevel) inTestFiles.push(`${rel}:${scan.fileLevel}`);
        for (const line of scan.inline) inTestFiles.push(`${rel}:${line}`);
        return;
      }
      if (scan.fileLevel) modules.push(rel);
      for (const line of scan.inline) inline.push(`${rel}:${line}`);
    });
    for (const files of byBase.values()) {
      if (files.length > 1) ambiguous.push(files.sort().join(' + '));
    }
  }
  return {
    modules: modules.sort(),
    inline: inline.sort(),
    inTestFiles: inTestFiles.sort(),
    ambiguous: ambiguous.sort(),
  };
}

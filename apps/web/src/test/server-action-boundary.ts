import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import * as ts from 'typescript';

/**
 * Server-action discovery scans the web app and the whole directory of each workspace
 * package it depends on. It is complete only while the build cannot reach a source
 * outside that set. This file states the ways a build could, and reports each one with
 * the sentence "extend server-action discovery to <path> first".
 */

/** next.config properties that let the build compile or resolve sources outside the app. */
export const REACH_OPTIONS = [
  'transpilePackages',
  'externalDir',
  'webpack',
  'turbopack',
  'resolveAlias',
  'alias',
] as const;

/** Explicit allow-list for the options above: empty today. Add an entry only after extending discovery. */
export const ALLOWED_REACH: readonly string[] = [];

const NEXT_RULE = /\/\\\.\(([a-z|]+)\)\$\/,\s*\/__barrel_optimize__\//;

/** Extensions the installed Next compiles as application code, read from its webpack rule. */
export function nextCompiledExtensions(webpackConfigSource: string): string[] {
  const match = NEXT_RULE.exec(webpackConfigSource);
  if (!match) throw new Error('Next webpack rule for compiled extensions not found: re-read it');
  return match[1].split('|').sort();
}

/** Identifiers or property names (code only, not comments or strings) from REACH_OPTIONS in a next.config source. */
export function reachOptionsIn(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      if ((REACH_OPTIONS as readonly string[]).includes(node.text)) found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found].filter((name) => !ALLOWED_REACH.includes(name)).sort();
}

/** Every `next.config.*` of the app: there may be one, and it is checked. */
export function nextConfigFiles(appDir: string): string[] {
  return readdirSync(appDir)
    .filter((name) => /^next\.config\./.test(name))
    .sort();
}

/** Resolved `paths` targets and `baseUrl` of a tsconfig, with `extends` applied. */
export function tsconfigTargets(tsconfigPath: string): string[] {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const dir = resolve(tsconfigPath, '..');
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir);
  const options = parsed.options;
  const base = (options.pathsBasePath as string | undefined) ?? dir;
  const targets: string[] = [];
  if (options.baseUrl) targets.push(options.baseUrl);
  for (const list of Object.values(options.paths ?? {})) {
    for (const target of list) targets.push(resolve(base, target.replace(/\*.*$/, '')));
  }
  return targets;
}

/** Targets that fall outside every scanned root. */
export function outsideScanned(targets: readonly string[], roots: readonly string[]): string[] {
  return targets.filter(
    (target) =>
      !roots.some((root) => {
        const rel = relative(root, target);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep));
      }),
  );
}

export function readText(path: string): string {
  return readFileSync(join(path), 'utf8');
}

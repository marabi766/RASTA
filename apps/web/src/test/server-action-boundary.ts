import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import * as ts from 'typescript';

/**
 * A FAST LOCAL EARLY WARNING, not the authority. The authority on which modules define
 * server actions is the compiler's own manifest, checked after `next build` by
 * `scripts/check-server-action-coverage.mjs` (CI: "Server-action coverage"). Do not
 * extend this file for every new resolver path a review finds: the manifest already
 * catches what the build reaches.
 *
 * Discovery scans the web app and the whole directory of each workspace package it
 * depends on. This file states a few cheap, obvious ways a build could reach outside that
 * set, and reports each with "extend server-action discovery to <path> first".
 */

/** next.config properties that let the build compile or resolve sources outside the app. */
export const REACH_OPTIONS = [
  'transpilePackages',
  'externalDir',
  'webpack',
  'turbopack',
  'resolveAlias',
  'alias',
  // Another tsconfig than the one checked here / another place for the manifest. A fast
  // local alarm only: the EFFECTIVE value is the one the build itself recorded (scripts/build-layout.mjs).
  'tsconfigPath',
  'distDir',
] as const;

/** The only next.config file name the checks understand. */
export const NEXT_CONFIG_FILE = 'next.config.mjs';

/** Explicit allow-list for the options above: empty today. Add an entry only after extending discovery. */
export const ALLOWED_REACH: readonly string[] = [];

/**
 * Extensions the installed Next compiles as application code, read from its webpack rule
 * by structure: exactly `const codeCondition = { test: { or: [ /\.(a|b|…)$/, /__barrel_optimize__/ ] } }`.
 * Any other shape (a further branch, regex, call, spread or computed value) throws:
 * re-read the rule, then teach this function the new shape.
 */
export function nextCompiledExtensions(webpackConfigSource: string): string[] {
  const file = ts.createSourceFile(
    'webpack-config.js',
    webpackConfigSource,
    ts.ScriptTarget.Latest,
    false,
  );
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'codeCondition') found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const unsupported = (why: string): never => {
    throw new Error(`Next webpack rule codeCondition.test: ${why}: re-read it`);
  };
  if (found.length !== 1) return unsupported(`${found.length} declarations of codeCondition`);
  const init = found[0].initializer;
  if (!init || !ts.isObjectLiteralExpression(init)) return unsupported('not an object literal');
  const props = init.properties.filter(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'test',
  );
  if (props.length !== 1) return unsupported('no single `test` property');
  const test = props[0].initializer;
  if (!ts.isObjectLiteralExpression(test) || test.properties.length !== 1) {
    return unsupported('`test` is not exactly { or: [...] }');
  }
  const or = test.properties[0];
  if (
    !ts.isPropertyAssignment(or) ||
    !ts.isIdentifier(or.name) ||
    or.name.text !== 'or' ||
    !ts.isArrayLiteralExpression(or.initializer) ||
    or.initializer.elements.length !== 2
  ) {
    return unsupported('`or` is not an array of exactly two regular expressions');
  }
  const [extensions, barrel] = or.initializer.elements;
  if (!ts.isRegularExpressionLiteral(extensions) || !ts.isRegularExpressionLiteral(barrel)) {
    return unsupported('an element is not a regular expression literal');
  }
  if (barrel.text !== '/__barrel_optimize__/') return unsupported('second term changed');
  const match = /^\/\\\.\(([a-z]+(?:\|[a-z]+)*)\)\$\/$/.exec(extensions.text);
  if (!match) return unsupported('first term is not /\\.(ext|ext|…)$/');
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

/** Every `next.config.*` of the app: exactly `next.config.mjs` is understood, and it is checked. */
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

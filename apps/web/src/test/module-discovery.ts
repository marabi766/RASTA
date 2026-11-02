import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';

const SRC_ROOT = join(__dirname, '..');

/** Every shipped source module under `dirs`, recursively (no specs, test plumbing, fixtures or declarations). */
export function sourceModules(dirs: readonly string[]): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return entry === 'test' ? [] : walk(path);
        return /\.tsx?$/.test(entry) && !/\.(spec|test)\.|fixture|\.d\.ts$/.test(entry)
          ? [relative(SRC_ROOT, path).replace(/\.tsx?$/, '')]
          : [];
      });
  return dirs.flatMap((dir) => walk(join(SRC_ROOT, dir)));
}

export function fileOf(name: string): string {
  const file = ['.ts', '.tsx']
    .map((ext) => join(SRC_ROOT, name + ext))
    .find((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
  if (file === undefined) throw new Error(`no source for ${name}`);
  return file;
}

export const kindOf = (file: string): ts.ScriptKind =>
  file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/** A module's source as written. */
export function sourceOf(name: string): string {
  return readFileSync(fileOf(name), 'utf8');
}

/** A module's code without its comments (printed by TypeScript), so a doc comment naming a call is not a call. */
export function codeOf(name: string): string {
  const file = fileOf(name);
  const source = ts.createSourceFile(
    file,
    sourceOf(name),
    ts.ScriptTarget.Latest,
    false,
    kindOf(file),
  );
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

export function exportsOf(name: string): Record<string, unknown> {
  return jest.requireActual<Record<string, unknown>>(join(SRC_ROOT, name));
}

/**
 * Finds the portal modules a sweep must cover, instead of listing them: a new
 * command module is covered the day it exists, and a module nobody listed
 * cannot be the one that reads a message raw. The directories are searched
 * recursively (PR-439 r1 F4).
 *
 * A module is picked up when its code matches `marker`. `excluded` names a
 * module that matches but is deliberately not swept, with the reason; an
 * exclusion that no longer matches anything fails, so the list cannot rot.
 */
export function discoverModules(args: {
  readonly dirs: readonly string[];
  readonly marker: RegExp;
  readonly excluded?: Readonly<Record<string, string>>;
}): Array<{ readonly name: string; readonly exports: Record<string, unknown> }> {
  const excluded = args.excluded ?? {};
  const matched = sourceModules(args.dirs).filter((name) => args.marker.test(codeOf(name)));
  const stale = Object.keys(excluded).filter((name) => !matched.includes(name));
  if (stale.length > 0) throw new Error(`exclusion matches no module: ${stale.join(', ')}`);
  return matched
    .filter((name) => !Object.hasOwn(excluded, name))
    .map((name) => ({ name, exports: exportsOf(name) }));
}

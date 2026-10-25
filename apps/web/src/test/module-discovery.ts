import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Finds the portal modules a sweep must cover, instead of listing them: a new
 * command module is covered the day it exists, and a module nobody listed
 * cannot be the one that reads a message raw.
 *
 * A module is picked up when its source matches `marker` (a declaration the
 * sweep depends on, e.g. an exported `…FormSchema`). `excluded` names a module
 * that matches but is deliberately not swept, with the reason; an exclusion
 * that no longer matches anything fails, so the list cannot rot.
 */
export function discoverModules(args: {
  readonly dirs: readonly string[];
  readonly marker: RegExp;
  readonly excluded?: Readonly<Record<string, string>>;
}): Array<{ readonly name: string; readonly exports: Record<string, unknown> }> {
  const srcRoot = join(__dirname, '..');
  const excluded = args.excluded ?? {};
  const matched: string[] = [];
  for (const dir of args.dirs) {
    for (const entry of readdirSync(join(srcRoot, dir)).sort()) {
      if (!/\.tsx?$/.test(entry) || /\.(spec|test)\.|fixture|\.d\.ts$/.test(entry)) continue;
      const name = `${dir}/${entry.replace(/\.tsx?$/, '')}`;
      if (args.marker.test(readFileSync(join(srcRoot, dir, entry), 'utf8'))) matched.push(name);
    }
  }
  const stale = Object.keys(excluded).filter((name) => !matched.includes(name));
  if (stale.length > 0) throw new Error(`exclusion matches no module: ${stale.join(', ')}`);
  return matched
    .filter((name) => !(name in excluded))
    .map((name) => ({
      name,
      exports: jest.requireActual<Record<string, unknown>>(join(srcRoot, name)),
    }));
}

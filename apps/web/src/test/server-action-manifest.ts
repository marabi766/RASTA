import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  actionKey,
  actionLabel,
  assertPlainExportName,
  assertPlainModulePath,
  printable,
} from './server-action-discovery.ts';

/**
 * The compiler is the authority on which modules define server actions: `next build`
 * writes every one it compiled to `<distDir>/server/server-reference-manifest.json`
 * (`next/dist/build/webpack/plugins/flight-client-entry-plugin.js`, emitAsset of
 * SERVER_REFERENCE_MANIFEST). This file reads that manifest and nothing else; it
 * has no resolver of its own, so it cannot disagree with the build about what was reached.
 *
 * Scope: it proves refusal coverage of server actions only. It says nothing about money,
 * tenancy or replay.
 *
 * It never reports the manifest's content (`encryptionKey` is in it): only paths and export
 * names, with every control character escaped. An export name must be a plain identifier or
 * `default` (the same rule discovery and the refusal spec apply: `assertPlainExportName`);
 * a module path may be an ordinary path but never contains a control character.
 */

/** Where Next writes the manifest, relative to the web project directory. */
export const MANIFEST_PATH = '.next/server/server-reference-manifest.json';

/**
 * Next writes `filename` as `path.posix.relative(projectDir, module)` with
 * `projectDir = path.join(appDir, '..')` (flight-client-entry-plugin.js), and finds
 * `appDir` as `./app` before `./src/app` (`next/dist/lib/find-pages-dir.js`). So the
 * names are relative to `src` in this app, not to the web project directory.
 */
export function nextProjectDir(webDir: string): string {
  if (existsSync(join(webDir, 'app'))) return webDir;
  if (existsSync(join(webDir, 'src', 'app'))) return join(webDir, 'src');
  throw new Error('no app directory (./app or ./src/app) in the web project');
}

export interface CompiledAction {
  /** Repo-relative real path of the module. */
  readonly module: string;
  readonly exportedName: string;
}

export interface Compiled {
  readonly actions: CompiledAction[];
  /** Why the manifest cannot be trusted; empty when `actions` is the whole truth. */
  readonly problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every action of the manifest, per entry; any malformed entry is a problem even if others are fine. */
export function compiledActions(
  manifestText: string | null,
  projectDir: string,
  repoRoot: string,
): Compiled {
  const problems: string[] = [];
  const actions: CompiledAction[] = [];
  if (manifestText === null) {
    return { actions, problems: [`${MANIFEST_PATH}: missing, run the web build first`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    // The parser's message quotes the text: report a fixed sentence instead.
    return { actions, problems: [`${MANIFEST_PATH}: not valid JSON`] };
  }
  if (!isRecord(parsed)) {
    return { actions, problems: [`${MANIFEST_PATH}: unknown shape (not an object)`] };
  }
  const root = realpathSync(repoRoot);
  for (const kind of ['node', 'edge'] as const) {
    const map = parsed[kind];
    if (!isRecord(map)) {
      problems.push(`${MANIFEST_PATH}: "${kind}" is missing or not a record: unknown shape`);
      continue;
    }
    let index = 0;
    for (const entry of Object.values(map)) {
      index += 1;
      const at = `${kind} entry ${index}`;
      if (!isRecord(entry)) {
        problems.push(`${at}: unknown record shape`);
        continue;
      }
      const { filename, exportedName } = entry;
      // Nothing from the manifest is interpolated before it is known to be plain.
      try {
        assertPlainModulePath(filename);
      } catch {
        problems.push(`${at}: filename missing, empty or containing a control character`);
        continue;
      }
      try {
        assertPlainExportName(exportedName, '');
      } catch {
        problems.push(
          `${at} (${printable(filename)}): export name is not a plain identifier or default`,
        );
        continue;
      }
      let real: string;
      try {
        real = realpathSync(resolve(projectDir, filename));
      } catch {
        problems.push(`${actionLabel(filename, exportedName)}: file does not exist`);
        continue;
      }
      const rel = relative(root, real);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        problems.push(`${actionLabel(filename, exportedName)}: resolves outside the repository`);
        continue;
      }
      actions.push({ module: rel, exportedName });
    }
  }
  if (problems.length === 0 && actions.length === 0) {
    problems.push(`${MANIFEST_PATH}: no server action at all (empty), refusing to pass`);
  }
  return { actions, problems };
}

/**
 * The compiled actions the refusal cases do not cover, as display labels. `covered` holds
 * the `actionKey`s (the JSON of `[module, export]`) of the pairs the cases exercise; the
 * comparison is on keys and never on labels.
 */
export function uncovered(
  compiled: readonly CompiledAction[],
  covered: ReadonlySet<string>,
): string[] {
  return [
    ...new Set(
      compiled
        .filter(({ module, exportedName }) => !covered.has(actionKey(module, exportedName)))
        .map(({ module, exportedName }) => actionLabel(module, exportedName)),
    ),
  ].sort();
}

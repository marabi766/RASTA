import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Fails a spec that reads a file outside this package which `turbo.json` does
 * not list as a test input.
 *
 * ## Why
 *
 * The contract specs read other packages' source as text (`labels.contract`,
 * `asset-commands.contract`, …). Turbo caches a green `test` run by hashing the
 * task's inputs, and a file outside `apps/web` is not one of them unless it is
 * named in `apps/web/turbo.json`. Unlisted, a change to the service replays a
 * cached green for the one test meant to catch it. The list used to be
 * maintained by hand and had silently fallen behind (the repair-order specs
 * read eight maintenance-service files it did not name).
 *
 * ## How
 *
 * `fs.readFileSync` is wrapped once per worker and every path it is asked for is
 * recorded; after each spec file, anything under the repository but outside
 * `apps/web`, `node_modules`, a build output (`dist`) or a `package.json` must be
 * named, exactly or by a `dir/**` entry, in the `test` inputs. The wrapper only
 * observes: every call reaches the real function unchanged.
 *
 * Only `readFileSync` is watched, because that is what the specs use. A spec
 * that read another way would not be seen; the negative control in
 * `turbo-config.spec.ts` shows the check itself works.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WEB_ROOT = path.join(REPO_ROOT, 'apps', 'web');

const TRACKER = Symbol.for('rasta.web.turbo-inputs-guard');
type Tracker = { reads: Set<string> };

function tracker(): Tracker {
  const holder = fs as unknown as Record<symbol, Tracker | undefined>;
  const existing = holder[TRACKER];
  if (existing) return existing;

  const created: Tracker = { reads: new Set() };
  holder[TRACKER] = created;
  const original = fs.readFileSync;
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = function (
    this: unknown,
    ...args: Parameters<typeof fs.readFileSync>
  ) {
    const target = args[0];
    if (typeof target === 'string' && path.isAbsolute(target)) created.reads.add(target);
    return original.apply(this, args);
  } as typeof fs.readFileSync;
  return created;
}

/** Whether the cache must know about this file: part of the repository, not this package, not generated. */
export function isOutsideInput(file: string): boolean {
  if (!file.startsWith(REPO_ROOT + path.sep)) return false;
  if (file === WEB_ROOT || file.startsWith(WEB_ROOT + path.sep)) return false;
  const relative = path.relative(REPO_ROOT, file).split(path.sep);
  if (relative.includes('node_modules') || relative.includes('dist') || relative[0] === '.git') {
    return false;
  }
  // Resolution metadata, not content a spec pins.
  return path.basename(file) !== 'package.json';
}

/** The `test` task's declared inputs, as repository-relative paths (`dir/**` kept as written). */
export function declaredTestInputs(): string[] {
  const text = readFileSync(path.join(WEB_ROOT, 'turbo.json'), 'utf8')
    // JSONC: whole-line comments only, which is all this file uses.
    .replace(/^\s*\/\/.*$/gm, '');
  const config = JSON.parse(text) as { tasks: Record<string, { inputs?: string[] }> };
  return (config.tasks.test?.inputs ?? [])
    .filter((entry) => entry.startsWith('$TURBO_ROOT$/'))
    .map((entry) => entry.slice('$TURBO_ROOT$/'.length));
}

export function isDeclared(file: string, declared: readonly string[]): boolean {
  const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  return declared.some((entry) =>
    entry.endsWith('/**') ? relative.startsWith(entry.slice(0, -2)) : relative === entry,
  );
}

/** What was read outside this package since the last call, and is not declared. */
export function undeclaredReads(reads: Iterable<string>): string[] {
  const declared = declaredTestInputs();
  return [...new Set(reads)]
    .filter(isOutsideInput)
    .filter((file) => !isDeclared(file, declared))
    .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
    .sort();
}

export function installTurboInputsGuard(): void {
  const seen = tracker();
  beforeAll(() => {
    seen.reads.clear();
  });
  afterAll(() => {
    const missing = undeclaredReads(seen.reads);
    if (missing.length > 0) {
      throw new Error(
        'This spec read files outside apps/web that apps/web/turbo.json does not list as `test` ' +
          'inputs, so a change to them would replay a cached green:\n  ' +
          missing.join('\n  ') +
          '\nAdd them to both "test" and "test:unit" inputs in apps/web/turbo.json.',
      );
    }
  });
}

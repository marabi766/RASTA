import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * ## What is watched
 *
 * The read APIs a spec can use to get a file's content, each wrapped once per
 * worker so that every call still reaches the real function unchanged:
 * `readFileSync`, `readFile`, `openSync`, `open`, `createReadStream`,
 * `promises.readFile` and `promises.open` (`node:fs/promises` is the same
 * object as `fs.promises`, so both import styles are seen). A path is taken as
 * a string, a `Buffer` or a `file:` URL, resolved against the working directory
 * as `fs` itself resolves it, and also followed through symlinks, so a relative
 * path, a `..` path and a link inside the package that points out of it are all
 * judged by where they really lead.
 *
 * ## When it is checked
 *
 * Tracking is reset when this file runs, which is **before the spec file's own
 * module is loaded**, and nothing is cleared afterwards. Both matter: the
 * contract specs read their pins at module level
 * (`const dto = parse(read('dto.ts'))`), which happens before any `beforeAll`,
 * and a reset there would forget exactly those reads. Everything read from the
 * moment the spec starts loading until its last test has run is judged in
 * `afterAll`.
 *
 * `turbo-inputs-guard.integration.spec.ts` proves each route, and the
 * module-load case, by running real specs through this guard in a child jest.
 *
 * ## What is not
 *
 * Files pulled in by `require`/`import` (jest loads those through its own
 * module system, not through these functions; workspace packages come in
 * through their built output, which turbo already tracks as a dependency), and
 * directory listings or existence checks, which do not read content.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WEB_ROOT = path.join(REPO_ROOT, 'apps', 'web');
/** The repository's real location: a checkout reached through a symlink must not hide files from the check. */
const REAL_REPO_ROOT = safeRealpath(REPO_ROOT) ?? REPO_ROOT;

function safeRealpath(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

const TRACKER = Symbol.for('rasta.web.turbo-inputs-guard');
type Tracker = { reads: Set<string> };

/** Every absolute location a path argument can mean: as given, resolved, and followed through links. */
function locationsOf(target: unknown): string[] {
  let text: string | null = null;
  if (typeof target === 'string') text = target;
  else if (target instanceof URL) text = target.protocol === 'file:' ? fileURLToPath(target) : null;
  else if (Buffer.isBuffer(target)) text = target.toString();
  if (text === null || text === '') return [];

  const resolved = path.resolve(process.cwd(), text);
  const real = safeRealpath(resolved);
  return real !== null && real !== resolved ? [resolved, real] : [resolved];
}

function record(reads: Set<string>, target: unknown): void {
  try {
    for (const location of locationsOf(target)) reads.add(location);
  } catch {
    // Observing must never change what a read does.
  }
}

type Fn = (...args: never[]) => unknown;

/** Replaces `owner[name]` with a function that notes the first argument and then calls the original. */
function watch(owner: object, name: string, reads: Set<string>): void {
  const holder = owner as Record<string, Fn | undefined>;
  const original = holder[name];
  if (typeof original !== 'function') return;
  holder[name] = function (this: unknown, ...args: never[]) {
    record(reads, args[0]);
    return original.apply(this, args);
  };
}

function tracker(): Tracker {
  const holder = fs as unknown as Record<symbol, Tracker | undefined>;
  const existing = holder[TRACKER];
  if (existing) return existing;

  const created: Tracker = { reads: new Set() };
  holder[TRACKER] = created;
  for (const name of [
    'readFileSync',
    'readFile',
    'openSync',
    'open',
    'createReadStream',
  ] as const) {
    watch(fs, name, created.reads);
  }
  for (const name of ['readFile', 'open'] as const) watch(fs.promises, name, created.reads);
  return created;
}

/** `file` relative to the repository, whichever way the repository is spelled; `null` outside it. */
function repoRelative(file: string): string[] | null {
  for (const root of [REPO_ROOT, REAL_REPO_ROOT]) {
    if (file === root) return [];
    if (file.startsWith(root + path.sep)) return path.relative(root, file).split(path.sep);
  }
  return null;
}

/** Whether the cache must know about this file: part of the repository, not this package, not generated. */
export function isOutsideInput(file: string): boolean {
  const relative = repoRelative(file);
  if (relative === null || relative.length === 0) return false;
  if (relative[0] === 'apps' && relative[1] === 'web') return false;
  if (relative.includes('node_modules') || relative.includes('dist') || relative[0] === '.git') {
    return false;
  }
  // Resolution metadata, not content a spec pins.
  return path.basename(file) !== 'package.json';
}

/** The `test` task's declared inputs, as repository-relative paths (`dir/**` kept as written). */
export function declaredTestInputs(): string[] {
  const text = fs
    .readFileSync(path.join(WEB_ROOT, 'turbo.json'), 'utf8')
    // JSONC: whole-line comments only, which is all this file uses.
    .replace(/^\s*\/\/.*$/gm, '');
  const config = JSON.parse(text) as { tasks: Record<string, { inputs?: string[] }> };
  return (config.tasks.test?.inputs ?? [])
    .filter((entry) => entry.startsWith('$TURBO_ROOT$/'))
    .map((entry) => entry.slice('$TURBO_ROOT$/'.length));
}

export function isDeclared(file: string, declared: readonly string[]): boolean {
  const relative = (repoRelative(file) ?? []).join('/');
  return declared.some((entry) =>
    entry.endsWith('/**') ? relative.startsWith(entry.slice(0, -2)) : relative === entry,
  );
}

/** What was read outside this package and is not declared, as repository-relative paths. */
export function undeclaredReads(reads: Iterable<string>): string[] {
  const declared = declaredTestInputs();
  return [...new Set(reads)]
    .filter(isOutsideInput)
    .filter((file) => !isDeclared(file, declared))
    .map((file) => (repoRelative(file) ?? []).join('/'))
    .sort();
}

export function installTurboInputsGuard(): void {
  const seen = tracker();
  // Now, not in `beforeAll`: this runs before the spec's own module loads, so
  // reads made while it loads are kept (see the header).
  seen.reads.clear();

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

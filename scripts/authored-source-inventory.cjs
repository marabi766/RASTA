'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: Jest specs and .mjs checks share it */
// The one way a check enumerates the files this repository AUTHORS (FU-102).
//
// Git-ignored output (`generated` Prisma clients, `node_modules`, build output, `.next.build-lock*`)
// is rewritten by other tasks while a check runs: a directory listed a moment ago can be gone
// (ENOENT) before it is read. A check that walked it died on a file nobody wrote. The inventory
// never OPENS such a directory, so there is nothing to race. What it does list is authored, so a
// listed file or directory that is then missing is a real fault and still throws. CommonJS so Jest
// specs (`require`) and the `.mjs` checks (`import`) share it.
//
// ONE exclusion policy, and git itself applies it: the repository's own `.gitignore` (the root file
// and any nested one). This file does NOT re-implement git's pattern language (a hand matcher
// disagreed with git on UTF-8 names, newlines in paths, byte semantics and `!` re-inclusion, PR #772
// r1). It asks `git ls-files --cached --others --exclude-standard -z`, which reads the working tree
// but does not open an ignored directory, and takes its NUL-separated BYTES as the paths (a name that
// is not UTF-8 is refused, never mangled). A tree outside the repository (a test's temporary tree)
// is judged by the same git against a throwaway empty git directory, with the repository's
// `.gitignore` as its excludes file. Anything git does not answer cleanly (a failure, a warning on
// stderr such as an unreadable directory, a nested repository) throws.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { TextDecoder } = require('node:util');
const { join, relative, resolve, sep, isAbsolute } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const DECODER = new TextDecoder('utf-8', { fatal: true }); // from node:util: a jsdom Jest environment has no global

const inside = (base, path) => {
  const rel = relative(base, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Runs git with this repository's `.gitignore` as the excludes file and no inherited repository. */
function git(scope, args, input) {
  fs.accessSync(join(REPO_ROOT, '.gitignore'), fs.constants.R_OK); // git silently skips a missing excludes file
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
    delete env[name];
  const result = spawnSync(
    'git',
    [
      ...scope,
      ...(args[0] === 'ls-files' ? ['--literal-pathspecs'] : []), // check-ignore reads a path, no globs
      '-c',
      `core.excludesFile=${join(REPO_ROOT, '.gitignore')}`,
      ...args,
    ],
    { env, input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (result.error) throw result.error;
  const warnings = result.stderr.toString('utf8').trim();
  if ((result.status !== 0 && !(args[0] === 'check-ignore' && result.status === 1)) || warnings)
    throw new Error(`git ${args[0]} failed (${result.status}): ${warnings}`);
  return { status: result.status, out: result.stdout };
}
const names = (buffer) => {
  const parts = [];
  for (let from = 0; from < buffer.length;) {
    const end = buffer.indexOf(0, from);
    if (end < 0) throw new Error('git printed a path without its NUL terminator');
    parts.push(DECODER.decode(buffer.subarray(from, end)));
    from = end + 1;
  }
  return parts;
};
const compareNames = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** The order of a depth-first walk that sorts every directory's entries by name. */
function compareWalk(a, b) {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const order = compareNames(left[i], right[i]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

/** A work tree with its own `.git` is listed as that repository; any other tree against an empty throwaway git directory. */
const isRepository = (base) => resolve(base) === REPO_ROOT || fs.existsSync(join(base, '.git'));
function withGit(base, body) {
  if (isRepository(base)) return body(['-C', base]);
  const empty = fs.mkdtempSync(join(tmpdir(), 'authored-inventory-git-'));
  try {
    const init = spawnSync('git', ['init', '-q', '--bare', empty], { stdio: 'pipe' });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    return body([`--git-dir=${empty}`, `--work-tree=${base}`]);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

/**
 * Absolute paths of every authored file under `dir`, sorted: what git lists as tracked or as
 * untracked-and-not-ignored (git never lists its own `.git`). `skip(name)` drops a path when any name below `dir`
 * satisfies it. `optional` lets a `dir` that does not exist yield [] (a workspace without `src`);
 * anything else that cannot be read throws, and so does a `dir` that is itself ignored output.
 * `base` is the directory the .gitignore paths are relative to: the repository root, which is the
 * default for a `dir` inside it; a `dir` elsewhere (a test's temporary tree) is its own base unless
 * the caller names one that holds it. A symbolic link to a directory is not a file and is not listed.
 */
function authoredFiles(dir, { skip, optional = false, base: given } = {}) {
  const top = resolve(dir);
  const base = given ? resolve(given) : inside(REPO_ROOT, top) ? REPO_ROOT : top;
  if (!inside(base, top)) throw new Error(`${top} is not inside its base ${base}`);
  try {
    if (!fs.statSync(top).isDirectory())
      throw Object.assign(new Error(`ENOTDIR: ${top}`), { code: 'ENOTDIR' });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return [];
    throw error;
  }
  const spec = relative(base, top) || '.';
  const listed = withGit(base, (scope) => {
    if (
      spec !== '.' &&
      git(
        scope,
        ['check-ignore', '--no-index', '-z', '--stdin'],
        `${spec.startsWith(':') ? `./${spec}` : spec}\0`,
      ).status === 0
    )
      throw Object.assign(new Error(`${top} is git-ignored output, not authored source`), {
        code: 'EIGNORED',
      });
    const gone = new Set(
      isRepository(base) ? names(git(scope, ['ls-files', '-z', '--deleted', '--', spec]).out) : [],
    );
    return names(
      git(scope, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', spec]).out,
    ).filter((path) => !gone.has(path));
  });
  const depth = relative(base, top) === '' ? 0 : relative(base, top).split(sep).length;
  const files = [];
  for (const path of listed.sort(compareWalk)) {
    if (path.endsWith('/'))
      throw new Error(`${join(base, path)} is a nested repository: its files are not listed`);
    const parts = path.split('/');
    if (typeof skip === 'function' && parts.slice(depth).some((name) => skip(name))) continue;
    const full = join(base, ...parts);
    try {
      if (fs.lstatSync(full).isSymbolicLink() && fs.statSync(full).isDirectory()) continue;
    } catch {
      // gone, or a dangling link: whoever reads it decides (a vanished authored file is a real fault)
    }
    files.push(full);
  }
  return files;
}

module.exports = { authoredFiles };

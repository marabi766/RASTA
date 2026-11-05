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
// ONE exclusion policy: the repository's own `.gitignore`, read at the time of the call, with git's
// own rules (wildcards, `**`, anchored path patterns, trailing-slash directory patterns, `!`
// exceptions, last match wins). A pattern shape this reader does not know throws, never guesses.
const fs = require('node:fs'); // members read at call time: a test watches which directories are opened
const { basename, dirname, join, relative, resolve, sep, isAbsolute } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');

/** One character class `[...]` of a gitignore glob, as a RegExp class (or undefined if unclosed). */
function characterClass(glob, start) {
  let end = start + 1;
  if (glob[end] === '!' || glob[end] === '^') end += 1;
  if (glob[end] === ']') end += 1;
  while (end < glob.length && glob[end] !== ']') end += 1;
  if (end >= glob.length) return undefined;
  const body = glob.slice(start + 1, end);
  if (body.includes('[:') || body.includes('[=') || body.includes('[.'))
    throw new Error(`.gitignore: unsupported character class ${glob.slice(start, end + 1)}`);
  const negate = body[0] === '!' || body[0] === '^';
  const inner = (negate ? body.slice(1) : body).replace(/[\\^]/g, '\\$&');
  return { end, source: `[${negate ? '^/' : ''}${inner}]` };
}

/** A gitignore glob (no leading `!`, no trailing `/`) as a RegExp source over a `/` path. */
function globSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '\\') {
      i += 1;
      if (i >= glob.length) throw new Error('.gitignore: a pattern ends in a backslash');
      out += glob[i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else if (c === '*' && glob[i + 1] === '*') {
      const before = i === 0 || glob[i - 1] === '/';
      const after = glob[i + 2];
      if (before && after === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else if (before && after === undefined) {
        out += '.+';
        i += 1;
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const cls = characterClass(glob, i);
      if (cls) {
        out += cls.source;
        i = cls.end;
      } else out += '\\[';
    } else out += c.replace(/[.+^${}()|\]/]/g, '\\$&');
  }
  return out;
}

/**
 * `.gitignore` text as `(path, isDirectory) => ignored`. `path` is `/`-separated and relative to
 * the directory that holds the `.gitignore`. The caller never descends into an ignored directory,
 * so a path is judged by its own name and place, last matching pattern wins.
 */
function ignoreMatcher(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(?<!\\)\s+$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    let glob = negate ? line.slice(1) : line;
    const directoryOnly = glob.endsWith('/');
    if (directoryOnly) glob = glob.slice(0, -1);
    const anchored = glob.includes('/');
    if (glob.startsWith('/')) glob = glob.slice(1);
    if (glob === '') throw new Error(`.gitignore: empty pattern in ${JSON.stringify(raw)}`);
    rules.push({
      negate,
      directoryOnly,
      anchored,
      regex: new RegExp(`^${globSource(glob)}$`),
    });
  }
  return (path, isDirectory) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    let ignored = false;
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.regex.test(rule.anchored ? path : name)) ignored = !rule.negate;
    }
    return ignored;
  };
}

// Read on every call: the policy is whatever .gitignore says now, and an unreadable one throws.
const repositoryMatcher = () =>
  ignoreMatcher(fs.readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8'));
const inside = (base, path) => {
  const rel = relative(base, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const posix = (path) => path.split(sep).join('/');
const comparator = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function isDirectory(entry, path) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path).isDirectory(); // a linked `node_modules` is never opened either
  } catch {
    return false;
  }
}

/**
 * Absolute paths of every authored file under `dir`, sorted: not git-ignored (see above) and not
 * `.git`. `skip(name)` prunes further directories (and files) by name before they are opened.
 * `optional` lets a `dir` that does not exist yield [] (a workspace without `src`); anything else
 * that cannot be read throws, and so does a `dir` that is itself ignored output. `base` is the
 * directory the .gitignore paths are relative to (`src/generated` is `<base>/…/src/generated`): the
 * repository root, which is the default for a `dir` inside it; a `dir` elsewhere (a test's temporary
 * tree) is its own base unless the caller names one that holds it.
 */
function authoredFiles(dir, { skip, optional = false, base: given } = {}) {
  const top = resolve(dir);
  const base = given ? resolve(given) : inside(REPO_ROOT, top) ? REPO_ROOT : top;
  if (!inside(base, top)) throw new Error(`${top} is not inside its base ${base}`);
  const ignored = repositoryMatcher();
  const isIgnored = (path, directory) =>
    basename(path) === '.git' || ignored(posix(relative(base, path)), directory);
  for (let up = top; up !== base; up = dirname(up)) {
    if (isIgnored(up, true))
      throw Object.assign(new Error(`${up} is git-ignored output, not authored source`), {
        code: 'EIGNORED',
      });
  }
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (optional && current === top && error?.code === 'ENOENT') return [];
      throw error;
    }
    return entries.sort(comparator).flatMap((entry) => {
      const path = join(current, entry.name);
      if (
        isIgnored(path, isDirectory(entry, path)) ||
        (typeof skip === 'function' && skip(entry.name))
      )
        return [];
      return entry.isDirectory() ? walk(path) : [path];
    });
  };
  return walk(top);
}

module.exports = { authoredFiles, ignoreMatcher };

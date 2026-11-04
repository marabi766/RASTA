/**
 * The one reader of `pnpm-workspace.yaml` for the repository's guards (FU-028).
 *
 * A guard that must visit "every workspace" used to spell the roots out
 * (`['apps', 'services', 'packages', 'tests']`), so a root added to the
 * workspace file was silently never checked. Membership comes from here:
 *
 *   workspaceManifestFiles(root)  relative `package.json` paths of every member
 *   workspaceDirectories(root)    the same, as relative directories
 *
 * Fail closed: a missing or unreadable file, a document that is not a mapping,
 * a `packages` entry that is not a nonempty list of relative globs inside the
 * repository, or a member whose manifest cannot be told apart from a stranger
 * throws. Whatever cannot be proven a workspace member is never guessed at, and
 * an empty answer is an error, not "no workspaces".
 *
 * The repository root is not a member: pnpm includes it implicitly and it
 * orchestrates, never shards. `node_modules` and dot-directories are never matched
 * by `*` (pnpm's rule); a symlink or an unreadable manifest format is refused.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The only pattern segments this reader understands: a plain directory name or
 * a lone `*`. pnpm accepts far more (`**`, braces, extglobs such as `!(apps)`,
 * character classes, ...); a form that is not implemented here is REFUSED, never
 * approximated, because a guess returns a shorter membership list without an error.
 */
const SEGMENT = /^(?:\*|[A-Za-z0-9_-][A-Za-z0-9._-]*)$/;

/** The only manifest this reader can read; pnpm also discovers the other two. */
const MANIFEST = 'package.json';
const OTHER_MANIFESTS = ['package.yaml', 'package.json5'];

/** The validated `packages` globs, exclusions (`!…`) included. */
export function workspacePatterns(root = REPOSITORY_ROOT) {
  const patterns = parseYaml(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('pnpm-workspace.yaml must declare nonempty packages');
  }
  for (const pattern of patterns) {
    if (
      typeof pattern !== 'string' ||
      isAbsolute(pattern.replace(/^!/, '')) ||
      !pattern
        .replace(/^!/, '')
        .split('/')
        .every((segment) => SEGMENT.test(segment))
    ) {
      throw new Error(
        `unsupported workspace package pattern ${JSON.stringify(pattern)}: ` +
          'only relative paths of plain names and "*" segments (optionally prefixed "!") are understood',
      );
    }
  }
  return patterns;
}

/** Relative directories a supported pattern selects; refuses what it cannot vouch for. */
function directoriesOf(root, pattern) {
  let level = [''];
  for (const segment of pattern.split('/')) {
    const next = [];
    for (const parent of level) {
      const names =
        segment === '*'
          ? readdirSync(resolve(root, parent)).filter(
              (name) => name !== 'node_modules' && !name.startsWith('.'),
            )
          : [segment];
      for (const name of names) {
        const relative = parent ? `${parent}/${name}` : name;
        const stat = lstatSync(resolve(root, relative), { throwIfNoEntry: false });
        if (stat === undefined) continue;
        if (stat.isSymbolicLink()) {
          throw new Error(
            `workspace candidate ${relative} is a symbolic link: not followed, not guessed`,
          );
        }
        if (stat.isDirectory()) next.push(relative);
      }
    }
    level = next;
  }
  return level;
}

/** A candidate directory's manifest: `package.json`, nothing, or a refusal. */
function manifestOf(root, directory) {
  const foreign = OTHER_MANIFESTS.filter((name) => existsSync(resolve(root, directory, name)));
  if (foreign.length > 0) {
    throw new Error(
      `workspace candidate ${directory} has ${foreign.join(', ')}: only ${MANIFEST} is read`,
    );
  }
  return existsSync(resolve(root, directory, MANIFEST)) ? `${directory}/${MANIFEST}` : undefined;
}

/** Relative `package.json` paths of every workspace member, sorted. */
export function workspaceManifestFiles(root = REPOSITORY_ROOT) {
  const patterns = workspacePatterns(root);
  const excluded = new Set(
    patterns.filter((p) => p.startsWith('!')).flatMap((p) => directoriesOf(root, p.slice(1))),
  );
  const members = patterns
    .filter((p) => !p.startsWith('!'))
    .flatMap((p) => directoriesOf(root, p))
    .filter((directory) => !excluded.has(directory))
    .map((directory) => manifestOf(root, directory))
    .filter((file) => file !== undefined);
  const sorted = [...new Set(members)].sort();
  if (sorted.length === 0) throw new Error('pnpm-workspace.yaml matched no workspace member');
  return sorted;
}

/** Relative directory of every workspace member, sorted (`services/foo`). */
export function workspaceDirectories(root = REPOSITORY_ROOT) {
  return workspaceManifestFiles(root).map((file) => dirname(file));
}

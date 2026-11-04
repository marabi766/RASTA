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
 * orchestrates, never shards. `node_modules` is never a member.
 */
import { globSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The validated `packages` globs, exclusions (`!…`) included. */
export function workspacePatterns(root = REPOSITORY_ROOT) {
  const patterns = parseYaml(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('pnpm-workspace.yaml must declare nonempty packages');
  }
  for (const pattern of patterns) {
    if (
      typeof pattern !== 'string' ||
      pattern.replace(/^!/, '').length === 0 ||
      isAbsolute(pattern.replace(/^!/, '')) ||
      pattern.includes('..') ||
      pattern.includes('\\')
    ) {
      throw new Error('workspace package patterns must be relative globs inside the repository');
    }
  }
  return patterns;
}

/** Relative `package.json` paths of every workspace member, sorted. */
export function workspaceManifestFiles(root = REPOSITORY_ROOT) {
  const patterns = workspacePatterns(root);
  const manifests = globSync(
    patterns
      .filter((pattern) => !pattern.startsWith('!'))
      .map((pattern) => `${pattern}/package.json`),
    {
      cwd: root,
      exclude: [
        '**/node_modules/**',
        ...patterns
          .filter((pattern) => pattern.startsWith('!'))
          .map((pattern) => `${pattern.slice(1)}/package.json`),
      ],
    },
  );
  const members = [...new Set(manifests)]
    .filter((file) => resolve(root, file) !== resolve(root, 'package.json'))
    .sort();
  if (members.length === 0) throw new Error('pnpm-workspace.yaml matched no workspace member');
  return members;
}

/** Relative directory of every workspace member, sorted (`services/foo`). */
export function workspaceDirectories(root = REPOSITORY_ROOT) {
  return workspaceManifestFiles(root).map((file) => dirname(file).split('\\').join('/'));
}

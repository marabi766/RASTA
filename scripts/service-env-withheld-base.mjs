#!/usr/bin/env node
/**
 * The revision CI compares scripts/service-env-turbo-withheld.json with
 * (scripts/service-env-turbo.test.mjs, SERVICE_ENV_WITHHELD_BASE): the list as
 * main had it before the change under test.
 *
 *   pull_request  HEAD is the synthetic merge commit; its first parent is the
 *                 branch it merges into. A HEAD that is not a merge fails: its
 *                 first parent would be the pull request's own commit.
 *   push          github.event.before, the main the push replaced — not
 *                 HEAD^1, which on a push of A..C is C's parent B, a commit of
 *                 the same push (Codex r1 on #316). Fetched when the shallow
 *                 checkout lacks it. An empty or all-zero before (no previous
 *                 main) or one the remote no longer has fails.
 *
 * Any other event fails. Failing blocks the run: an unknown base would compare
 * the list with itself and pass.
 *
 * Prints the base commit. Settings: GITHUB_EVENT_NAME (set by Actions),
 * SERVICE_ENV_WITHHELD_PUSH_BEFORE (`${{ github.event.before }}`).
 * Exit 2 when no base can be chosen.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const BASELINE_FILE = 'scripts/service-env-turbo-withheld.json';

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;

function gitIn(cwd) {
  return (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/** The commit `rev` names in `cwd`, or null when it does not resolve to one here. */
function commitOf(git, rev) {
  const run = git('rev-parse', '--verify', '--quiet', `${rev}^{commit}`);
  return run.status === 0 ? run.stdout.trim() : null;
}

/** The base commit for `event` in the checkout at `cwd`; throws when there is none. */
export function withheldBase({ event, before, cwd, remote = 'origin' }) {
  const git = gitIn(cwd);
  if (event === 'pull_request') {
    const base = commitOf(git, 'HEAD^1');
    if (!base || !commitOf(git, 'HEAD^2')) {
      throw new Error(
        'HEAD is not a pull request merge commit with both parents fetched: its first parent is not the base branch',
      );
    }
    return base;
  }
  if (event === 'push') {
    if (!before || ZERO_SHA.test(before)) {
      throw new Error(
        `the push names no previous main (github.event.before "${before ?? ''}"): nothing to compare the withheld list with`,
      );
    }
    if (!SHA.test(before)) throw new Error(`github.event.before "${before}" is not a commit id`);
    if (!commitOf(git, before)) {
      const fetch = git('fetch', '--no-tags', '--depth=1', remote, before);
      if (fetch.status !== 0) {
        throw new Error(
          `cannot fetch the previous main ${before} from ${remote}: ${fetch.stderr.trim()}`,
        );
      }
    }
    const base = commitOf(git, before);
    if (!base)
      throw new Error(`the previous main ${before} is not a commit here after fetching it`);
    return base;
  }
  throw new Error(`no withheld-list base for event "${event ?? ''}" (pull_request or push only)`);
}

/** A withheld list, as `service task SETTING` entries. */
export function flatten(listed) {
  const entries = [];
  for (const [service, settings] of Object.entries(listed)) {
    if (service.startsWith('$')) continue;
    for (const [name, tasks] of Object.entries(settings)) {
      for (const task of tasks) entries.push(`${service} ${task} ${name}`);
    }
  }
  return entries;
}

/**
 * The list at revision `rev` of the repository at `cwd`, or null when `rev`
 * does not resolve to a commit. A commit without the file lists nothing.
 */
export function listedAt(rev, cwd) {
  const git = gitIn(cwd);
  const commit = commitOf(git, rev);
  if (!commit) return null;
  const file = git('show', `${commit}:${BASELINE_FILE}`);
  return { commit, entries: file.status === 0 ? flatten(JSON.parse(file.stdout)) : [] };
}

/** The entries of `listed` that `base` does not list: growth, or a replacement's new half. */
export function notListedIn(listed, base) {
  const known = new Set(base);
  return listed.filter((entry) => !known.has(entry));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const base = withheldBase({
      event: process.env.GITHUB_EVENT_NAME,
      before: process.env.SERVICE_ENV_WITHHELD_PUSH_BEFORE,
      cwd: process.cwd(),
    });
    process.stdout.write(`${base}\n`);
  } catch (error) {
    process.stderr.write(`service-env-withheld-base: ${error.message}\n`);
    process.exit(2);
  }
}

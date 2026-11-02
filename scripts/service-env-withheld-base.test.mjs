// The base CI compares the withheld-settings list with
// (scripts/service-env-withheld-base.mjs), against real git histories: a
// remote, and a shallow CI-like checkout of it. Codex r1 on #316: a push of
// A..C was compared with HEAD^1 = B, so a list grown in B passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SENTINELS, assertNoSentinel } from './refusal-probes.mjs';
import {
  BASELINE_FILE,
  listedAt,
  notListedIn,
  withheldBase,
} from './service-env-withheld-base.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'service-env-withheld-base.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function commitList(cwd, listed, message) {
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(
    join(cwd, BASELINE_FILE),
    `${JSON.stringify({ $comment: 'fixture', ...listed })}\n`,
  );
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function commitOther(cwd, message) {
  writeFileSync(join(cwd, 'other.txt'), `${message}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * main at A, then one push of A..C: B grows the list, C changes something
 * else. `ci` is a depth-2 clone of C (C and B only), as actions/checkout
 * fetches it.
 */
function multiCommitPush() {
  const dir = mkdtempSync(join(tmpdir(), 'withheld-base-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const ci = join(dir, 'ci');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-q', '-b', 'main', work);
  const a = commitList(work, { svc: { X: ['dev'] } }, 'A');
  // Populate only this disposable local bare remote; no push to main is needed.
  git(origin, 'fetch', '-q', work, 'main:main');
  const b = commitList(work, { svc: { X: ['dev'], Y: ['dev'] } }, 'B: list Y');
  const c = commitOther(work, 'C: unrelated');
  git(origin, 'fetch', '-q', work, 'main:main');
  git(dir, 'clone', '-q', '--depth=2', '--branch', 'main', pathToFileURL(origin).href, ci);
  return { dir, origin, work, ci, a, b, c };
}

test('a multi-commit push is compared with the main it replaced, not with HEAD^1', (t) => {
  const repo = multiCommitPush();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  assert.equal(listedAt(repo.a, repo.ci), null, 'the fixture checkout must lack A');

  const base = withheldBase({ event: 'push', before: repo.a, cwd: repo.ci });
  assert.equal(base, repo.a);
  const head = listedAt('HEAD', repo.ci).entries;
  assert.deepEqual(notListedIn(head, listedAt(base, repo.ci).entries), ['svc dev Y']);

  // The defect: HEAD^1 is B, which already lists Y, so the growth passed.
  assert.equal(listedAt('HEAD^1', repo.ci).commit, repo.b);
  assert.deepEqual(notListedIn(head, listedAt('HEAD^1', repo.ci).entries), []);
});

test('a single-commit push is compared with its parent, already fetched', (t) => {
  const repo = multiCommitPush();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  assert.equal(withheldBase({ event: 'push', before: repo.b, cwd: repo.ci }), repo.b);
});

test('a push with no previous main, or one that cannot be fetched, fails closed', (t) => {
  const repo = multiCommitPush();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const push = (before) => () => withheldBase({ event: 'push', before, cwd: repo.ci });
  assert.throws(push('0'.repeat(40)), /names no previous main/);
  assert.throws(push(''), /names no previous main/);
  assert.throws(push(undefined), /names no previous main/);
  assert.throws(push('HEAD^1'), /not a commit id/);
  assert.throws(push(repo.a.slice(0, 12)), /not a commit id/);
  assert.throws(push('1234567890abcdef1234567890abcdef12345678'), /cannot fetch the previous main/);
  assert.throws(
    () => withheldBase({ event: 'push', before: repo.a, cwd: repo.ci, remote: 'no-such-remote' }),
    /cannot fetch the previous main/,
  );
});

test('a pull request is compared with its merge commit first parent, and only a merge commit', (t) => {
  const repo = multiCommitPush();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  // The pull request branched at A and lists Z; GitHub merges it into C.
  git(repo.work, 'checkout', '-q', '-b', 'pr', repo.a);
  const pr = commitList(repo.work, { svc: { X: ['dev'], Z: ['test'] } }, 'PR: list Z');
  git(repo.work, 'checkout', '-q', '--detach', repo.c);
  git(repo.work, 'merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'merge', pr);

  const base = withheldBase({ event: 'pull_request', cwd: repo.work });
  assert.equal(base, repo.c);
  const head = listedAt('HEAD', repo.work).entries;
  assert.deepEqual(notListedIn(head, listedAt(base, repo.work).entries), ['svc test Z']);

  // Not a merge commit: HEAD^1 would be the pull request's own history.
  git(repo.work, 'checkout', '-q', pr);
  assert.throws(
    () => withheldBase({ event: 'pull_request', cwd: repo.work }),
    /not a pull request merge commit/,
  );
});

test('any other event fails closed', (t) => {
  const repo = multiCommitPush();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  for (const event of ['workflow_dispatch', 'schedule', '', undefined]) {
    assert.throws(
      () => withheldBase({ event, before: repo.a, cwd: repo.ci }),
      /no withheld-list base/,
    );
  }
});

test('the command prints the base, and exits 2 when there is none', (t) => {
  const repo = multiCommitPush();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const run = (before) =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd: repo.ci,
      encoding: 'utf8',
      env: { ...GIT_ENV, GITHUB_EVENT_NAME: 'push', SERVICE_ENV_WITHHELD_PUSH_BEFORE: before },
    });
  const ok = run(repo.a);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${repo.a}\n`);
  const zero = run('0'.repeat(40));
  assert.equal(zero.status, 2);
  assert.equal(zero.stdout, '');
  assert.match(zero.stderr, /names no previous main/);
});

// #385 r4: an event name or a "before" that is not a commit id is any text; the
// command refuses it with a fixed line, from its real entry point.
test('the command repeats neither an unknown event nor a before that is not a commit', (t) => {
  const repo = multiCommitPush();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const run = (env) =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd: repo.ci,
      encoding: 'utf8',
      env: { ...GIT_ENV, ...env },
    });
  for (const sentinel of SENTINELS) {
    const event = run({ GITHUB_EVENT_NAME: sentinel, SERVICE_ENV_WITHHELD_PUSH_BEFORE: repo.a });
    assert.equal(event.status, 2);
    assert.equal(
      event.stderr,
      'service-env-withheld-base: no withheld-list base for this event: GITHUB_EVENT_NAME is ' +
        'pull_request or push only\n',
    );
    const before = run({ GITHUB_EVENT_NAME: 'push', SERVICE_ENV_WITHHELD_PUSH_BEFORE: sentinel });
    assert.equal(before.status, 2);
    assert.equal(
      before.stderr,
      'service-env-withheld-base: github.event.before is not a commit id\n',
    );
    for (const output of [event, before]) assertNoSentinel(output.stdout + output.stderr, sentinel);
  }
});

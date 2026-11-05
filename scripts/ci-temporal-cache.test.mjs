import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { tokenizeShell } from './check-dockerfile-pins-lib.mjs';
import { planTestRun } from './test-phases-lib.mjs';

const root = new URL('../', import.meta.url).pathname;
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const files = (dir) =>
  readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')
      ? []
      : e.isDirectory()
        ? files(`${dir}/${e.name}`)
        : [`${dir}/${e.name}`],
  );
const sources = [...files('services'), ...files('packages')];
const temporalPackages = sources
  .filter((p) => /\.[cm]?tsx?$/.test(p) && /\bTestWorkflowEnvironment\b/.test(read(p)))
  .map((p) => p.split('/').slice(0, 2).join('/'));
const packages = [...sources, ...files('apps')]
  .filter((p) => /^[^/]+\/[^/]+\/package.json$/.test(p))
  .map((p) => ({
    dir: p.slice(0, -13),
    ...JSON.parse(read(p)),
  }));
const scripts = JSON.parse(read('package.json')).scripts;
const workflow = parse(read(process.env.TEMPORAL_CI_WORKFLOW ?? '.github/workflows/ci.yml'));
const cacheDir = '${{ runner.temp }}/temporal-test-server';
const cacheKey = "temporal-test-server-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}";
const quote = (w) => `'${w.replaceAll("'", "'\\''")}'`;
const cacheAction = 'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830';

// Conservative selection: name filters never prove a Temporal suite cannot run.
// Follow root aliases and the real shard planner; unknown selectors require the cache.
function runsTemporal(run, cwd = '.', stack = []) {
  assert.ok(stack.length < 20, 'recursive test script');
  const parsed = tokenizeShell(run);
  return [
    ...parsed.nested.map((n) => n.script),
    ...parsed.commands.map((c) => c.words.map((w) => w.value)),
  ].some((words) => {
    if (typeof words === 'string') return runsTemporal(words, cwd, [...stack, 'nested']);
    const phase = words.findIndex((w) => w.endsWith('/run-test-phases.mjs'));
    if (phase >= 0)
      return planTestRun(words.slice(phase + 1)).some(({ args }) =>
        runsTemporal(`turbo ${args.map(quote).join(' ')}`, cwd, [...stack, 'phase']),
      );
    if (!words.some((w) => /(?:^|\/)(?:pnpm|npm|turbo|jest)(?:\.js)?$/.test(w))) return false;
    const task = words.find((w) => /^(?:test(?::[\w-]+)*|jest)$/.test(w));
    if (!task) return false;
    const selected = words.flatMap((w, i) =>
      /^(?:--filter|-F|--dir|-C)(?:=|$)/.test(w)
        ? [w.includes('=') ? w.slice(w.indexOf('=') + 1) : words[i + 1]]
        : [],
    );
    if (selected.length === 0 && cwd === '.' && !words.includes('turbo') && scripts[task]) {
      assert.ok(!stack.includes(task), `recursive root script ${task}`);
      return runsTemporal(
        `${scripts[task]} ${words
          .slice(words.indexOf(task) + 1)
          .map(quote)
          .join(' ')}`,
        cwd,
        [...stack, task],
      );
    }
    const targets = packages.filter((p) =>
      selected.length
        ? selected.includes(p.name) || selected.includes(p.dir)
        : cwd === '.' || resolve(root, p.dir) === resolve(root, cwd),
    );
    if (selected.some((s) => !packages.some((p) => p.name === s || p.dir === s))) return true;
    // An unresolvable target is not evidence that Temporal is excluded.
    return (
      targets.length === 0 ||
      targets.some(
        (p) =>
          temporalPackages.includes(p.dir) &&
          (task === 'jest' || Object.hasOwn(p.scripts ?? {}, task)),
      )
    );
  });
}

function problems(doc) {
  const errors = [];
  for (const [id, job] of Object.entries(doc.jobs)) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (
        !step.run ||
        !runsTemporal(
          step.run,
          step['working-directory'] ??
            job.defaults?.run?.['working-directory'] ??
            doc.defaults?.run?.['working-directory'] ??
            '.',
        )
      )
        continue;
      const label = `${id}: ${step.name ?? index}`;
      const env = { ...doc.env, ...job.env, ...step.env };
      if (env.TEMPORAL_TEST_SERVER_DIR !== cacheDir)
        errors.push(`${label}: TEMPORAL_TEST_SERVER_DIR`);
      if (
        !job.steps
          .slice(0, index)
          .some(
            (s, cacheIndex) =>
              s.uses === cacheAction &&
              s.with?.path === cacheDir &&
              s.with?.key === cacheKey &&
              !s.if &&
              !s['continue-on-error'] &&
              job.steps
                .slice(0, cacheIndex)
                .some((prior) => prior.uses?.startsWith('actions/checkout@')),
          )
      )
        errors.push(`${label}: cache`);
    }
  }
  return errors;
}

test('every CI Temporal test run has the shared pinned cache and directory', () => {
  assert.deepEqual(problems(workflow), []);
});

test('removing each consumer directory or cache fails closed', () => {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (!step.run || !runsTemporal(step.run, step['working-directory'] ?? '.')) continue;
      const mutant = structuredClone(workflow);
      mutant.jobs[id].env = { ...job.env, TEMPORAL_TEST_SERVER_DIR: '' };
      mutant.jobs[id].steps[index].env = { ...step.env, TEMPORAL_TEST_SERVER_DIR: '' };
      assert.ok(problems(mutant).some((e) => e.startsWith(`${id}:`) && e.endsWith('DIR')));
      mutant.jobs[id].steps = job.steps.filter((s) => s.uses !== cacheAction);
      assert.ok(problems(mutant).some((e) => e.startsWith(`${id}:`) && e.endsWith('cache')));
    }
  }
});

test('Turbo passes the directory and every server caller uses the shared helper', () => {
  assert.ok(
    JSON.parse(read('turbo.json').replaceAll(/^\s*\/\/[^\n]*/gm, '')).globalPassThroughEnv.includes(
      'TEMPORAL_TEST_SERVER_DIR',
    ),
  );
  for (const path of sources.filter((p) => /\.[cm]?tsx?$/.test(p))) {
    if (/TestWorkflowEnvironment\.create(?:TimeSkipping|Local)\s*\(/.test(read(path))) {
      assert.equal(path, 'services/marketplace-service/test/temporal-environment.ts', path);
    }
  }
});

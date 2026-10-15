import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  AGGREGATE_JOB,
  SPLIT_STEPS,
  checkIntegrationSplit,
  checkIntegrationSplitText,
} from './ci-integration-split-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const real = () => parseYaml(TEXT);
const fails = (workflow, pattern) => {
  const problems = checkIntegrationSplit(workflow);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got: ${JSON.stringify(problems)}`,
  );
};
const splitJobs = (workflow) =>
  Object.keys(workflow.jobs).filter((id) => id.startsWith('integration-'));
const jobRunning = (workflow, name) =>
  splitJobs(workflow).find((id) => workflow.jobs[id].steps.some((step) => step.name === name));
const dropStep = (job, name) => {
  job.steps = job.steps.filter((step) => step.name !== name);
};

test('the committed workflow passes', () => {
  assert.deepEqual(checkIntegrationSplitText(TEXT), []);
});

test('the parser sees the split it is meant to check', () => {
  const workflow = real();
  assert.ok(splitJobs(workflow).length >= 2);
  assert.equal(workflow.jobs[AGGREGATE_JOB].name, 'Integration and security tests');
  for (const name of SPLIT_STEPS) assert.ok(jobRunning(workflow, name), name);
  assert.ok(workflow.jobs.containers.needs.includes(AGGREGATE_JOB));
});

test('a split job the aggregate does not need is refused', () => {
  const workflow = real();
  workflow.jobs[AGGREGATE_JOB].needs = workflow.jobs[AGGREGATE_JOB].needs.slice(1);
  fails(workflow, /does not need integration-/);
  const extra = real();
  extra.jobs[AGGREGATE_JOB].needs.push('quality');
  fails(extra, /needs quality, not a split job/);
});

test('an aggregate that runs only on success, or does not check results, is refused', () => {
  const onSuccess = real();
  delete onSuccess.jobs[AGGREGATE_JOB].if;
  fails(onSuccess, /must run if: always\(\)/);
  const notCancelled = real();
  notCancelled.jobs[AGGREGATE_JOB].if = '${{ !cancelled() }}';
  fails(notCancelled, /must run if: always\(\)/);
  const noVerdict = real();
  noVerdict.jobs[AGGREGATE_JOB].steps = [{ name: 'ok', run: 'true' }];
  fails(noVerdict, /must fail unless every needed job's result is "success"/);
  const renamed = real();
  renamed.jobs[AGGREGATE_JOB].name = 'Integration';
  fails(renamed, /must be named "Integration and security tests"/);
});

test('a step dropped from every job, or run twice, is refused', () => {
  for (const name of ['Contract coverage gate', 'Retry replay, published as ops-replay']) {
    const workflow = real();
    dropStep(workflow.jobs[jobRunning(workflow, name)], name);
    fails(workflow, new RegExp(`runs "${name.replace(/[()]/g, '\\$&')}"`));
  }
  const twice = real();
  const step = twice.jobs[jobRunning(twice, 'Audit coverage gate')].steps.find(
    (candidate) => candidate.name === 'Audit coverage gate',
  );
  twice.jobs['integration-suites'].steps.push(structuredClone(step));
  fails(twice, /"Audit coverage gate" runs in more than one job/);
});

test('a step without its infrastructure is refused', () => {
  const documentJob = (workflow) => workflow.jobs[jobRunning(workflow, 'Document coverage gate')];
  const noScanner = real();
  dropStep(documentJob(noScanner), 'Start ClamAV on a Unix socket');
  fails(noScanner, /"Document coverage gate" runs without "Start ClamAV on a Unix socket"/);
  const noBucket = real();
  dropStep(documentJob(noBucket), 'Start MinIO and create the document bucket');
  fails(noBucket, /"Document coverage gate" runs without "Start MinIO/);
  const noBroker = real();
  dropStep(documentJob(noBroker), 'Start the authenticated Kafka broker');
  fails(noBroker, /runs without "Start the authenticated Kafka broker"/);
  const noMigrations = real();
  dropStep(documentJob(noMigrations), 'Apply migrations');
  fails(noMigrations, /runs without "Apply migrations"/);
  const noRedis = real();
  delete noRedis.jobs[jobRunning(noRedis, 'Integration tests')].services.redis;
  fails(noRedis, /"Integration tests" runs without a redis service container/);
  const noBuild = real();
  dropStep(documentJob(noBuild), 'Build the shared packages');
  fails(noBuild, /needs the packages built before it/);
});

test('infrastructure no step of the job reads is refused', () => {
  const workflow = real();
  const id = jobRunning(workflow, 'Construction coverage gate');
  workflow.jobs[id].services.redis = { image: 'redis' };
  fails(workflow, new RegExp(`${id} starts Redis, which no step of it reads`));
});

test('invalid YAML is a problem, not a pass', () => {
  assert.equal(checkIntegrationSplitText('jobs: [unclosed').length, 1);
});

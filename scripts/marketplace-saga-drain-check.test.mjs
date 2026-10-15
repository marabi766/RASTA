// The D-053 deployment gate (scripts/marketplace-saga-drain-check.mjs) passes
// only on a verified drained order task queue, and blocks on everything else —
// a pending activity, a poller, and every way of not being able to tell.
//
// Runs the script itself against a stand-in `temporal` CLI (TEMPORAL_CLI) that
// answers from a scenario file and records every call. The answers have the
// shapes the real CLI prints (`temporal` of the image docker-compose.yml pins,
// temporalio/auto-setup:1.26.2, against a dev server with one workflow parked
// in an activity and one in a timer): `workflow list` a JSON array,
// `workflow count` `{"count": "<n>"}`, `workflow describe` with
// `pendingActivities` left out when there is none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./marketplace-saga-drain-check.mjs', import.meta.url));
const QUERY = 'WorkflowType="orderSaga" AND ExecutionStatus="Running"';

const FAKE_CLI = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const scenario = JSON.parse(readFileSync(process.env.FAKE_TEMPORAL_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
const keyOf = (a) => {
  const key = a[0] + ' ' + a[1];
  return key === 'workflow describe' ? key + ' ' + a[a.indexOf('--workflow-id') + 1] : key;
};
appendFileSync(process.env.FAKE_TEMPORAL_CALLS, JSON.stringify(args) + '\\n');
const key = keyOf(args);
const nth = readFileSync(process.env.FAKE_TEMPORAL_CALLS, 'utf8').trim().split('\\n')
  .filter((line) => keyOf(JSON.parse(line)) === key).length;
let answer = scenario[key];
if (answer && Array.isArray(answer.sequence)) answer = answer.sequence[Math.min(nth, answer.sequence.length) - 1];
if (!answer) {
  process.stderr.write('fake temporal: no answer for ' + key + '\\n');
  process.exit(9);
}
if (answer.stderr) process.stderr.write(answer.stderr);
if (answer.stdout !== undefined) {
  process.stdout.write(typeof answer.stdout === 'string' ? answer.stdout : JSON.stringify(answer.stdout));
}
process.exit(answer.status ?? 0);
`;

const execution = (id) => ({
  execution: { workflowId: `order-${id}`, runId: `run-${id}` },
  type: { name: 'orderSaga' },
  status: 'WORKFLOW_EXECUTION_STATUS_RUNNING',
});
const description = (id, pendingActivities) => ({
  executionConfig: { taskQueue: { name: 'rasta-order', kind: 'TASK_QUEUE_KIND_NORMAL' } },
  workflowExecutionInfo: {
    execution: { workflowId: `order-${id}`, runId: `run-${id}` },
    type: { name: 'orderSaga' },
    status: 'WORKFLOW_EXECUTION_STATUS_RUNNING',
  },
  ...(pendingActivities === undefined ? {} : { pendingActivities }),
});
const pendingHold = {
  activityId: '1',
  activityType: { name: 'markSettlementFailed' },
  state: 'PENDING_ACTIVITY_STATE_STARTED',
  attempt: 1,
};

/** Two running sagas, neither with a pending activity, no poller. */
function drained() {
  return {
    'task-queue describe': { stdout: { reachability: null, pollers: [], stats: [] } },
    'workflow count': { stdout: { count: '2' } },
    'workflow list': { stdout: [execution('A'), execution('B')] },
    'workflow describe order-A': { stdout: description('A') },
    'workflow describe order-B': { stdout: description('B', []) },
  };
}

const SETTINGS = {
  TEMPORAL_ADDRESS: 'temporal.internal:7233',
  TEMPORAL_NAMESPACE: 'rasta-prod',
  MARKETPLACE_TEMPORAL_TASK_QUEUE: 'rasta-order',
};

function run(scenario, { settings = SETTINGS, cli } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'saga-drain-'));
  try {
    const fake = join(dir, 'temporal.mjs');
    writeFileSync(fake, FAKE_CLI);
    chmodSync(fake, 0o755);
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
    writeFileSync(join(dir, 'calls.jsonl'), '');
    const env = { PATH: process.env.PATH, ...settings, TEMPORAL_CLI: cli ?? fake };
    env.FAKE_TEMPORAL_SCENARIO = join(dir, 'scenario.json');
    env.FAKE_TEMPORAL_CALLS = join(dir, 'calls.jsonl');
    const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('passes a drained queue, having asked exactly what the runbook says', () => {
  const { status, stdout, calls } = run(drained());
  assert.equal(status, 0);
  assert.match(stdout, /OK — no poller, 2 running order saga\(s\), no pending activity/);
  const common = ['--address', 'temporal.internal:7233', '--namespace', 'rasta-prod'];
  assert.deepEqual(calls, [
    ['task-queue', 'describe', ...common, '--task-queue', 'rasta-order', '--output', 'json'],
    ['workflow', 'count', ...common, '--query', QUERY, '--output', 'json'],
    ['workflow', 'list', ...common, '--query', QUERY, '--output', 'json'],
    [
      'workflow',
      'describe',
      ...common,
      '--workflow-id',
      'order-A',
      '--run-id',
      'run-A',
      '--output',
      'json',
    ],
    [
      'workflow',
      'describe',
      ...common,
      '--workflow-id',
      'order-B',
      '--run-id',
      'run-B',
      '--output',
      'json',
    ],
    ['workflow', 'count', ...common, '--query', QUERY, '--output', 'json'],
  ]);
});

test('passes with no running saga at all', () => {
  const scenario = {
    ...drained(),
    'workflow count': { stdout: { count: '0' } },
    'workflow list': { stdout: [] },
  };
  const { status, stdout } = run(scenario);
  assert.equal(status, 0);
  assert.match(stdout, /0 running order saga/);
});

test('blocks on a pending activity, naming the workflow and the activity', () => {
  const scenario = {
    ...drained(),
    'workflow describe order-B': { stdout: description('B', [pendingHold]) },
  };
  const { status, stderr } = run(scenario);
  assert.equal(status, 1);
  assert.match(stderr, /BLOCKED — 1 finding/);
  assert.match(
    stderr,
    /order-B has a pending activity markSettlementFailed \(PENDING_ACTIVITY_STATE_STARTED, attempt 1\)/,
  );
});

test('blocks while a worker still polls the order task queue', () => {
  const poller = {
    buildId: 'UNVERSIONED',
    taskQueueType: 'activity',
    identity: '41@marketplace-old',
    lastAccessTime: '2026-10-15T05:14:05.617930744Z',
  };
  const scenario = {
    ...drained(),
    'task-queue describe': { stdout: { pollers: [poller], stats: [] } },
  };
  const { status, stderr } = run(scenario);
  assert.equal(status, 1);
  assert.match(
    stderr,
    /task queue rasta-order has a poller 41@marketplace-old \(activity, last seen/,
  );
});

for (const name of Object.keys(SETTINGS)) {
  test(`cannot verify without ${name}, and asks Temporal nothing`, () => {
    const settings = { ...SETTINGS, [name]: '  ' };
    const { status, stderr, calls } = run(drained(), { settings });
    assert.equal(status, 2);
    assert.match(stderr, new RegExp(`could not verify: ${name} is not set`));
    assert.deepEqual(calls, []);
  });
}

const UNVERIFIABLE = {
  'the CLI is not installed': [
    drained(),
    { cli: '/nonexistent/temporal' },
    /temporal task-queue describe: .*ENOENT/,
  ],
  'the CLI fails (unreachable server, refused credentials)': [
    {
      ...drained(),
      'workflow describe order-A': {
        status: 1,
        stderr: 'level=ERROR msg="failed reaching server"\n',
      },
    },
    {},
    /temporal workflow describe exited 1: level=ERROR msg="failed reaching server"/,
  ],
  'the CLI prints something other than JSON': [
    { ...drained(), 'workflow list': { stdout: 'order-A orderSaga Running\n' } },
    {},
    /temporal workflow list did not print JSON/,
  ],
  'the count has no number': [
    { ...drained(), 'workflow count': { stdout: {} } },
    {},
    /workflow count: no count/,
  ],
  'the list is not a list': [
    { ...drained(), 'workflow list': { stdout: {} } },
    {},
    /workflow list: not a list/,
  ],
  'the answer about the queue has no poller list': [
    { ...drained(), 'task-queue describe': { stdout: { pollers: 'none' } } },
    {},
    /no poller list/,
  ],
  'visibility lists fewer sagas than it counts': [
    { ...drained(), 'workflow count': { stdout: { count: '3' } } },
    {},
    /counts 3 running order sagas but lists 2/,
  ],
  'a saga starts during the check': [
    {
      ...drained(),
      'workflow count': { sequence: [{ stdout: { count: '2' } }, { stdout: { count: '3' } }] },
    },
    {},
    /went from 2 to 3 during the check/,
  ],
  'a listed entry is not an order saga execution': [
    {
      ...drained(),
      'workflow list': { stdout: [execution('A'), { ...execution('B'), type: { name: 'other' } }] },
    },
    {},
    /an entry without an orderSaga execution/,
  ],
  'a description is of another workflow': [
    { ...drained(), 'workflow describe order-B': { stdout: description('A') } },
    {},
    /describe order-B: not a description of it/,
  ],
  'pending activities that are not a list': [
    { ...drained(), 'workflow describe order-B': { stdout: description('B', { count: 0 }) } },
    {},
    /describe order-B: not a description of it/,
  ],
};

for (const [name, [scenario, options, message]] of Object.entries(UNVERIFIABLE)) {
  test(`blocks when ${name}`, () => {
    const { status, stdout, stderr } = run(scenario, options);
    assert.equal(status, 2);
    assert.match(stderr, /BLOCKED — could not verify: /);
    assert.match(stderr, message);
    assert.doesNotMatch(stdout, /OK/);
  });
}

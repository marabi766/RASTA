// The D-053 deployment gate (scripts/marketplace-saga-drain-check.mjs) passes
// only on a verified drained order task queue, and blocks on everything else —
// a pending activity, a poller, and every way of not being able to tell.
//
// Runs the script itself against a stand-in `temporal` CLI (TEMPORAL_CLI) that
// answers from a scenario file and records every call. The answers have the
// shapes the real CLI prints (`temporal` of the image docker-compose.yml pins,
// temporalio/auto-setup:1.26.2, against a dev server with one workflow parked
// in an activity and one in a timer, and with none): `workflow list` a JSON
// array, `workflow count` `{"count": "<n>"}` and `{}` for zero, `task-queue
// describe` `"pollers": null` when none polls, `workflow describe` with
// `pendingActivities` left out when there is none. Any other shape blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SENTINELS, assertNoSentinel } from './refusal-probes.mjs';

const SCRIPT = fileURLToPath(new URL('./marketplace-saga-drain-check.mjs', import.meta.url));
const STOP_TIME = '2026-01-01T00:00:00.000Z';
const CONTINUED_QUERY = `WorkflowType="orderSaga" AND ExecutionStatus="ContinuedAsNew" AND CloseTime >= "${STOP_TIME}"`;
const QUERY = 'WorkflowType="orderSaga" AND ExecutionStatus="Running"';

const FAKE_CLI = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const scenario = JSON.parse(readFileSync(process.env.FAKE_TEMPORAL_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
const keyOf = (a) => {
  let key = a[0] + ' ' + a[1];
  if (a.includes('--query') && a[a.indexOf('--query') + 1].includes('ContinuedAsNew')) key += ' continued';
  return ['workflow describe', 'workflow show'].includes(key) ? key + ' ' + a[a.indexOf('--workflow-id') + 1] : key;
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
const stats = [
  { buildId: 'UNVERSIONED', taskQueueType: 'workflow', approximateBacklogCount: 0 },
  { buildId: 'UNVERSIONED', taskQueueType: 'activity', approximateBacklogCount: 0 },
];
const description = (id, pendingActivities) => ({
  executionConfig: { taskQueue: { name: 'rasta-order', kind: 'TASK_QUEUE_KIND_NORMAL' } },
  workflowExecutionInfo: {
    execution: { workflowId: `order-${id}`, runId: `run-${id}` },
    type: { name: 'orderSaga' },
    status: 'WORKFLOW_EXECUTION_STATUS_RUNNING',
    historyLength: '1',
  },
  ...(pendingActivities === undefined ? {} : { pendingActivities }),
});
const pendingHold = {
  activityId: '1',
  activityType: { name: 'markSettlementFailed' },
  state: 'PENDING_ACTIVITY_STATE_STARTED',
  attempt: 1,
};

const payload = (value) => ({
  metadata: { encoding: 'anNvbi9wbGFpbg==' },
  data: Buffer.from(JSON.stringify(value)).toString('base64'),
});
const legacyStart = JSON.parse(
  readFileSync(
    new URL(
      '../services/marketplace-service/src/temporal/fixtures/pre-rollover.json',
      import.meta.url,
    ),
    'utf8',
  ),
).events[0];
const history = (input = {}, markers = []) => ({
  events: [
    {
      ...legacyStart,
      workflowExecutionStartedEventAttributes: {
        ...legacyStart.workflowExecutionStartedEventAttributes,
        taskQueue: { name: 'rasta-order' },
        input: { payloads: [payload(input)] },
      },
    },
    ...markers.map((value, i) => ({
      eventId: String(i + 2),
      eventType: 'EVENT_TYPE_MARKER_RECORDED',
      markerRecordedEventAttributes: {
        markerName: 'core_patch',
        details: { 'patch-data': { payloads: [payload(value)] } },
      },
    })),
  ],
});

/** Two running sagas, neither with a pending activity, no poller. */
function drained() {
  return {
    'task-queue describe': { stdout: { reachability: null, pollers: null, stats } },
    'workflow count': { stdout: { count: '2' } },
    'workflow list': { stdout: [execution('A'), execution('B')] },
    'workflow count continued': { stdout: {} },
    'workflow list continued': { stdout: [] },
    'workflow describe order-A': { stdout: description('A') },
    'workflow describe order-B': { stdout: description('B', []) },
    'workflow show order-A': { stdout: history() },
    'workflow show order-B': { stdout: history() },
  };
}

const SETTINGS = {
  TEMPORAL_ADDRESS: 'temporal.internal:7233',
  TEMPORAL_NAMESPACE: 'rasta-prod',
  MARKETPLACE_TEMPORAL_TASK_QUEUE: 'rasta-order',
  MARKETPLACE_SAGA_STOP_TIME: STOP_TIME,
};

const TARGET_NAME = '@rasta/marketplace-service';
// Unmodified origin/main eae31b07 manifest: real pre-protocol target release.
const legacyTarget = JSON.parse(
  readFileSync(
    new URL('./fixtures/marketplace-pre-protocol-package.json', import.meta.url),
    'utf8',
  ),
);

function run(
  scenario,
  {
    settings = SETTINGS,
    cli,
    target = { name: TARGET_NAME, marketplaceSagaProtocol: 1 },
    args = [],
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'saga-drain-'));
  try {
    const fake = join(dir, 'temporal.mjs');
    writeFileSync(fake, FAKE_CLI);
    chmodSync(fake, 0o755);
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
    writeFileSync(join(dir, 'calls.jsonl'), '');
    writeFileSync(join(dir, 'target.json'), JSON.stringify(target));
    const env = {
      MARKETPLACE_TARGET_PACKAGE_JSON: join(dir, 'target.json'),
      PATH: process.env.PATH,
      ...settings,
      TEMPORAL_CLI: cli ?? fake,
    };
    env.FAKE_TEMPORAL_SCENARIO = join(dir, 'scenario.json');
    env.FAKE_TEMPORAL_CALLS = join(dir, 'calls.jsonl');
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
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
      'show',
      ...common,
      '--workflow-id',
      'order-A',
      '--run-id',
      'run-A',
      '--output',
      'json',
      '--no-json-shorthand-payloads',
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
    [
      'workflow',
      'show',
      ...common,
      '--workflow-id',
      'order-B',
      '--run-id',
      'run-B',
      '--output',
      'json',
      '--no-json-shorthand-payloads',
    ],
    ['workflow', 'count', ...common, '--query', CONTINUED_QUERY, '--output', 'json'],
    ['workflow', 'list', ...common, '--query', CONTINUED_QUERY, '--output', 'json'],
    ['workflow', 'count', ...common, '--query', CONTINUED_QUERY, '--output', 'json'],
    ['workflow', 'count', ...common, '--query', QUERY, '--output', 'json'],
  ]);
});

// #673 r1 F2: the gate takes its settings from the environment only. An
// argument — even one naming another namespace — is refused before any
// `temporal` call, so it can never report OK for a namespace it did not check.
for (const args of [
  ['--namespace', 'requested-namespace'],
  ['--task-queue', SENTINELS[1]],
  [SENTINELS[0]],
]) {
  test(`refuses an argument (${args[0]}) on a drained queue, asking Temporal nothing`, () => {
    const { status, stdout, stderr, calls } = run(drained(), { args });
    assert.equal(status, 1);
    assert.equal(stdout, '');
    assert.equal(
      stderr,
      'marketplace saga drain check: cannot verify — deployment blocked: ' +
        'command refused (code usage); diagnostics withheld; ' +
        'prior work may have committed — reconcile before retrying\n',
    );
    assert.deepEqual(calls, []);
    assertNoSentinel(stdout + stderr, args[0]);
  });
}

// The predecessor is visible; its current successor need not be indexed yet.
const predecessor = (id, runId = `previous-${id}`) => ({
  ...execution(id),
  execution: { workflowId: `order-${id}`, runId },
  status: 'WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW',
});
function continued(current = description('C')) {
  return {
    ...drained(),
    'workflow count continued': { stdout: { count: '1' } },
    'workflow list continued': { stdout: [predecessor('C')] },
    'workflow describe order-C': { stdout: current },
    'workflow show order-C': { stdout: history() },
  };
}

test('blocks a continued-as-new successor absent from running visibility, even without activities', () => {
  const { status, stdout, stderr, calls } = run(continued());
  assert.equal(status, 1);
  assert.doesNotMatch(stdout, /OK/);
  assert.match(stderr, /current running order saga is absent from visibility/);
  const current = calls.find((args) => args.includes('order-C'));
  assert.ok(current);
  assert.equal(current.includes('--run-id'), false);
});

test('blocks an unlisted continued-as-new successor with a pending financial activity', () => {
  const result = run(continued(description('C', [pendingHold])));
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /OK/);
});

test('blocks when describing the current continued-as-new successor fails', () => {
  const scenario = continued();
  scenario['workflow describe order-C'] = { status: 1, stderr: SENTINELS.join(' ') };
  const { status, stderr } = run(scenario);
  assert.equal(status, 1);
  assert.match(stderr, /temporal workflow describe failed/);
  assertNoSentinel(stderr);
});

test('passes a continued-as-new chain whose current run has completed', () => {
  const current = description('C');
  current.workflowExecutionInfo.execution.runId = 'current-C';
  current.workflowExecutionInfo.status = 'WORKFLOW_EXECUTION_STATUS_COMPLETED';
  const result = run(continued(current));
  assert.equal(result.status, 0);
  const shown = result.calls.find((args) => args[1] === 'show' && args.includes('order-C'));
  assert.equal(shown[shown.indexOf('--run-id') + 1], 'current-C');
});

test('inspects a visible current run again by workflow id, even across multiple continuations', () => {
  const scenario = continued();
  scenario['workflow count continued'] = { stdout: { count: '2' } };
  scenario['workflow list continued'].stdout = [predecessor('A'), predecessor('A', 'earlier-A')];
  const { status, calls } = run(scenario);
  assert.equal(status, 0);
  const current = calls.filter((args) => args[1] === 'describe' && args.includes('order-A'));
  assert.equal(current.length, 2);
  assert.equal(current[1].includes('--run-id'), false);
});

const CONTINUED_FAILURES = {
  'wrong predecessor status': { 'workflow list continued': { stdout: [execution('C')] } },
  'incomplete pagination': { 'workflow count continued': { stdout: { count: '2' } } },
  'duplicate predecessors': {
    'workflow list continued': { stdout: [predecessor('C'), predecessor('C')] },
  },
  'unknown list shape or pagination envelope': {
    'workflow list continued': { stdout: { executions: [], nextPageToken: 'more' } },
  },
  'malformed count': { 'workflow count continued': { stdout: { count: null } } },
  'changed count': {
    'workflow count continued': {
      sequence: [{ stdout: { count: '1' } }, { stdout: { count: '2' } }],
    },
  },
  'unknown current description': { 'workflow describe order-C': { stdout: {} } },
  'unknown current status': {
    'workflow describe order-C': {
      stdout: {
        ...description('C'),
        workflowExecutionInfo: { ...execution('C'), status: 'UNKNOWN' },
      },
    },
  },
  'closed predecessor returned as current': {
    'workflow describe order-C': {
      stdout: {
        ...description('C'),
        workflowExecutionInfo: {
          ...execution('C'),
          status: 'WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW',
        },
      },
    },
  },
};
for (const [name, answers] of Object.entries(CONTINUED_FAILURES)) {
  test(`blocks continued-as-new with ${name}`, () => {
    const completed = description('C');
    completed.workflowExecutionInfo.status = 'WORKFLOW_EXECUTION_STATUS_COMPLETED';
    const result = run({ ...continued(completed), ...answers });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /OK/);
  });
}

for (const stopTime of [
  'garbage',
  '2026-02-30T00:00:00.000Z',
  '2999-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00.000Z" OR WorkflowType="other',
]) {
  test(`blocks an invalid or future stop time ${stopTime}`, () => {
    const result = run(drained(), {
      settings: { ...SETTINGS, MARKETPLACE_SAGA_STOP_TIME: stopTime },
    });
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
    assert.match(result.stderr, /must be a past canonical UTC timestamp/);
  });
}

test('passes with no running saga at all (the CLI prints {} for a zero count)', () => {
  const scenario = {
    ...drained(),
    'workflow count': { stdout: {} },
    'workflow list': { stdout: [] },
  };
  const { status, stdout } = run(scenario);
  assert.equal(status, 0);
  assert.match(stdout, /0 running order saga/);
});

const PASSING = {
  'a count of zero printed as "0"': {
    'workflow count': { stdout: { count: '0' } },
    'workflow list': { stdout: [] },
  },
  'a count printed as a JSON number': { 'workflow count': { stdout: { count: 2 } } },
  'an empty poller list printed as []': {
    'task-queue describe': { stdout: { reachability: null, pollers: [], stats } },
  },
};

for (const [name, answers] of Object.entries(PASSING)) {
  test(`passes a drained queue with ${name}`, () => {
    const { status, stdout } = run({ ...drained(), ...answers });
    assert.equal(status, 0);
    assert.match(stdout, /OK — no poller/);
  });
}

test('blocks on a pending activity, withholding foreign details', () => {
  const scenario = {
    ...drained(),
    'workflow describe order-B': { stdout: description('B', [pendingHold]) },
  };
  const { status, stderr } = run(scenario);
  assert.equal(status, 1);
  assert.match(stderr, /BLOCKED — 1 finding/);
  assert.match(stderr, /workflow has a pending activity; details withheld/);
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
    'task-queue describe': { stdout: { reachability: null, pollers: [poller], stats } },
  };
  const { status, stderr } = run(scenario);
  assert.equal(status, 1);
  assert.match(stderr, /task queue has an active poller; details withheld/);
});

for (const name of Object.keys(SETTINGS)) {
  test(`cannot verify without ${name}, and asks Temporal nothing`, () => {
    const settings = { ...SETTINGS, [name]: '  ' };
    const { status, stderr, calls } = run(drained(), { settings });
    assert.equal(status, 1);
    assert.match(stderr, new RegExp(`cannot verify — deployment blocked: ${name} is not set`));
    assert.deepEqual(calls, []);
  });
}

const UNVERIFIABLE = {
  'the CLI is not installed': [
    drained(),
    { cli: '/nonexistent/temporal' },
    /temporal task-queue describe: TEMPORAL_CLI could not be run \(ENOENT\)$/m,
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
    /temporal workflow describe failed; child diagnostics withheld/,
  ],
  'the CLI prints something other than JSON': [
    { ...drained(), 'workflow list': { stdout: 'order-A orderSaga Running\n' } },
    {},
    /temporal workflow list did not print JSON/,
  ],
  'the list is not a list': [
    { ...drained(), 'workflow list': { stdout: {} } },
    {},
    /workflow list: not a list/,
  ],
  'visibility lists fewer sagas than it counts': [
    { ...drained(), 'workflow count': { stdout: { count: '3' } } },
    {},
    /counts 3 order sagas but lists 2/,
  ],
  'visibility lists more sagas than it counts': [
    { ...drained(), 'workflow count': { stdout: { count: '1' } } },
    {},
    /counts 1 order sagas but lists 2/,
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
    /describe: not a description of that run/,
  ],
  'pending activities that are not a list': [
    { ...drained(), 'workflow describe order-B': { stdout: description('B', { count: 0 }) } },
    {},
    /describe: not a description of that run/,
  ],
};

// Every way an answer can be malformed or ambiguous while everything around it
// says "drained" — each would pass if a missing or odd value were read as
// "none" (Codex r3 on #283). The counts come with an empty list, so a count
// misread as 0 would agree with it.
const noneListed = (count) => ({
  ...drained(),
  'workflow count': { stdout: count },
  'workflow list': { stdout: [] },
});
const describedAs = (id, change) => {
  const answer = description(id);
  change(answer);
  return { ...drained(), [`workflow describe order-${id}`]: { stdout: answer } };
};
const COUNT = /temporal workflow count: not a count/;
const QUEUE = /temporal task-queue describe: no poller list/;
const RUN = /describe: not a description of that run/;
const MALFORMED = {
  'the count is an empty string': [noneListed({ count: '' }), COUNT],
  'the count is false': [noneListed({ count: false }), COUNT],
  'the count is null': [noneListed({ count: null }), COUNT],
  'the count is negative': [noneListed({ count: '-1' }), COUNT],
  'the count is not an integer': [noneListed({ count: '0.0' }), COUNT],
  'the count is padded': [noneListed({ count: ' 0' }), COUNT],
  'the count is an array': [noneListed([]), COUNT],
  'the count answer has fields it should not': [noneListed({ total: '0' }), COUNT],
  'the count is beyond a safe integer': [noneListed({ count: '9007199254740993' }), COUNT],
  'the queue answer is a list': [{ ...drained(), 'task-queue describe': { stdout: [] } }, QUEUE],
  'the queue answer is empty': [{ ...drained(), 'task-queue describe': { stdout: {} } }, QUEUE],
  'the queue answer is null': [{ ...drained(), 'task-queue describe': { stdout: null } }, QUEUE],
  'the queue answer has no stats': [
    { ...drained(), 'task-queue describe': { stdout: { pollers: null } } },
    QUEUE,
  ],
  'the poller list is not a list': [
    { ...drained(), 'task-queue describe': { stdout: { pollers: 'none', stats } } },
    QUEUE,
  ],
  'a description is of another run of the same workflow': [
    describedAs('B', (d) => (d.workflowExecutionInfo.execution.runId = 'run-B-earlier')),
    RUN,
  ],
  'a description has no run id': [
    describedAs('B', (d) => delete d.workflowExecutionInfo.execution.runId),
    RUN,
  ],
  'a description is not of an orderSaga': [
    describedAs('B', (d) => (d.workflowExecutionInfo.type.name = 'other')),
    RUN,
  ],
  'a description is empty': [{ ...drained(), 'workflow describe order-B': { stdout: {} } }, RUN],
  'a description is a list': [{ ...drained(), 'workflow describe order-B': { stdout: [] } }, RUN],
  'pending activities are null': [describedAs('B', (d) => (d.pendingActivities = null)), RUN],
  'a run is on another task queue': [
    describedAs('B', (d) => (d.executionConfig.taskQueue.name = 'rasta-order-v2')),
    /workflow runs on an unchecked task queue/,
  ],
  'a description does not say its task queue': [
    describedAs('B', (d) => delete d.executionConfig),
    /workflow runs on an unchecked task queue/,
  ],
};
for (const [name, [scenario, message]] of Object.entries(MALFORMED)) {
  UNVERIFIABLE[name] = [scenario, {}, message];
}

// Codex r4 on #283: A listed twice made up the count for B, which has a
// pending activity and was never described — exit 0. A listed execution is
// described exactly once, and a duplicate blocks before anything is described,
// whether the count agrees with the whole list or with its distinct entries.
const DUPLICATED = {
  'the count matches the list with the duplicate': '2',
  'the count matches the distinct executions': '1',
};
for (const [name, count] of Object.entries(DUPLICATED)) {
  test(`blocks when an execution is listed twice and ${name}`, () => {
    const scenario = {
      ...drained(),
      'workflow count': { stdout: { count } },
      'workflow list': { stdout: [execution('A'), execution('A')] },
      'workflow describe order-B': { stdout: description('B', [pendingHold]) },
    };
    const { status, stdout, stderr, calls } = run(scenario);
    assert.equal(status, 1);
    assert.match(stderr, /cannot verify — deployment blocked: /);
    assert.match(stderr, /temporal workflow list: an execution is listed twice/);
    assert.doesNotMatch(stdout, /OK/);
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2).join(' ')),
      ['task-queue describe', 'workflow count', 'workflow list'],
    );
  });
}

test('passes two runs of one workflow id listed once each, describing each run', () => {
  const runOf = (runId) => ({ ...execution('A'), execution: { workflowId: 'order-A', runId } });
  const describedRun = (runId) => {
    const answer = description('A');
    answer.workflowExecutionInfo.execution.runId = runId;
    return { stdout: answer };
  };
  const scenario = {
    ...drained(),
    'workflow list': { stdout: [runOf('run-A1'), runOf('run-A2')] },
    'workflow describe order-A': { sequence: [describedRun('run-A1'), describedRun('run-A2')] },
  };
  const { status, calls } = run(scenario);
  assert.equal(status, 0);
  const described = calls
    .filter((args) => args[1] === 'describe' && args[0] === 'workflow')
    .map((args) => args[args.indexOf('--run-id') + 1]);
  assert.deepEqual(described, ['run-A1', 'run-A2']);
});

for (const [name, [scenario, options, message]] of Object.entries(UNVERIFIABLE)) {
  test(`blocks when ${name}`, () => {
    const { status, stdout, stderr } = run(scenario, options);
    assert.equal(status, 1);
    assert.match(stderr, /cannot verify — deployment blocked: /);
    assert.match(stderr, message);
    assert.doesNotMatch(stdout, /OK/);
  });
}

// #385 r4: TEMPORAL_CLI's value — a path — is not repeated when it cannot run.
test('blocks on a CLI that cannot run, without printing the configured path', () => {
  for (const sentinel of SENTINELS) {
    const { status, stdout, stderr } = run(drained(), {
      cli: `/nonexistent/${sentinel}/${sentinel.replaceAll('-', '_')}/temporal`,
    });
    assert.equal(status, 1);
    assert.equal(
      stderr,
      'marketplace saga drain check: cannot verify — deployment blocked: temporal task-queue ' +
        'describe: TEMPORAL_CLI could not be run (ENOENT)\n',
    );
    assertNoSentinel(stdout + stderr, sentinel);
  }
});

// Every foreign text channel is opaque, including ordinary successful JSON.
for (const sentinel of SENTINELS) {
  const scenarios = {
    stderr: { ...drained(), 'workflow count': { status: 1, stderr: sentinel } },
    json: { ...drained(), 'workflow count': { stdout: { count: sentinel } } },
    poller: {
      ...drained(),
      'task-queue describe': {
        stdout: {
          pollers: [{ identity: sentinel, taskQueueType: sentinel, lastAccessTime: sentinel }],
          stats,
        },
      },
    },
    activity: {
      ...drained(),
      'workflow describe order-B': {
        stdout: description('B', [
          {
            activityType: { name: sentinel },
            state: sentinel,
            attempt: sentinel,
          },
        ]),
      },
    },
    queue: describedAs('B', (d) => {
      d.executionConfig.taskQueue.name = sentinel;
    }),
    duplicate: {
      ...drained(),
      'workflow list': {
        stdout: [
          { ...execution('A'), execution: { workflowId: sentinel, runId: sentinel } },
          { ...execution('A'), execution: { workflowId: sentinel, runId: sentinel } },
        ],
      },
    },
  };
  for (const [channel, scenario] of Object.entries(scenarios)) {
    test(`Temporal ${channel} never repeats a sentinel`, () => {
      const result = run(scenario);
      assert.equal(result.status, 1);
      assertNoSentinel(result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /OK/);
    });
  }
}

for (const [name, recorded] of Object.entries({
  'unstarted continuation': history({
    resume: { mirroredDispute: 'DSP', status: { remindersRecorded: 7, settlementAttempts: 3 } },
  }),
  'patched history': history({}, [{ id: 'order-saga-durable-rollover-v1', deprecated: false }]),
})) {
  test(`forward-only boundary: refuses incompatible target for ${name} without pending activity`, () => {
    const scenario = drained();
    scenario['workflow show order-A'].stdout = recorded;
    scenario['workflow describe order-A'].stdout.workflowExecutionInfo.historyLength = String(
      recorded.events.length,
    );
    const refused = run(scenario, { target: { name: TARGET_NAME, marketplaceSagaProtocol: 0 } });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /incompatible target build/);
    const legacyRefused = run(scenario, { target: legacyTarget });
    assert.equal(legacyRefused.status, 1);
    assert.match(legacyRefused.stderr, /incompatible target build/);
    assert.equal(run(scenario).status, 0);
  });
}

// ---- Recorded activity results are evidence too (PR-796 r2 F5) ------------------
//
// A worker that recorded a final answer and stopped before the workflow's next task
// leaves a history without the marker. An older workflow reads that answer as the
// call's own effect: `markCancelled` on a paid-out order.
const encoded = (value) =>
  value === undefined ? { metadata: { encoding: 'YmluYXJ5L251bGw=' } } : payload(value);
/** A history of one scheduled activity and its recorded result, as the CLI prints it. */
const withResult = (activity, result = { payloads: [encoded(undefined)] }) => {
  const { events } = history();
  return {
    events: [
      ...events,
      {
        eventId: '2',
        eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED',
        activityTaskScheduledEventAttributes: { activityType: { name: activity } },
      },
      {
        eventId: '3',
        eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED',
        activityTaskCompletedEventAttributes: { scheduledEventId: '2', result },
      },
    ],
  };
};
const showing = (recorded) => {
  const scenario = drained();
  scenario['workflow show order-A'].stdout = recorded;
  scenario['workflow describe order-A'].stdout.workflowExecutionInfo.historyLength = String(
    recorded.events.length,
  );
  return scenario;
};
const atProtocol = (marketplaceSagaProtocol) => ({
  target: { name: TARGET_NAME, marketplaceSagaProtocol },
});
const FINAL_ANSWER = { final: true, status: 'SETTLED', funds: 'PAID_OUT' };
const LATEST_KNOWN = 6;
const producers = {
  compensate: [undefined],
  resolveObligationDispute: [undefined],
  disputeObligation: [undefined, null, 'ECON_DISPUTE'],
  authoriseSettlement: [
    undefined,
    { disputed: true, reason: 'broken' },
    { disputed: true, reason: 'broken', economicDisputeId: null },
    { disputed: true, reason: 'broken', economicDisputeId: 'ECON_DISPUTE' },
  ],
};

test('the review of #796 r2: a settled refund recorded just before the workers stopped', () => {
  // The captured history cut right after `compensate` answered, before its marker.
  const captured = JSON.parse(
    readFileSync(
      new URL(
        '../services/marketplace-service/src/temporal/__fixtures__/order-saga-fu117r2-settled-reconciliation.history.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const events = captured.events.slice(0, 15);
  assert.equal(events[12].activityTaskScheduledEventAttributes.activityType.name, 'compensate');
  assert.deepEqual(
    JSON.parse(
      Buffer.from(
        events[14].activityTaskCompletedEventAttributes.result.payloads[0].data,
        'base64',
      ).toString(),
    ),
    FINAL_ANSWER,
  );
  events[0].workflowExecutionStartedEventAttributes.taskQueue.name = 'rasta-order';
  const scenario = showing({ events });
  const refused = run(scenario, atProtocol(5));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /requires saga protocol 6; incompatible target build/);
  assert.equal(run(scenario, atProtocol(6)).status, 0);
});

for (const [activity, earlier] of Object.entries(producers)) {
  test(`${activity}: a final answer without the marker needs protocol 6`, () => {
    const scenario = showing(withResult(activity, { payloads: [payload(FINAL_ANSWER)] }));
    for (const target of [0, 5]) {
      const refused = run(scenario, atProtocol(target));
      assert.equal(refused.status, 1, `target ${target}`);
      assert.match(refused.stderr, /requires saga protocol 6; incompatible target build/);
    }
    assert.equal(run(scenario, atProtocol(6)).status, 0);
  });

  for (const value of earlier) {
    test(`${activity}: ${JSON.stringify(value)} needs nothing of its own`, () => {
      const scenario = showing(withResult(activity, { payloads: [encoded(value)] }));
      assert.equal(run(scenario, atProtocol(0)).status, 0);
    });
  }

  for (const unknown of [
    { final: false, status: 'SETTLED', funds: 'PAID_OUT' },
    { final: true, status: 'SETTLED' },
    { final: true, status: 7, funds: 'PAID_OUT' },
    { final: true, status: 'SETTLED', funds: 7 },
    { ...FINAL_ANSWER, extra: 1 },
    { something: 'else' },
    [],
    false,
    7,
    ...(activity === 'disputeObligation' ? [] : ['a words answer']),
    ...(activity === 'authoriseSettlement' ? [] : [{ disputed: true, reason: 'broken' }]),
    { disputed: true, reason: 'broken', extra: 1 },
    { disputed: true },
  ]) {
    test(`${activity}: an unknown result ${JSON.stringify(unknown)} blocks every target`, () => {
      const refused = run(
        showing(withResult(activity, { payloads: [payload(unknown)] })),
        atProtocol(LATEST_KNOWN),
      );
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /unknown activity result/);
    });
  }
}

for (const [name, recorded, words] of [
  ['an activity it does not list', withResult('newActivity'), /unknown activity result/],
  [
    'a final answer from a call that never gives one',
    withResult('settle', { payloads: [payload(FINAL_ANSWER)] }),
    /unknown activity result/,
  ],
  ['two results', withResult('compensate', { payloads: [payload(1), payload(2)] }), /unreadable/],
  [
    'a result in another encoding',
    withResult('compensate', { payloads: [{ metadata: { encoding: 'YmluYXJ5L3BsYWlu' } }] }),
    /cannot be read/,
  ],
  [
    'a null encoding that carries data',
    withResult('compensate', {
      payloads: [{ metadata: { encoding: 'YmluYXJ5L251bGw=' }, data: 'e30=' }],
    }),
    /cannot be read/,
  ],
  [
    'a result of no scheduling',
    (() => {
      const orphan = withResult('compensate');
      orphan.events[2].activityTaskCompletedEventAttributes.scheduledEventId = '9';
      return orphan;
    })(),
    /without its scheduling/,
  ],
  [
    'result attributes on another event type',
    (() => {
      const odd = withResult('compensate');
      odd.events[2].eventType = 'EVENT_TYPE_TIMER_FIRED';
      return odd;
    })(),
    /without its scheduling/,
  ],
]) {
  test(`recorded result: ${name} blocks even the latest target`, () => {
    const refused = run(showing(recorded), atProtocol(LATEST_KNOWN));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, words);
  });
}

test('recorded result: a completed event with no result is not taken for a void one', () => {
  const recorded = withResult('compensate');
  delete recorded.events[2].activityTaskCompletedEventAttributes.result;
  const refused = run(showing(recorded), atProtocol(LATEST_KNOWN));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unreadable activity result/);
});

test('the gate lists every activity the saga can schedule', () => {
  const source = readFileSync(
    new URL('../services/marketplace-service/src/temporal/activities.ts', import.meta.url),
    'utf8',
  );
  const names = [];
  const file = ts.createSourceFile('activities.ts', source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'createActivities') {
      const returned = node.body.statements.find(ts.isReturnStatement);
      for (const property of returned.expression.properties) names.push(property.name.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(names.length >= 18, names.join());
  // Absent from the gate's table, a call's result refuses every target.
  const events = [history().events[0]];
  for (const name of names) {
    const [, scheduled, completed] = withResult(name).events;
    const id = events.length + 1;
    events.push(
      { ...scheduled, eventId: String(id) },
      {
        ...completed,
        eventId: String(id + 1),
        activityTaskCompletedEventAttributes: {
          ...completed.activityTaskCompletedEventAttributes,
          scheduledEventId: String(id),
        },
      },
    );
  }
  const answered = run(showing({ events }), atProtocol(0));
  assert.equal(answered.status, 0, answered.stderr);
});

// ---- Every marker the saga records is known to the gate (FU-079) --------------
//
// What a target must declare to run a history carrying each patch id. Adding a
// `patched()` id to the saga without an entry here fails below; the entry then
// fails until the gate knows the id and the manifest declares its protocol.
const PATCHES = {
  'order-saga-durable-rollover-v1': 1,
  'dispute-settle-resumes-order': 2,
  'dispute-release-durable-wait-v1': 3,
  'economic-call-durable-wait-v1': 4,
  'economic-sibling-call-durable-wait-v1': 5,
  'saga-owed-work-durable-v1': 6,
};
const LATEST = Math.max(...Object.values(PATCHES));
const SAGA_SOURCE = new URL('../services/marketplace-service/src/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../package.json', SAGA_SOURCE), 'utf8'));
const WORKFLOWS_FILE = 'temporal/workflows.ts';
// Prisma's output is machine-written and git-ignored, so CI does not have it.
const scannedFiles = (files) =>
  files
    .filter((file) => !file.startsWith('generated/prisma/') && /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => !file.endsWith('.spec.ts'))
    .map((file) => {
      // Read as TypeScript below: another kind of source would be misread or missed.
      assert.ok(file.endsWith('.ts') && !file.endsWith('.d.ts'), `unscannable file: ${file}`);
      return file;
    });
const sagaSources = () =>
  scannedFiles(readdirSync(SAGA_SOURCE, { recursive: true })).map((file) =>
    readFileSync(new URL(file, SAGA_SOURCE), 'utf8'),
  );
const parsed = (source) => ts.createSourceFile('saga.ts', source, ts.ScriptTarget.Latest, true);
const eachNode = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => eachNode(child, visit));
};
const WORKFLOW_MODULE = '@temporalio/workflow';
// What the saga may import from the SDK. Read the SDK before adding one: some
// record a marker of their own. `condition` does, on a zero timeout (see below).
const WORKFLOW_IMPORTS = new Set(
  `ActivityFailure ActivityOptions ApplicationFailure CancellationScope condition continueAsNew
   defineQuery defineSignal deprecatePatch isCancellation patched proxyActivities setHandler sleep
   workflowInfo`.split(/\s+/),
);
// The SDK's other ways to a marker, which the gate refuses, and what reaches them unseen.
const REFUSED_NAMES =
  'proxyLocalActivities scheduleLocalActivity patchInternal __TEMPORAL_ACTIVATOR__ globalThis eval Function';
// `condition(fn, 0)` records `__sdk_internal_patch_number:1` (SDK workflow.js:901). These
// are the timeouts proven non-zero: a client sends hours of at least 1 (env.ts:174), and
// the release backoff is never under a minute, whatever its round (workflows.spec.ts).
const RECHECK = '(input.recheckIntervalHours ?? DEFAULT_RECHECK_HOURS) * HOUR';
const RELEASE_BACKOFF = 'releaseBackoffMs(round)';

/**
 * The compiler's own binder and checker over this one file: a name means what
 * its scope says, not what some declaration of that spelling holds. No imports
 * are followed, so what lives in another file stays unresolved and is refused.
 * The target is the run time's scoping: a parameter default does not see the body.
 */
function checkerOf(file) {
  const host = ts.createCompilerHost({});
  host.getSourceFile = (name) => (name === file.fileName ? file : undefined);
  const target = ts.ScriptTarget.Latest;
  const options = { noLib: true, noResolve: true, types: [], strict: true, target };
  return ts.createProgram({ rootNames: [file.fileName], options, host }).getTypeChecker();
}

/** The initializer of the `const` this identifier binds to; anything else is unproven. */
function constInitializer(argument, checker) {
  if (!argument || !ts.isIdentifier(argument)) return null;
  const declaration = checker().getSymbolAtLocation(argument)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration)) return null;
  const flags = ts.getCombinedNodeFlags(declaration);
  const isConst = (flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
  if (!isConst || flags & ts.NodeFlags.Ambient) return null;
  return declaration.initializer ?? null;
}

/** A patch id is a string literal, or the one `const` that holds one; nothing else is proven. */
function patchIdOf(argument, checker) {
  if (ts.isStringLiteralLike(argument)) return argument.text;
  const initializer = constInitializer(argument, checker);
  return initializer && ts.isStringLiteralLike(initializer) ? initializer.text : null;
}

/** What could add to a scanned interface, or to the compile, from outside the scan. */
function assertAddsNothingElsewhere(name, source) {
  assert.ok(!name.endsWith('.d.ts'), `unscannable declaration file: ${name}`);
  const file = parsed(source);
  const { referencedFiles, typeReferenceDirectives, libReferenceDirectives } = file;
  const references = [referencedFiles, typeReferenceDirectives, libReferenceDirectives].flat();
  assert.equal(references.length, 0, 'unscannable reference directive');
  eachNode(file, (node) => {
    assert.ok(!ts.isModuleDeclaration(node), 'unscannable module or namespace declaration');
  });
}

/** Every patch id in `sources`; any use it cannot read as a plain call throws. */
function patchIdsIn(sources) {
  const ids = new Set();
  for (const source of sources) {
    const file = parsed(source);
    let bound;
    const checker = () => (bound ??= checkerOf(file));
    eachNode(file, (node) => {
      // A computed module name reads as nothing below.
      const dynamic =
        ts.isCallExpression(node) && ['import', 'require'].includes(node.expression.getText());
      assert.ok(!dynamic, 'unscannable dynamic import');
      if (!ts.isIdentifier(node) && !ts.isStringLiteralLike(node)) return;
      const { parent } = node;
      assert.ok(
        node.text === WORKFLOW_MODULE || !node.text.includes(WORKFLOW_MODULE),
        'unscannable SDK path',
      );
      // Specs are not scanned, so production must not load one.
      assert.ok(!/\.spec(\.[cm]?[jt]s)?$/.test(node.text), 'unscannable import of a spec');
      if (node.text === WORKFLOW_MODULE) {
        // Named imports only: a namespace, a default or a re-export hides names.
        const clause = ts.isImportDeclaration(parent) ? parent.importClause : undefined;
        const bindings = clause?.name ? undefined : clause?.namedBindings;
        assert.ok(bindings && ts.isNamedImports(bindings), 'unscannable use of the workflow API');
        for (const { propertyName, name } of bindings.elements) {
          const known = !propertyName && WORKFLOW_IMPORTS.has(name.text);
          assert.ok(known, `unreviewed workflow API: ${name.text}`);
        }
      }
      assert.ok(!REFUSED_NAMES.split(' ').includes(node.text), `refused name: ${node.text}`);
      if (node.text === 'condition') {
        if (ts.isImportSpecifier(parent)) return;
        const isCall =
          ts.isIdentifier(node) && ts.isCallExpression(parent) && parent.expression === node;
        assert.ok(isCall, 'unscannable use of condition');
        const [, timeout, ...others] = parent.arguments;
        const initializer = constInitializer(timeout, checker)?.getText();
        const proven = initializer === RECHECK || initializer === RELEASE_BACKOFF;
        assert.ok(others.length === 0 && (!timeout || proven), 'condition timeout may be zero');
        return;
      }
      if (node.text !== 'patched' && node.text !== 'deprecatePatch') return;
      if (ts.isImportSpecifier(parent) && !parent.propertyName) return;
      assert.ok(
        ts.isIdentifier(node) && ts.isCallExpression(parent) && parent.expression === node,
        `unscannable use of ${node.text}`,
      );
      const [argument] = parent.arguments;
      const id = parent.arguments.length === 1 && patchIdOf(argument, checker);
      assert.ok(id, `patch id cannot be resolved: ${node.text}`);
      ids.add(id);
    });
  }
  return ids;
}

test('every patch id in the saga source has its own protocol; the manifest declares the latest', () => {
  const found = patchIdsIn(sagaSources());
  // A scan that stopped finding them would pass everything below.
  assert.ok(
    found.has('order-saga-durable-rollover-v1') && found.has('dispute-settle-resumes-order'),
  );
  for (const id of found) assert.ok(Object.hasOwn(PATCHES, id), `gate test does not know ${id}`);
  // A new id on an old protocol would pass the previous release, which cannot replay it.
  const protocols = Object.values(PATCHES);
  assert.equal(new Set(protocols).size, protocols.length);
  assert.equal(manifest.marketplaceSagaProtocol, LATEST);
});

test('the source scan refuses what it cannot read, so a marker cannot hide from it', () => {
  const url = "const u = 'http://x'; ";
  assert.deepEqual(
    [
      ...patchIdsIn([
        `const P = 'via-constant';\nimport { patched } from '${WORKFLOW_MODULE}';\npatched(P);\n${url}patched('direct');`,
        "'/*'; patched('between-comment-marks'); '*/'",
      ]),
    ],
    ['via-constant', 'direct', 'between-comment-marks'],
  );
  // The same spelling in two scopes is two ids, each where the compiler binds it.
  assert.deepEqual(
    [
      ...patchIdsIn([
        "function a() { const P = 'one'; patched(P); }\nfunction b() { const P = 'two'; patched(P); }",
        "const Q = 'outer'; { const Q = 'inner'; patched(Q); }",
      ]),
    ],
    ['one', 'two', 'inner'],
  );
  assert.deepEqual(
    [
      ...patchIdsIn([
        'condition(fn);',
        `const ms = ${RECHECK};\ncondition(fn, ms);`,
        `const ms = ${RELEASE_BACKOFF};\ncondition(fn, ms);`,
      ]),
    ],
    [],
  );
  // A parameter default does not see the body's binding at run time, nor here.
  assert.deepEqual(
    [...patchIdsIn(["const P = 'outer'; function f(a = patched(P)) { const P = 'body'; }"])],
    ['outer'],
  );
  for (const source of [
    "import { patched as p } from 'x';",
    'const p = patched;',
    "import { patched } from 'x';\nconst p = patched;\np('hidden');",
    "wf['patched']('hidden');",
    "wf.patched('hidden');",
    `import * as wf from '${WORKFLOW_MODULE}';\nwf[k]('hidden');`,
    `import wf from '${WORKFLOW_MODULE}';`,
    `export * from '${WORKFLOW_MODULE}';`,
    `const wf = require('${WORKFLOW_MODULE}');`,
    "patched('one', 'two');",
    'patched();',
    'patched(computed());',
    'patched(unresolved);',
    'deprecatePatch(unresolved);',
    'proxyLocalActivities({});',
    `import { uuid4 } from '${WORKFLOW_MODULE}';`,
    `import { default as wf } from '${WORKFLOW_MODULE}';`,
    `import wf, { sleep } from '${WORKFLOW_MODULE}';`,
    `import * as wf from '${WORKFLOW_MODULE}/lib/workflow';`,
    "wf.scheduleLocalActivity('x', []);",
    "activator.patchInternal('hidden', false);",
    "x['__TEMPORAL_ACTIVATOR__'];",
    "(globalThis as any)['__TEMPORAL_' + 'ACTIVATOR__'];",
    "(0, eval)('code');",
    "new Function('code');",
    "import('@temporalio/' + name);",
    "require('@temporalio/' + name);",
    `import * as wf from '../../node_modules/${WORKFLOW_MODULE}';`,
    "import { mark } from './mark.spec';",
    `import { condition as sleep } from '${WORKFLOW_MODULE}';`,
    'const wait = condition;',
    'condition(fn, 0);',
    'const ms = 0;\ncondition(fn, ms);',
    `let ms = ${RECHECK};\ncondition(fn, ms);`,
    `const ms = Math.max(0, ${RECHECK});\ncondition(fn, ms);`,
    'const ms = releaseBackoffMs(round) - HOUR;\ncondition(fn, ms);',
    'const ms = releaseBackoffMs(other);\ncondition(fn, ms);',
    `let ms = ${RELEASE_BACKOFF};\ncondition(fn, ms);`,
    `const ms = ${RECHECK};\ncondition(fn, ms, opts);`,
  ]) {
    assert.throws(() => patchIdsIn([source]), assert.AssertionError, source);
  }
});

// Review of #728 r1: these passed the scan, which took the initializer of any
// variable of that spelling, while the saga recorded another marker at run time.
const KNOWN_ID = 'order-saga-durable-rollover-v1';
const HIDDEN_IDS = {
  'a reassigned variable': (call) => `let P = '${KNOWN_ID}';\nP = 'future';\n${call}(P);`,
  'a shadowing parameter': (call) =>
    `const P = '${KNOWN_ID}';\nfunction step(P: string) { ${call}(P); }\nstep('future');`,
  'an uninitialized shadowing variable': (call) =>
    `const P = '${KNOWN_ID}';\nfunction step() { let P: string; P = 'future'; ${call}(P); }`,
};
for (const [name, source] of Object.entries(HIDDEN_IDS)) {
  for (const call of ['patched', 'deprecatePatch']) {
    test(`the source scan refuses ${call}() of ${name}`, () => {
      assert.throws(() => patchIdsIn([source(call)]), /patch id cannot be resolved/);
    });
  }
}

test('a patch id is only ever a literal or the one const holding one', () => {
  for (const binding of [
    "let P = 'x';",
    "var P = 'x';",
    'let P;',
    "declare const P = 'x';",
    "const P = 'x' as string;",
    'const P = `x${y}`;',
    "const P = 'x' + 'y';",
    "const Q = 'x'; const P = Q;",
    "const { P = 'x' } = o;",
    "const [P = 'x'] = o;",
    "using P = 'x';",
    "await using P = 'x';",
    "for (const P of ['x']) patched(P);",
    'try {} catch (P) { patched(P); }',
    'function P() {}',
    'enum P { x }',
    "import { P } from './elsewhere';",
  ]) {
    const source = `${binding}\npatched(P);`;
    assert.throws(() => patchIdsIn([source]), /patch id cannot be resolved/, source);
  }
  for (const argument of ['...P', "('x')", "'x' as string", 'o.P', '`x${y}`']) {
    const source = `const P = 'x';\npatched(${argument});`;
    assert.throws(() => patchIdsIn([source]), /patch id cannot be resolved/, source);
  }
  for (const file of ['a.js', 'a.mjs', 'a.tsx', 'a.d.ts', 'temporal/a.js', 'generated/a.js']) {
    assert.throws(() => scannedFiles([file]), /unscannable file/, file);
  }
  assert.deepEqual(scannedFiles(['a.ts', 'a.spec.ts', 'generated/prisma/a.js', 'a.json', 'dir']), [
    'a.ts',
  ]);
});

function assertServiceAddsNothing(listing, read) {
  const outsideScan = /^(node_modules|dist|src\/generated\/prisma)\//;
  const files = listing.filter((file) => /\.[cm]?ts$/.test(file) && !outsideScan.test(file));
  // The specs too: a production import of one would apply what it declares.
  assert.ok(files.includes(`src/${WORKFLOWS_FILE}`) && files.some((f) => f.endsWith('.spec.ts')));
  for (const file of files) assertAddsNothingElsewhere(file, read(file));
}

test('nothing in the service adds to a scanned interface from outside the scan', () => {
  const service = new URL('../', SAGA_SOURCE);
  assertServiceAddsNothing(readdirSync(service, { recursive: true }), (file) =>
    readFileSync(new URL(file, service), 'utf8'),
  );
  for (const file of ['test/a.spec.ts', 'src/generated/a.ts', 'dev/a.ts']) {
    const listing = [`src/${WORKFLOWS_FILE}`, 'src/b.spec.ts', file];
    const read = (name) => (name === file ? 'declare global {}' : '');
    assert.throws(() => assertServiceAddsNothing(listing, read), /module or namespace/, file);
  }
  for (const source of [
    "declare module './temporal/workflows' { interface SagaResume { future: string } }",
    'declare global { interface SagaResume { future: string } }',
    'namespace N { export const x = 1; }',
  ]) {
    assert.throws(() => assertAddsNothingElsewhere('a.ts', source), /module or namespace/, source);
  }
  for (const directive of ['path="../a.d.ts"', 'types="a"', 'lib="dom"']) {
    const source = `/// <reference ${directive} />\nexport {};`;
    assert.throws(() => assertAddsNothingElsewhere('a.ts', source), /reference directive/, source);
  }
  for (const name of ['test/a.d.ts', 'b.d.ts']) {
    assert.throws(() => assertAddsNothingElsewhere(name, ''), /declaration file/, name);
  }
});

function withHistory(recorded) {
  const scenario = drained();
  scenario['workflow show order-A'].stdout = recorded;
  scenario['workflow describe order-A'].stdout.workflowExecutionInfo.historyLength = String(
    recorded.events.length,
  );
  return scenario;
}
const targetOf = (marketplaceSagaProtocol) => ({
  target: { name: TARGET_NAME, marketplaceSagaProtocol },
});

for (const [id, protocol] of Object.entries(PATCHES)) {
  test(`marker ${id} needs protocol ${protocol}: passes the real manifest, blocks below`, () => {
    const scenario = withHistory(history({}, [{ id, deprecated: false }]));
    assert.equal(run(scenario, { target: manifest }).status, 0);
    assert.equal(run(scenario, targetOf(protocol)).status, 0);
    const below = run(scenario, targetOf(protocol - 1));
    assert.equal(below.status, 1);
    assert.match(below.stderr, new RegExp(`requires saga protocol ${protocol}; incompatible`));
  });
}

test('the highest protocol in a history decides, in either order', () => {
  const markers = [
    { id: 'order-saga-durable-rollover-v1', deprecated: false },
    { id: 'dispute-settle-resumes-order', deprecated: true },
  ];
  for (const recorded of [markers, [...markers].reverse()]) {
    const scenario = withHistory(history({}, recorded));
    assert.equal(run(scenario, targetOf(1)).status, 1);
    assert.equal(run(scenario, targetOf(2)).status, 0);
  }
});

for (const id of ['unknown', 'constructor', '__proto__', 'dispute-settle-resumes-order-v2', 7]) {
  test(`refuses unknown marker ${id} even for the latest target`, () => {
    const result = run(withHistory(history({}, [{ id, deprecated: false }])), targetOf(LATEST));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown compatibility marker/);
  });
}

test('a missing marker id or flag is refused, known id or not', () => {
  for (const patch of [{ deprecated: false }, { id: 'dispute-settle-resumes-order' }]) {
    const result = run(withHistory(history({}, [patch])), targetOf(LATEST));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown compatibility marker/);
  }
});

test('a continuation carries its writer protocol before its first marker', () => {
  const written = withHistory(history({ resume: { activitySequence: 1, reminderDue: [] } }));
  assert.match(run(written, targetOf(1)).stderr, /requires saga protocol 2; incompatible/);
  assert.equal(run(written, targetOf(2)).status, 0);
  const before = withHistory(history({ resume: { activitySequence: 1 } }));
  assert.equal(run(before, targetOf(1)).status, 0);
});

/**
 * The property signatures a type node stands for, read only from syntax whose
 * meaning cannot depend on anything outside this file: this file's own plain
 * interfaces and type literals, `extends` and `&`. This one-file checker gets the
 * rest wrong (a conditional on an import or a lib type, an overload, a generic),
 * so all else is refused rather than evaluated.
 */
function membersOf(checker, node, what) {
  const refuse = () => assert.fail(`cannot enumerate ${what}: ${node.getText()}`);
  const listed = (members) =>
    members.map((member) =>
      ts.isPropertySignature(member) && ts.isIdentifier(member.name) ? member : refuse(),
    );
  if (ts.isIntersectionTypeNode(node)) {
    return node.types.flatMap((part) => membersOf(checker, part, what));
  }
  if (ts.isTypeLiteralNode(node)) return listed(node.members);
  const name = ts.isTypeReferenceNode(node)
    ? node.typeName
    : ts.isExpressionWithTypeArguments(node)
      ? node.expression
      : null;
  if (!name || !ts.isIdentifier(name)) refuse();
  const declarations = checker.getSymbolAtLocation(name)?.declarations ?? [];
  const plain = (found) => ts.isInterfaceDeclaration(found) && !found.typeParameters;
  if (declarations.length === 0 || !declarations.every(plain)) refuse();
  return declarations.flatMap(({ members, heritageClauses = [] }) => [
    ...listed(members),
    ...heritageClauses
      .flatMap((clause) => [...clause.types])
      .flatMap((base) => membersOf(checker, base, what)),
  ]);
}

/** Every field `orderSaga` in `source` takes, read from its one declaration, not a name. */
function sagaFields(source) {
  const file = parsed(source);
  const checker = checkerOf(file);
  const [saga, ...overloads] = file.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'orderSaga',
  );
  const isExport = ({ kind }) => kind === ts.SyntaxKind.ExportKeyword;
  const isDefault = ({ kind }) => kind === ts.SyntaxKind.DefaultKeyword;
  assert.ok(
    saga?.modifiers?.some(isExport) && !saga.modifiers.some(isDefault),
    'no exported orderSaga',
  );
  const [parameter, ...others] = saga.parameters;
  assert.ok(
    overloads.length === 0 &&
      others.length === 0 &&
      parameter?.type &&
      !parameter.dotDotDotToken &&
      !parameter.questionToken &&
      !parameter.initializer,
    'orderSaga must take exactly one input',
  );
  const input = membersOf(checker, parameter.type, 'the saga input');
  const resumes = input.filter((member) => member.name.text === 'resume');
  assert.ok(resumes.length === 1 && resumes[0].type, 'the saga input must have one typed resume');
  const names = (members) => members.map((member) => member.name.text);
  return {
    input: names(input),
    resume: names(membersOf(checker, resumes[0].type, 'the saga resume')),
  };
}

const RESUME_FIELDS = {
  status: 1,
  mirroredDispute: 1,
  mirroredEconomicDispute: 1,
  waitingIn: 1,
  nextReminderAt: 1,
  activitySequence: 1,
  reminderDue: 2,
  releaseRounds: 3,
  unconfirmedCall: 4,
  siblingCall: 5,
  outstandingWork: 6,
};

function assertResumeFieldsKnown(fields) {
  for (const field of fields) {
    const protocol = RESUME_FIELDS[field];
    assert.ok(protocol, `gate test does not know resume.${field}`);
    const known = withHistory(history({ resume: { [field]: 1 } }));
    assert.equal(run(known, targetOf(protocol)).status, 0, `gate does not know resume.${field}`);
    assert.equal(run(known, targetOf(protocol - 1)).status, 1, `resume.${field} needs ${protocol}`);
  }
}

function assertInputFieldsKnown(fields) {
  for (const field of fields.filter((name) => name !== 'resume')) {
    const known = withHistory(history({ [field]: 1 }));
    assert.equal(run(known, targetOf(0)).status, 0, `gate does not know input.${field}`);
  }
}

/** The saga's own source with `edits` applied; each must actually change it. */
function sagaSourceWith(...edits) {
  let source = readFileSync(new URL(WORKFLOWS_FILE, SAGA_SOURCE), 'utf8');
  for (const [from, to] of edits) {
    assert.ok(source.includes(from), `the saga source no longer has: ${from}`);
    source = source.replace(from, to);
  }
  return source;
}

test('every field the saga continues with needs its protocol, and any other is refused', () => {
  const { resume: fields } = sagaFields(sagaSourceWith());
  // A scan that stopped finding them would pass everything below.
  assert.deepEqual(fields.toSorted(), Object.keys(RESUME_FIELDS).toSorted());
  assert.ok(Math.max(...Object.values(RESUME_FIELDS)) <= manifest.marketplaceSagaProtocol);
  assertResumeFieldsKnown(fields);
  for (const resume of [{ another: 1 }, null, []]) {
    const result = run(withHistory(history({ resume })), targetOf(LATEST));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown continuation state|invalid start input/);
  }
});

test('every field a saga starts with is known, and any other is refused', () => {
  const { input: fields } = sagaFields(sagaSourceWith());
  assert.ok(fields.includes('orderId') && fields.includes('resume'));
  assertInputFieldsKnown(fields);
  const unknown = run(withHistory(history({ anotherField: 1 })), targetOf(LATEST));
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /invalid start input/);
});

// Review of #728 r1: `extends` added a field the inventory, which read only the
// members written in the interface's own body, never saw.
const RESUME = 'export interface SagaResume {';
const INPUT = 'export interface OrderSagaInput {';
const PROP = 'resume?: SagaResume;';
const ARG = 'orderSaga(input: OrderSagaInput)';
const ADD = [RESUME, `interface Added { futureField: string }\n${RESUME}`];
const viaBase = (base) => `export interface SagaResume extends ${base} {`;
const FN = ARG.replace('orderSaga', 'function orderSaga');
const ONE = /exactly one input/;
const onResume = (declared, type) => [
  ADD,
  [RESUME, `${declared}\n${RESUME}`],
  [PROP, `resume?: ${type};`],
];
const IMPORT = "import type { F } from './f';";
const EITHER = (on) => `string extends ${on} ? SagaResume : SagaResume & Added;`;
const PICK = 'function f(x: string): SagaResume;\nfunction f(x: number): Added;\nconst r = f(v);';

test('SagaResume extends Added: the inherited field fails the inventory', () => {
  const { resume } = sagaFields(sagaSourceWith(ADD, [RESUME, viaBase('Added')]));
  assert.ok(resume.includes('futureField'));
  assert.throws(() => assertResumeFieldsKnown(resume), /does not know resume\.futureField/);
});

test('OrderSagaInput extends Added: the inherited field fails the inventory', () => {
  const extended = [INPUT, 'export interface OrderSagaInput extends Added {'];
  const { input } = sagaFields(sagaSourceWith(ADD, extended));
  assert.ok(input.includes('futureField'));
  assert.throws(() => assertInputFieldsKnown(input), /does not know input\.futureField/);
});

for (const [name, side, edits] of [
  ['a chain', 'resume', [ADD, [RESUME, `interface Mid extends Added {}\n${viaBase('Mid')}`]]],
  ['a merged declaration', 'resume', [[RESUME, `${RESUME} futureField: string }\n${RESUME}`]]],
  ['an intersected property', 'resume', [ADD, [PROP, 'resume?: SagaResume & Added;']]],
  ['another type on the property', 'resume', [ADD, [PROP, 'resume?: Added;']]],
  ['an intersected signature', 'input', [ADD, [ARG, 'orderSaga(input: OrderSagaInput & Added)']]],
]) {
  test(`the field inventory sees a field added by ${name}`, () => {
    assert.ok(sagaFields(sagaSourceWith(...edits))[side].includes('futureField'));
  });
}

for (const [name, edits, reason = /cannot enumerate the saga (input|resume)/] of [
  ['an imported base', [[RESUME, `import type { O } from './o';\n${viaBase('O')}`]]],
  ['a missing base', [[RESUME, viaBase('Missing')]]],
  ['an index signature', [[RESUME, `${RESUME}\n  [field: string]: unknown;`]]],
  ['a computed member', [[RESUME, `const KEY = 'x';\n${RESUME}\n  [KEY]: string;`]]],
  ['a union', [ADD, [PROP, 'resume?: SagaResume | Added;']]],
  ['a mapped type', [[PROP, "resume?: { [K in 'x']: string };"]]],
  ['an untyped property', [[PROP, 'resume?: any;']]],
  ['an untyped input', [[ARG, 'orderSaga(input: any)']]],
  ['a second parameter', [[ARG, `${ARG.slice(0, -1)}, more: string)`]], /exactly one input/],
  ['no export', [['export async function orderSaga', 'async function orderSaga']], /no exported/],
  [
    'a default export',
    [['export async function orderSaga', 'export default async function orderSaga']],
    /no exported/,
  ],
  // The real compile lists futureField in the first four; this one-file checker did not.
  ['a conditional on an import', onResume(`${IMPORT} type C = ${EITHER('F')}`, 'C')],
  ['a conditional on a lib type', onResume(`type C = ${EITHER("Lowercase<'A'>")}`, 'C')],
  ['a conditional base', [ADD, [RESUME, `type C = ${EITHER('F')}\n${viaBase('C')}`]]],
  ['an overload picked by an import', onResume(`${IMPORT} ${PICK}`, 'typeof r')],
  [
    'an overloaded saga',
    [[`export async ${FN}`, `export async ${FN}: string;\nexport async ${FN}`]],
    ONE,
  ],
  ['a lib type on a base', [ADD, [RESUME, viaBase('Partial<Added>')]]],
  ['a generic base', [[RESUME, `interface G<T> { f: T }\n${viaBase('G')}`]]],
  [
    'a type parameter',
    [ADD, [INPUT, `${INPUT.slice(0, -2)}<T = Added> {`], [PROP, `${PROP.slice(0, -1)} & T;`]],
  ],
  ['a generic saga', [[ARG, 'orderSaga<T extends OrderSagaInput>(input: T)']]],
  ['a class base', [[RESUME, `class C { futureField = 1 }\n${viaBase('C')}`]]],
  ['an optional input', [[ARG, 'orderSaga(input?: OrderSagaInput)']], ONE],
  ['a rest input', [[ARG, 'orderSaga(...input: [OrderSagaInput])']], ONE],
  ['a default input', [[ARG, 'orderSaga(input: OrderSagaInput = o)']], ONE],
  [
    'two resumes',
    [[ARG, 'orderSaga(input: OrderSagaInput & { resume?: Added })']],
    /one typed resume/,
  ],
]) {
  test(`the field inventory refuses ${name}`, () => {
    const source = sagaSourceWith(...edits);
    assert.throws(() => sagaFields(source), reason);
  });
}

test('a continuation rolled over in the wait of an authorisation needs protocol 4', () => {
  const rolled = withHistory(
    history({
      resume: {
        activitySequence: 1,
        unconfirmedCall: { operation: 'authoriseSettlement', rounds: 2 },
      },
    }),
  );
  assert.match(run(rolled, targetOf(3)).stderr, /requires saga protocol 4; incompatible/);
  assert.equal(run(rolled, targetOf(4)).status, 0);
});

test('a continuation rolled over in the wait of a filing or refund needs protocol 5', () => {
  const rolled = withHistory(
    history({
      resume: {
        activitySequence: 1,
        siblingCall: { operation: 'compensate', rounds: 2, transactionId: 'T' },
      },
    }),
  );
  assert.match(run(rolled, targetOf(4)).stderr, /requires saga protocol 5; incompatible/);
  assert.equal(run(rolled, targetOf(5)).status, 0);
});

test('a continuation carrying owed work needs protocol 6', () => {
  const rolled = withHistory(
    history({
      resume: {
        activitySequence: 1,
        outstandingWork: { operation: 'settle', rounds: 1 },
      },
    }),
  );
  assert.match(run(rolled, targetOf(5)).stderr, /requires saga protocol 6; incompatible/);
  assert.equal(run(rolled, targetOf(6)).status, 0);
});

test('a continuation rolled over in the release wait needs protocol 3', () => {
  const rolled = withHistory(history({ resume: { activitySequence: 1, releaseRounds: 2 } }));
  assert.match(run(rolled, targetOf(2)).stderr, /requires saga protocol 3; incompatible/);
  assert.equal(run(rolled, targetOf(3)).status, 0);
});

// The SDK's own markers, not this file's idea of them.
for (const [name, required] of [
  ['pre-fu080-release-refused', 2],
  ['fu080-release-wait', 3],
  ['fu103-authorise-wait', 4],
  ['fu103-wait-then-refund-exhausted', 4],
  ['fu103-wait-then-dispute-exhausted', 4],
  ['fu117-compensate-wait', 5],
  ['fu117-dispute-wait', 5],
]) {
  test(`a real captured history (${name}) requires protocol ${required}`, () => {
    const real = JSON.parse(
      readFileSync(new URL(`temporal/__fixtures__/order-saga-${name}.history.json`, SAGA_SOURCE)),
    );
    const scenario = withHistory(real);
    scenario['workflow count'] = { stdout: { count: '1' } };
    scenario['workflow list'] = { stdout: [execution('A')] };
    const queue = real.events[0].workflowExecutionStartedEventAttributes.taskQueue.name;
    scenario['workflow describe order-A'].stdout.executionConfig.taskQueue.name = queue;
    const settings = { ...SETTINGS, MARKETPLACE_TEMPORAL_TASK_QUEUE: queue };
    assert.equal(run(scenario, { settings, ...targetOf(required) }).status, 0);
    const below = run(scenario, { settings, ...targetOf(required - 1) });
    assert.equal(below.status, 1);
    assert.match(below.stderr, new RegExp(`requires saga protocol ${required}; incompatible`));
  });
}

test('legacy-only histories accept an explicitly declared legacy target', () => {
  assert.equal(
    run(drained(), { target: { name: TARGET_NAME, marketplaceSagaProtocol: 0 } }).status,
    0,
  );
});

test('legacy-only histories accept the unmodified origin/main pre-protocol target', () => {
  assert.equal(legacyTarget.name, TARGET_NAME);
  assert.equal(Object.hasOwn(legacyTarget, 'marketplaceSagaProtocol'), false);
  const result = run(drained(), { target: legacyTarget });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OK — no poller/);
});

for (const value of ['1', '0', LATEST + 1, -1, 0.5, null, false, {}, []]) {
  test(`refuses malformed or unknown target protocol ${JSON.stringify(value)} before querying`, () => {
    const result = run(drained(), {
      target: { name: TARGET_NAME, marketplaceSagaProtocol: value },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /compatibility declaration is unsupported/);
    assert.deepEqual(result.calls, []);
  });
}
for (const target of [
  { name: '@rasta/economic-service', marketplaceSagaProtocol: 1 },
  { name: '@rasta/economic-service' },
  { marketplaceSagaProtocol: 1 },
  {},
  null,
  [],
]) {
  test(`refuses wrong or missing target manifest name ${JSON.stringify(target)} before querying`, () => {
    const result = run(drained(), { target });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /target manifest is not marketplace-service/);
    assert.deepEqual(result.calls, []);
  });
}
test('refuses unreadable or omitted target manifest', () => {
  for (const path of ['', '/nonexistent/target.json']) {
    assert.equal(
      run(drained(), { settings: { ...SETTINGS, MARKETPLACE_TARGET_PACKAGE_JSON: path } }).status,
      1,
    );
  }
});
test('refuses unreadable histories, inputs and compatibility markers', () => {
  const unreadable = history();
  unreadable.events[0].workflowExecutionStartedEventAttributes.input.payloads = [{}];
  for (const bad of [
    {},
    { events: [] },
    unreadable,
    history({}, [null]),
    history({}, [{ id: 'unknown', deprecated: false }]),
    history({}, [{ id: 'order-saga-durable-rollover-v1' }]),
  ]) {
    const scenario = { ...drained(), 'workflow show order-A': { stdout: bad } };
    scenario['workflow describe order-A'].stdout.workflowExecutionInfo.historyLength = String(
      bad.events?.length,
    );
    assert.equal(run(scenario).status, 1);
  }
  const truncated = drained();
  truncated['workflow describe order-A'].stdout.workflowExecutionInfo.historyLength = '2';
  assert.equal(run(truncated).status, 1);
});

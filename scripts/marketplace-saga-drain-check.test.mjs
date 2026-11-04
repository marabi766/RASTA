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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  { settings = SETTINGS, cli, target = { name: TARGET_NAME, marketplaceSagaProtocol: 1 } } = {},
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

for (const value of ['1', '0', 2, -1, 0.5, null, false, {}, []]) {
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

#!/usr/bin/env node
/**
 * The deployment gate of D-053: run after every replica of the previous
 * marketplace-service is stopped and before any replica of the new one starts.
 * See docs/runbooks/marketplace-saga-deploy.md.
 *
 * Passes (exit 0) only when Temporal shows, for the namespace and task queue
 * given, that
 *   1. no worker polls the order task queue (the old worker is really gone,
 *      so nothing can start an activity between this check and the switch);
 *   2. visibility lists exactly as many running `orderSaga` workflows as it
 *      counts (`workflow list` against `workflow count`, before and after);
 *   3. not one of them has a pending activity (`workflow describe`, one by
 *      one: visibility does not index pending activities).
 * Exit 1: a poller or a pending activity was found. Exit 2: anything could not
 * be checked — a missing setting, the CLI absent or failing, output it does
 * not recognise. Both block the deployment; there is no exception.
 *
 * Settings, all required (no default: a check against the wrong namespace or
 * queue finds nothing and would pass): TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE,
 * MARKETPLACE_TEMPORAL_TASK_QUEUE — the values the service runs with. TLS or
 * an API key: the `temporal` CLI's own TEMPORAL_* variables, inherited.
 * TEMPORAL_CLI overrides the binary (default `temporal` on PATH).
 */
import { spawnSync } from 'node:child_process';

const QUERY = 'WorkflowType="orderSaga" AND ExecutionStatus="Running"';
const CLI_TIMEOUT_MS = 60_000;

class Unverifiable extends Error {}

function setting(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Unverifiable(`${name} is not set`);
  return value;
}

function temporal(cli, args) {
  const result = spawnSync(cli, args, {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
  const command = `temporal ${args.slice(0, 2).join(' ')}`;
  if (result.error) throw new Unverifiable(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim().split('\n').at(-1) ?? '';
    throw new Unverifiable(`${command} exited ${result.status ?? result.signal}: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Unverifiable(`${command} did not print JSON`);
  }
}

function countRunning(cli, common) {
  const answer = temporal(cli, [
    'workflow',
    'count',
    ...common,
    '--query',
    QUERY,
    '--output',
    'json',
  ]);
  const count = Number(answer?.count ?? Number.NaN);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Unverifiable('temporal workflow count: no count in its answer');
  }
  return count;
}

function check() {
  const cli = process.env.TEMPORAL_CLI?.trim() || 'temporal';
  const address = setting('TEMPORAL_ADDRESS');
  const namespace = setting('TEMPORAL_NAMESPACE');
  const taskQueue = setting('MARKETPLACE_TEMPORAL_TASK_QUEUE');
  const common = ['--address', address, '--namespace', namespace];
  const blockers = [];

  const queue = temporal(cli, [
    'task-queue',
    'describe',
    ...common,
    '--task-queue',
    taskQueue,
    '--output',
    'json',
  ]);
  if (queue === null || typeof queue !== 'object' || !Array.isArray(queue.pollers ?? [])) {
    throw new Unverifiable('temporal task-queue describe: no poller list in its answer');
  }
  for (const poller of queue.pollers ?? []) {
    blockers.push(
      `task queue ${taskQueue} has a poller ${poller.identity ?? '?'} ` +
        `(${poller.taskQueueType ?? '?'}, last seen ${poller.lastAccessTime ?? '?'})`,
    );
  }

  const before = countRunning(cli, common);
  const listed = temporal(cli, [
    'workflow',
    'list',
    ...common,
    '--query',
    QUERY,
    '--output',
    'json',
  ]);
  if (!Array.isArray(listed)) throw new Unverifiable('temporal workflow list: not a list');
  if (listed.length !== before) {
    throw new Unverifiable(
      `visibility counts ${before} running order sagas but lists ${listed.length}`,
    );
  }

  for (const entry of listed) {
    const workflowId = entry?.execution?.workflowId;
    const runId = entry?.execution?.runId;
    if (
      typeof workflowId !== 'string' ||
      typeof runId !== 'string' ||
      entry?.type?.name !== 'orderSaga'
    ) {
      throw new Unverifiable('temporal workflow list: an entry without an orderSaga execution');
    }
    const described = temporal(cli, [
      'workflow',
      'describe',
      ...common,
      '--workflow-id',
      workflowId,
      '--run-id',
      runId,
      '--output',
      'json',
    ]);
    // An empty list is omitted from the JSON; anything else that is not a list
    // is not an answer.
    const pending = described?.pendingActivities ?? [];
    if (
      described?.workflowExecutionInfo?.execution?.workflowId !== workflowId ||
      !Array.isArray(pending)
    ) {
      throw new Unverifiable(`temporal workflow describe ${workflowId}: not a description of it`);
    }
    for (const activity of pending) {
      blockers.push(
        `${workflowId} has a pending activity ${activity?.activityType?.name ?? '?'} ` +
          `(${activity?.state ?? '?'}, attempt ${activity?.attempt ?? '?'})`,
      );
    }
  }

  const after = countRunning(cli, common);
  if (after !== before) {
    throw new Unverifiable(`running order sagas went from ${before} to ${after} during the check`);
  }
  return { running: before, blockers };
}

try {
  const { running, blockers } = check();
  if (blockers.length > 0) {
    console.error(`marketplace saga drain check: BLOCKED — ${blockers.length} finding(s):`);
    for (const blocker of blockers) console.error(`  ${blocker}`);
    process.exit(1);
  }
  console.log(
    `marketplace saga drain check: OK — no poller, ${running} running order saga(s), no pending activity`,
  );
} catch (error) {
  const reason = error instanceof Unverifiable ? error.message : String(error?.stack ?? error);
  console.error(`marketplace saga drain check: BLOCKED — could not verify: ${reason}`);
  process.exit(2);
}

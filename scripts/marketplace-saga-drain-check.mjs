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
 *   2. visibility lists exactly as many running `orderSaga` executions as it
 *      counts, none twice (`workflow list` against `workflow count`, before
 *      and after; a (workflow id, run id) listed twice is unverifiable);
 *   3. not one of them has a pending activity (`workflow describe`, each
 *      listed run exactly once: visibility does not index pending activities).
 * Exit 1: a poller or a pending activity was found. Exit 2: anything could not
 * be checked — a missing setting, the CLI absent or failing, output it does
 * not recognise. Both block the deployment; there is no exception.
 *
 * Every answer is checked against the shape the pinned CLI prints (the
 * `temporal` of temporalio/auto-setup:1.26.2, captured against a dev server)
 * before anything is read from it; nothing missing is taken for "none" unless
 * that CLI leaves it out for exactly that reason (Codex r3 on #283):
 *   workflow count       {"count": "<n>"}, and {} for zero (proto3 omits a 0)
 *   task-queue describe  {"pollers": null | [...], "stats": [...], ...}
 *   workflow describe    {"executionConfig": {"taskQueue": {"name"}},
 *                         "workflowExecutionInfo": {"execution": {workflowId,
 *                         runId}, "type": {"name"}}, "pendingActivities"
 *                         left out when there is none}
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

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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
  const count = countOf(answer);
  if (count === null) {
    throw new Unverifiable(`temporal workflow count: not a count: ${JSON.stringify(answer)}`);
  }
  return count;
}

/** The count in an answer of the pinned CLI, or null for anything else. */
function countOf(answer) {
  if (!isRecord(answer) || Object.keys(answer).some((key) => key !== 'count')) return null;
  if (!Object.hasOwn(answer, 'count')) return 0;
  const { count } = answer;
  if (typeof count === 'string' && /^[0-9]+$/.test(count)) {
    const value = Number(count);
    return Number.isSafeInteger(value) ? value : null;
  }
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
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
  if (
    !isRecord(queue) ||
    !Object.hasOwn(queue, 'pollers') ||
    !(queue.pollers === null || Array.isArray(queue.pollers)) ||
    !Array.isArray(queue.stats)
  ) {
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
  // Every entry is checked, and no execution may be listed twice, before the
  // list is compared with the count or anything is described: a duplicate
  // could otherwise make up the number for a run that is not listed at all,
  // which would then never be described (Codex r4 on #283).
  const executions = [];
  const seen = new Set();
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
    const identity = JSON.stringify([workflowId, runId]);
    if (seen.has(identity)) {
      throw new Unverifiable(`temporal workflow list: ${workflowId} ${runId} is listed twice`);
    }
    seen.add(identity);
    executions.push({ workflowId, runId });
  }
  if (executions.length !== before) {
    throw new Unverifiable(
      `visibility counts ${before} running order sagas but lists ${executions.length}`,
    );
  }

  for (const { workflowId, runId } of executions) {
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
    // Proof only about this very run: the same workflow id AND run id, an
    // orderSaga on the queue whose pollers were checked. An empty list is
    // omitted from the JSON; anything else that is not a list is not an answer.
    const info = isRecord(described) ? described.workflowExecutionInfo : undefined;
    const pending = isRecord(described)
      ? Object.hasOwn(described, 'pendingActivities')
        ? described.pendingActivities
        : []
      : undefined;
    if (
      info?.execution?.workflowId !== workflowId ||
      info?.execution?.runId !== runId ||
      info?.type?.name !== 'orderSaga' ||
      !Array.isArray(pending)
    ) {
      throw new Unverifiable(
        `temporal workflow describe ${workflowId} ${runId}: not a description of that run`,
      );
    }
    const queueOfRun = described.executionConfig?.taskQueue?.name;
    if (queueOfRun !== taskQueue) {
      throw new Unverifiable(
        `${workflowId} runs on task queue ${JSON.stringify(queueOfRun)}, not ${taskQueue}: ` +
          'its pollers were not checked',
      );
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
  console.error(`marketplace saga drain check: cannot verify — deployment blocked: ${reason}`);
  process.exit(2);
}

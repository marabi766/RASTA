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
 *      listed run exactly once: visibility does not index pending activities);
 *   4. every complete history is compatible with the declared target build,
 *      including patch markers and not-yet-started continued runs with resume.
 * Exit 1: a poller or a pending activity was found, or anything could not
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
 * MARKETPLACE_TARGET_PACKAGE_JSON is the package.json extracted from the target
 * image, whose name must be @rasta/marketplace-service. marketplaceSagaProtocol
 * is 0 (legacy) or 1; an absent field means 0. Always run this gate from the
 * newest of the running and target releases, never the rollback target checkout.
 * TEMPORAL_CLI overrides the binary (default `temporal` on PATH).
 */
import {
  commandFailure,
  clientFailureCode,
  markRefusal,
} from '../packages/config/src/command-failure.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const QUERY = 'WorkflowType="orderSaga" AND ExecutionStatus="Running"';
const CLI_TIMEOUT_MS = 60_000;

class Unverifiable extends Error {}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function setting(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Unverifiable(`${name} is not set`);
  return value;
}

/** A spawn failure's errno name (`ENOENT`, `EACCES`, …), or a fixed word for anything else. */
const spawnCode = clientFailureCode;

function temporal(cli, args) {
  const result = spawnSync(cli, args, {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
  const command = `temporal ${args.slice(0, 2).join(' ')}`;
  // The error's code only: its message names the executable, which is
  // TEMPORAL_CLI's value (#385 r4).
  if (result.error) {
    throw new Unverifiable(
      `${command}: TEMPORAL_CLI could not be run (${spawnCode(result.error)})`,
    );
  }
  if (result.status !== 0) {
    throw new Unverifiable(`${command} failed; child diagnostics withheld`);
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
    throw new Unverifiable('temporal workflow count: not a count');
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

// Protocol 1 is forward-only: patch commands and continuation state cannot be
// understood by protocol 0. Read durable history, not eventually indexed memo.
const ROLLOVER_PATCH = 'order-saga-durable-rollover-v1';
function jsonPayload(payload) {
  try {
    if (payload?.metadata?.encoding !== 'anNvbi9wbGFpbg==' || typeof payload.data !== 'string') {
      throw new Error();
    }
    const bytes = Buffer.from(payload.data, 'base64');
    if (bytes.toString('base64') !== payload.data) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Unverifiable('workflow history: compatibility payload cannot be read');
  }
}

function requiredProtocol(history, historyLength, taskQueue) {
  const events = history?.events;
  if (
    !Array.isArray(events) ||
    events.length === 0 ||
    String(events.length) !== String(historyLength) ||
    events.some(
      (event, i) => event?.eventId !== String(i + 1) || typeof event.eventType !== 'string',
    )
  ) {
    throw new Unverifiable('workflow history: incomplete or unreadable compatibility evidence');
  }
  const start = events[0].workflowExecutionStartedEventAttributes;
  if (
    events[0].eventType !== 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED' ||
    start?.workflowType?.name !== 'orderSaga' ||
    start?.taskQueue?.name !== taskQueue ||
    start?.input?.payloads?.length !== 1
  ) {
    throw new Unverifiable('workflow history: missing start input');
  }
  const input = jsonPayload(start.input.payloads[0]);
  if (!isRecord(input)) throw new Unverifiable('workflow history: invalid start input');
  let required = Object.hasOwn(input, 'resume') ? 1 : 0;
  for (const event of events) {
    if (
      event.eventType !== 'EVENT_TYPE_MARKER_RECORDED' &&
      !Object.hasOwn(event, 'markerRecordedEventAttributes')
    )
      continue;
    const marker = event.markerRecordedEventAttributes;
    if (
      event.eventType !== 'EVENT_TYPE_MARKER_RECORDED' ||
      marker?.markerName !== 'core_patch' ||
      marker.details?.['patch-data']?.payloads?.length !== 1
    ) {
      throw new Unverifiable('workflow history: unreadable compatibility marker');
    }
    const patch = jsonPayload(marker.details['patch-data'].payloads[0]);
    if (patch?.id !== ROLLOVER_PATCH || typeof patch.deprecated !== 'boolean') {
      throw new Unverifiable('workflow history: unknown compatibility marker');
    }
    required = 1;
  }
  return required;
}

function check() {
  const cli = process.env.TEMPORAL_CLI?.trim() || 'temporal';
  const address = setting('TEMPORAL_ADDRESS');
  const namespace = setting('TEMPORAL_NAMESPACE');
  const taskQueue = setting('MARKETPLACE_TEMPORAL_TASK_QUEUE');
  let target;
  try {
    // Must be extracted from the immutable target image, never this checkout.
    target = JSON.parse(readFileSync(setting('MARKETPLACE_TARGET_PACKAGE_JSON'), 'utf8'));
  } catch {
    throw new Unverifiable('target build compatibility declaration cannot be read');
  }
  if (target?.name !== '@rasta/marketplace-service') {
    throw new Unverifiable('target manifest is not marketplace-service');
  }
  // Pre-protocol releases support only legacy histories; do not rewrite their manifests.
  const targetProtocol =
    target.marketplaceSagaProtocol === undefined ? 0 : target.marketplaceSagaProtocol;
  if (targetProtocol !== 0 && targetProtocol !== 1) {
    throw new Unverifiable('target build compatibility declaration is unsupported');
  }
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
  for (let i = 0; i < (queue.pollers ?? []).length; i += 1) {
    blockers.push('task queue has an active poller; details withheld');
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
      throw new Unverifiable('temporal workflow list: an execution is listed twice');
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
      throw new Unverifiable('temporal workflow describe: not a description of that run');
    }
    const queueOfRun = described.executionConfig?.taskQueue?.name;
    if (queueOfRun !== taskQueue) {
      throw new Unverifiable('workflow runs on an unchecked task queue; details withheld');
    }
    const history = temporal(cli, [
      'workflow',
      'show',
      ...common,
      '--workflow-id',
      workflowId,
      '--run-id',
      runId,
      '--output',
      'json',
      '--no-json-shorthand-payloads',
    ]);
    if (requiredProtocol(history, info.historyLength, taskQueue) > targetProtocol) {
      blockers.push('workflow requires saga protocol 1; incompatible target build');
    }
    for (let i = 0; i < pending.length; i += 1) {
      blockers.push('workflow has a pending activity; details withheld');
    }
  }

  const after = countRunning(cli, common);
  if (after !== before) {
    throw new Unverifiable(`running order sagas went from ${before} to ${after} during the check`);
  }
  return { running: before, blockers };
}

try {
  // Environment only, so any argument is a command line it does not have
  // (#673 r1 F2): `--namespace x` would otherwise check TEMPORAL_NAMESPACE's
  // namespace and could report OK for the wrong one. Refused before any
  // setting is read or any `temporal` call is made.
  if (process.argv.length !== 2) {
    throw markRefusal(
      new Error(
        'usage: marketplace-saga-drain-check.mjs (no arguments; settings from the environment)',
      ),
      'usage',
    );
  }
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
  const reason = error instanceof Unverifiable ? error.message : commandFailure(error);
  console.error(`marketplace saga drain check: cannot verify — deployment blocked: ${reason}`);
  process.exit(1);
}

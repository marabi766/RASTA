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
 *      listed run: visibility does not index pending activities);
 *   4. all orderSaga runs closed as ContinuedAsNew since the recorded stop
 *      time are enumerated (count/list/count); their CURRENT runs are described
 *      by workflow id alone, and any unlisted running successor blocks;
 *   5. inspected histories, their markers and their recorded activity results, are
 *      compatible with the declared target build;
 *   6. no durable saga call record is open (`saga_unconfirmed_call`, FU-221, D-151),
 *      whatever its operation: a call economic-service has not answered may still be
 *      answered only by the build that made it. Temporal cannot show one: a fenced
 *      authorisation completes its saga with no pending activity and its record open.
 * This is an observation after workers stop, not proof that workflows have
 * completed or that funds cannot move when workers resume.
 * Exit 1: a poller (before or after the database read), a pending activity or an open
 * call record was found, or anything could not
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
 * MARKETPLACE_TEMPORAL_TASK_QUEUE — the values the service runs with.
 * MARKETPLACE_SAGA_STOP_TIME — canonical UTC timestamp recorded before stopping
 * all old replicas (YYYY-MM-DDTHH:mm:ss.sssZ); required, never a future time. TLS or
 * an API key: the `temporal` CLI's own TEMPORAL_* variables, inherited.
 * MARKETPLACE_TARGET_PACKAGE_JSON is the package.json extracted from the target
 * image, whose name must be @rasta/marketplace-service. marketplaceSagaProtocol
 * is a protocol this gate knows (`PATCH_PROTOCOL`); an absent field means 0, the
 * legacy protocol. Always run this gate from the
 * newest of the running and target releases, never the rollback target checkout.
 * TEMPORAL_CLI overrides the binary (default `temporal` on PATH).
 * DATABASE_URL_MARKETPLACE — the service's own runtime URL, required: psql on PATH reads
 * the table with the role the service's monitor reads it with (cross-tenant platform
 * plumbing; the table has no row security, and row security found on it refuses). The URL
 * is the read's only connection input (#947 r1 M1): explicit host, port and database, no
 * libpq parameter that could point elsewhere, no inherited PG* variable, and the server
 * must name that database and port back.
 */
import {
  commandFailure,
  clientFailureCode,
  markRefusal,
} from '../packages/config/src/command-failure.js';
import { readUrl } from '../packages/config/src/url-reader.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { libpqInvocation } from './psql-prisma-url.mjs';

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

function countExecutions(cli, common, query = QUERY) {
  const answer = temporal(cli, [
    'workflow',
    'count',
    ...common,
    '--query',
    query,
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

function listExecutions(cli, common, query, expected, status = 'RUNNING') {
  const listed = temporal(cli, [
    'workflow',
    'list',
    ...common,
    '--query',
    query,
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
      !workflowId ||
      typeof runId !== 'string' ||
      !runId ||
      entry?.type?.name !== 'orderSaga' ||
      entry?.status !== `WORKFLOW_EXECUTION_STATUS_${status}`
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
  if (executions.length !== expected) {
    throw new Unverifiable(
      `visibility counts ${expected} order sagas but lists ${executions.length}`,
    );
  }

  return executions;
}

// Each protocol is forward-only: its patch commands and continuation state cannot
// be understood by a lower one. Read durable history, not eventually indexed memo.
// Whatever is not listed here refuses the deployment; the test suite scans the
// saga's source, so a new `patched()` id fails CI until it is listed.
const PATCH_PROTOCOL = new Map([
  ['order-saga-durable-rollover-v1', 1],
  ['dispute-settle-resumes-order', 2],
  ['dispute-release-durable-wait-v1', 3],
  ['economic-call-durable-wait-v1', 4],
  ['economic-sibling-call-durable-wait-v1', 5],
  ['saga-owed-work-durable-v1', 6],
  ['authorisation-order-fence-v1', 7],
]);
const LATEST_PROTOCOL = Math.max(...PATCH_PROTOCOL.values());
// A continued run has no marker until its first workflow task: its `resume` is
// the only evidence of what wrote it: `reminderDue` came with protocol 2, and
// `releaseRounds` means it rolled over inside the release wait of protocol 3,
// `unconfirmedCall` inside the same wait of an authorisation, protocol 4,
// `siblingCall` inside that of a dispute filing or a refund, protocol 5, and
// `outstandingWork` with work owed outside any call's wait, protocol 6.
const RESUME_PROTOCOL = new Map([
  ['status', 1],
  ['mirroredDispute', 1],
  ['mirroredEconomicDispute', 1],
  ['waitingIn', 1],
  ['nextReminderAt', 1],
  ['activitySequence', 1],
  ['reminderDue', 2],
  ['releaseRounds', 3],
  ['unconfirmedCall', 4],
  ['siblingCall', 5],
  ['outstandingWork', 6],
]);
// Every field a saga has ever been started with; any other could mean anything.
const INPUT_FIELDS = new Set([
  'orderId',
  'fulfillmentWindowDays',
  'receiptWindowDays',
  'reminderIntervalDays',
  'recheckIntervalHours',
  'historyEventThreshold',
  'resume',
]);
function resumeProtocol(resume) {
  if (!isRecord(resume)) throw new Unverifiable('workflow history: invalid start input');
  let required = 1;
  for (const field of Object.keys(resume)) {
    const protocol = RESUME_PROTOCOL.get(field);
    if (protocol === undefined) {
      throw new Unverifiable('workflow history: unknown continuation state');
    }
    required = Math.max(required, protocol);
  }
  return required;
}
// Every activity the saga schedules, and what its recorded result requires of the build
// that reads it. An old workflow takes any answer of these calls as the call's own effect,
// so the result itself is evidence, before any marker: a `compensate` that answered "paid
// out" would cancel the order under it (PR-796 r2 F5). For those calls, a result in none
// of the shapes listed could mean anything and refuses every target, as does any result of
// a call not listed: the test suite scans `createActivities`, so a new activity fails CI
// until it is listed. The other calls' results did not change, and their shapes are not
// pinned: a change to one needs its own entry and protocol here.
const FINAL_ANSWER_PROTOCOL = PATCH_PROTOCOL.get('saga-owed-work-durable-v1');
const isFinalAnswer = (value) =>
  isRecord(value) &&
  value.final === true &&
  typeof value.status === 'string' &&
  typeof value.funds === 'string' &&
  Object.keys(value).length === 3;
const isDisputedAnswer = (value) =>
  isRecord(value) &&
  value.disputed === true &&
  typeof value.reason === 'string' &&
  Object.keys(value).every((field) => ['disputed', 'reason', 'economicDisputeId'].includes(field));
// An authorisation the order fenced: nothing was sent. To a build below its protocol this
// reads as "authorised", and the saga goes on to settle what economic-service never
// authorised (#895 r1 F1). Only the authorisation answers it.
const FENCED_ANSWER_PROTOCOL = PATCH_PROTOCOL.get('authorisation-order-fence-v1');
const isFencedAnswer = (value) =>
  isRecord(value) &&
  value.fenced === true &&
  typeof value.status === 'string' &&
  value.status !== '' &&
  typeof value.inDoubt === 'boolean' &&
  Object.keys(value).length === 3;
// The four calls that may answer `ObligationFinal`: true for their answers before it.
const FINAL_ANSWER_CALLS = new Map([
  ['compensate', (value) => value === undefined],
  ['resolveObligationDispute', (value) => value === undefined],
  [
    'disputeObligation',
    (value) => value === undefined || value === null || typeof value === 'string',
  ],
  ['authoriseSettlement', (value) => value === undefined || isDisputedAnswer(value)],
]);
// None of these has ever given a final or a fenced answer, and one that does is refused.
const OTHER_CALLS = new Set([
  'createObligation',
  'findObligation',
  'readOrder',
  'markFundsHeld',
  'markFailed',
  'markSettling',
  'settle',
  'markObligationDisputed',
  'markSettlementFailed',
  'markCompleted',
  'noteReleaseUnconfirmed',
  'noteEconomicCallUnconfirmed',
  'markCancelled',
  'recordReminder',
]);
function resultProtocol(activity, value) {
  const earlier = FINAL_ANSWER_CALLS.get(activity);
  if (earlier?.(value)) return 0;
  if (earlier && isFinalAnswer(value)) return FINAL_ANSWER_PROTOCOL;
  if (activity === 'authoriseSettlement' && isFencedAnswer(value)) return FENCED_ANSWER_PROTOCOL;
  const claimsAnother = isRecord(value) && ['final', 'fenced'].some((f) => Object.hasOwn(value, f));
  if (OTHER_CALLS.has(activity) && !claimsAnother) return 0;
  throw new Unverifiable('workflow history: unknown activity result');
}

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

/** What an activity returned; nothing for a void one, which the SDK records as `binary/null`. */
function resultOf(completed) {
  const payloads = completed?.result?.payloads;
  if (!Array.isArray(payloads) || payloads.length !== 1) {
    throw new Unverifiable('workflow history: unreadable activity result');
  }
  const [payload] = payloads;
  if (payload?.metadata?.encoding === 'YmluYXJ5L251bGw=' && !payload.data) return undefined;
  return jsonPayload(payload);
}

function activityResultProtocol(events) {
  const scheduled = new Map();
  let required = 0;
  for (const event of events) {
    const name = event.activityTaskScheduledEventAttributes?.activityType?.name;
    if (event.eventType === 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED' && typeof name === 'string') {
      scheduled.set(event.eventId, name);
    }
    if (
      event.eventType !== 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED' &&
      !Object.hasOwn(event, 'activityTaskCompletedEventAttributes')
    )
      continue;
    const completed = event.activityTaskCompletedEventAttributes;
    const activity = scheduled.get(completed?.scheduledEventId);
    if (event.eventType !== 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED' || activity === undefined) {
      throw new Unverifiable('workflow history: an activity result without its scheduling');
    }
    required = Math.max(required, resultProtocol(activity, resultOf(completed)));
  }
  return required;
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
  if (!isRecord(input) || Object.keys(input).some((field) => !INPUT_FIELDS.has(field))) {
    throw new Unverifiable('workflow history: invalid start input');
  }
  let required = Object.hasOwn(input, 'resume') ? resumeProtocol(input.resume) : 0;
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
    const protocol = PATCH_PROTOCOL.get(patch?.id);
    if (protocol === undefined || typeof patch.deprecated !== 'boolean') {
      throw new Unverifiable('workflow history: unknown compatibility marker');
    }
    required = Math.max(required, protocol);
  }
  return Math.max(required, activityResultProtocol(events));
}

// Every operation the saga keeps a durable call record of (`RecordedCall` in
// services/marketplace-service/src/temporal/activities.ts; the test pins the two equal).
// An open record of another operation was written by a build this gate does not know.
const RECORDED_CALLS = new Set([
  'createObligation',
  'authoriseSettlement',
  'settle',
  'compensate',
  'resolveObligationDispute',
]);
const OPEN_CALLS_SHOWN = 50;
const DATABASE_URL = 'DATABASE_URL_MARKETPLACE';
/** An identifier is printed only in this shape; any other is withheld, never the row dropped. */
const PRINTABLE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The URL parameters the read accepts: Prisma's own (dropped before psql), the credential
 * `libpqInvocation` moves to the environment, the startup options it moves to PGOPTIONS,
 * and libpq's TLS, authentication and socket settings. None of them can name a host, an
 * address, a port, a database or a service, so libpq has nothing beside the URL's own
 * authority and path to connect with (#947 r1 M1: `service`, `hostaddr`, `host`, `port`,
 * `dbname`, `user`, multi-host routing). An allowlist: whatever a later libpq adds refuses.
 */
const PINNED_URL_PARAMETERS = new Set([
  'schema',
  'connection_limit',
  'pool_timeout',
  'socket_timeout',
  'pgbouncer',
  'statement_cache_size',
  'password',
  'options',
  'application_name',
  'channel_binding',
  'connect_timeout',
  'gssencmode',
  'keepalives',
  'keepalives_count',
  'keepalives_idle',
  'keepalives_interval',
  'krbsrvname',
  'require_auth',
  'ssl_max_protocol_version',
  'ssl_min_protocol_version',
  'sslcert',
  'sslcompression',
  'sslcrl',
  'sslcrldir',
  'sslkey',
  'sslmode',
  'sslnegotiation',
  'sslrootcert',
  'sslsni',
  'tcp_user_timeout',
]);

/**
 * How psql reaches the service's database: the service's own runtime URL, through the
 * one URL-to-psql boundary (password in PGPASSWORD, never argv), and the URL's schema,
 * which qualifies the table itself: nothing rides on a search_path a pooler may drop.
 * The URL must name its host, port and database, and only parameters that cannot move
 * the connection: libpq fills whatever the URL leaves out from PG* variables or a
 * service file, which the service itself (Prisma) never reads (#947 r1 M1). `expected`
 * is what the server must answer it is. Refused with a fixed text, before Temporal is
 * asked anything.
 */
function databaseConnection() {
  const url = setting(DATABASE_URL);
  try {
    const { target, env } = libpqInvocation(url);
    const parsed = readUrl(url);
    const schemas = parsed.searchParams.getAll('schema');
    const schema = schemas.length === 0 ? 'public' : schemas[0];
    if (schemas.length > 1 || !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error();
    if ([...parsed.searchParams.keys()].some((name) => !PINNED_URL_PARAMETERS.has(name))) {
      throw new Error();
    }
    const port = /^[1-9][0-9]{0,4}$/.test(parsed.port) ? Number(parsed.port) : 0;
    const database = /^\/([\w$-]+)$/.exec(parsed.pathname)?.[1];
    // An empty host with a port does not parse; the host check stands for a parser that would.
    if (!parsed.hostname || port < 1 || port > 65535 || !database) throw new Error();
    // `env` is the URL's own password and options, nothing inherited.
    return { target, env, schema, expected: { database, port } };
  } catch {
    throw new Unverifiable(
      `${DATABASE_URL} cannot be handed to psql (it must name host, port and database, ` +
        'with no parameter that can move the connection); its value is not repeated',
    );
  }
}

/**
 * psql's whole environment: PATH to find it, HOME, the URL's own password and options, and
 * a connect timeout. No inherited PG* variable (PGHOSTADDR, PGPORT, PGDATABASE, PGSERVICE,
 * PGSERVICEFILE, PGSYSCONFDIR, PGPASSFILE, PGSSLMODE, …) and no PSQLRC reaches it. HOME
 * names no connection (a service file there is read only for a named service, refused) and
 * keeps `~/.postgresql/root.crt`, which libpq verifies the server against, where it was.
 */
function psqlEnv(env) {
  return {
    ...Object.fromEntries(
      ['PATH', 'HOME'].flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    ),
    PGCONNECT_TIMEOUT: '10',
    ...env,
  };
}

/**
 * Every durable saga call record still open (FU-221, D-151) becomes a blocker. A fenced
 * authorisation completes with no pending activity and its record open, so Temporal
 * cannot show it. One READ ONLY transaction, time-boxed in the SQL itself; the rows come
 * through the partial index `ix_saga_unconfirmed_call_open` (opened_at WHERE confirmed_at
 * IS NULL), oldest first and one more than shown, so closed history is never walked.
 * Row security on the table would make an empty answer the policy's, not the table's,
 * and a standby's may lag the primary: both refused. Only pg_catalog is searched, the
 * table named with its schema. Whatever does not answer exactly as asked refuses.
 */
function openCallRecords({ target, env, schema, expected }) {
  const table = `"${schema}".saga_unconfirmed_call`;
  const sql = `BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog;
SELECT json_build_object(
  'database', current_database(),
  'port', inet_server_port(),
  'recovery', pg_is_in_recovery(),
  'rowSecurity', (SELECT relrowsecurity OR relforcerowsecurity FROM pg_catalog.pg_class
    WHERE oid = '${table}'::regclass),
  'open', COALESCE((SELECT json_agg(r) FROM (
    SELECT c.organization_id AS "organizationId", c.order_id AS "orderId", c.operation,
      c.subject, c.generation,
      floor(extract(epoch FROM clock_timestamp() - c.opened_at))::bigint AS "ageSeconds"
    FROM ${table} c
    WHERE c.confirmed_at IS NULL
    ORDER BY c.opened_at, c.organization_id, c.order_id, c.operation, c.subject
    LIMIT ${OPEN_CALLS_SHOWN + 1}
  ) r), '[]'::json));
COMMIT;
`;
  const result = spawnSync(
    'psql',
    [target, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    {
      input: sql,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      env: psqlEnv(env),
    },
  );
  if (result.error) throw new Unverifiable(`psql could not be run (${spawnCode(result.error)})`);
  if (result.status !== 0) {
    throw new Unverifiable('saga_unconfirmed_call could not be read; psql diagnostics withheld');
  }
  let answer;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    answer = undefined;
  }
  const rows = isRecord(answer) ? answer.open : undefined;
  if (
    !isRecord(answer) ||
    Object.keys(answer).length !== 5 ||
    typeof answer.database !== 'string' ||
    !Number.isSafeInteger(answer.port) ||
    typeof answer.recovery !== 'boolean' ||
    typeof answer.rowSecurity !== 'boolean' ||
    !Array.isArray(rows) ||
    rows.length > OPEN_CALLS_SHOWN + 1
  ) {
    throw new Unverifiable('saga_unconfirmed_call: psql did not print the open records');
  }
  // The same statement names where it ran: another database or another server's port
  // answered for one the URL does not name, and its empty table proves nothing.
  if (answer.database !== expected.database || answer.port !== expected.port) {
    throw new Unverifiable(
      'saga_unconfirmed_call was read from a database or port other than the URL names',
    );
  }
  if (answer.recovery) {
    throw new Unverifiable(
      'saga_unconfirmed_call was read on a standby; a record may not have arrived',
    );
  }
  if (answer.rowSecurity) {
    throw new Unverifiable(
      'saga_unconfirmed_call has row security: an empty answer proves nothing',
    );
  }
  const shown = (value) => (PRINTABLE.test(value) ? value : '<withheld>');
  const blockers = [];
  for (const row of rows) {
    if (
      !isRecord(row) ||
      ['organizationId', 'orderId', 'operation', 'subject'].some(
        (field) => typeof row[field] !== 'string' || !row[field],
      ) ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 1 ||
      !Number.isSafeInteger(row.ageSeconds)
    ) {
      throw new Unverifiable('saga_unconfirmed_call: an open record this gate cannot read');
    }
    if (!RECORDED_CALLS.has(row.operation)) {
      throw new Unverifiable('saga_unconfirmed_call: an open record of an unknown operation');
    }
    if (blockers.length === OPEN_CALLS_SHOWN) {
      blockers.push(`more than ${OPEN_CALLS_SHOWN} open saga call records; list them (runbook)`);
      break;
    }
    blockers.push(
      `open saga call record: order ${shown(row.orderId)} (organization ${shown(row.organizationId)}), ` +
        `${row.operation} on ${shown(row.subject)}, generation ${row.generation}, open ${row.ageSeconds} s`,
    );
  }
  return blockers;
}

function check() {
  const cli = process.env.TEMPORAL_CLI?.trim() || 'temporal';
  const address = setting('TEMPORAL_ADDRESS');
  const namespace = setting('TEMPORAL_NAMESPACE');
  const taskQueue = setting('MARKETPLACE_TEMPORAL_TASK_QUEUE');
  const stopTime = setting('MARKETPLACE_SAGA_STOP_TIME');
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stopTime) ||
    !Number.isFinite(Date.parse(stopTime)) ||
    new Date(stopTime).toISOString() !== stopTime ||
    Date.parse(stopTime) > Date.now()
  ) {
    throw new Unverifiable('MARKETPLACE_SAGA_STOP_TIME must be a past canonical UTC timestamp');
  }
  const database = databaseConnection();
  const continuedQuery = `WorkflowType="orderSaga" AND ExecutionStatus="ContinuedAsNew" AND CloseTime >= "${stopTime}"`;
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
  if (!Number.isInteger(targetProtocol) || targetProtocol < 0 || targetProtocol > LATEST_PROTOCOL) {
    throw new Unverifiable('target build compatibility declaration is unsupported');
  }
  const common = ['--address', address, '--namespace', namespace];
  const blockers = [];

  const pollers = () => {
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
    return (queue.pollers ?? []).length;
  };
  for (let i = pollers(); i > 0; i -= 1) {
    blockers.push('task queue has an active poller; details withheld');
  }

  const before = countExecutions(cli, common);
  const executions = listExecutions(cli, common, QUERY, before);
  const seen = new Set(
    executions.map(({ workflowId, runId }) => JSON.stringify([workflowId, runId])),
  );

  const inspect = ({ workflowId, runId }) => {
    const described = temporal(cli, [
      'workflow',
      'describe',
      ...common,
      '--workflow-id',
      workflowId,
      ...(runId === undefined ? [] : ['--run-id', runId]),
      '--output',
      'json',
    ]);
    // Match the workflow id and, when pinned, the run id. Current lookups must
    // return a known terminal status or a running execution we also listed. An empty list is
    // omitted from the JSON; anything else that is not a list is not an answer.
    const info = isRecord(described) ? described.workflowExecutionInfo : undefined;
    const pending = isRecord(described)
      ? Object.hasOwn(described, 'pendingActivities')
        ? described.pendingActivities
        : []
      : undefined;
    if (
      info?.execution?.workflowId !== workflowId ||
      typeof info?.execution?.runId !== 'string' ||
      !info.execution.runId ||
      (runId !== undefined && info.execution.runId !== runId) ||
      !['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT'].some(
        (status) => info?.status === `WORKFLOW_EXECUTION_STATUS_${status}`,
      ) ||
      info?.type?.name !== 'orderSaga' ||
      !Array.isArray(pending)
    ) {
      throw new Unverifiable('temporal workflow describe: not a description of that run');
    }
    if (
      info.status === 'WORKFLOW_EXECUTION_STATUS_RUNNING' &&
      !seen.has(JSON.stringify([workflowId, info.execution.runId]))
    ) {
      throw new Unverifiable('current running order saga is absent from visibility');
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
      info.execution.runId,
      '--output',
      'json',
      '--no-json-shorthand-payloads',
    ]);
    const required = requiredProtocol(history, info.historyLength, taskQueue);
    if (required > targetProtocol) {
      blockers.push(`workflow requires saga protocol ${required}; incompatible target build`);
    }
    for (let i = 0; i < pending.length; i += 1) {
      blockers.push('workflow has a pending activity; details withheld');
    }
  };
  for (const execution of executions) inspect(execution);

  // A successor can be absent from RUNNING visibility while its predecessor
  // is already indexed. Resolve CURRENT by workflow id, never the closed run id.
  // Count/list/count refuses partial pagination, duplicates and index changes.
  const continuedBefore = countExecutions(cli, common, continuedQuery);
  const continued = listExecutions(
    cli,
    common,
    continuedQuery,
    continuedBefore,
    'CONTINUED_AS_NEW',
  );
  for (const workflowId of new Set(continued.map((execution) => execution.workflowId))) {
    inspect({ workflowId });
  }
  if (countExecutions(cli, common, continuedQuery) !== continuedBefore) {
    throw new Unverifiable('continued-as-new order saga count changed during the check');
  }

  const after = countExecutions(cli, common);
  if (after !== before) {
    throw new Unverifiable(`running order sagas went from ${before} to ${after} during the check`);
  }
  blockers.push(...openCallRecords(database));
  // The queue again, after the read (#947 r1 L1): the first describe may be minutes old.
  // With no poller listed now, no worker was there to open a record after the read; one
  // that came back meanwhile blocks.
  for (let i = pollers(); i > 0; i -= 1) {
    blockers.push('task queue has an active poller after the record read; details withheld');
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
    `marketplace saga drain check: OK — no poller, ${running} running order saga(s), no pending activity, no open saga call record`,
  );
} catch (error) {
  const reason = error instanceof Unverifiable ? error.message : commandFailure(error);
  console.error(`marketplace saga drain check: cannot verify — deployment blocked: ${reason}`);
  process.exit(1);
}

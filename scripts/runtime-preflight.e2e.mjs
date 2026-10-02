// -----------------------------------------------------------------------------
// A service started with its database owner's URL is gone before it consumes
// anything (D-045, Codex on #178).
//
//   node scripts/runtime-preflight.e2e.mjs refused  <service>   (before it starts)
//   node scripts/runtime-preflight.e2e.mjs consumed <service>   (after it started properly)
//
// Nest runs every provider's onModuleInit before the root module's, and a Kafka
// consumer or a timer starts in its own — so a startup check in
// AppModule.onModuleInit alone would refuse only after a consumer had already
// taken, and committed, work under an owner connection. Every split service
// therefore runs `preflightRuntimeRole` (@rasta/nest-common) first in
// bootstrap(), before NestFactory.create. This is the live proof, on the
// artefact the container runs (services/<service>/dist/main.js), against a
// real broker and database, in CI:
//
//   refused  — records the service consumer group's committed offsets, queues
//              (where SERVICES gives one) a valid event on a topic it consumes,
//              as that topic's only permitted producer, then starts the service
//              with its runtime URL naming its migrator. The process must exit non-zero
//              naming RuntimeRoleRefusedError — never the URL's password — and
//              afterwards the group must never have formed (Kafka reports it
//              Dead: no consumer so much as joined, which only a gate before
//              Nest can promise), its offsets must be exactly as before
//              (nothing committed) and, where the service records the event,
//              no record may exist (nothing consumed).
//   consumed — the positive control, once the job has started the service with
//              its runtime role: the very same queued event is consumed — the
//              group's offset moves past it, and audit-service records it — or,
//              with no event, the group forms. So the refusal is not vacuous:
//              only the preflight kept the consumer from an owner connection.
//
// SERVICES below says, per service, what it consumes and from whom.
// Environment (the CI step's, plus): PREFLIGHT_OWNER_URL — the service
// migrator's URL; the service's runtime URL variable (audit: read back for its
// rows); KAFKA_SASL_PASSWORD_<SERVICE> and the producer's. The event id passes
// from `refused` to `consumed` in PREFLIGHT_STATE_DIR (default /tmp/rasta-logs).
// -----------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Kafka, logLevel } = require(
  join(ROOT, 'packages', 'nest-common', 'node_modules', 'kafkajs'),
);
const { kafkaClientConfig, kafkaConnectionFor } = require(
  join(ROOT, 'packages', 'nest-common', 'dist', 'index.js'),
);
const { kafkaPasswordVariable } = require(join(ROOT, 'packages', 'config', 'dist', 'index.js'));
const serviceDir = (service) => join(ROOT, 'services', service);

/**
 * Per service: the consumer group that consumes the topic, the topic, and —
 * where a queued event can prove it — the event, its producer, and how to find
 * the service's record of it.
 */
const SERVICES = {
  // A consumer started from AppModule after its own check: the queued event
  // must not become an audit row, and does once audit-service runs properly.
  // The group is audit's own constant, read from its dist.
  'audit-service': {
    runtimeVariables: ['DATABASE_URL_AUDIT'],
    migrator: 'rasta_audit_migrator',
    group: () =>
      require(join(serviceDir('audit-service'), 'dist', 'audit', 'audit.mapper.js'))
        .DOMAIN_PROJECTOR_CONSUMER,
    topic: 'rasta.asset.v1',
    producer: 'asset-service',
    event: (stamp) => ({
      eventName: 'ASSET_DECOMMISSIONED',
      aggregateType: 'Asset',
      aggregateId: `AST-PREFLIGHT-${stamp}`,
      payload: { reason: 'runtime-preflight regression' },
    }),
    async records(eventId) {
      const { PrismaClient } = require(
        join(serviceDir('audit-service'), 'src', 'generated', 'prisma'),
      );
      const prisma = new PrismaClient({
        datasources: { db: { url: required('DATABASE_URL_AUDIT') } },
      });
      try {
        return await prisma.auditEvent.count({ where: { sourceEventId: eventId } });
      } finally {
        await prisma.$disconnect();
      }
    },
  },
  // The case Codex named: a consumer that starts in its own onModuleInit —
  // identity's Keycloak re-projection — which Nest runs before AppModule's.
  // Gated in AppModule alone, it joined its group under the owner connection
  // before the refusal (measured: "Consuming rasta.identity.v1 … as group
  // identity-service.keycloak-projection", and the group left Stable). It reads
  // from the latest offset, so no event is queued for it: the proof is that the
  // group never forms, the positive control that it does once identity runs.
  'identity-service': {
    // identity reads DATABASE_URL first, then DATABASE_URL_IDENTITY.
    runtimeVariables: ['DATABASE_URL_IDENTITY', 'DATABASE_URL'],
    migrator: 'rasta_identity_migrator',
    group: () => 'identity-service.keycloak-projection', // its app.module.ts
    topic: 'rasta.identity.v1',
  },
};

const stateFile = (service) =>
  join(process.env.PREFLIGHT_STATE_DIR || '/tmp/rasta-logs', `runtime-preflight-${service}.json`);
const REFUSAL_TIMEOUT_MS = 60_000;
const CONSUME_TIMEOUT_MS = 180_000;

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const kafkaAs = (principal) =>
  new Kafka({
    ...kafkaClientConfig(kafkaConnectionFor(principal, `runtime-preflight-${principal}`)),
    logLevel: logLevel.NOTHING,
  });

/**
 * Coordinator errors a fresh broker answers with while it is still loading
 * __consumer_offsets (or moving a group to another broker): retried, bounded.
 * kafkajs's admin does not retry them inside fetchOffsets.
 */
const COORDINATOR_NOT_READY = new Set([
  'NOT_COORDINATOR_FOR_GROUP',
  'GROUP_COORDINATOR_NOT_AVAILABLE',
  'GROUP_LOAD_IN_PROGRESS',
]);
const COORDINATOR_WAIT_MS = 60_000;

/** The group's committed offset per partition of its topic ('-1' = none), and its state. */
async function groupView(service, group, topic) {
  const deadline = Date.now() + COORDINATOR_WAIT_MS;
  for (;;) {
    try {
      return await readGroup(service, group, topic);
    } catch (error) {
      if (!COORDINATOR_NOT_READY.has(error?.type) || Date.now() > deadline) throw error;
      await new Promise((wake) => setTimeout(wake, 1_000));
    }
  }
}

async function readGroup(service, group, topic) {
  const admin = kafkaAs(service).admin();
  await admin.connect();
  try {
    const [entry] = await admin.fetchOffsets({ groupId: group, topics: [topic] });
    const { groups } = await admin.describeGroups([group]);
    return {
      offsets: Object.fromEntries(
        (entry?.partitions ?? []).map(({ partition, offset }) => [partition, offset]),
      ),
      state: groups[0]?.state ?? 'Dead',
    };
  } finally {
    await admin.disconnect();
  }
}

/** Queues the service's event, if it has one; returns its id. */
async function queueEvent(spec) {
  if (!spec.event) return null;
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  const envelope = {
    eventId: `EVT-PREFLIGHT-${stamp}`,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: spec.producer,
    producerVersion: '0.0.0-preflight',
    tenantId: `ORG-PREFLIGHT-${stamp}`,
    correlationId: `COR-PREFLIGHT-${stamp}`,
    ...spec.event(stamp),
  };
  const producer = kafkaAs(spec.producer).producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();
  try {
    await producer.send({
      topic: spec.topic,
      messages: [{ key: envelope.aggregateId, value: JSON.stringify(envelope) }],
    });
  } finally {
    await producer.disconnect();
  }
  return envelope.eventId;
}

/** The service's dist/main.js with the owner's URL; resolves with how it ended. */
function startWithOwnerUrl(service, spec, ownerUrl) {
  const env = { ...process.env, SERVICE_NAME: service };
  for (const variable of spec.runtimeVariables) env[variable] = ownerUrl;
  // The service gets its own Kafka credential only, as in the start step.
  if (spec.producer) delete env[kafkaPasswordVariable(spec.producer)];
  delete env.PREFLIGHT_OWNER_URL;
  return new Promise((done) => {
    const child = spawn(process.execPath, ['dist/main.js'], { cwd: serviceDir(service), env });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, output, timedOut: true });
    }, REFUSAL_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ code, output, timedOut: false });
    });
  });
}

async function refused(service, spec) {
  const ownerUrl = required('PREFLIGHT_OWNER_URL');
  assert.equal(new URL(ownerUrl).username, spec.migrator, `not ${spec.migrator}'s URL`);
  const ownerPassword = decodeURIComponent(new URL(ownerUrl).password);
  const group = spec.group();

  const before = await groupView(service, group, spec.topic);
  assert.equal(before.state, 'Dead', `${group} has run before; the proof needs a fresh group`);
  const eventId = await queueEvent(spec);
  writeFileSync(stateFile(service), JSON.stringify({ group, eventId, before: before.offsets }));
  console.log(
    `${group} on ${spec.topic}: ${JSON.stringify(before)}; queued ${eventId ?? 'nothing'}`,
  );

  const run = await startWithOwnerUrl(service, spec, ownerUrl);
  assert.equal(run.timedOut, false, `${service} kept running with the owner URL:\n${run.output}`);
  assert.notEqual(run.code, 0, `${service} exited 0 with the owner URL:\n${run.output}`);
  assert.match(run.output, /RuntimeRoleRefusedError/, run.output);
  assert.match(
    run.output,
    new RegExp(`${service} refuses to start: it is connected as ${spec.migrator}`),
  );
  assert.ok(!run.output.includes(ownerPassword), 'the owner password was printed');
  assert.doesNotMatch(run.output, /listening on :/, 'the application started listening');
  assert.doesNotMatch(run.output, /Consuming /, 'a consumer started before the refusal');
  console.log(`${service} with the owner URL exited ${run.code}: RuntimeRoleRefusedError`);

  // No consumer joined, nothing was committed, nothing was recorded.
  const after = await groupView(service, group, spec.topic);
  assert.equal(after.state, 'Dead', `a consumer joined ${group} before the refusal`);
  assert.deepEqual(after.offsets, before.offsets, `${group} committed an offset`);
  if (eventId) assert.equal(await spec.records(eventId), 0, `${eventId} was recorded`);
  console.log(`${group}: never formed, offsets unchanged; nothing consumed`);
}

async function consumed(service, spec) {
  const state = JSON.parse(readFileSync(stateFile(service), 'utf8'));
  // With an event queued: the group's offset moves past it and the service
  // records it. Without: the group forms — a consumer joined.
  const done = async () => {
    const view = await groupView(service, state.group, spec.topic);
    if (!state.eventId) return view.state !== 'Dead';
    const moved = JSON.stringify(view.offsets) !== JSON.stringify(state.before);
    return moved && (await spec.records(state.eventId)) > 0;
  };
  const what = state.eventId ? `${state.eventId} consumed` : `${state.group} formed`;
  const deadline = Date.now() + CONSUME_TIMEOUT_MS;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error(`never ${what} once ${service} ran properly: the refusal proves nothing`);
    }
    await new Promise((wake) => setTimeout(wake, 2_000));
  }
  console.log(`positive control: ${what} once ${service} runs as its runtime role`);
}

const [mode, service] = process.argv.slice(2);
const run = { refused, consumed }[mode];
const spec = SERVICES[service];
if (!run || !spec) {
  console.error(
    `usage: node scripts/runtime-preflight.e2e.mjs refused|consumed ${Object.keys(SERVICES).join('|')}`,
  );
  process.exit(2);
}
run(service, spec).then(
  () => process.exit(0),
  (error) => {
    console.error(`runtime-preflight ${mode}: ${error.stack ?? error}`);
    process.exit(1);
  },
);

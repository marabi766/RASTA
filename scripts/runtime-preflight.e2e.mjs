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
//              twice, and each run must exit non-zero, never printing the
//              owner's password:
//                1. with its runtime URL naming its migrator: refused by the
//                   environment guard, MigratorCredentialInServiceError naming
//                   the variable — the first statement of main.js (#421 r1 F2);
//                2. with its real runtime URL, while the migrator has granted the
//                   runtime role CREATE on its schema (revoked again whatever
//                   happens): the URL is a runtime role's, so only the catalogue
//                   can tell — RuntimeRoleRefusedError from the preflight;
//              and afterwards the group must never have formed (Kafka reports
//              it Dead: no consumer so much as joined, which only a gate before
//              Nest can promise), its offsets must be exactly as before
//              (nothing committed) and, where the service records the event,
//              no record may exist (nothing consumed).
//   consumed — the positive control, once the job has started the service with
//              its runtime role: the very same queued event is consumed — the
//              group's offset moves past it, and audit-service and
//              maintenance-service record it (an audit row; a processed
//              marker and a usage meter) — or,
//              with no event, the group forms. So the refusal is not vacuous:
//              only the preflight kept the consumer from an owner connection.
//
// SERVICES below says, per service, what it consumes and from whom.
// Environment (the CI step's, plus): PREFLIGHT_OWNER_URL — the service
// migrator's URL; the service's first runtime URL variable — its real runtime
// URL (audit: also read back for its rows); KAFKA_SASL_PASSWORD_<SERVICE> and the producer's. The event id passes
// from `refused` to `consumed` in PREFLIGHT_STATE_DIR (default /tmp/rasta-logs).
// -----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { UnreadableUrlError, readUrl } from '../packages/config/src/url-reader.js';
import { withUtcSession } from './prisma-lib.mjs';
import { psqlRunner } from './verify-migration-reversible-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Kafka, logLevel } = require(
  join(ROOT, 'packages', 'nest-common', 'node_modules', 'kafkajs'),
);
const { KafkaConnectionConfigError, kafkaClientConfig, kafkaConnectionFor } = require(
  join(ROOT, 'packages', 'nest-common', 'dist', 'index.js'),
);
const { kafkaPasswordVariable } = require(join(ROOT, 'packages', 'config', 'dist', 'index.js'));
const serviceDir = (service) => join(ROOT, 'services', service);

/**
 * A USAGE_RECORDED exactly as fleet-service publishes it: built to fleet's own
 * payload schema (`usageRecordedPayload`, its built events module) and parsed
 * by it, so a consumer that rejects it is rejecting fleet's real event. It
 * names an asset no service knows: asset-service skips it, maintenance-service
 * folds it into a usage meter of its own (Codex on #178).
 */
const usageRecorded = (stamp) => {
  const { usageRecordedPayload } = require(
    join(serviceDir('fleet-service'), 'dist', 'fleet', 'events.js'),
  );
  const periodEnd = new Date();
  const payload = usageRecordedPayload.parse({
    usageRecordId: `USG-PREFLIGHT-${stamp}`,
    assetId: `AST-PREFLIGHT-${stamp}`,
    organizationId: `ORG-PREFLIGHT-${stamp}`,
    driverId: null,
    assignmentId: null,
    periodStart: new Date(periodEnd.getTime() - 3_600_000).toISOString(),
    periodEnd: periodEnd.toISOString(),
    hours: '1.5',
    kilometres: null,
    hourMeter: null,
    odometer: null,
    source: 'runtime-preflight',
  });
  return {
    eventName: 'USAGE_RECORDED',
    aggregateType: 'UsageRecord',
    aggregateId: payload.usageRecordId,
    tenantId: payload.organizationId,
    payload,
  };
};

/** The stamp an event id was made from (`EVT-PREFLIGHT-<stamp>`). */
const stampOf = (eventId) => eventId.replace(/^EVT-PREFLIGHT-/, '');

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
        datasources: { db: { url: withUtcSession(required('DATABASE_URL_AUDIT')) } },
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
  // Consumers that start in their own onModuleInit, the ones Codex named:
  // asset-service's timeline and maintenance-service's usage projection, both
  // from the beginning of rasta.fleet.v1, each sent fleet's real
  // USAGE_RECORDED. asset-service's timeline skips an asset it does not know,
  // and a skip commits, so its positive control is the offset moving past the
  // event; maintenance-service folds it, so its positive control is the fold
  // itself — the event marked processed and the usage meter written.
  'asset-service': {
    runtimeVariables: ['DATABASE_URL_ASSET', 'DATABASE_URL'],
    migrator: 'rasta_asset_migrator',
    group: () => 'asset-service.timeline', // its app.module.ts
    topic: 'rasta.fleet.v1',
    producer: 'fleet-service',
    event: usageRecorded,
  },
  'maintenance-service': {
    runtimeVariables: ['DATABASE_URL_MAINTENANCE', 'DATABASE_URL'],
    migrator: 'rasta_maintenance_migrator',
    group: () => 'maintenance-service.usage', // its app.module.ts
    topic: 'rasta.fleet.v1',
    producer: 'fleet-service',
    event: usageRecorded,
    /**
     * Its real outcome, both halves of one transaction: the event marked
     * processed by the usage consumer, and the asset's usage meter carrying
     * this usage record. 0 unless both are there.
     */
    async records(eventId) {
      const { PrismaClient } = require(
        join(serviceDir('maintenance-service'), 'src', 'generated', 'prisma'),
      );
      const prisma = new PrismaClient({
        datasources: { db: { url: withUtcSession(required('DATABASE_URL_MAINTENANCE')) } },
      });
      try {
        const processed = await prisma.processedEvent.count({ where: { eventId } });
        const meters = await prisma.assetUsageMeter.count({
          where: { lastUsageRecordId: `USG-PREFLIGHT-${stampOf(eventId)}` },
        });
        return processed > 0 && meters > 0 ? 1 : 0;
      } finally {
        await prisma.$disconnect();
      }
    },
  },
};

const stateFile = (service) =>
  join(process.env.PREFLIGHT_STATE_DIR || '/tmp/rasta-logs', `runtime-preflight-${service}.json`);
const REFUSAL_TIMEOUT_MS = 60_000;
/** Why the service's output is not shown with a failed check. */
const WITHHELD =
  "the service's output is withheld (it may repeat its configuration); rerun it to see it";
const CONSUME_TIMEOUT_MS = 180_000;

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new PreflightFailure(`${name} is not set`);
  return value;
};

/**
 * A refusal of this script, printed as it is: always a fixed text, which may
 * name a setting, a service, a consumer group or a topic (all this script's
 * own constants), never a value read from the environment and never anything
 * another program wrote. Not `node:assert` — an AssertionError's message and
 * stack carry both compared values, here the owner URL's username, and the
 * rejection handler below printed that stack (#385 r5).
 */
class PreflightFailure extends Error {
  name = 'PreflightFailure';
}

/** Throws a {@link PreflightFailure} with `text` unless `condition` holds. */
function check(condition, text) {
  if (!condition) throw new PreflightFailure(text);
}

/**
 * A code a client library sets on its errors — a kafkajs protocol error type
 * (`GROUP_COORDINATOR_NOT_AVAILABLE`), a system error code (`ENOTFOUND`), a
 * Prisma code (`P1001`) — or `unknown`. Only its shape is trusted: upper-case
 * letters, digits and `_`, so it cannot spell a host, a URL or a password
 * with a lower-case letter in it.
 */
function codeOf(error) {
  for (const candidate of [error?.type, error?.code, error?.cause?.code]) {
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate)) {
      return candidate;
    }
  }
  return 'unknown';
}

/**
 * A refusal with a fixed text: this script's, the URL reader's, or
 * nest-common's refusal of the Kafka connection settings (which names them).
 */
const isOwnRefusal = (error) =>
  error instanceof PreflightFailure ||
  error instanceof UnreadableUrlError ||
  error instanceof KafkaConnectionConfigError;

/**
 * `work()`, with whatever another program or a client library throws from it
 * — a kafkajs, DNS or connection error, a Prisma error — replaced by a
 * {@link PreflightFailure} of a fixed category: `category` names what failed
 * and the settings it read, the code is {@link codeOf}'s. Their own text is
 * never printed: it may quote a broker, a URL or a username, and no scrubbing
 * of credential substrings can tell which part of it is one (Codex PR-385 r5
 * F1: a two-character password survived). This script's own refusals pass.
 */
async function reported(category, work) {
  try {
    return await work();
  } catch (error) {
    if (isOwnRefusal(error)) throw error;
    throw new PreflightFailure(`${category} (code ${codeOf(error)}); its own text is withheld`);
  }
}

/** The categories {@link reported} reports by, naming the settings each reads. */
const KAFKA_FAILED = (service, what) =>
  `kafka connection failed while ${what} as ${service} ` +
  `(KAFKA_BROKERS, ${kafkaPasswordVariable(service)})`;
const DATABASE_FAILED = (variable) => `database query failed (${variable})`;

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

/** The service's dist/main.js with `url` as its runtime URL; resolves with how it ended. */
function startWith(service, spec, url) {
  const env = { ...process.env, SERVICE_NAME: service };
  for (const variable of spec.runtimeVariables) env[variable] = url;
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
    // Not started at all (no node, no dist): a refusal like any other.
    child.on('error', () => {
      clearTimeout(timer);
      done({ code: null, output, timedOut: false });
    });
  });
}

/** What every refused run must show, whichever gate refused it. */
function checkRefused(service, run, ownerPassword) {
  // The service's output is tested, never printed: what it wrote is its own,
  // and may quote anything it was configured with (WITHHELD).
  check(!run.output.includes(ownerPassword), `the owner password was printed; ${WITHHELD}`);
  check(!run.timedOut, `${service} kept running; ${WITHHELD}`);
  check(run.code !== 0, `${service} exited 0; ${WITHHELD}`);
  check(!/listening on :/.test(run.output), 'the application started listening');
  check(!/Consuming /.test(run.output), 'a consumer started before the refusal');
}

async function refused(service, spec) {
  const ownerUrl = required('PREFLIGHT_OWNER_URL');
  const owner = readUrl(ownerUrl, {
    refusal: 'PREFLIGHT_OWNER_URL cannot be read as a URL; its value is not repeated',
  });
  check(
    owner.username === spec.migrator,
    `PREFLIGHT_OWNER_URL is not ${spec.migrator}'s URL; its username is not repeated`,
  );
  const ownerPassword = decodeURIComponent(owner.password);
  const group = spec.group();

  const before = await reported(KAFKA_FAILED(service, `reading ${group}`), () =>
    groupView(service, group, spec.topic),
  );
  check(before.state === 'Dead', `${group} has run before; the proof needs a fresh group`);
  const eventId = await reported(
    KAFKA_FAILED(spec.producer ?? service, `queueing on ${spec.topic}`),
    () => queueEvent(spec),
  );
  writeFileSync(stateFile(service), JSON.stringify({ group, eventId, before: before.offsets }));
  console.log(
    `${group} on ${spec.topic}: ${JSON.stringify(before)}; queued ${eventId ?? 'nothing'}`,
  );

  // 1. The owner's URL: the environment guard, before anything is loaded.
  const owned = await startWith(service, spec, ownerUrl);
  checkRefused(service, owned, ownerPassword);
  check(
    /MigratorCredentialInServiceError/.test(owned.output) &&
      new RegExp(`\\b${spec.runtimeVariables[0]}\\b`).test(owned.output),
    `no MigratorCredentialInServiceError naming ${spec.runtimeVariables[0]}; ${WITHHELD}`,
  );
  console.log(
    `${service} with the owner URL exited ${owned.code}: MigratorCredentialInServiceError`,
  );

  // 2. The runtime role's own URL, the role granted CREATE on its schema by the
  // migrator: only the catalogue shows it, so only the preflight can refuse.
  const runtimeUrl = required(spec.runtimeVariables[0]);
  const runtime = spec.migrator.replace(/_migrator$/, '');
  const schema = owner.searchParams.get('schema') ?? 'public';
  const asOwner = psqlRunner(ownerUrl);
  const grant = asOwner(`GRANT CREATE ON SCHEMA "${schema}" TO ${runtime}`);
  check(grant.ok, `the migrator could not grant CREATE on ${schema} (sqlstate ${grant.sqlstate})`);
  let creating;
  try {
    creating = await startWith(service, spec, runtimeUrl);
  } finally {
    const revoke = asOwner(`REVOKE CREATE ON SCHEMA "${schema}" FROM ${runtime}`);
    check(
      revoke.ok,
      `CREATE on ${schema} could not be revoked again (sqlstate ${revoke.sqlstate})`,
    );
  }
  checkRefused(service, creating, ownerPassword);
  check(/RuntimeRoleRefusedError/.test(creating.output), `no RuntimeRoleRefusedError; ${WITHHELD}`);
  check(
    new RegExp(
      `${service} refuses to start: it is connected as ${runtime}, which holds CREATE on schema ${schema}`,
    ).test(creating.output),
    `${service} did not refuse naming CREATE on ${schema}; ${WITHHELD}`,
  );
  console.log(
    `${service} as ${runtime} holding CREATE exited ${creating.code}: RuntimeRoleRefusedError`,
  );

  // No consumer joined, nothing was committed, nothing was recorded.
  const after = await reported(KAFKA_FAILED(service, `reading ${group}`), () =>
    groupView(service, group, spec.topic),
  );
  check(after.state === 'Dead', `a consumer joined ${group} before the refusal`);
  check(isDeepStrictEqual(after.offsets, before.offsets), `${group} committed an offset`);
  if (eventId && spec.records) {
    const recorded = await reported(DATABASE_FAILED(spec.runtimeVariables[0]), () =>
      spec.records(eventId),
    );
    check(recorded === 0, `${eventId} was recorded`);
  }
  console.log(`${group}: never formed, offsets unchanged; nothing consumed`);
}

async function consumed(service, spec) {
  const state = JSON.parse(readFileSync(stateFile(service), 'utf8'));
  // With an event queued: the group's offset moves past it and the service
  // records it. Without: the group forms — a consumer joined.
  const done = async () => {
    const view = await reported(KAFKA_FAILED(service, `reading ${state.group}`), () =>
      groupView(service, state.group, spec.topic),
    );
    if (!state.eventId) return view.state !== 'Dead';
    const moved = JSON.stringify(view.offsets) !== JSON.stringify(state.before);
    if (!moved || !spec.records) return moved;
    const recorded = await reported(DATABASE_FAILED(spec.runtimeVariables[0]), () =>
      spec.records(state.eventId),
    );
    return recorded > 0;
  };
  const what = state.eventId ? `${state.eventId} consumed` : `${state.group} formed`;
  const deadline = Date.now() + CONSUME_TIMEOUT_MS;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new PreflightFailure(
        `never ${what} once ${service} ran properly: the refusal proves nothing`,
      );
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
    // This script's own refusals as written; anything else — what escaped
    // every `reported` stage — by a fixed text only (#385 r6).
    const text = isOwnRefusal(error)
      ? error.message
      : `an unexpected failure (code ${codeOf(error)}); its own text is withheld`;
    console.error(`runtime-preflight ${mode}: ${text}`);
    process.exit(1);
  },
);

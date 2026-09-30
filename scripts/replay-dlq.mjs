#!/usr/bin/env node
/**
 * Replays dead letters to their `.retry` topic, as `ops-replay`
 * (docs/runbooks/replay-dlq.md; the rules are replay-dlq-lib.mjs).
 *
 *   node scripts/replay-dlq.mjs --dlq rasta.maintenance.v1.dlq --event-id EVT_… [--event-id …]
 *   node scripts/replay-dlq.mjs --dlq rasta.maintenance.v1.dlq --partition 0 --from-offset 10 --to-offset 14
 *     [--max N] [--allow-stale EVT_…] [--report replay.jsonl]
 *     [--execute --expect-count N]
 *
 * A dry-run by default: it reads, decides and reports, and writes nothing.
 * `--execute` writes only when the selection is exactly what `--expect-count`
 * says and every record in it is replayable; then one at a time (acks=-1,
 * idempotent), in dead-letter order, stopping at the first failure.
 *
 * Environment: KAFKA_BROKERS, KAFKA_SASL_PASSWORD_OPS_REPLAY (development:
 * infrastructure/docker/kafka/bootstrap.env; a deployment: its secret store),
 * KAFKA_SSL_CA_FILE (absolute; otherwise the exported development CA), and for
 * --execute REPLAY_OPERATOR — who runs it, stamped on every replayed record.
 * It connects as `ops-replay` and nothing else: without that credential it
 * refuses to run.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kafkajs from 'kafkajs';
import { connectionFor } from './kafka-acl-lib.mjs';
import {
  SCAN_LIMIT,
  UsageError,
  assess,
  executionProblems,
  headerStrings,
  operatorFrom,
  parseArgs,
  parseTopics,
  replayMessage,
  reportLine,
  staleFrom,
  stalenessProbe,
  topologyOf,
  withStaleness,
} from './replay-dlq-lib.mjs';

const { Kafka, logLevel } = kafkajs;
const PRINCIPAL = 'ops-replay';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = createRequire(import.meta.url)(resolve(root, 'packages/contracts/dist/index.js'));

function fail(message, code = 1) {
  process.stderr.write(`replay-dlq: ${message}\n`);
  process.exit(code);
}

let options;
let operator = null;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.execute) operator = operatorFrom(process.env);
} catch (error) {
  if (error instanceof UsageError) fail(error.message, 2);
  throw error;
}

const topics = parseTopics(
  readFileSync(resolve(root, 'infrastructure/docker/kafka/topics.txt'), 'utf8'),
);
let topology;
try {
  topology = topologyOf(options.dlq, { topics, consumers: contracts.TOPIC_CONSUMERS });
} catch (error) {
  if (error instanceof UsageError) fail(error.message, 2);
  throw error;
}

const configuredCa = process.env.KAFKA_SSL_CA_FILE?.trim();
const env = {
  ...process.env,
  KAFKA_SSL_CA_FILE:
    configuredCa && isAbsolute(configuredCa)
      ? configuredCa
      : resolve(root, 'infrastructure/docker/kafka/.tls/ca.pem'),
};
const connection = connectionFor(PRINCIPAL, env, (path) => readFileSync(path, 'utf8'));
if (!connection.sasl || !connection.ssl) {
  fail(
    'KAFKA_SASL_PASSWORD_OPS_REPLAY and the broker CA are required: the tool connects as ops-replay ' +
      'over SASL_SSL and as nothing else',
  );
}

const reportId = `rpl-${randomUUID()}`;
const mode = options.execute ? 'execute' : 'dry-run';
const kafka = new Kafka({
  ...connection,
  clientId: `ops-replay-${reportId}`,
  logLevel: logLevel.ERROR,
  retry: { initialRetryTime: 300, retries: 5 },
});
const admin = kafka.admin();

function report(line) {
  const text = `${JSON.stringify(line)}\n`;
  process.stdout.write(text);
  if (options.report) appendFileSync(options.report, text);
}

/**
 * Reads `[from, to)` of one partition under an `ops-replay.` group, never
 * committing. Returns `{ records, incomplete }`; incomplete when more than
 * `limit` records were in range or the read timed out.
 */
async function readPartition(topic, partition, from, to, limit = SCAN_LIMIT) {
  if (from >= to) return { records: [], incomplete: false };
  const consumer = kafka.consumer({
    groupId: `ops-replay.${reportId}.${topic}.${partition}`,
    allowAutoTopicCreation: false,
  });
  const records = [];
  try {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    const outcome = await new Promise((resolveRead, rejectRead) => {
      const timer = setTimeout(() => resolveRead('TIMEOUT'), 60_000);
      const settle = (value) => {
        clearTimeout(timer);
        resolveRead(value);
      };
      consumer
        .run({
          autoCommit: false,
          eachBatch: async ({ batch }) => {
            if (batch.partition !== partition) return;
            for (const message of batch.messages) {
              const offset = BigInt(message.offset);
              if (offset < from) continue;
              if (offset >= to) return settle('DONE');
              records.push({
                partition,
                offset: message.offset,
                key: message.key,
                value: message.value,
                headers: message.headers,
              });
              if (records.length > limit) return settle('LIMIT');
              if (offset + 1n >= to) return settle('DONE');
            }
            // A batch can end on offsets that carry no message (control
            // records); its last offset still says how far the log was read.
            if (BigInt(batch.lastOffset()) + 1n >= to) return settle('DONE');
          },
        })
        .then(() => consumer.seek({ topic, partition, offset: String(from) }))
        .catch(rejectRead);
    });
    return { records, incomplete: outcome !== 'DONE' };
  } finally {
    await consumer.disconnect().catch(() => undefined);
  }
}

/** `[low, high)` of a partition, as bigints. */
async function bounds(topic, partition) {
  const offsets = await admin.fetchTopicOffsets(topic);
  const entry = offsets.find((o) => o.partition === partition);
  if (!entry) throw new UsageError(`${topic} has no partition ${partition}`);
  return { low: BigInt(entry.low), high: BigInt(entry.high) };
}

/** The dead letters the selection names, in dead-letter order. */
async function select() {
  if (options.eventIds.length === 0) {
    const { low, high } = await bounds(options.dlq, options.partition);
    const from = BigInt(options.fromOffset);
    const to = BigInt(options.toOffset) + 1n;
    if (from < low || to > high) {
      throw new UsageError(
        `offsets ${options.fromOffset}–${options.toOffset} are not all on ${options.dlq}/${options.partition} (${low}–${high - 1n})`,
      );
    }
    const { records, incomplete } = await readPartition(options.dlq, options.partition, from, to);
    if (incomplete) throw new Error(`could not read ${options.dlq}/${options.partition} in full`);
    return records;
  }

  const wanted = new Set(options.eventIds);
  const found = new Map();
  const offsets = await admin.fetchTopicOffsets(options.dlq);
  for (const { partition, low, high } of offsets) {
    const { records, incomplete } = await readPartition(
      options.dlq,
      partition,
      BigInt(low),
      BigInt(high),
    );
    if (incomplete) throw new Error(`could not read ${options.dlq}/${partition} in full`);
    for (const record of records) {
      const headers = headerStrings(record.headers);
      let eventId = headers[contracts.EVENT_HEADERS.eventId];
      if (!eventId) {
        try {
          eventId = JSON.parse(record.value?.toString('utf8') ?? '').eventId;
        } catch {
          eventId = undefined;
        }
      }
      if (!wanted.has(eventId)) continue;
      if (found.has(eventId)) {
        throw new UsageError(
          `${eventId} is on ${options.dlq} more than once; select it by offset instead`,
        );
      }
      found.set(eventId, record);
    }
  }
  const missing = options.eventIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw new UsageError(`not on ${options.dlq}: ${missing.join(', ')}`);
  return [...found.values()].sort((a, b) =>
    a.partition !== b.partition
      ? a.partition - b.partition
      : BigInt(a.offset) < BigInt(b.offset)
        ? -1
        : 1,
  );
}

/** Staleness for every replayable record: one scan per original partition. */
async function staleness(assessments) {
  const probes = new Map();
  for (const assessment of assessments) {
    if (assessment.verdict !== 'REPLAYABLE') continue;
    const probe = stalenessProbe(assessment, contracts.RETRY_TOPIC_SUFFIX);
    if (!probe) continue;
    const id = `${probe.topic}\u0000${probe.partition}`;
    const group = probes.get(id) ?? { ...probe, from: probe.after + 1n };
    if (probe.after + 1n < group.from) group.from = probe.after + 1n;
    probes.set(id, group);
  }
  const scans = new Map();
  for (const [id, group] of probes) {
    const { low, high } = await bounds(group.topic, group.partition);
    // Retention may have taken the start of the tail: read what is left, and
    // let `staleFrom` see how much is missing.
    const from = group.from > low ? group.from : low;
    const scan = await readPartition(group.topic, group.partition, from, high);
    scans.set(id, {
      low,
      incomplete: scan.incomplete,
      records: scan.records.map((r) => ({
        offset: r.offset,
        key: r.key == null ? null : r.key.toString('utf8'),
      })),
    });
  }
  return assessments.map((assessment) => {
    if (assessment.verdict !== 'REPLAYABLE')
      return withStaleness(assessment, null, options.allowStale);
    const probe = stalenessProbe(assessment, contracts.RETRY_TOPIC_SUFFIX);
    const scan = probe ? scans.get(`${probe.topic}\u0000${probe.partition}`) : undefined;
    return withStaleness(assessment, staleFrom(probe, scan), options.allowStale);
  });
}

let exitCode = 0;
try {
  await admin.connect();
  if (options.report) writeFileSync(options.report, '');
  const records = await select();
  const assessed = records.map((record) =>
    assess(record, { dlq: options.dlq, topology, topics, contracts }),
  );
  const decisions = await staleness(assessed);

  if (!options.execute) {
    for (const decision of decisions) report(reportLine(reportId, mode, decision));
    const replayable = decisions.filter((d) => d.verdict === 'REPLAYABLE').length;
    report({
      reportId,
      mode,
      summary: true,
      dlq: options.dlq,
      selected: decisions.length,
      replayable,
      refused: decisions.length - replayable,
    });
  } else {
    const problems = executionProblems(decisions, options.expectCount);
    if (problems.length > 0) {
      for (const decision of decisions) report(reportLine(reportId, mode, decision));
      report({ reportId, mode, summary: true, written: 0, refused: problems });
      exitCode = 1;
    } else {
      const replayId = `${reportId}/${operator}`;
      const producer = kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        allowAutoTopicCreation: false,
      });
      await producer.connect();
      let written = 0;
      try {
        for (const decision of decisions) {
          try {
            const [result] = await producer.send({
              topic: decision.summary.target,
              acks: -1,
              messages: [replayMessage(decision, replayId, contracts.REPLAY_HEADERS)],
            });
            written += 1;
            report(
              reportLine(reportId, mode, decision, {
                replayId,
                replayPartition: result?.partition ?? null,
                replayOffset: result?.baseOffset ?? null,
                replayedAt: new Date().toISOString(),
              }),
            );
          } catch (error) {
            report(reportLine(reportId, mode, decision, { replayId, error: error.message }));
            exitCode = 1;
            break;
          }
        }
      } finally {
        await producer.disconnect().catch(() => undefined);
      }
      report({ reportId, mode, summary: true, replayId, written, expected: options.expectCount });
    }
  }
} catch (error) {
  process.stderr.write(`replay-dlq: ${error.message}\n`);
  exitCode = error instanceof UsageError ? 2 : 1;
} finally {
  await admin.disconnect().catch(() => undefined);
}
process.exit(exitCode);

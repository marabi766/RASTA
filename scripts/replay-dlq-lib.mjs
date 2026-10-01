/**
 * The DLQ replay tool's rules (docs/runbooks/replay-dlq.md, ADR-051 § R6,
 * docs/23 D-039/D-040) — pure: records and arguments in, verdicts out. The
 * broker half is `replay-dlq.mjs`.
 *
 * A dead letter is replayed only when every rule below holds; each refusal is
 * named in the report:
 *
 *   - it came from a topic the dead-letter topic's own consumer subscribes to,
 *     and it goes to that topic's `.retry` twin — never the original topic,
 *     never computed from the dead-letter topic's name;
 *   - its body is a valid envelope, and its platform headers agree with that
 *     body — on presence as on value: a header whose field the body lacks, or
 *     a field whose header is missing, is a disagreement too (refused, not
 *     repaired);
 *   - its reason is one a replay can change (`PRODUCER_NOT_ALLOWED`,
 *     `SOURCE_UNCONFIRMED` and `BACKFILL_REQUIRED` are not: the same claim gets
 *     the same answer);
 *   - it is not a `NEVER_AUTO_REPLAY` event, nor from a
 *     `NEVER_AUTO_REPLAY_TOPICS` topic (or its `.retry`) whatever its name —
 *     money is replayed by the runbook's manual procedure, and this tool has
 *     no override for it;
 *   - it kept its message key (D-040, #145), and the replay goes out under
 *     that key, never one inferred: a sequenced event's kept key must be its
 *     stream key (`KEY_MISMATCH`), and one dead-lettered without a key is
 *     refused (`KEY_UNVERIFIABLE`: before #145, or published without one —
 *     the two cannot be told apart without the original record); an
 *     unsequenced event with no kept key is refused (`UNSEQUENCED_NO_KEY`),
 *     with no guessing from `aggregateId`;
 *   - it is not stale — no newer event for the same stream key on the original
 *     topic — unless the operator names it with `--allow-stale <eventId>`;
 *     staleness that cannot be known (a `.retry` original, a partial read, or
 *     retention past the original offset) needs the same.
 *
 * What is replayed: the original body, byte for byte, under that key, with
 * only the platform headers (`EVENT_HEADERS`) — each as the original publisher
 * set it — and `x-replay-id: <reportId>/<operator>/<seq>/<eventId>` (one per
 * replayed event: `seq` is its 1-based place in the run, see `replayIdFor`),
 * never an `x-dlq-*` header.
 * `x-producer` is the one platform header a dead letter does not keep: the
 * dead-lettering consumer overwrites it with its own client id. It is neither
 * compared nor copied; it is restored from the envelope's `producer`, exactly
 * as the outbox relay set it.
 *
 * A dead letter from a `.retry` topic (a replay that failed again) names that
 * topic as its original: exactly one `.retry` suffix is stripped to find the
 * subscribed topic, and the replay goes back to that same `.retry` twin.
 */

export const DEFAULT_MAX = 10;
export const MAX_CEILING = 100;
/** How far a scan reads before it gives up and reports what it could not see. */
export const SCAN_LIMIT = 100_000;
/** An operator named in the environment: a login or an address, never a secret. */
export const OPERATOR_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

export class UsageError extends Error {}

const OFFSET = /^\d+$/;

/**
 * The command line. Selection is always explicit and bounded: `--event-id`
 * (repeatable) or one partition's offset range, never "the whole DLQ".
 */
export function parseArgs(argv) {
  const options = { eventIds: [], allowStale: [], execute: false, max: DEFAULT_MAX };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--dlq':
        options.dlq = value(i, flag);
        i += 1;
        break;
      case '--event-id':
        options.eventIds.push(value(i, flag));
        i += 1;
        break;
      case '--partition':
        options.partition = value(i, flag);
        i += 1;
        break;
      case '--from-offset':
        options.fromOffset = value(i, flag);
        i += 1;
        break;
      case '--to-offset':
        options.toOffset = value(i, flag);
        i += 1;
        break;
      case '--max':
        options.max = Number(value(i, flag));
        i += 1;
        break;
      case '--expect-count':
        options.expectCount = Number(value(i, flag));
        i += 1;
        break;
      case '--allow-stale':
        options.allowStale.push(value(i, flag));
        i += 1;
        break;
      case '--report':
        options.report = value(i, flag);
        i += 1;
        break;
      case '--execute':
        options.execute = true;
        break;
      default:
        throw new UsageError(`unknown argument ${flag}`);
    }
  }

  if (!options.dlq) throw new UsageError('--dlq <dead-letter topic> is required');
  if (!Number.isInteger(options.max) || options.max < 1 || options.max > MAX_CEILING) {
    throw new UsageError(`--max must be an integer from 1 to ${MAX_CEILING}`);
  }
  const byRange = [options.partition, options.fromOffset, options.toOffset].some(
    (v) => v !== undefined,
  );
  if (byRange === options.eventIds.length > 0) {
    throw new UsageError(
      'select either --event-id (repeatable) or --partition with --from-offset and --to-offset',
    );
  }
  if (byRange) {
    for (const [name, v] of [
      ['--partition', options.partition],
      ['--from-offset', options.fromOffset],
      ['--to-offset', options.toOffset],
    ]) {
      if (v === undefined || !OFFSET.test(v)) throw new UsageError(`${name} must be a number`);
    }
    options.partition = Number(options.partition);
    const size = BigInt(options.toOffset) - BigInt(options.fromOffset) + 1n;
    if (size < 1n) throw new UsageError('--to-offset is before --from-offset');
    if (size > BigInt(options.max)) {
      throw new UsageError(`the range holds ${size} offsets, more than --max ${options.max}`);
    }
  } else {
    if (new Set(options.eventIds).size !== options.eventIds.length) {
      throw new UsageError('an --event-id is repeated');
    }
    if (options.eventIds.length > options.max) {
      throw new UsageError(`${options.eventIds.length} event ids, more than --max ${options.max}`);
    }
  }
  if (options.execute) {
    if (!Number.isInteger(options.expectCount) || options.expectCount < 1) {
      throw new UsageError(
        '--execute needs --expect-count N, the number the matching dry-run selected',
      );
    }
  } else if (options.expectCount !== undefined) {
    throw new UsageError('--expect-count is for --execute');
  }
  return options;
}

/** The operator an executed replay is stamped with: required, and never a secret. */
export function operatorFrom(env) {
  const operator = env.REPLAY_OPERATOR?.trim();
  if (!operator || !OPERATOR_PATTERN.test(operator)) {
    throw new UsageError(
      'REPLAY_OPERATOR must name who runs the replay (letters, digits, . _ @ -; at most 64)',
    );
  }
  return operator;
}

/** `topics.txt` as `Map<topic, kind>`. */
export function parseTopics(text) {
  const kinds = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [name, kind] = trimmed.split(/\s+/);
    kinds.set(name, kind);
  }
  return kinds;
}

/**
 * The topology a dead-letter topic implies: the one consumer that writes it,
 * and the topics that consumer subscribes to — the only ones its dead letters
 * can have come from.
 */
export function topologyOf(dlq, { topics, consumers }) {
  if (topics.get(dlq) !== 'dead-letter') {
    throw new UsageError(`${dlq} is not a dead-letter topic in topics.txt`);
  }
  const owners = Object.entries(consumers).filter(([, c]) => c.deadLetterTopic === dlq);
  if (owners.length !== 1) {
    throw new UsageError(`${dlq} is not the dead-letter topic of exactly one consumer`);
  }
  const [consumer, { subscribes }] = owners[0];
  return { consumer, subscribes: new Set(subscribes) };
}

/** kafkajs headers (Buffer, string or array) as plain strings; the first of a repeat. */
export function headerStrings(headers = {}) {
  const out = {};
  for (const [name, raw] of Object.entries(headers)) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (first === undefined || first === null) continue;
    out[name] = Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
  }
  return out;
}

/** Where an envelope field lives, for each platform header. */
const HEADER_FIELDS = {
  eventId: 'eventId',
  eventName: 'eventName',
  eventVersion: 'eventVersion',
  correlationId: 'correlationId',
  causationId: 'causationId',
  tenantId: 'tenantId',
  producer: 'producer',
  traceparent: 'traceparent',
  streamSeq: 'streamSeq',
};

/**
 * The verdict on one dead letter, before staleness: everything that can be
 * decided from the record and the contracts alone.
 *
 * `record`: `{ partition, offset, key, value, headers }` as kafkajs gives it.
 * `contracts`: `{ EVENT_HEADERS, DLQ_HEADERS, DLQ_REASONS, NEVER_AUTO_REPLAY,
 *  NEVER_AUTO_REPLAY_TOPICS, eventEnvelopeSchema, RETRY_TOPIC_SUFFIX }`.
 */
export function assess(record, { dlq, topology, topics, contracts }) {
  const { EVENT_HEADERS, DLQ_HEADERS, DLQ_REASONS, NEVER_AUTO_REPLAY, NEVER_AUTO_REPLAY_TOPICS } =
    contracts;
  const headers = headerStrings(record.headers);
  const summary = {
    dlq,
    dlqPartition: record.partition,
    dlqOffset: String(record.offset),
    eventId: headers[EVENT_HEADERS.eventId] ?? null,
    eventName: headers[EVENT_HEADERS.eventName] ?? null,
    tenantId: headers[EVENT_HEADERS.tenantId] ?? null,
    reason: headers[DLQ_HEADERS.reason] ?? null,
    originalTopic: headers[DLQ_HEADERS.originalTopic] ?? null,
    originalPartition: headers[DLQ_HEADERS.originalPartition] ?? null,
    originalOffset: headers[DLQ_HEADERS.originalOffset] ?? null,
    firstFailedAt: headers[DLQ_HEADERS.firstFailedAt] ?? null,
    streamKey: null,
    streamSeq: null,
    key: record.key == null ? null : record.key.toString('utf8'),
    target: null,
  };
  const refuse = (refusal) => ({ summary, verdict: 'REFUSED', refusal });

  if (!summary.reason) return refuse('NO_DLQ_REASON');
  if (!summary.originalTopic) return refuse('NO_ORIGINAL_TOPIC');
  const suffix = contracts.RETRY_TOPIC_SUFFIX;
  const base = summary.originalTopic.endsWith(suffix)
    ? summary.originalTopic.slice(0, -suffix.length)
    : summary.originalTopic;
  if (!topology.subscribes.has(base)) return refuse('ORIGINAL_TOPIC_NOT_SUBSCRIBED');
  // By source topic, whatever event it names: the economic stream is never replayed.
  if (NEVER_AUTO_REPLAY_TOPICS.has(base)) return refuse('NEVER_AUTO_REPLAY');
  const target = `${base}${suffix}`;
  if (topics.get(target) !== 'retry') return refuse('UNKNOWN_RETRY_TOPIC');
  summary.target = target;

  // The body as published, before the schema fills in any default
  // (`eventVersion` defaults to 1): presence is judged on this.
  let raw;
  try {
    raw = JSON.parse(record.value?.toString('utf8') ?? '');
  } catch {
    return refuse('UNPARSEABLE_BODY');
  }
  const parsed = contracts.eventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return refuse('INVALID_ENVELOPE');
  const envelope = parsed.data;
  summary.eventId = envelope.eventId;
  summary.eventName = envelope.eventName;
  summary.tenantId = envelope.tenantId ?? null;
  summary.streamKey = envelope.streamKey ?? null;
  summary.streamSeq = envelope.streamSeq ?? null;

  for (const [field, name] of Object.entries(EVENT_HEADERS)) {
    // The dead letter's x-producer names the consumer that wrote it, by design.
    if (field === 'producer') continue;
    const header = headers[name];
    // The relay writes a header exactly when the body has the field (an empty
    // one included, as absent), so the two agree on presence — judged on the
    // body as published, not after schema defaults — and on value.
    const published = raw[HEADER_FIELDS[field]];
    const bodyPresent = published !== undefined && published !== null && published !== '';
    if ((header !== undefined) !== bodyPresent) return refuse(`HEADER_BODY_MISMATCH:${name}`);
    const body = envelope[HEADER_FIELDS[field]];
    if (header !== undefined && header !== String(body)) {
      return refuse(`HEADER_BODY_MISMATCH:${name}`);
    }
  }
  const unfixable = [
    DLQ_REASONS.PRODUCER_NOT_ALLOWED,
    DLQ_REASONS.SOURCE_UNCONFIRMED,
    DLQ_REASONS.BACKFILL_REQUIRED,
  ];
  if (unfixable.includes(summary.reason)) return refuse('REASON_NOT_REPLAYABLE');
  if (NEVER_AUTO_REPLAY.has(envelope.eventName)) return refuse('NEVER_AUTO_REPLAY');
  // The replay goes out under the key the dead letter kept (#145), never one
  // inferred: a record published without a key sits on a partition that
  // `streamKey` does not name.
  const key = summary.key;
  if (envelope.streamKey) {
    // Dead-lettered with no key: before #145, or published without one —
    // which, without reading the original record, cannot be told apart.
    if (key === null) return refuse('KEY_UNVERIFIABLE');
    if (key !== envelope.streamKey) return refuse('KEY_MISMATCH');
  }
  // Unsequenced and dead-lettered before the key was kept (#145): nothing
  // says which partition key the publisher used.
  if (!key) return refuse('UNSEQUENCED_NO_KEY');

  // Its REPLAY_EXECUTED record must be writable before anything is sent
  // (round 1 on #166): the same schema, with this run's values stood in, so
  // an event id past 128 characters — which the envelope allows and the
  // record does not — is refused here by name, never discovered mid-run.
  const unrecordable = recordProblem(summary, contracts);
  if (unrecordable) return refuse(`UNRECORDABLE:${unrecordable}`);

  const restored = {};
  for (const [field, name] of Object.entries(EVENT_HEADERS)) {
    if (field === 'producer') continue;
    if (headers[name] !== undefined) restored[name] = headers[name];
  }
  restored[EVENT_HEADERS.producer] = envelope.producer;
  return {
    summary,
    verdict: 'REPLAYABLE',
    refusal: null,
    message: { key, value: record.value, headers: restored },
  };
}

/** A report id and operator of the right shape, standing in for the run's own. */
const RECORD_PROBE = Object.freeze({
  reportId: 'rpl-00000000-0000-4000-8000-000000000000',
  operator: 'probe',
});

/**
 * The first field of this dead letter the `REPLAY_EXECUTED` v1 payload would
 * refuse, as its schema path (`replayedEvent.eventId`), or `null` when a
 * record can be written for it. The target position is not known yet and is
 * stood in by `0`; the run's report id and operator are checked on their own.
 */
export function recordProblem(summary, contracts) {
  const probe = contracts.replayExecutedPayloadSchemaV1.safeParse({
    ...RECORD_PROBE,
    replayedEvent: {
      eventId: summary.eventId,
      eventName: summary.eventName,
      ...(summary.tenantId === null || summary.tenantId === undefined
        ? {}
        : { tenantId: summary.tenantId }),
    },
    dlq: { topic: summary.dlq, partition: summary.dlqPartition, offset: summary.dlqOffset },
    target: { topic: summary.target, partition: 0, offset: '0' },
    stale: false,
  });
  if (probe.success) return null;
  return probe.error.issues[0].path.join('.') || '(root)';
}

/**
 * Where to look for a newer event on the stream: the original topic, from
 * just after the dead letter's original offset. A `.retry` original, or one
 * without its position, cannot be looked at: its staleness is unknown.
 */
export function stalenessProbe(assessment, suffix) {
  const { originalTopic, originalPartition, originalOffset } = assessment.summary;
  if (
    !originalTopic ||
    originalTopic.endsWith(suffix) ||
    originalPartition === null ||
    !OFFSET.test(originalPartition) ||
    originalOffset === null ||
    !OFFSET.test(originalOffset)
  ) {
    return null;
  }
  return {
    topic: originalTopic,
    partition: Number(originalPartition),
    after: BigInt(originalOffset),
    key: assessment.summary.key,
  };
}

/**
 * Staleness from a scan of the original partition: `true` when a record with
 * the same key sits after the original offset, `false` when the scan saw the
 * whole tail without one, `'UNKNOWN'` when it could not — read in part, or
 * retention already took records after the original (the partition's low
 * watermark `scan.low` is past it: streams keep 7 days, dead letters 30).
 */
export function staleFrom(probe, scan) {
  if (!probe || !scan || scan.incomplete) return 'UNKNOWN';
  const newer = scan.records.some(
    (record) => BigInt(record.offset) > probe.after && record.key === probe.key,
  );
  if (newer) return true;
  if (typeof scan.low !== 'bigint' || scan.low > probe.after + 1n) return 'UNKNOWN';
  return false;
}

/** The final verdict: a stale, or unknowably stale, record needs `--allow-stale <eventId>`. */
export function withStaleness(assessment, stale, allowStale) {
  const summary = { ...assessment.summary, stale };
  if (assessment.verdict !== 'REPLAYABLE') return { ...assessment, summary };
  if (stale !== false && !allowStale.includes(summary.eventId)) {
    return {
      ...assessment,
      summary,
      verdict: 'REFUSED',
      refusal: stale === true ? 'STALE' : 'STALENESS_UNKNOWN',
    };
  }
  return { ...assessment, summary };
}

/**
 * Whether an execution may write anything: every selected record replayable,
 * and exactly as many as the operator expected from the dry-run. All or
 * nothing: a selection with a refusal in it is narrowed, not half-replayed.
 */
export function executionProblems(decisions, expectCount) {
  const problems = [];
  if (decisions.length === 0) problems.push('the selection holds no record');
  const refused = decisions.filter((d) => d.verdict !== 'REPLAYABLE');
  if (refused.length > 0) {
    problems.push(
      `${refused.length} selected record(s) are refused (${[...new Set(refused.map((d) => d.refusal))].join(', ')}); narrow the selection`,
    );
  }
  if (decisions.length !== expectCount) {
    problems.push(`--expect-count ${expectCount} but the selection holds ${decisions.length}`);
  }
  return problems;
}

/**
 * The replay stamp of one replayed event: `<reportId>/<operator>/<seq>/<eventId>`,
 * `seq` its 1-based place among the run's replays. Per event, not per run
 * (round 2 on #166): after an unknown commit, the search for this exact value
 * can only find this event's replay — never an earlier one of the same run.
 * The operator pattern has no `/`, so the last segment is the whole event id.
 */
export function replayIdFor(reportId, operator, seq, eventId) {
  return `${reportId}/${operator}/${seq}/${eventId}`;
}

/** The record published to `.retry`: body unchanged, keyed, platform headers and the replay stamp. */
export function replayMessage(decision, replayId, REPLAY_HEADERS) {
  return {
    key: decision.message.key,
    value: decision.message.value,
    headers: { ...decision.message.headers, [REPLAY_HEADERS.replayId]: replayId },
  };
}

/** `producerVersion` of every replay record: the version of these rules. */
export const REPLAY_TOOL_VERSION = '1.0.0';

/**
 * The platform's record of one executed replay: a `REPLAY_EXECUTED` on
 * `rasta.ops.replay.v1` (contracts `ops-replay.ts`), published after the
 * replay landed on `.retry` at `landed` (`{ partition, offset }`). Ids and
 * positions only — never the replayed payload. Keyed by the report id, so one
 * run's records sit on one partition, in order.
 *
 * The envelope and payload are checked against the contracts before anything
 * is sent: a record audit-service would refuse is a failure here, not later.
 */
export function replayExecutedRecord(
  decision,
  { reportId, operator, landed, eventId, occurredAt },
  contracts,
) {
  const { summary } = decision;
  const tenantId = summary.tenantId ?? undefined;
  const payload = {
    reportId,
    operator,
    replayedEvent: {
      eventId: summary.eventId,
      eventName: summary.eventName,
      ...(tenantId === undefined ? {} : { tenantId }),
    },
    dlq: { topic: summary.dlq, partition: summary.dlqPartition, offset: summary.dlqOffset },
    target: { topic: summary.target, partition: landed.partition, offset: String(landed.offset) },
    stale: summary.stale,
  };
  const envelope = {
    eventId,
    eventName: contracts.REPLAY_EXECUTED,
    eventVersion: contracts.REPLAY_EXECUTED_VERSION,
    occurredAt,
    producer: contracts.OPS_REPLAY_PRODUCER,
    producerVersion: REPLAY_TOOL_VERSION,
    aggregateType: contracts.REPLAY_RUN_AGGREGATE,
    aggregateId: reportId,
    ...(tenantId === undefined ? {} : { tenantId }),
    correlationId: reportId,
    causationId: summary.eventId,
    actor: { type: 'USER', id: operator },
    payload,
  };
  const checkedPayload = contracts.replayExecutedPayloadSchemaV1.safeParse(payload);
  const checkedEnvelope = contracts.eventEnvelopeSchema.safeParse(envelope);
  if (!checkedPayload.success || !checkedEnvelope.success) {
    const issues = [
      ...(checkedPayload.success ? [] : checkedPayload.error.issues),
      ...(checkedEnvelope.success ? [] : checkedEnvelope.error.issues),
    ].map((issue) => `${issue.path.join('.') || '(root)'} ${issue.code}`);
    throw new Error(`the replay record breaks its contract: ${issues.join(', ')}`);
  }
  const { EVENT_HEADERS } = contracts;
  const headers = {
    [EVENT_HEADERS.eventId]: envelope.eventId,
    [EVENT_HEADERS.eventName]: envelope.eventName,
    [EVENT_HEADERS.eventVersion]: String(envelope.eventVersion),
    [EVENT_HEADERS.correlationId]: envelope.correlationId,
    [EVENT_HEADERS.causationId]: envelope.causationId,
    [EVENT_HEADERS.producer]: envelope.producer,
    ...(tenantId === undefined ? {} : { [EVENT_HEADERS.tenantId]: tenantId }),
  };
  return { key: reportId, value: JSON.stringify(envelope), headers };
}

/**
 * `--execute` once every check has passed: for each decision, in order, one
 * Kafka transaction holding the replay to its `.retry` **and** its
 * `REPLAY_EXECUTED` record on `rasta.ops.replay.v1` (round 1 on #166).
 *
 * `beginTransaction()` opens one (a transactional producer, id
 * `ops-replay.<reportId>`); its `send(topic, message)` resolves
 * `{ partition, offset }`, and `commit()` / `abort()` end it. Consumers read
 * committed only (kafkajs' default, and `EventConsumer`'s), so the pair is
 * seen together or not at all: a failure before the commit — of either send,
 * of building the record, or the process being killed — leaves neither
 * record visible (an open transaction is aborted by its coordinator, or
 * fenced by the next producer with the same id).
 *
 * Stops at the first failure and fails the run. A commit whose answer was
 * lost is the one outcome the tool cannot know: the pair is either committed
 * or not — never one without the other — and the warning names how to tell:
 * this event's own replay stamp at the position the replay was written to.
 */
export async function executeReplays(
  decisions,
  { reportId, operator, beginTransaction, newEventId, now, report, warn, contracts },
) {
  let written = 0;
  for (const [index, decision] of decisions.entries()) {
    const replayId = replayIdFor(reportId, operator, index + 1, decision.summary.eventId);
    let transaction;
    let line = { replayId };
    try {
      transaction = await beginTransaction();
      const landed = await transaction.send(
        decision.summary.target,
        replayMessage(decision, replayId, contracts.REPLAY_HEADERS),
      );
      const replayedAt = now();
      const auditEventId = newEventId();
      line = {
        replayId,
        replayPartition: landed.partition,
        replayOffset: String(landed.offset),
        replayedAt,
        auditEventId,
      };
      const record = replayExecutedRecord(
        decision,
        { reportId, operator, landed, eventId: auditEventId, occurredAt: replayedAt },
        contracts,
      );
      const audited = await transaction.send(contracts.OPS_REPLAY_TOPIC, record);
      line = { ...line, auditPartition: audited.partition, auditOffset: String(audited.offset) };
    } catch (error) {
      await transaction?.abort().catch(() => undefined);
      report(
        reportLine(reportId, 'execute', decision, {
          ...line,
          error: error.message,
          committed: false,
        }),
      );
      return { written, recorded: written, failed: true };
    }
    try {
      await transaction.commit();
    } catch (error) {
      report(
        reportLine(reportId, 'execute', decision, {
          ...line,
          error: error.message,
          committed: 'UNKNOWN',
        }),
      );
      warn(
        `COMMIT OUTCOME UNKNOWN for ${decision.summary.eventId} (${error.message}): its replay and ` +
          `its ${contracts.REPLAY_EXECUTED} record are both committed or both not. It landed — if ` +
          `committed — at ${decision.summary.target} partition ${line.replayPartition} offset ` +
          `${line.replayOffset}: read that position read-committed and look for exactly ` +
          `x-replay-id ${replayId}; any other x-replay-id, this run's earlier ones included, says ` +
          'nothing about this event (runbook: docs/runbooks/replay-dlq.md, step 3). Stopped here.',
      );
      return { written, recorded: written, failed: true };
    }
    written += 1;
    report(reportLine(reportId, 'execute', decision, { ...line, committed: true }));
  }
  return { written, recorded: written, failed: false };
}

/** One report line: ids, names, reasons and offsets — never a payload. */
export function reportLine(reportId, mode, decision, extra = {}) {
  return {
    reportId,
    mode,
    ...decision.summary,
    verdict: decision.verdict,
    refusal: decision.refusal,
    ...extra,
  };
}

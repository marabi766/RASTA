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
 *   - its body is a valid envelope, and every platform header it carries
 *     agrees with that body (a disagreement is refused, not repaired);
 *   - its reason is one a replay can change (`PRODUCER_NOT_ALLOWED`,
 *     `SOURCE_UNCONFIRMED` and `BACKFILL_REQUIRED` are not: the same claim gets
 *     the same answer);
 *   - it is not a `NEVER_AUTO_REPLAY` event — money is replayed by the
 *     runbook's manual procedure, and this tool has no override for it;
 *   - it carries its stream key (`envelope.streamKey`), which becomes the
 *     message key: an unsequenced event is refused until the dead letter keeps
 *     the original key (D-040) — no guessing from `aggregateId`;
 *   - it is not stale — no newer event for the same stream key on the original
 *     topic — unless the operator names it with `--allow-stale <eventId>`.
 *
 * What is replayed: the original body, byte for byte, keyed by the stream key,
 * with only the platform headers (`EVENT_HEADERS`) it carried, and
 * `x-replay-id: <reportId>/<operator>` — never an `x-dlq-*` header.
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
 *  eventEnvelopeSchema, RETRY_TOPIC_SUFFIX }`.
 */
export function assess(record, { dlq, topology, topics, contracts }) {
  const { EVENT_HEADERS, DLQ_HEADERS, DLQ_REASONS, NEVER_AUTO_REPLAY } = contracts;
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
  const target = `${base}${suffix}`;
  if (topics.get(target) !== 'retry') return refuse('UNKNOWN_RETRY_TOPIC');
  summary.target = target;

  let envelope;
  try {
    const parsed = contracts.eventEnvelopeSchema.safeParse(
      JSON.parse(record.value?.toString('utf8') ?? ''),
    );
    if (!parsed.success) return refuse('INVALID_ENVELOPE');
    envelope = parsed.data;
  } catch {
    return refuse('UNPARSEABLE_BODY');
  }
  summary.eventId = envelope.eventId;
  summary.eventName = envelope.eventName;
  summary.tenantId = envelope.tenantId ?? null;
  summary.streamKey = envelope.streamKey ?? null;
  summary.streamSeq = envelope.streamSeq ?? null;

  for (const [field, name] of Object.entries(EVENT_HEADERS)) {
    const header = headers[name];
    const body = envelope[HEADER_FIELDS[field]];
    if (header !== undefined && body !== undefined && header !== String(body)) {
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
  if (!envelope.streamKey) return refuse('UNSEQUENCED');
  const key = record.key == null ? null : record.key.toString('utf8');
  if (key !== null && key !== envelope.streamKey) return refuse('KEY_MISMATCH');

  const restored = {};
  for (const name of Object.values(EVENT_HEADERS)) {
    if (headers[name] !== undefined) restored[name] = headers[name];
  }
  return {
    summary,
    verdict: 'REPLAYABLE',
    refusal: null,
    message: { key: envelope.streamKey, value: record.value, headers: restored },
  };
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
    key: assessment.summary.streamKey,
  };
}

/**
 * Staleness from a scan of the original partition: `true` when a record with
 * the same key sits after the original offset, `false` when the scan saw the
 * whole tail without one, `'UNKNOWN'` when it could not.
 */
export function staleFrom(probe, scan) {
  if (!probe || !scan || scan.incomplete) return 'UNKNOWN';
  return scan.records.some(
    (record) => BigInt(record.offset) > probe.after && record.key === probe.key,
  );
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

/** The record published to `.retry`: body unchanged, keyed, platform headers and the replay stamp. */
export function replayMessage(decision, replayId, REPLAY_HEADERS) {
  return {
    key: decision.message.key,
    value: decision.message.value,
    headers: { ...decision.message.headers, [REPLAY_HEADERS.replayId]: replayId },
  };
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

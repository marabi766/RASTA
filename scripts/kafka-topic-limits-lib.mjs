/**
 * The rule `infrastructure/docker/kafka/topics.txt` must keep for message
 * sizes (PR #378 r2 F1, r4 F2): every topic states its planned
 * `max.message.bytes`; every dead-letter topic lists its sources — what each
 * consumer writing it subscribes to, and each one's `.retry` twin, from
 * `TOPIC_CONSUMERS` — and is planned above the largest of them by the bound on
 * the headers the shared consumer adds (`DLQ_ADDED_HEADERS_MAX_BYTES`, also
 * stated in the file's `#@` line) and GZIP's worst-case growth
 * (`gzipGrowthMaxBytes`). `create-topics.sh` reads the sources and the bound
 * to size each dead-letter topic over its sources' effective limits on a
 * running broker.
 *
 * That headroom covers the shared consumer's dead letter of a source batch
 * sent uncompressed, or GZIP that did not shrink; for compressible batches it
 * is measured, not proved, and it does not cover a source compressed at a
 * higher level than the dead letter's, nor fleet's parked dead letters
 * (`@rasta/contracts` dead-letter-size.ts). A dead letter the topic refuses is
 * never committed past.
 *
 * Pure: the caller passes the parsed file and the contracts' values.
 */

/**
 * `topics.txt` as `Map<topic, { kind, maxMessageBytes, sources }>`; a missing
 * or unreadable limit is `undefined`, and so are the sources of a line with
 * no fourth column.
 */
export function parseTopicLimits(text) {
  const topics = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [name, kind, limit, sources] = trimmed.split(/\s+/);
    topics.set(name, {
      kind,
      maxMessageBytes:
        limit !== undefined && /^[1-9][0-9]*$/.test(limit) ? Number(limit) : undefined,
      sources: sources === undefined ? undefined : sources.split(','),
    });
  }
  return topics;
}

/** The added-header bound `topics.txt` states in its `#@` line; `undefined` unless exactly one. */
export function parseAddedHeaderBound(text) {
  const stated = text
    .split('\n')
    .map((line) => /^#@ dead-letter-added-headers-max-bytes ([1-9][0-9]*)$/.exec(line.trim()))
    .filter(Boolean);
  return stated.length === 1 ? Number(stated[0][1]) : undefined;
}

/** The smallest limit a dead-letter topic needs over a source limited to `sourceMaxBytes`. */
export function requiredDeadLetterBytes(
  sourceMaxBytes,
  { addedHeadersMaxBytes, gzipGrowthMaxBytes },
) {
  const uncompressed = sourceMaxBytes + addedHeadersMaxBytes;
  return uncompressed + gzipGrowthMaxBytes(uncompressed);
}

/**
 * Every way `topics` breaks the rule, as text; empty when it holds.
 *
 * `consumers` is `TOPIC_CONSUMERS`; `bounds` carries `addedHeadersMaxBytes`
 * and `gzipGrowthMaxBytes` from `@rasta/contracts`.
 */
export function topicLimitProblems(topics, consumers, bounds, retrySuffix = '.retry') {
  const problems = [];
  for (const [name, { maxMessageBytes }] of topics) {
    if (maxMessageBytes === undefined) problems.push(`${name}: no explicit max.message.bytes`);
  }

  const sources = new Map();
  for (const [service, { subscribes, deadLetterTopic }] of Object.entries(consumers)) {
    const dlq = topics.get(deadLetterTopic);
    if (!dlq || dlq.kind !== 'dead-letter') {
      problems.push(
        `${deadLetterTopic}: ${service}'s dead-letter topic is not a dead-letter topic in topics.txt`,
      );
    }
    const into = sources.get(deadLetterTopic) ?? new Set();
    for (const topic of subscribes) {
      into.add(topic);
      into.add(`${topic}${retrySuffix}`);
    }
    sources.set(deadLetterTopic, into);
  }

  for (const [name, { kind, sources: listed }] of topics) {
    if (kind !== 'dead-letter' && listed !== undefined) {
      problems.push(`${name}: only a dead-letter topic lists sources`);
    }
  }

  for (const [deadLetterTopic, from] of sources) {
    const listed = topics.get(deadLetterTopic)?.sources;
    const expected = [...from].sort();
    if (topics.has(deadLetterTopic) && listed?.join(',') !== expected.join(',')) {
      problems.push(
        `${deadLetterTopic}: lists sources ${listed?.join(',') ?? '(none)'}, but TOPIC_CONSUMERS ` +
          `dead-letters ${expected.join(',')} into it; run pnpm kafka:acl:generate`,
      );
    }
    const limit = topics.get(deadLetterTopic)?.maxMessageBytes;
    for (const source of from) {
      const sourceLimit = topics.get(source)?.maxMessageBytes;
      if (!topics.has(source)) {
        problems.push(`${source}: dead-letters into ${deadLetterTopic} but is not in topics.txt`);
        continue;
      }
      if (sourceLimit === undefined || limit === undefined) continue;
      const required = requiredDeadLetterBytes(sourceLimit, bounds);
      if (limit < required) {
        problems.push(
          `${deadLetterTopic}: planned max.message.bytes ${limit} leaves no headroom over ` +
            `${source} (${sourceLimit}); it needs at least ${required} ` +
            `(${sourceLimit} + ${bounds.addedHeadersMaxBytes} added headers + ` +
            `${bounds.gzipGrowthMaxBytes(sourceLimit + bounds.addedHeadersMaxBytes)} GZIP)`,
        );
      }
    }
  }
  return problems;
}

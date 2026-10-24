/**
 * The rule `infrastructure/docker/kafka/topics.txt` must keep for message
 * sizes (PR #378 r2 F1): every topic states its `max.message.bytes`, and every
 * dead-letter topic has room for the dead letter of the largest record any of
 * its source topics admits.
 *
 * A dead letter is the source record plus the headers the shared consumer adds
 * (at most `DLQ_ADDED_HEADERS_MAX_BYTES` serialized), sent GZIP (at most
 * `gzipGrowthMaxBytes(n)` more than `n` bytes). A dead-letter topic with less
 * room refuses that send, the consumer never commits the source record, and
 * its partition stops. The sources of a dead-letter topic are read from
 * `TOPIC_CONSUMERS`: what each consumer writing it subscribes to, and each
 * one's `.retry` twin.
 *
 * Pure: the caller passes the parsed file and the contracts' values.
 */

/** `topics.txt` as `Map<topic, { kind, maxMessageBytes }>`; a missing or unreadable limit is `undefined`. */
export function parseTopicLimits(text) {
  const topics = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [name, kind, limit] = trimmed.split(/\s+/);
    topics.set(name, {
      kind,
      maxMessageBytes:
        limit !== undefined && /^[1-9][0-9]*$/.test(limit) ? Number(limit) : undefined,
    });
  }
  return topics;
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

  for (const [deadLetterTopic, from] of sources) {
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
          `${deadLetterTopic}: max.message.bytes ${limit} leaves no room for a dead letter from ` +
            `${source} (${sourceLimit}); it needs at least ${required} ` +
            `(${sourceLimit} + ${bounds.addedHeadersMaxBytes} added headers + ` +
            `${bounds.gzipGrowthMaxBytes(sourceLimit + bounds.addedHeadersMaxBytes)} GZIP)`,
        );
      }
    }
  }
  return problems;
}

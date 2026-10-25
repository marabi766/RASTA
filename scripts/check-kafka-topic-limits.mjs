#!/usr/bin/env node
/**
 * Fails when topics.txt (or the file given) breaks the size rule
 * (`kafka-topic-limits-lib.mjs`; PR #378 r2 F1, r4 F2): a topic states no
 * `max.message.bytes`, a dead-letter topic lists other sources than
 * `TOPIC_CONSUMERS` dead-letters into it or is planned without the headroom
 * over them, or the `#@` added-header bound is not the contracts'.
 * Needs `packages/contracts` built.
 *
 * It checks the plan, not a broker, and the headroom is not a guarantee for
 * every dead letter: what it covers is stated in `@rasta/contracts`
 * dead-letter-size.ts.
 *
 *   node scripts/check-kafka-topic-limits.mjs [topics.txt]
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAddedHeaderBound,
  parseTopicLimits,
  topicLimitProblems,
} from './kafka-topic-limits-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = createRequire(import.meta.url)(resolve(root, 'packages/contracts/dist/index.js'));
const file = resolve(process.argv[2] ?? resolve(root, 'infrastructure/docker/kafka/topics.txt'));

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  // Not the path, nor the error that quotes it (#385 r6).
  console.error('kafka topic limits: the topics file cannot be read; its path is not repeated');
  process.exit(1);
}
const topics = parseTopicLimits(text);
const problems = topicLimitProblems(
  topics,
  contracts.TOPIC_CONSUMERS,
  {
    addedHeadersMaxBytes: contracts.DLQ_ADDED_HEADERS_MAX_BYTES,
    gzipGrowthMaxBytes: contracts.gzipGrowthMaxBytes,
  },
  contracts.RETRY_TOPIC_SUFFIX,
);
const bound = parseAddedHeaderBound(text);
if (bound !== contracts.DLQ_ADDED_HEADERS_MAX_BYTES) {
  problems.push(
    `#@ dead-letter-added-headers-max-bytes is ${bound ?? 'not stated once'}, ` +
      `not DLQ_ADDED_HEADERS_MAX_BYTES (${contracts.DLQ_ADDED_HEADERS_MAX_BYTES})`,
  );
}
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`kafka topic limits: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  `kafka topic limits: ${topics.size} topics, each with a planned limit; every dead-letter ` +
    'topic lists its sources and is planned above them by the added-header bound and the GZIP margin\n',
);

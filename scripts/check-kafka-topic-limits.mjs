#!/usr/bin/env node
/**
 * Fails when a topic in topics.txt (or the file given) states no
 * `max.message.bytes`, or a dead-letter topic has no room for the dead letter
 * of the largest record a source topic admits (PR #378 r2 F1;
 * `kafka-topic-limits-lib.mjs`). Needs `packages/contracts` built.
 *
 *   node scripts/check-kafka-topic-limits.mjs [topics.txt]
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTopicLimits, topicLimitProblems } from './kafka-topic-limits-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = createRequire(import.meta.url)(resolve(root, 'packages/contracts/dist/index.js'));
const file = resolve(process.argv[2] ?? resolve(root, 'infrastructure/docker/kafka/topics.txt'));

const topics = parseTopicLimits(readFileSync(file, 'utf8'));
const problems = topicLimitProblems(
  topics,
  contracts.TOPIC_CONSUMERS,
  {
    addedHeadersMaxBytes: contracts.DLQ_ADDED_HEADERS_MAX_BYTES,
    gzipGrowthMaxBytes: contracts.gzipGrowthMaxBytes,
  },
  contracts.RETRY_TOPIC_SUFFIX,
);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`kafka topic limits: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  `kafka topic limits: ${topics.size} topics, every dead-letter topic has room\n`,
);

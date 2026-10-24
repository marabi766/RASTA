import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTopicLimits,
  requiredDeadLetterBytes,
  topicLimitProblems,
} from './kafka-topic-limits-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = createRequire(import.meta.url)(resolve(ROOT, 'packages/contracts/dist/index.js'));
const BOUNDS = {
  addedHeadersMaxBytes: contracts.DLQ_ADDED_HEADERS_MAX_BYTES,
  gzipGrowthMaxBytes: contracts.gzipGrowthMaxBytes,
};
const TOPICS_TXT = resolve(ROOT, 'infrastructure/docker/kafka/topics.txt');
const FIXTURES = resolve(ROOT, 'scripts/fixtures/kafka-topic-limits');
const CHECK = resolve(ROOT, 'scripts/check-kafka-topic-limits.mjs');

const problemsOf = (text) =>
  topicLimitProblems(
    parseTopicLimits(text),
    contracts.TOPIC_CONSUMERS,
    BOUNDS,
    contracts.RETRY_TOPIC_SUFFIX,
  );

test('the committed topics.txt gives every topic a limit and every dead-letter topic its room', () => {
  assert.deepEqual(problemsOf(readFileSync(TOPICS_TXT, 'utf8')), []);
});

test('every source topic keeps Kafka’s default; every dead-letter topic is above it by the bound and the GZIP margin', () => {
  const topics = parseTopicLimits(readFileSync(TOPICS_TXT, 'utf8'));
  const required = requiredDeadLetterBytes(contracts.TOPIC_MESSAGE_MAX_BYTES, BOUNDS);
  assert.equal(contracts.TOPIC_MESSAGE_MAX_BYTES, 1_048_588);
  assert.ok(required > contracts.TOPIC_MESSAGE_MAX_BYTES + contracts.DLQ_ADDED_HEADERS_MAX_BYTES);
  for (const [name, { kind, maxMessageBytes }] of topics) {
    assert.equal(
      maxMessageBytes,
      kind === 'dead-letter' ? required : contracts.TOPIC_MESSAGE_MAX_BYTES,
      name,
    );
  }
});

test('a dead-letter topic one byte short of its room fails; exactly its room passes', () => {
  const text = readFileSync(TOPICS_TXT, 'utf8');
  const required = requiredDeadLetterBytes(contracts.TOPIC_MESSAGE_MAX_BYTES, BOUNDS);
  const at = (limit) =>
    text.replace(
      /^rasta\.fleet\.v1\.dlq dead-letter \d+$/m,
      `rasta.fleet.v1.dlq dead-letter ${limit}`,
    );
  assert.deepEqual(problemsOf(at(required)), []);
  const short = problemsOf(at(required - 1));
  // fleet-service subscribes to asset, insurance and maintenance, and reads each `.retry` twin.
  assert.equal(short.length, 6);
  for (const source of ['rasta.asset.v1', 'rasta.insurance.v1.retry', 'rasta.maintenance.v1']) {
    assert.ok(
      short.some((problem) => problem.includes(`from ${source} `)),
      source,
    );
  }
});

test('a larger source limit raises what its dead-letter topic needs, a .retry twin included', () => {
  const text = readFileSync(TOPICS_TXT, 'utf8').replace(
    /^rasta\.inventory\.v1\.retry retry \d+$/m,
    'rasta.inventory.v1.retry retry 2000000',
  );
  const problems = problemsOf(text);
  // marketplace-service and audit-service read inventory.
  assert.deepEqual(problems.map((problem) => problem.split(':')[0]).sort(), [
    'rasta.audit.v1.dlq',
    'rasta.marketplace.v1.dlq',
  ]);
  assert.match(problems[0], /from rasta\.inventory\.v1\.retry \(2000000\)/);
});

test('fixture: a dead-letter topic equal to its sources fails (the setup before this rule)', () => {
  const problems = problemsOf(readFileSync(resolve(FIXTURES, 'dlq-equal-to-source.txt'), 'utf8'));
  assert.ok(problems.length > 0);
  assert.ok(
    problems.every((problem) =>
      problem.startsWith('rasta.audit.v1.dlq: max.message.bytes 1048588'),
    ),
  );
});

test('fixture: a topic with no explicit limit fails, even a source whose dead-letter topics have room', () => {
  const problems = problemsOf(readFileSync(resolve(FIXTURES, 'no-explicit-limit.txt'), 'utf8'));
  assert.deepEqual(problems, ['rasta.economic.v1.retry: no explicit max.message.bytes']);
});

test('a source a consumer reads but topics.txt lacks fails, and so does a missing dead-letter topic', () => {
  const text = readFileSync(TOPICS_TXT, 'utf8')
    .replace(/^rasta\.supplier\.v1\.retry .*\n/m, '')
    .replace(/^rasta\.analytics\.v1\.dlq .*\n/m, '');
  const problems = problemsOf(text);
  assert.ok(
    problems.includes(
      'rasta.supplier.v1.retry: dead-letters into rasta.construction.v1.dlq but is not in topics.txt',
    ),
  );
  assert.ok(
    problems.includes(
      "rasta.analytics.v1.dlq: analytics-service's dead-letter topic is not a dead-letter topic in topics.txt",
    ),
  );
});

test('the check exits 1 on each failing fixture and 0 on topics.txt', () => {
  for (const fixture of ['dlq-equal-to-source.txt', 'no-explicit-limit.txt']) {
    const run = spawnSync(process.execPath, [CHECK, resolve(FIXTURES, fixture)], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 1, fixture);
    assert.match(run.stderr, /kafka topic limits: /);
  }
  const ok = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('create-topics.sh creates with, and converges every topic to, the limit topics.txt states', () => {
  const script = readFileSync(
    resolve(ROOT, 'infrastructure/docker/kafka/create-topics.sh'),
    'utf8',
  );
  assert.match(script, /while read -r name kind max_bytes; do/);
  assert.match(script, /--config "max\.message\.bytes=\$\{max_bytes\}"/);
  assert.match(script, /--alter --entity-type topics --entity-name "\$\{name\}"/);
  assert.match(script, /--add-config "max\.message\.bytes=\$\{max_bytes\}"/);
  assert.match(script, /max\.message\.bytes is not \$\{max_bytes\}/);
});

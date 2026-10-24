import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAddedHeaderBound,
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
const HELPERS = resolve(ROOT, 'infrastructure/docker/kafka/topic-limits.sh');
const CREATE_TOPICS = resolve(ROOT, 'infrastructure/docker/kafka/create-topics.sh');

const problemsOf = (text) =>
  topicLimitProblems(
    parseTopicLimits(text),
    contracts.TOPIC_CONSUMERS,
    BOUNDS,
    contracts.RETRY_TOPIC_SUFFIX,
  );

test('the committed topics.txt gives every topic a limit and every dead-letter topic its sources and headroom', () => {
  const text = readFileSync(TOPICS_TXT, 'utf8');
  assert.deepEqual(problemsOf(text), []);
  assert.equal(parseAddedHeaderBound(text), contracts.DLQ_ADDED_HEADERS_MAX_BYTES);
  const fleet = parseTopicLimits(text).get('rasta.fleet.v1.dlq');
  assert.deepEqual(fleet.sources, contracts.deadLetterSources().get('rasta.fleet.v1.dlq'));
});

test('a dead-letter topic listing other sources than TOPIC_CONSUMERS fails, and so does a source list on any other topic', () => {
  const text = readFileSync(TOPICS_TXT, 'utf8')
    .replace(/^(rasta\.fleet\.v1\.dlq dead-letter \d+ )rasta\.asset\.v1,/m, '$1')
    .replace(/^(rasta\.fleet\.v1 stream \d+)$/m, '$1 rasta.asset.v1');
  const problems = problemsOf(text);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /^rasta\.fleet\.v1: only a dead-letter topic lists sources$/);
  assert.match(problems[1], /^rasta\.fleet\.v1\.dlq: lists sources rasta\.asset\.v1\.retry,/);
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
      /^rasta\.fleet\.v1\.dlq dead-letter \d+ /m,
      `rasta.fleet.v1.dlq dead-letter ${limit} `,
    );
  assert.deepEqual(problemsOf(at(required)), []);
  const short = problemsOf(at(required - 1));
  // fleet-service subscribes to asset, insurance and maintenance, and reads each `.retry` twin.
  assert.equal(short.length, 6);
  for (const source of ['rasta.asset.v1', 'rasta.insurance.v1.retry', 'rasta.maintenance.v1']) {
    assert.ok(
      short.some((problem) => problem.includes(`over ${source} `)),
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
  assert.match(problems[0], /over rasta\.inventory\.v1\.retry \(2000000\)/);
});

test('fixture: a dead-letter topic equal to its sources fails (the setup before this rule)', () => {
  const problems = problemsOf(readFileSync(resolve(FIXTURES, 'dlq-equal-to-source.txt'), 'utf8'));
  assert.ok(problems.length > 0);
  assert.ok(
    problems.every((problem) =>
      problem.startsWith('rasta.audit.v1.dlq: planned max.message.bytes 1048588'),
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

test('the check exits 1 on each failing fixture, and on a wrong added-header bound, and 0 on topics.txt', () => {
  for (const fixture of ['dlq-equal-to-source.txt', 'no-explicit-limit.txt']) {
    const run = spawnSync(process.execPath, [CHECK, resolve(FIXTURES, fixture)], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 1, fixture);
    assert.match(run.stderr, /kafka topic limits: /);
  }
  const dir = mkdtempSync(resolve(tmpdir(), 'topic-limits-'));
  try {
    const wrong = resolve(dir, 'topics.txt');
    writeFileSync(
      wrong,
      readFileSync(TOPICS_TXT, 'utf8').replace(
        /^#@ dead-letter-added-headers-max-bytes \d+$/m,
        '#@ dead-letter-added-headers-max-bytes 1000',
      ),
    );
    const run = spawnSync(process.execPath, [CHECK, wrong], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /dead-letter-added-headers-max-bytes is 1000, not DLQ_ADDED_HEADERS_MAX_BYTES/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const ok = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});

/** Runs one of topic-limits.sh's functions, as create-topics.sh does, under bash. */
const helper = (call, input = '') =>
  spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; ${call}`, 'helper', HELPERS], {
    encoding: 'utf8',
    input,
  });

test('create-topics.sh sizes a dead-letter topic as the contracts do, at every source size', () => {
  const sizes = [
    1,
    4095,
    4096,
    16_384,
    1_048_588,
    2_097_152,
    2.5 * 1_048_576,
    3_145_728,
    33_554_432,
    2_147_483_647,
  ];
  for (const size of sizes) {
    const run = helper(`dead_letter_limit ${size} ${contracts.DLQ_ADDED_HEADERS_MAX_BYTES}`);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      Number(run.stdout.trim()),
      contracts.deadLetterMessageMaxBytes(size),
      String(size),
    );
  }
  // The margin grows with the size: 345 bytes at the planned limit, 665 at 2 MiB.
  assert.equal(contracts.deadLetterMessageMaxBytes(1_048_588), 1_048_588 + 1632 + 345);
  assert.equal(contracts.deadLetterMessageMaxBytes(2_097_152), 2_097_152 + 1632 + 665);
});

test('effective limits are read from real describe output: an override, an inherited broker default, the built-in default', () => {
  const run = helper(
    'effective_limits',
    readFileSync(resolve(FIXTURES, 'describe-all.txt'), 'utf8'),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n').sort(), [
    'itest.inherits-broker-default 3145728 DYNAMIC_DEFAULT_BROKER_CONFIG',
    'itest.inherits-built-in-default 1048588 DEFAULT_CONFIG',
    'rasta.asset.v1 1048588 DYNAMIC_TOPIC_CONFIG',
    'rasta.asset.v1.dlq 1050565 DYNAMIC_TOPIC_CONFIG',
  ]);
});

test('describe output that cannot be read for certain fails, printing no limit at all', () => {
  const real = readFileSync(resolve(FIXTURES, 'describe-all.txt'), 'utf8');
  const limitOf = /^ {2}max\.message\.bytes=1050565 .*$/m;
  const block = real.slice(real.indexOf('All configs for topic rasta.asset.v1.dlq'));
  const cases = {
    'no max.message.bytes': real.replace(limitOf, ''),
    'not a number': real.replace(limitOf, (line) => line.replace('=1050565 ', '=1e6 ')),
    'beyond int32': real.replace(limitOf, (line) => line.replace('=1050565 ', '=4294967296 ')),
    'no synonym': real.replace(limitOf, (line) => line.replace(/ synonyms=.*$/, '')),
    'stated twice': real.replace(limitOf, (line) => `${line}\n${line}`),
    'described twice': `${real}${block}`,
    'outside any block': `  max.message.bytes=1048588 sensitive=false synonyms={DEFAULT_CONFIG:x=1}\n${real}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const run = helper('effective_limits', text);
    assert.equal(run.status, 1, name);
    assert.equal(run.stdout, '', name);
    assert.match(run.stderr, /^effective max\.message\.bytes: /, name);
  }
});

test('create-topics.sh reads every limit before any change, and raises dead-letter topics before any other', () => {
  const script = readFileSync(CREATE_TOPICS, 'utf8');
  const at = (text) => {
    const index = script.indexOf(text);
    assert.ok(index >= 0, text);
    return index;
  };
  const preflight = at('described="$(describe_limits)"');
  const deadLetters = at('apply_all "${DEAD_LETTERS[@]}"');
  const others = at('apply_all "${OTHERS[@]}"');
  assert.ok(preflight < deadLetters && deadLetters < at('read_back "${DEAD_LETTERS[@]}"'));
  assert.ok(at('read_back "${DEAD_LETTERS[@]}"') < others);
  // No call creates or alters a topic outside apply_limit / create_topic.
  assert.equal(script.match(/--alter --entity-type topics/g)?.length, 1);
  assert.equal(script.match(/--create --if-not-exists/g)?.length, 1);
  assert.doesNotMatch(script, /--delete-config|--allow-decrease/);
});

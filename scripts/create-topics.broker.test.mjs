/**
 * `create-topics.sh` on a real broker: a single run never lowers a
 * `max.message.bytes`, reads effective limits (inherited ones included)
 * before changing anything, gives each dead-letter topic room over the limits
 * its sources really have, and raises dead-letter topics before any source
 * (PR #378 r4 F2). A second provisioner whose change lands before the run's
 * re-read of a topic stops the run before it writes; one landing between that
 * re-read and the write is NOT detected — pinned here as it is (r5 F1, D-066).
 *
 *   RASTA_DISPOSABLE_BROKER=1 node --test scripts/create-topics.broker.test.mjs
 *
 * Needs the broker `infrastructure/docker/kafka/ci-up.sh` starts — its
 * container (KAFKA_CONTAINER_NAME, default `rasta-ci-kafka`), which mounts
 * this checkout's bootstrap directory, so the script under test is the
 * committed one — and the admin's password (KAFKA_SASL_PASSWORD_ADMIN, the
 * `admin` scope of `kafka-credentials.sh`). Without them it refuses to run
 * rather than skip.
 *
 * Every topic it provisions is its own (`itest.limits.<run>.…`), listed in a
 * topics file of its own, so the platform's topics are never altered. It also
 * sets the cluster-wide default `message.max.bytes`, and puts back exactly
 * what was there — the old override, or none — when each case ends, failed
 * or not. That still moves every inherited limit while it runs, so it refuses
 * to start without the disposable-broker declaration (disposable-broker.mjs).
 * The cases run one after another: each is a single provisioner on the
 * broker, except where a case starts a second one on purpose.
 *
 * Malformed describe output, failing alters and a second writer come from a
 * wrapper `KAFKA_BIN` inside the container: it logs every call, then runs the
 * real tool — mangling a describe, refusing an alter, or running a hook
 * between the real call and its answer, when told to.
 */
import './disposable-broker.mjs';
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = createRequire(import.meta.url)(resolve(ROOT, 'packages/contracts/dist/index.js'));
const CONTAINER = process.env.KAFKA_CONTAINER_NAME?.trim() || 'rasta-ci-kafka';
if (!process.env.KAFKA_SASL_PASSWORD_ADMIN) {
  throw new Error(
    'the create-topics broker test needs the admin password (KAFKA_SASL_PASSWORD_ADMIN; ' +
      '`kafka-credentials.sh admin`); refusing to run rather than skip',
  );
}

const RUN = randomUUID().slice(0, 8);
const WORK = `/tmp/itest-limits-${RUN}`;
const BIN = `${WORK}/bin`;
const REAL = '/opt/kafka/bin';
const ADMIN = ['--bootstrap-server', 'kafka:9094', '--command-config', '/tmp/admin.properties'];
const BOUND = contracts.DLQ_ADDED_HEADERS_MAX_BYTES;
const room = (sourceLimit) => contracts.deadLetterMessageMaxBytes(sourceLimit);
const PLANNED = contracts.TOPIC_MESSAGE_MAX_BYTES;
const MIB = 1_048_576;

function docker(args, input) {
  return new Promise((done, fail) => {
    const child = spawn('docker', args, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

async function inContainer(command, input) {
  const run = await docker(['exec', '-i', CONTAINER, 'bash', '-c', command], input);
  assert.equal(run.status, 0, `${command}: ${run.stderr}`);
  return run.stdout;
}

async function kafka(tool, args) {
  const run = await docker(['exec', CONTAINER, `${REAL}/${tool}`, ...ADMIN, ...args]);
  assert.equal(run.status, 0, `${tool} ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

const topicName = (scenario, role) => `itest.limits.${RUN}.${scenario}.${role}`;

function createTopic(name, maxBytes) {
  return kafka('kafka-topics.sh', [
    '--create',
    '--topic',
    name,
    '--partitions',
    '1',
    '--replication-factor',
    '1',
    ...(maxBytes === undefined ? [] : ['--config', `max.message.bytes=${maxBytes}`]),
  ]);
}

/** Every topic's effective limit and where it comes from, as the broker reports it. */
async function limits() {
  const out = await kafka('kafka-configs.sh', ['--describe', '--all', '--entity-type', 'topics']);
  const seen = new Map();
  let topic;
  for (const line of out.split('\n')) {
    const header = /^All configs for topic (\S+) are:$/.exec(line);
    if (header) topic = header[1];
    const limit = /^ {2}max\.message\.bytes=(\d+) .*synonyms=\{([A-Z_]+):/.exec(line);
    if (limit && topic) seen.set(topic, { bytes: Number(limit[1]), origin: limit[2] });
  }
  return seen;
}

/** Whether the broker lists `name`. */
const exists = async (name) =>
  (await kafka('kafka-topics.sh', ['--list'])).split('\n').includes(name);

/**
 * A topics file: `topics` maps a name to `[kind, planned]`, or
 * `['dead-letter', planned, [sources]]`.
 */
async function writeTopics(scenario, topics) {
  const lines = [
    `# itest ${RUN} ${scenario}`,
    `#@ dead-letter-added-headers-max-bytes ${BOUND}`,
    ...Object.entries(topics).map(([name, [kind, planned, sources]]) =>
      [name, kind, planned, ...(sources ? [sources.join(',')] : [])].join(' '),
    ),
  ];
  const path = `${WORK}/${scenario}.topics.txt`;
  await inContainer(`cat > ${path}`, `${lines.join('\n')}\n`);
  return path;
}

/**
 * Runs the committed create-topics.sh against `topicsFile`, through the
 * wrapper bin, and returns what it printed and every Kafka tool it called.
 */
async function provision(topicsFile, shim = {}) {
  const calls = `${topicsFile}.calls`;
  await inContainer(`: > ${calls}`);
  const env = Object.entries({ ...shim, SHIM_CALLS: calls }).flatMap(([name, value]) => [
    '-e',
    `${name}=${value}`,
  ]);
  const run = await docker([
    'exec',
    '-e',
    'KAFKA_SASL_PASSWORD_ADMIN',
    '-e',
    'KAFKA_CA_FILE=/tls/ca.pem',
    '-e',
    'KAFKA_BOOTSTRAP=kafka:9094',
    '-e',
    `TOPICS_FILE=${topicsFile}`,
    '-e',
    `KAFKA_BIN=${BIN}`,
    ...env,
    CONTAINER,
    'bash',
    '/bootstrap/create-topics.sh',
  ]);
  return { ...run, calls: (await inContainer(`cat ${calls}`)).split('\n').filter(Boolean) };
}

const changes = (calls) =>
  calls.filter((call) => / --alter /.test(` ${call} `) || / --create /.test(` ${call} `));

// The wrapper tools: log the call (no password is on any command line), then
// run the real one — mangling a describe (SHIM_DESCRIBE, for SHIM_TOPIC),
// refusing an alter of SHIM_FAIL_ALTER, losing one of SHIM_LOSE_ALTER, or
// running SHIM_HOOK when told to.
const WRAPPER = [
  '#!/bin/bash',
  'tool="$(basename "$0")"',
  'echo "${tool} $*" >> "${SHIM_CALLS}"',
  'args=" $* "',
  'if [ "${tool}" = kafka-configs.sh ] && [[ "${args}" == *" --describe "* ]] && [ -n "${SHIM_DESCRIBE:-}" ]; then',
  '  [ "${SHIM_DESCRIBE}" = fail ] && { echo "shim: describe failed" >&2; exit 1; }',
  '  out="$(__REAL__/kafka-configs.sh "$@")" || exit 1',
  '  printf \'%s\\n\' "${out}" | awk -v mode="${SHIM_DESCRIBE}" -v topic="${SHIM_TOPIC:-}" \'',
  '    /^All configs for topic / { current = $5 }',
  '    current == topic && /^  max\\.message\\.bytes=/ {',
  '      if (mode == "drop-limit") next',
  '      if (mode == "not-a-number") { sub(/=[0-9]+ /, "=1e6 ") }',
  '      if (mode == "twice") { print }',
  '    }',
  '    { print }',
  "  '",
  '  exit 0',
  'fi',
  // SHIM_HOOK runs once, on the first call whose arguments end with
  // SHIM_HOOK_AFTER: the real call is made, then the hook, and only then is
  // the real answer given — as if another writer ran while this one waited.
  'if [ -n "${SHIM_HOOK:-}" ] && [[ "${args}" == *"${SHIM_HOOK_AFTER}" ]] && [ ! -e "${SHIM_HOOK}.done" ]; then',
  '  : > "${SHIM_HOOK}.done"',
  '  out="$(__REAL__/"${tool}" "$@")"',
  '  status=$?',
  '  bash "${SHIM_HOOK}" >> "${SHIM_HOOK}.log" 2>&1 || { echo "shim: hook failed" >&2; exit 1; }',
  '  printf \'%s\\n\' "${out}"',
  '  exit "${status}"',
  'fi',
  // SHIM_LOSE_ALTER: the alter of that topic answers success and writes nothing.
  'if [ "${tool}" = kafka-configs.sh ] && [[ "${args}" == *" --alter "* ]] && [ -n "${SHIM_LOSE_ALTER:-}" ] &&',
  '  [[ "${args}" == *" --entity-name ${SHIM_LOSE_ALTER} "* ]]; then',
  '  exit 0',
  'fi',
  'if [ "${tool}" = kafka-configs.sh ] && [[ "${args}" == *" --alter "* ]] && [ -n "${SHIM_FAIL_ALTER:-}" ] &&',
  '  [[ "${args}" == *" --entity-name ${SHIM_FAIL_ALTER} "* ]]; then',
  '  echo "shim: alter of ${SHIM_FAIL_ALTER} refused" >&2',
  '  exit 1',
  'fi',
  'exec __REAL__/"${tool}" "$@"',
  '',
]
  .join('\n')
  .replaceAll('__REAL__', REAL);

await inContainer(`mkdir -p ${BIN}`);
for (const tool of ['kafka-configs.sh', 'kafka-topics.sh', 'kafka-consumer-groups.sh']) {
  await inContainer(`cat > ${BIN}/${tool} && chmod 755 ${BIN}/${tool}`, WRAPPER);
}

/**
 * The cluster's dynamic default `message.max.bytes` override, or undefined
 * when there is none and topics inherit the static or built-in value.
 */
async function brokerDefault() {
  const out = await kafka('kafka-configs.sh', [
    '--describe',
    '--entity-type',
    'brokers',
    '--entity-default',
  ]);
  const found = out.split('\n').flatMap((line) => {
    const match = /^ {2}message\.max\.bytes=(\d+) /.exec(line);
    return match ? [Number(match[1])] : [];
  });
  assert.ok(found.length <= 1, out);
  return found[0];
}

async function setBrokerDefault(bytes) {
  await kafka('kafka-configs.sh', [
    '--alter',
    '--entity-type',
    'brokers',
    '--entity-default',
    ...(bytes === undefined
      ? ['--delete-config', 'message.max.bytes']
      : ['--add-config', `message.max.bytes=${bytes}`]),
  ]);
}

/**
 * Runs `work` with the cluster default override set to `bytes` (undefined:
 * none), then puts back exactly what was there before — the old override
 * re-set, or deleted if there was none — whether `work` passed or threw.
 */
async function withBrokerDefault(bytes, work) {
  const before = await brokerDefault();
  if (bytes !== before) await setBrokerDefault(bytes);
  try {
    return await work();
  } finally {
    if ((await brokerDefault()) !== before) await setBrokerDefault(before);
  }
}

/** Waits until `topic` reports `bytes` as its effective limit. */
async function untilLimit(topic, bytes) {
  for (let tries = 0; (await limits()).get(topic)?.bytes !== bytes; tries += 1) {
    assert.ok(tries < 20, `${topic} did not reach ${bytes}`);
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** A hook script in the container: `lines` of bash, run as another writer. */
async function writeHook(scenario, lines) {
  const path = `${WORK}/${scenario}.hook.sh`;
  await inContainer(`cat > ${path}`, `set -euo pipefail\n${lines.join('\n')}\n`);
  return path;
}

/** A second create-topics.sh, on the real tools, provisioning `topicsFile`. */
const secondProvisioner = (topicsFile) =>
  `TOPICS_FILE=${topicsFile} KAFKA_BIN=${REAL} bash /bootstrap/create-topics.sh`;

after(async () => {
  await docker(['exec', CONTAINER, 'rm', '-rf', WORK]);
});

// One case after another, each a single provisioner on the broker (D-066)
// unless it starts a second one on purpose; the inherited-default cases move
// every inherited limit on the broker while they run.
describe('create-topics.sh, max.message.bytes on a real broker', () => {
  test('2 MiB overrides on a source and its dead-letter topic: nothing lowered, the dead-letter topic raised to room over 2 MiB, a second run changes nothing', async () => {
    const [src, retry, dlq] = ['src', 'src.retry', 'dlq'].map((role) => topicName('two-mib', role));
    await createTopic(src, 2 * MIB);
    await createTopic(dlq, 2 * MIB);
    const file = await writeTopics('two-mib', {
      [src]: ['stream', PLANNED],
      [retry]: ['retry', PLANNED],
      [dlq]: ['dead-letter', room(PLANNED), [src, retry]],
    });

    const first = await provision(file);
    assert.equal(first.status, 0, first.stderr);
    let now = await limits();
    assert.deepEqual(now.get(src), { bytes: 2 * MIB, origin: 'DYNAMIC_TOPIC_CONFIG' });
    assert.deepEqual(now.get(retry), { bytes: PLANNED, origin: 'DYNAMIC_TOPIC_CONFIG' });
    assert.deepEqual(now.get(dlq), { bytes: room(2 * MIB), origin: 'DYNAMIC_TOPIC_CONFIG' });
    assert.equal(room(2 * MIB), 2 * MIB + BOUND + 665);
    assert.match(first.stdout, new RegExp(`${src}: keeps max\\.message\\.bytes ${2 * MIB} `));
    assert.match(
      first.stdout,
      new RegExp(
        `${dlq}: max\\.message\\.bytes ${2 * MIB} \\(DYNAMIC_TOPIC_CONFIG\\) raised to ${room(2 * MIB)}`,
      ),
    );
    // The only alter is the dead-letter topic's; the only create the missing .retry.
    assert.deepEqual(
      changes(first.calls).map((call) =>
        call.includes(dlq) ? 'alter dlq' : call.includes(retry) ? 'create retry' : call,
      ),
      ['alter dlq', 'create retry'],
    );

    const second = await provision(file);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(changes(second.calls), []);
    assert.doesNotMatch(second.stdout, /raised to|created/);
    now = await limits();
    assert.deepEqual(
      [src, retry, dlq].map((name) => now.get(name)),
      [
        { bytes: 2 * MIB, origin: 'DYNAMIC_TOPIC_CONFIG' },
        { bytes: PLANNED, origin: 'DYNAMIC_TOPIC_CONFIG' },
        { bytes: room(2 * MIB), origin: 'DYNAMIC_TOPIC_CONFIG' },
      ],
    );
  });

  test('an inherited broker default larger than planned counts as the effective limit: kept, and the dead-letter topic sized over it', async () => {
    const [src, retry, dlq] = ['src', 'src.retry', 'dlq'].map((role) =>
      topicName('inherited', role),
    );
    await createTopic(src);
    await withBrokerDefault(3 * MIB, async () => {
      await untilLimit(src, 3 * MIB);
      assert.equal((await limits()).get(src)?.origin, 'DYNAMIC_DEFAULT_BROKER_CONFIG');
      const file = await writeTopics('inherited', {
        [src]: ['stream', PLANNED],
        [retry]: ['retry', PLANNED],
        [dlq]: ['dead-letter', room(PLANNED), [src, retry]],
      });

      const run = await provision(file);
      assert.equal(run.status, 0, run.stderr);
      const now = await limits();
      // Not lowered to the planned limit, and not pinned either: still inherited.
      assert.deepEqual(now.get(src), { bytes: 3 * MIB, origin: 'DYNAMIC_DEFAULT_BROKER_CONFIG' });
      assert.deepEqual(now.get(retry), { bytes: PLANNED, origin: 'DYNAMIC_TOPIC_CONFIG' });
      assert.deepEqual(now.get(dlq), { bytes: room(3 * MIB), origin: 'DYNAMIC_TOPIC_CONFIG' });
      assert.match(
        run.stdout,
        new RegExp(
          `${src}: keeps max\\.message\\.bytes ${3 * MIB} \\(DYNAMIC_DEFAULT_BROKER_CONFIG\\)`,
        ),
      );
      assert.ok(!changes(run.calls).some((call) => call.includes(`--entity-name ${src} `)));
    });
  });

  test('a larger limit on a .retry twin alone sizes the dead-letter topic', async () => {
    const [src, retry, dlq] = ['src', 'src.retry', 'dlq'].map((role) =>
      topicName('retry-only', role),
    );
    const larger = 2.5 * MIB;
    await createTopic(retry, larger);
    await createTopic(dlq, room(PLANNED));
    const file = await writeTopics('retry-only', {
      [src]: ['stream', PLANNED],
      [retry]: ['retry', PLANNED],
      [dlq]: ['dead-letter', room(PLANNED), [src, retry]],
    });

    const run = await provision(file);
    assert.equal(run.status, 0, run.stderr);
    const now = await limits();
    assert.equal(now.get(src)?.bytes, PLANNED);
    assert.equal(now.get(retry)?.bytes, larger);
    assert.equal(now.get(dlq)?.bytes, room(larger));
  });

  test('a dead-letter topic serving several sources gets room over the largest; one serving fewer, over its own', async () => {
    const [a, aRetry, b, bRetry, dlq, other] = [
      'a',
      'a.retry',
      'b',
      'b.retry',
      'dlq',
      'other-dlq',
    ].map((role) => topicName('several', role));
    const larger = 1.5 * MIB;
    await createTopic(b, larger);
    const file = await writeTopics('several', {
      [a]: ['stream', PLANNED],
      [aRetry]: ['retry', PLANNED],
      [b]: ['stream', PLANNED],
      [bRetry]: ['retry', PLANNED],
      [dlq]: ['dead-letter', room(PLANNED), [a, aRetry, b, bRetry]],
      [other]: ['dead-letter', room(PLANNED), [a, aRetry]],
    });

    const run = await provision(file);
    assert.equal(run.status, 0, run.stderr);
    const now = await limits();
    assert.equal(now.get(b)?.bytes, larger);
    assert.equal(now.get(dlq)?.bytes, room(larger));
    assert.equal(now.get(other)?.bytes, room(PLANNED));
    // Both dead-letter topics were created before any source.
    const order = changes(run.calls).map((call) => call.match(/--topic (\S+)/)?.[1]);
    assert.ok(
      order.indexOf(dlq) < order.indexOf(a) && order.indexOf(other) < order.indexOf(a),
      order.join(' '),
    );
  });

  for (const [mode, why] of [
    ['drop-limit', /no max\.message\.bytes|was not described/],
    ['not-a-number', /unreadable max\.message\.bytes line/],
    ['twice', /stated twice/],
    ['fail', /could not be read; nothing was changed/],
  ]) {
    test(`describe output it cannot read for certain (${mode}) stops the run before anything is created or changed`, async () => {
      const [src, retry, dlq] = ['src', 'src.retry', 'dlq'].map((role) =>
        topicName(`bad-${mode}`, role),
      );
      await createTopic(src, 512 * 1024);
      await createTopic(dlq, PLANNED);
      const file = await writeTopics(`bad-${mode}`, {
        [src]: ['stream', PLANNED],
        [retry]: ['retry', PLANNED],
        [dlq]: ['dead-letter', room(PLANNED), [src, retry]],
      });

      const run = await provision(file, { SHIM_DESCRIBE: mode, SHIM_TOPIC: src });
      assert.notEqual(run.status, 0, run.stdout);
      assert.match(run.stderr, why);
      assert.match(run.stderr, /nothing was changed/);
      assert.deepEqual(changes(run.calls), []);
      const now = await limits();
      assert.equal(now.get(src)?.bytes, 512 * 1024);
      assert.equal(now.get(dlq)?.bytes, PLANNED);
      assert.equal(await exists(retry), false);
    });
  }

  test('a dead-letter topic that cannot be raised stops the run before any source is created or changed', async () => {
    const [src, retry, dlq] = ['src', 'src.retry', 'dlq'].map((role) =>
      topicName('fail-dlq', role),
    );
    await createTopic(src, 512 * 1024);
    await createTopic(dlq, PLANNED);
    const file = await writeTopics('fail-dlq', {
      [src]: ['stream', PLANNED],
      [retry]: ['retry', PLANNED],
      [dlq]: ['dead-letter', room(PLANNED), [src, retry]],
    });

    const run = await provision(file, { SHIM_FAIL_ALTER: dlq });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stderr, /could not be raised; nothing further was changed/);
    assert.deepEqual(
      changes(run.calls).filter((call) => !call.includes(dlq)),
      [],
    );
    const now = await limits();
    assert.equal(now.get(src)?.bytes, 512 * 1024);
    assert.equal(now.get(dlq)?.bytes, PLANNED);
    assert.equal(await exists(retry), false);
  });

  test('a source that cannot be raised fails the run with every dead-letter topic already sized over every source', async () => {
    const [src, retry, other, dlq] = ['src', 'src.retry', 'other', 'dlq'].map((role) =>
      topicName('fail-src', role),
    );
    await createTopic(src, 512 * 1024);
    await createTopic(other, 512 * 1024);
    await createTopic(dlq, PLANNED);
    const file = await writeTopics('fail-src', {
      [src]: ['stream', PLANNED],
      [retry]: ['retry', PLANNED],
      [other]: ['stream', PLANNED],
      [dlq]: ['dead-letter', room(PLANNED), [src, retry, other]],
    });

    const run = await provision(file, { SHIM_FAIL_ALTER: src });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(
      run.stderr,
      new RegExp(`${src}: max\\.message\\.bytes could not be raised; nothing further was changed`),
    );
    const now = await limits();
    assert.equal(now.get(src)?.bytes, 512 * 1024);
    assert.equal(now.get(dlq)?.bytes, room(PLANNED));
    // Whatever the other sources reached, the dead-letter topic has room over it.
    const largest = Math.max(...[src, retry, other].map((name) => now.get(name)?.bytes ?? 0));
    assert.ok(now.get(dlq).bytes >= room(largest));
    // The dead-letter topic was raised before any source was touched.
    const touched = changes(run.calls);
    assert.ok(touched[0].includes(`--entity-name ${dlq} `), touched.join('\n'));
  });

  test('an alter the broker answered but did not apply: the read-back right after it stops the run before the next topic is touched', async () => {
    const [src, other, dlq] = ['src', 'other', 'dlq'].map((role) => topicName('lost-alter', role));
    await createTopic(src, 512 * 1024);
    await createTopic(other, 512 * 1024);
    await createTopic(dlq, room(PLANNED));
    const file = await writeTopics('lost-alter', {
      [src]: ['stream', PLANNED],
      [other]: ['stream', PLANNED],
      [dlq]: ['dead-letter', room(PLANNED), [src, other]],
    });

    const run = await provision(file, { SHIM_LOSE_ALTER: src });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(
      run.stderr,
      new RegExp(
        `${src}: max\\.message\\.bytes read back as ${512 * 1024} DYNAMIC_TOPIC_CONFIG, below the ${PLANNED} just written; nothing further was changed`,
      ),
    );
    // The lost write is the last change: the next topic was never touched.
    assert.ok(!changes(run.calls).some((call) => call.includes(`--entity-name ${other} `)));
    assert.equal((await limits()).get(other)?.bytes, 512 * 1024);
  });

  // ------------------------------------------------ a second writer (r5 F1)
  // The review's interleaving: run A reads 524,288 everywhere and plans
  // 1,048,588 / 1,050,565; run B, planning 2 MiB, raises source, .retry and
  // dead-letter topic to 2,097,152 / 2,099,449 while A waits; A resumes.
  const at512k = async (scenario) => {
    const names = ['src', 'src.retry', 'dlq'].map((role) => topicName(scenario, role));
    for (const name of names) await createTopic(name, 512 * 1024);
    const [src, retry, dlq] = names;
    const plannedBy = (sourceLimit) => ({
      [src]: ['stream', sourceLimit],
      [retry]: ['retry', sourceLimit],
      [dlq]: ['dead-letter', room(sourceLimit), [src, retry]],
    });
    return {
      names,
      a: await writeTopics(`${scenario}-a`, plannedBy(PLANNED)),
      b: await writeTopics(`${scenario}-b`, plannedBy(2 * MIB)),
    };
  };

  test('a second provisioner raising limits after this run read them: the re-read before the first write sees it, and the run stops having written nothing', async () => {
    const { names, a, b } = await at512k('interleaved');
    const [src, retry, dlq] = names;
    const hook = await writeHook('interleaved', [secondProvisioner(b)]);

    // B runs right after A's preflight describe, before A has its answer.
    const run = await provision(a, {
      SHIM_HOOK: hook,
      SHIM_HOOK_AFTER: '--describe --all --entity-type topics ',
    });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(await inContainer(`cat ${hook}.log`), /this run lowered nothing/);
    assert.match(
      run.stderr,
      new RegExp(
        `${dlq}: max\\.message\\.bytes is now ${room(2 * MIB)} DYNAMIC_TOPIC_CONFIG, not the ${512 * 1024} \\(DYNAMIC_TOPIC_CONFIG\\) this run planned from — another writer changed it; nothing further was changed\\. Re-run`,
      ),
    );
    assert.deepEqual(changes(run.calls), []);
    const now = await limits();
    assert.deepEqual(
      [src, retry, dlq].map((name) => now.get(name)?.bytes),
      [2 * MIB, 2 * MIB, room(2 * MIB)],
    );
  });

  test('RESIDUAL, not detected: a change landing between the re-read and the write is overwritten — the run stops at the next topic, and a re-run restores the room', async () => {
    const { names, a, b } = await at512k('residual');
    const [src, retry, dlq] = names;
    const hook = await writeHook('residual', [secondProvisioner(b)]);

    // B runs after A's re-read of the dead-letter topic, before A writes it.
    const run = await provision(a, {
      SHIM_HOOK: hook,
      SHIM_HOOK_AFTER: `--entity-name ${dlq} `,
    });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(await inContainer(`cat ${hook}.log`), /this run lowered nothing/);
    // A wrote its smaller limit over B's: LOWERED, and A's read-back passed —
    // this is the window D-066 accepts, and why one writer at a time is the
    // precondition. The next topic's re-read sees B, and A stops there.
    assert.deepEqual(
      changes(run.calls).map((call) =>
        call.includes(`--entity-name ${dlq} `) ? 'alter dlq' : call,
      ),
      ['alter dlq'],
    );
    assert.match(run.stderr, new RegExp(`${src}: max\\.message\\.bytes is now ${2 * MIB} `));
    let now = await limits();
    assert.deepEqual(
      [src, retry, dlq].map((name) => now.get(name)?.bytes),
      [2 * MIB, 2 * MIB, room(PLANNED)],
    );
    assert.ok(now.get(dlq).bytes < room(2 * MIB));

    // Re-run, alone: the dead-letter topic is raised over its sources again.
    const again = await provision(a);
    assert.equal(again.status, 0, again.stderr);
    now = await limits();
    assert.deepEqual(
      [src, retry, dlq].map((name) => now.get(name)?.bytes),
      [2 * MIB, 2 * MIB, room(2 * MIB)],
    );
  });

  test('a topic another writer created after the preflight: the broker refuses the create, and the run stops with nothing further changed', async () => {
    const [src, retry, dlq] = ['src', 'src.retry', 'dlq'].map((role) => topicName('created', role));
    await createTopic(src, 512 * 1024);
    const file = await writeTopics('created', {
      [src]: ['stream', PLANNED],
      [retry]: ['retry', PLANNED],
      [dlq]: ['dead-letter', room(PLANNED), [src, retry]],
    });
    const hook = await writeHook('created', [
      `${REAL}/kafka-topics.sh ${ADMIN.join(' ')} --create --topic ${dlq} --partitions 1 --replication-factor 1 --config max.message.bytes=${room(2 * MIB)}`,
    ]);

    const run = await provision(file, {
      SHIM_HOOK: hook,
      SHIM_HOOK_AFTER: '--describe --all --entity-type topics ',
    });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(
      run.stderr,
      new RegExp(
        `${dlq} could not be created — another writer may have created it since this run read the broker; nothing further was changed`,
      ),
    );
    // Its one attempted change is the refused create; the source is untouched.
    assert.deepEqual(
      changes(run.calls).map((call) => (call.includes(`--topic ${dlq} `) ? 'create dlq' : call)),
      ['create dlq'],
    );
    const now = await limits();
    assert.equal(now.get(src)?.bytes, 512 * 1024);
    assert.equal(now.get(dlq)?.bytes, room(2 * MIB));
    assert.equal(await exists(retry), false);
  });

  test('the broker default raised while a run is under way: the final headroom check on what the broker has fails the run; a re-run sizes the dead-letter topic over it', async () => {
    const [src, retry, dlq] = ['src', 'src.retry', 'dlq'].map((role) =>
      topicName('default-moved', role),
    );
    await withBrokerDefault(undefined, async () => {
      await createTopic(src);
      await createTopic(retry, PLANNED);
      await createTopic(dlq, 512 * 1024);
      await untilLimit(src, PLANNED);
      const file = await writeTopics('default-moved', {
        [src]: ['stream', PLANNED],
        [retry]: ['retry', PLANNED],
        [dlq]: ['dead-letter', room(PLANNED), [src, retry]],
      });
      await withBrokerDefault(undefined, async () => {
        // After the preflight, the default goes to 3 MiB (the hook waits until
        // the inherited source shows it); A raises only its dead-letter topic.
        const hook = await writeHook('default-moved', [
          `${REAL}/kafka-configs.sh ${ADMIN.join(' ')} --alter --entity-type brokers --entity-default --add-config message.max.bytes=${3 * MIB}`,
          'for _ in $(seq 1 20); do',
          `  out="$(${REAL}/kafka-configs.sh ${ADMIN.join(' ')} --describe --all --entity-type topics --entity-name ${src})"`,
          `  case "\${out}" in *'max.message.bytes=${3 * MIB} '*) exit 0 ;; esac`,
          '  sleep 0.5',
          'done',
          'exit 1',
        ]);
        const run = await provision(file, {
          SHIM_HOOK: hook,
          SHIM_HOOK_AFTER: '--describe --all --entity-type topics ',
        });
        assert.notEqual(run.status, 0, run.stdout);
        assert.match(
          run.stderr,
          new RegExp(
            `${dlq}: max\\.message\\.bytes ${room(PLANNED)} leaves no room over its sources' ${3 * MIB}; it needs ${room(3 * MIB)}`,
          ),
        );
        let now = await limits();
        assert.deepEqual(now.get(src), { bytes: 3 * MIB, origin: 'DYNAMIC_DEFAULT_BROKER_CONFIG' });
        assert.equal(now.get(dlq)?.bytes, room(PLANNED));

        const again = await provision(file);
        assert.equal(again.status, 0, again.stderr);
        now = await limits();
        assert.equal(now.get(dlq)?.bytes, room(3 * MIB));
      });
    });
  });

  // ------------------------------------------------ the cluster default, restored (r5 F2)
  test('the cluster default message.max.bytes is put back as it was — an absent override deleted again, an existing one re-set — also when the case fails', async () => {
    const initially = await brokerDefault();
    const failing = (bytes) =>
      assert.rejects(
        withBrokerDefault(bytes, async () => {
          assert.equal(await brokerDefault(), bytes);
          throw new Error('a failing case');
        }),
        /a failing case/,
      );
    await withBrokerDefault(undefined, async () => {
      // No override: the case's override is deleted, not left behind.
      await failing(3 * MIB);
      assert.equal(await brokerDefault(), undefined);
      await withBrokerDefault(1_100_000, async () => {
        // An override: the case's value is replaced by it, not deleted.
        await failing(3 * MIB);
        assert.equal(await brokerDefault(), 1_100_000);
      });
      assert.equal(await brokerDefault(), undefined);
    });
    assert.equal(await brokerDefault(), initially);
  });
});

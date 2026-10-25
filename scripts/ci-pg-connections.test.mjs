import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import {
  alive,
  containerMemory,
  parseLimits,
  parseSample,
  readSeries,
  runBounded,
  SAMPLE_SQL,
  stopWatcher,
  watcherTargets,
  summarize,
  TIMING,
  uncoveredMs,
} from './ci-pg-connections-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = join(ROOT, 'scripts/ci-pg-connections-watch.mjs');
const REPORT = join(ROOT, 'scripts/ci-pg-connections-report.mjs');
const LIMITS_100 = { maxConnections: 100, superuserReserved: 3, reserved: 0, sharedMemory: null };
const LIMITS_300 = { ...LIMITS_100, maxConnections: 300 };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** A sample at `at` ms with the given [database, role, state, sessions, monitor] groups. */
const sample = (at, ...groups) => ({
  at,
  groups: groups.map(([database, role, state, sessions, monitor = 0]) => ({
    at,
    database,
    role,
    state,
    sessions,
    monitor,
  })),
});

/** A complete series: started 1 s before the first sample, stopped 1 s after the last. */
function series(samples, limits = LIMITS_100, extra = {}) {
  const times = samples.map((s) => s.at);
  return {
    started: Math.min(...times) - 1000,
    pid: null,
    pgid: null,
    limits,
    limitsRecorded: true,
    samples,
    failures: [],
    stopped: Math.max(...times) + 1000,
    unreadable: 0,
    ...extra,
  };
}

/** One sample per second from `from` ms, each the suites' `sessions` plus the monitor. */
const steady = (from, count, sessions) =>
  Array.from({ length: count }, (_, i) =>
    sample(from + 1000 * i, ['d', 'r', 'idle', sessions], ['postgres', 'rasta', 'active', 1, 1]),
  );

const report = (s, now = s.stopped ?? 0) => summarize(s, { cpus: 4, now });

// --- parsing ------------------------------------------------------------------

test('parses the limits row (16: reserved_connections, shared memory) and refuses anything else', () => {
  assert.deepEqual(parseLimits('300|3|0|143MB\n'), {
    maxConnections: 300,
    superuserReserved: 3,
    reserved: 0,
    sharedMemory: '143MB',
  });
  // Before PostgreSQL 15 there is no shared_memory_size: the field is empty.
  assert.equal(parseLimits('100|3|0|').sharedMemory, null);
  for (const row of ['', '100', '100|3', '100|3|0', 'max|3|0|', '100|3|0|143 MB']) {
    assert.equal(parseLimits(row), null, row);
  }
});

test('the sample query stamps the statement once, not every row', () => {
  assert.match(SAMPLE_SQL, /statement_timestamp\(\)/);
  assert.doesNotMatch(SAMPLE_SQL, /clock_timestamp|now\(\)/);
});

test('one psql answer is ONE sample, even when its rows carry different milliseconds', () => {
  // The shape task 241's local sampler produced (clock_timestamp() per row):
  // an analysis keyed on the timestamp split it; the watcher must not.
  const { sample: parsed } = parseSample(
    [
      '1792941475354|rasta_economic|rasta_economic|idle|10|0',
      '1792941475354|postgres|rasta|active|1|1',
      '1792941475355|rasta_procurement|rasta_procurement|idle|30|0',
      '1792941475356|rasta_audit|rasta_audit|active|11|0',
    ].join('\n'),
  );
  assert.equal(parsed.groups.length, 4);
  assert.equal(parsed.at, 1792941475356);
  const result = report(series([parsed], LIMITS_300));
  assert.match(result.lines.join('\n'), /WORKLOAD PEAK 51 client sessions/);
  assert.match(result.lines.join('\n'), /OCCUPIED PEAK 52 client backends/);
});

test('an answer that is not one whole answer is refused, with its reason', () => {
  assert.deepEqual(parseSample('1|d|r|idle|4|0\n1|postgres|rasta|active|1|1\nnoise\n'), {
    reason: '1 malformed row(s)',
  });
  assert.deepEqual(parseSample(''), { reason: 'no rows' });
  assert.deepEqual(parseSample('1|d|r|idle|4|0'), { reason: 'monitor sessions 0, not 1' });
  assert.deepEqual(parseSample('1|postgres|rasta|active|2|2'), {
    reason: 'monitor sessions 2, not 1',
  });
});

test('reading the file counts every line that is not a record, and goes on', () => {
  const lines = [
    JSON.stringify({ started: 1000, pid: 4242, pgid: 4242 }),
    JSON.stringify({ limits: LIMITS_100 }),
    JSON.stringify(sample(2000, ['d', 'r', 'idle', 5], ['postgres', 'rasta', 'active', 1, 1])),
    '{"at": 3000, "groups": [{"database": "d", "rol', // truncated mid-write
    JSON.stringify({ at: 3500, groups: [{ database: 'd', sessions: -1 }] }), // malformed
    JSON.stringify({ failed: 4000, reason: 'timeout' }),
    JSON.stringify(sample(5000, ['d', 'r', 'idle', 7], ['postgres', 'rasta', 'active', 1, 1])),
    'null',
    JSON.stringify({ stopped: 6000 }),
  ];
  const s = readSeries(lines.join('\n'));
  assert.equal(s.started, 1000);
  assert.equal(s.pid, 4242);
  assert.equal(s.pgid, 4242);
  assert.deepEqual(s.limits, LIMITS_100);
  assert.deepEqual(
    s.samples.map((x) => x.at),
    [2000, 5000],
  );
  assert.deepEqual(s.failures, [{ at: 4000, reason: 'timeout' }]);
  assert.equal(s.unreadable, 3);
  assert.equal(s.stopped, 6000);
});

// --- workload and occupied capacity (r1 F2) ------------------------------------

test('workload leaves the monitor out; occupied counts it; each has its own peak', () => {
  const s = series([
    sample(1000, ['rasta_a', 'rasta_a', 'idle', 20], ['postgres', 'rasta', 'active', 1, 1]),
    sample(
      2000,
      ['rasta_a', 'rasta_a', 'idle', 30],
      ['rasta_b', 'rasta_b', 'active', 40],
      ['postgres', 'rasta', 'active', 1, 1],
    ),
    // More backends occupied, fewer of them the suites': three monitor sessions.
    sample(3000, ['rasta_a', 'rasta_a', 'idle', 69], ['postgres', 'rasta', 'active', 3, 3]),
  ]);
  const text = report(s).lines.join('\n');
  assert.match(
    text,
    /WORKLOAD PEAK 70 client sessions of the suites \(monitor excluded\) at 1970-01-01T00:00:02\.000Z/,
  );
  assert.match(
    text,
    /OCCUPIED PEAK 72 client backends \(monitor included\) at 1970-01-01T00:00:03\.000Z: admission headroom 25 of 97 usable slots \(26%\)/,
  );
  assert.match(text, /by database: rasta_b=40 rasta_a=30/);
  assert.match(
    text,
    /per-database peak over the run: rasta_a=69 rasta_b=40 \(sum of all 2: 109; a sizing heuristic, not a bound\)/,
  );
});

test('admission headroom at 296 suite sessions + the monitor is 0, and warns', () => {
  const result = report(series(steady(1000, 3, 296), LIMITS_300));
  const text = result.lines.join('\n');
  assert.match(text, /usable_by_ordinary_roles=297/);
  assert.match(text, /WORKLOAD PEAK 296 /);
  assert.match(
    text,
    /OCCUPIED PEAK 297 client backends .* admission headroom 0 of 297 usable slots \(0%\)/,
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /admission headroom 0 of 297/);
});

test('the 20 % edge is taken on occupied capacity: 236 + monitor is fine, 237 + monitor warns', () => {
  // ceil(0.2 * 297) = 60 slots must stay free for an ordinary role.
  const at = (sessions) => report(series(steady(1000, 3, sessions), LIMITS_300));
  assert.match(at(236).lines.join('\n'), /admission headroom 60 of 297/);
  assert.deepEqual(at(236).warnings, []);
  assert.match(at(237).lines.join('\n'), /admission headroom 59 of 297/);
  assert.equal(at(237).warnings.length, 1);
  assert.match(at(400).lines.join('\n'), /admission headroom -104 of 297/); // shown, not clamped
});

test('slots reserved for pg_use_reserved_connections are not usable by the suites', () => {
  const text = report(series(steady(1000, 3, 10), { ...LIMITS_300, reserved: 7 })).lines.join('\n');
  assert.match(text, /reserved_connections=7 usable_by_ordinary_roles=290/);
  assert.match(text, /admission headroom 279 of 290/);
});

// --- incomplete telemetry is unknown, never healthy (addendum E) ---------------

test('a complete series says so and does not warn', () => {
  const result = report(series(steady(1000, 30, 10), LIMITS_300));
  assert.equal(result.complete, true);
  assert.deepEqual(result.warnings, []);
  assert.match(result.lines.join('\n'), /telemetry complete/);
  assert.doesNotMatch(result.lines.join('\n'), /sampled time only/);
});

test('a stretch without samples makes the margin unknown for that long, with a warning', () => {
  const samples = [...steady(1000, 5, 10), ...steady(16_000, 5, 10)]; // nothing for 11 s
  const result = report(series(samples, LIMITS_300));
  const text = result.lines.join('\n');
  assert.equal(result.complete, false);
  assert.equal(result.unknownS, 10); // 5 s .. 16 s, less the 1.5 s the 5 s sample covers
  assert.match(
    text,
    /admission headroom 286 of 297 usable slots \(96%\) over the sampled time only/,
  );
  assert.match(text, /telemetry INCOMPLETE: 10 s without a sample: margin unknown for 10 s/);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /margin unknown for 10 s/);
});

test('failed samples, unreadable lines and a missing stop are each counted and printed', () => {
  const s = series(steady(1000, 10, 10), LIMITS_300, {
    failures: [
      { at: 3500, reason: 'timeout' },
      { at: 4500, reason: 'timeout' },
      { at: 5500, reason: 'exit 2' },
    ],
    unreadable: 2,
    stopped: null,
  });
  const result = summarize(s, { cpus: 4, now: 30_000 });
  const text = result.lines.join('\n');
  assert.match(
    text,
    /telemetry INCOMPLETE: 3 failed sample\(s\) \(timeout x2, exit 2 x1\); 2 unreadable line\(s\); the watcher recorded no stop; 19 s without a sample: margin unknown for 19 s/,
  );
  assert.ok(result.warnings.some((w) => /margin unknown for 19 s/.test(w)));
});

test('a problem that leaves no stretch without a sample still makes the margin unknown', () => {
  const result = report(series(steady(1000, 10, 10), LIMITS_300, { unreadable: 1 }));
  assert.equal(result.unknownS, 0);
  assert.match(
    result.lines.join('\n'),
    /telemetry INCOMPLETE: 1 unreadable line\(s\): margin unknown for 1 s/,
  );
  assert.equal(result.warnings.length, 1);
});

test('no readable max_connections, or no sample: unknown for the whole run, warned', () => {
  const noLimits = report(series(steady(1000, 5, 10), null));
  assert.match(
    noLimits.lines.join('\n'),
    /no readable max_connections .* no margin can be computed/,
  );
  assert.match(
    noLimits.lines.join('\n'),
    /max_connections unreadable: margin unknown for the whole run/,
  );
  assert.ok(noLimits.warnings.length > 0);
  const none = summarize(readSeries(''), { cpus: 4, now: 5000 });
  assert.match(
    none.lines.join('\n'),
    /no sample was taken \(no start record; no limits record; the watcher recorded no stop\): margin unknown for the whole run/,
  );
  assert.ok(none.warnings.length > 0);
});

test('the uncovered time counts the start, the gaps and the end', () => {
  assert.equal(uncoveredMs(0, 3000, [1000, 2000, 3000]), 0);
  assert.equal(uncoveredMs(0, 10_000, []), 8500);
  assert.equal(uncoveredMs(0, 10_000, [1000]), 7500);
  assert.equal(uncoveredMs(0, 5000, [4000, 5000]), 2500);
});

test('the report never prints a role password or query: only names and counts', () => {
  const text = report(series(steady(1000, 3, 3))).lines.join('\n');
  assert.doesNotMatch(text, /postgres(ql)?:\/\/|password|SELECT/i);
});

// --- the container's memory: measured from its cgroup, or "unmeasured" ---------

test('container memory comes from cgroup v2 files of either docker driver, never estimated', () => {
  const id = 'a'.repeat(64);
  const files = (dir) => ({
    [`${dir}/memory.peak`]: '734003200',
    [`${dir}/memory.current`]: '524288000',
    [`${dir}/memory.stat`]: 'anon 104857600\nfile 314572800\nshmem 209715200\nkernel 1',
  });
  const reader = (map) => (path) => {
    if (!(path in map)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return map[path];
  };
  for (const dir of [
    `/sys/fs/cgroup/system.slice/docker-${id}.scope`,
    `/sys/fs/cgroup/docker/${id}`,
  ]) {
    assert.deepEqual(containerMemory(id, reader(files(dir)), 17179869184), {
      peak: 734003200,
      current: 524288000,
      anon: 104857600,
      file: 314572800,
      shmem: 209715200,
      runnerTotal: 17179869184,
    });
  }
  assert.deepEqual(containerMemory('', reader({})), { unmeasured: 'no container id' });
  assert.deepEqual(containerMemory('../../etc', reader({})), { unmeasured: 'no container id' });
  assert.deepEqual(containerMemory(id, reader({})), {
    unmeasured: 'no cgroup v2 memory.peak for the container',
  });
  const broken = files(`/sys/fs/cgroup/docker/${id}`);
  broken[`/sys/fs/cgroup/docker/${id}/memory.current`] = 'max';
  assert.match(containerMemory(id, reader(broken)).unmeasured, /unreadable values/);
  const text = summarize(series(steady(1000, 3, 3)), {
    cpus: 4,
    now: 0,
    memory: containerMemory(id, reader(files(`/sys/fs/cgroup/docker/${id}`)), 17179869184),
  }).lines.join('\n');
  assert.match(
    text,
    /postgres container memory \(cgroup v2\): peak 700 MiB over its life, now 500 MiB \(anon 100 MiB, file 300 MiB of which shmem 200 MiB\); runner memory 16384 MiB/,
  );
  const unmeasured = summarize(series(steady(1000, 3, 3)), {
    cpus: 4,
    now: 0,
    memory: { unmeasured: 'no container id' },
  }).lines.join('\n');
  assert.match(unmeasured, /postgres container memory: unmeasured \(no container id\)/);
});

// --- real processes: every child is bounded, and nothing survives a stop --------

/** A stub psql: answers the limits and sample queries, or stalls (optionally ignoring TERM). */
function stubPsql(dir, { stallOn = null, ignoreTerm = false } = {}) {
  const bin = join(dir, 'psql');
  const stall = [
    `echo $$ > '${join(dir, 'stalled.pid')}'`,
    ...(ignoreTerm ? ["trap '' TERM"] : []),
    'exec sleep 600',
  ].join('; ');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      'case "$*" in',
      `  *max_connections*) ${stallOn === 'limits' ? stall : 'echo "300|3|0|143MB"'} ;;`,
      `  *pg_stat_activity*) ${
        stallOn === 'sample'
          ? stall
          : 'now=$(date +%s%3N); printf "%s\\n" "$now|rasta_a|rasta_a|idle|12|0" "$now|postgres|rasta|active|1|1"'
      } ;;`,
      '  *) exit 3 ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
}

function watcherEnv(dir, extra = {}) {
  return {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    PG_CONNECTIONS_SAMPLES: join(dir, 'samples.jsonl'),
    ...extra,
  };
}

/** Starts the watcher leading its own process group, as `setsid` does in the workflow. */
function startWatcher(env) {
  const child = spawn(process.execPath, [WATCH], { env, stdio: 'ignore', detached: true });
  const exited = once(child, 'exit');
  return { child, exited };
}

async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(25);
  }
}

const records = (dir, name = 'samples.jsonl') =>
  readSeries(existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
/** The workflow's own file name for the samples (`${{ runner.temp }}/pg-connections.jsonl`). */
const STEP_FILE = 'pg-connections.jsonl';

/** TERM to the watcher; it must exit 0 within `boundMs` and leave no process of its group. */
async function termAndCheck(watcher, boundMs) {
  const sent = Date.now();
  process.kill(watcher.child.pid, 'SIGTERM');
  const timer = delay(boundMs).then(() => 'late');
  const outcome = await Promise.race([watcher.exited, timer]);
  if (outcome === 'late') {
    process.kill(-watcher.child.pid, 'SIGKILL');
    assert.fail(`watcher still running ${boundMs} ms after TERM`);
  }
  assert.deepEqual(outcome, [0, null]);
  assert.equal(alive(watcher.child.pid, true), false, 'a process of the watcher group survived');
  return Date.now() - sent;
}

/** A TCP server that accepts and never answers: a real psql connecting to it stalls. */
async function silentServer(port = 0) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.resume(); // read, so the client's close is seen
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    port: server.address().port,
    sockets,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

const realPsqlEnv = (dir, port) =>
  watcherEnv(dir, {
    PATH: process.env.PATH,
    PGHOST: '127.0.0.1',
    PGPORT: String(port),
    PGUSER: 'monitor_test',
    PGPASSWORD: 'not-a-secret',
    PGDATABASE: 'postgres',
  });

test('real psql stalled in the start-up limits query: TERM ends it, the watcher exits 0, nothing survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-pg-connections-'));
  const silent = await silentServer();
  try {
    const watcher = startWatcher(realPsqlEnv(dir, silent.port));
    await waitFor(() => silent.sockets.size > 0, 5000, 'psql to connect');
    const took = await termAndCheck(watcher, TIMING.termGraceMs + TIMING.killWaitMs + 1000);
    assert.ok(took < 2000, `psql honours TERM: no KILL needed (took ${took} ms)`);
    await waitFor(() => silent.sockets.size === 0, 2000, 'the stalled connection to close');
    const s = records(dir);
    assert.equal(s.pid, watcher.child.pid);
    assert.equal(s.pgid, watcher.child.pid);
    assert.equal(s.limitsRecorded, false); // stopped before the limits came back
    assert.ok(s.stopped !== null);
  } finally {
    silent.close();
  }
});

test('real psql stalled in a sample: TERM ends it, the watcher exits 0, nothing survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-pg-connections-'));
  // A port with nothing on it: the limits query and the first samples are refused fast.
  const probe = await silentServer();
  const port = probe.port;
  probe.close();
  const watcher = startWatcher(realPsqlEnv(dir, port));
  await waitFor(() => records(dir).failures.length >= 1, 5000, 'a refused sample');
  const silent = await silentServer(port);
  try {
    await waitFor(() => silent.sockets.size > 0, 5000, 'a sample to connect');
    await termAndCheck(watcher, TIMING.termGraceMs + TIMING.killWaitMs + 1000);
    await waitFor(() => silent.sockets.size === 0, 2000, 'the stalled connection to close');
    const s = records(dir);
    assert.equal(s.limits, null);
    assert.ok(s.failures.every((f) => f.reason === 'exit 2'));
    assert.ok(s.stopped !== null);
  } finally {
    silent.close();
  }
});

for (const stallOn of ['limits', 'sample']) {
  test(`a child that ignores TERM (${stallOn} query) gets KILL after the grace; nothing survives`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-pg-connections-'));
    stubPsql(dir, { stallOn, ignoreTerm: true });
    const watcher = startWatcher(watcherEnv(dir));
    await waitFor(() => existsSync(join(dir, 'stalled.pid')), 5000, 'the stalled child');
    await delay(100); // past the stub's trap, into the exec'd sleep
    const stalled = Number(readFileSync(join(dir, 'stalled.pid'), 'utf8'));
    assert.ok(alive(stalled));
    const took = await termAndCheck(watcher, TIMING.termGraceMs + TIMING.killWaitMs + 1000);
    assert.ok(took >= TIMING.termGraceMs, `KILL only after the grace (took ${took} ms)`);
    assert.equal(alive(stalled), false);
    assert.ok(records(dir).stopped !== null);
  });
}

test('a query past its deadline is TERMed, then KILLed, and recorded as a failed sample', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-pg-connections-'));
  stubPsql(dir, { stallOn: 'sample', ignoreTerm: true });
  const started = Date.now();
  const run = runBounded(join(dir, 'psql'), ['-c', 'SELECT 1 FROM pg_stat_activity'], {
    env: process.env,
    deadlineMs: 300,
    termGraceMs: 300,
    killWaitMs: 1000,
  });
  await waitFor(() => existsSync(join(dir, 'stalled.pid')), 5000, 'the stalled child');
  const result = await run.done;
  assert.deepEqual(result, { ok: false, stdout: '', reason: 'timeout' });
  assert.ok(Date.now() - started >= 600 && Date.now() - started < 3000);
  assert.equal(alive(Number(readFileSync(join(dir, 'stalled.pid'), 'utf8'))), false);
  const missing = await runBounded(join(dir, 'absent-psql'), [], {
    env: process.env,
    deadlineMs: 1000,
    termGraceMs: 100,
    killWaitMs: 100,
  }).done;
  assert.deepEqual(missing, { ok: false, stdout: '', reason: 'ENOENT' });
});

test('the report signals only a recorded pid above 1, and its group only when it leads one', () => {
  for (const pid of [null, undefined, 0, 1, -1, -4242, 1.5, '4242']) {
    assert.equal(watcherTargets({ pid, pgid: pid }), null, String(pid));
  }
  assert.deepEqual(watcherTargets({ pid: 4242, pgid: 4242 }), { pid: 4242, group: true });
  assert.deepEqual(watcherTargets({ pid: 4242, pgid: 17 }), { pid: 4242, group: false });
  assert.deepEqual(watcherTargets({ pid: 4242, pgid: null }), { pid: 4242, group: false });
});

test('stopping a watcher that ignores TERM kills its whole process group, bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-pg-connections-'));
  // A group leader that ignores TERM, with a child of its own that does too.
  const leader = spawn(
    'bash',
    [
      '-c',
      `trap '' TERM; (trap '' TERM; echo $BASHPID > '${dir}/child.pid'; exec sleep 600) & wait`,
    ],
    {
      stdio: 'ignore',
      detached: true,
    },
  );
  const exited = once(leader, 'exit');
  await waitFor(() => existsSync(join(dir, 'child.pid')), 5000, 'the child');
  await delay(100);
  const child = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
  const started = Date.now();
  const outcome = await stopWatcher(
    { pid: leader.pid, pgid: leader.pid },
    { waitMs: 500, killWaitMs: 2000 },
  );
  await exited;
  assert.equal(outcome, 'killed after 500 ms');
  assert.ok(Date.now() - started < 3000);
  assert.equal(alive(child), false);
  assert.equal(alive(leader.pid, true), false);
  assert.equal(
    await stopWatcher({ pid: null, pgid: null }, { waitMs: 10, killWaitMs: 10 }),
    'no watcher pid recorded: not stopped',
  );
});

// --- the workflow's own steps, run as GitHub runs them ---------------------------

const workflow = parseYaml(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
/** The jobs whose suites run through turbo's default concurrency against one service PostgreSQL. */
const PARALLEL_JOBS = {
  'integration-suites': 'Integration tests',
  'integration-security': 'Test independence (F-25)',
};
const stepOf = (job, name) => workflow.jobs[job].steps.find((step) => step.name === name);

/** Runs a step's `run` as GitHub's default shell does, with its env (expressions replaced). */
function runStep(job, name, dir, extraEnv = {}, script = stepOf(job, name).run) {
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, ...extraEnv };
  for (const [key, value] of Object.entries(stepOf(job, name)?.env ?? {})) {
    env[key] = String(value)
      .replace('${{ runner.temp }}', dir)
      .replace('${{ job.services.postgres.id }}', 'f'.repeat(64));
  }
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

for (const job of Object.keys(PARALLEL_JOBS)) {
  test(`${job}: watch, a failing suite, then the report — exit 0, figures printed, no survivor`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-pg-connections-'));
    stubPsql(dir);
    assert.equal(runStep(job, 'Watch PostgreSQL connections', dir).status, 0);
    await waitFor(() => records(dir, STEP_FILE).samples.length >= 3, 10_000, 'three samples');
    const { pid, pgid } = records(dir, STEP_FILE);
    assert.equal(pgid, pid, 'setsid: the watcher leads its own process group');
    // The suite step fails; the report runs after it (always()) and still exits 0.
    assert.equal(runStep(job, 'suite', dir, {}, 'exit 1').status, 1);
    const result = runStep(job, 'PostgreSQL connection peak', dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[pg-connections\] watcher: stopped/);
    assert.match(
      result.stdout,
      /max_connections=300 superuser_reserved_connections=3 reserved_connections=0 usable_by_ordinary_roles=297 shared_memory_size=143MB/,
    );
    assert.match(result.stdout, /WORKLOAD PEAK 12 client sessions/);
    assert.match(
      result.stdout,
      /OCCUPIED PEAK 13 client backends .* admission headroom 284 of 297/,
    );
    assert.match(result.stdout, /telemetry complete/);
    assert.match(result.stdout, /postgres container memory: unmeasured/);
    assert.doesNotMatch(result.stdout, /::warning/);
    assert.equal(alive(pid, true), false);
  });
}

test('the report step stops a watcher whose psql ignores TERM, exits 0, and leaves nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-pg-connections-'));
  stubPsql(dir, { stallOn: 'sample', ignoreTerm: true });
  const job = 'integration-suites';
  assert.equal(runStep(job, 'Watch PostgreSQL connections', dir).status, 0);
  await waitFor(() => existsSync(join(dir, 'stalled.pid')), 10_000, 'the stalled child');
  await delay(100);
  const stalled = Number(readFileSync(join(dir, 'stalled.pid'), 'utf8'));
  const { pid } = records(dir, STEP_FILE);
  assert.ok(alive(stalled) && alive(pid));
  const started = Date.now();
  const result = runStep(job, 'PostgreSQL connection peak', dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < TIMING.stopWaitMs + TIMING.killWaitMs + 5000);
  assert.match(result.stdout, /watcher: stopped/);
  assert.match(result.stdout, /no sample was taken/);
  assert.match(result.stdout, /::warning title=PostgreSQL connection margin::/);
  assert.equal(alive(stalled), false);
  assert.equal(alive(pid, true), false);
});

test('the report exits 0 and warns when the watcher never wrote anything, or wrote garbage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-pg-'));
  for (const content of [null, '{"started":', 'not json\n\n[]\n']) {
    const file = join(dir, 'samples.jsonl');
    if (content !== null) writeFileSync(file, content);
    const result = spawnSync(process.execPath, [REPORT], {
      env: {
        ...process.env,
        PG_CONNECTIONS_SAMPLES: content === null ? join(dir, 'absent') : file,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /watcher: no watcher pid recorded: not stopped/);
    assert.match(result.stdout, /no readable max_connections/);
    assert.match(result.stdout, /no sample was taken .*margin unknown for the whole run/);
    assert.match(result.stdout, /::warning title=PostgreSQL connection margin::/);
  }
});

// --- the workflow wires it the same way in every job that runs suites in parallel ---------------

for (const [id, firstTest] of Object.entries(PARALLEL_JOBS)) {
  test(`${id}: a raised ceiling, proven by SHOW, watched, and reported even after a failure`, () => {
    const job = workflow.jobs[id];
    const ceilingFlag = /^postgres -c max_connections=(\d+)$/.exec(
      job.services.postgres.command ?? '',
    );
    assert.ok(ceilingFlag, 'the postgres service sets max_connections through its command');
    const ceiling = Number(ceilingFlag[1]);
    assert.ok(ceiling > 100, 'above the image default of 100');
    const names = job.steps.map((step) => step.name);
    const at = (name) => {
      assert.ok(names.includes(name), `${id} has "${name}"`);
      return names.indexOf(name);
    };
    const step = (name) => job.steps[at(name)];
    assert.match(
      step('PostgreSQL connection ceiling').run,
      new RegExp(`SHOW max_connections[\\s\\S]*test "\\$\\{ceiling\\}" = ${ceiling}\\b`),
    );
    assert.ok(at('Apply migrations') < at('PostgreSQL connection ceiling'));
    assert.ok(at('PostgreSQL connection ceiling') < at('Watch PostgreSQL connections'));
    assert.ok(at('Watch PostgreSQL connections') < at(firstTest));
    assert.ok(at(firstTest) < at('PostgreSQL connection peak'));
    const report = step('PostgreSQL connection peak');
    assert.equal(report.if, 'always()');
    assert.equal(report.run, 'node scripts/ci-pg-connections-report.mjs');
    assert.equal(report.env.PG_CONTAINER_ID, '${{ job.services.postgres.id }}');
    assert.match(
      step('Watch PostgreSQL connections').run,
      /^setsid nohup node scripts\/ci-pg-connections-watch\.mjs \\\n.*&\n$/,
    );
    assert.equal(
      report.env.PG_CONNECTIONS_SAMPLES,
      step('Watch PostgreSQL connections').env.PG_CONNECTIONS_SAMPLES,
    );
    // psql defaults the database to the user's name; `rasta` has none on the service PostgreSQL.
    for (const name of ['PostgreSQL connection ceiling', 'Watch PostgreSQL connections']) {
      assert.equal(step(name).env.PGDATABASE, 'postgres', name);
    }
    // The suites themselves keep their pools: nothing here sets a pool parameter.
    assert.doesNotMatch(JSON.stringify(job), /connection_limit|DATABASE_POOL_SIZE/);
  });
}

test('both jobs run the very same monitor steps', () => {
  const [a, b] = Object.keys(PARALLEL_JOBS);
  for (const name of [
    'PostgreSQL connection ceiling',
    'Watch PostgreSQL connections',
    'PostgreSQL connection peak',
  ]) {
    assert.deepEqual(stepOf(a, name), stepOf(b, name), name);
  }
  assert.equal(
    workflow.jobs[a].services.postgres.command,
    workflow.jobs[b].services.postgres.command,
  );
});

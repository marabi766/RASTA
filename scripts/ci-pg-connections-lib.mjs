// -----------------------------------------------------------------------------
// How close a CI run came to PostgreSQL's connection ceiling.
//
// The integration job runs up to ten packages' suites at once against ONE
// PostgreSQL, each Prisma client with its own pool. When the cluster's
// `max_connections` runs out every new connection is refused with "remaining
// connection slots are reserved for roles with the SUPERUSER attribute", in
// whichever package asked next — so the failure names a victim, not a cause,
// and every new pool moves the whole job closer to it (PR #402's fence pool
// did). `ci-pg-connections-watch.mjs` samples `pg_stat_activity` once a second
// while the suites run; `ci-pg-connections-report.mjs` stops it and prints the
// peak against the ceiling, so the margin is on every run's log before it is
// zero.
//
// Only counts and names of databases, roles and session states are recorded:
// never a query, a payload or a connection string.
//
// Sampled once a second, so a peak is a LOWER bound of the true one; and the
// sum of the per-database peaks is a sizing heuristic, not a bound (the peaks
// need not coincide, and each is itself a lower bound).
//
// Two figures, because they answer two questions:
//   workload  the suites' client sessions: every client backend but the
//             monitor's own. What the tests need.
//   occupied  every client backend, the monitor included. PostgreSQL admits
//             an ordinary role only while occupied < usable, so the admission
//             headroom is usable - occupied. Each has its own peak.
//
// Telemetry that is missing is UNKNOWN, never healthy: a failed or malformed
// sample, an unreadable line, a stretch with no sample, a watcher that did not
// record its stop — each is counted and printed, and the run's margin is then
// "unknown for N s", with a warning. Nothing here fails the job.
// -----------------------------------------------------------------------------
import { spawn } from 'node:child_process';

/**
 * One row per backend group: epoch ms | database | role | state | sessions |
 * the monitor's own. One timestamp for the whole answer: statement_timestamp()
 * is fixed for the statement, and pg_stat_activity is read from one snapshot
 * per transaction, so every row describes the same instant. (clock_timestamp()
 * differs per row, and an analysis keyed on it split one answer in parts.)
 */
export const SAMPLE_SQL =
  "SELECT (extract(epoch FROM statement_timestamp()) * 1000)::bigint, coalesce(datname, ''), " +
  "coalesce(usename, ''), coalesce(state, ''), count(*), sum((pid = pg_backend_pid())::int) " +
  "FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 2, 3, 4";

/**
 * The settings the ceiling is made of: max_connections, the slots reserved
 * for superusers and (PostgreSQL 16) for pg_use_reserved_connections, and the
 * shared memory the server sized for them (PostgreSQL 15+; empty before).
 */
export const LIMITS_SQL =
  "SELECT current_setting('max_connections') || '|' || " +
  "current_setting('superuser_reserved_connections') || '|' || " +
  "coalesce(current_setting('reserved_connections', true), '0') || '|' || " +
  "coalesce(current_setting('shared_memory_size', true), '')";

/** Fraction of the usable slots left below which the report warns. */
export const WARN_MARGIN = 0.2;

/** Timings of the watcher and of the report that stops it, in ms. */
export const TIMING = Object.freeze({
  /** One sample is started every period. */
  periodMs: 1000,
  /** A sample vouches for this long after it; time no sample vouches for is unknown. */
  coverMs: 1500,
  /** A psql that has not finished by then is stopped (TERM, then KILL). */
  queryDeadlineMs: 10_000,
  /** After TERM, a child gets this long before KILL. */
  termGraceMs: 2000,
  /** After KILL, how long to wait for the exit to be observed. */
  killWaitMs: 2000,
  /** How long the report waits for the watcher's process group to empty after TERM. */
  stopWaitMs: 10_000,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `max|superuser reserved|reserved|shared memory` (a psql -At row) into values, or null. */
export function parseLimits(row) {
  const match = /^(\d+)\|(\d+)\|(\d+)\|(\d+[kMGT]?B)?$/.exec(String(row).trim());
  if (!match) return null;
  return {
    maxConnections: Number(match[1]),
    superuserReserved: Number(match[2]),
    reserved: Number(match[3]),
    sharedMemory: match[4] ?? null,
  };
}

const GROUP_ROW = /^(\d+)\|([^|]*)\|([^|]*)\|([^|]*)\|(\d+)\|(\d+)$/;

/**
 * One psql answer (-At -F'|', one group per line) into ONE sample — however
 * its rows' timestamps read — or a refusal: `{ sample }` or `{ reason }`.
 * Refused: any line that is not a group (the counts could be short), no row,
 * or not exactly one session of the monitor (its own backend is always in
 * the answer, so anything else is not one whole answer).
 */
export function parseSample(text) {
  const groups = [];
  let malformed = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const match = GROUP_ROW.exec(line.trim());
    if (!match) {
      malformed++;
      continue;
    }
    groups.push({
      at: Number(match[1]),
      database: match[2] || '(none)',
      role: match[3] || '(none)',
      state: match[4] || '(none)',
      sessions: Number(match[5]),
      monitor: Number(match[6]),
    });
  }
  if (malformed > 0) return { reason: `${malformed} malformed row(s)` };
  if (groups.length === 0) return { reason: 'no rows' };
  const monitor = total(groups, 'monitor');
  if (monitor !== 1) return { reason: `monitor sessions ${monitor}, not 1` };
  return { sample: { at: Math.max(...groups.map((g) => g.at)), groups } };
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isGroup = (g) =>
  g !== null &&
  typeof g === 'object' &&
  ['database', 'role', 'state'].every((key) => typeof g[key] === 'string') &&
  isCount(g.sessions) &&
  isCount(g.monitor) &&
  g.monitor <= g.sessions;
const isLimits = (l) =>
  l !== null &&
  typeof l === 'object' &&
  isCount(l.maxConnections) &&
  isCount(l.superuserReserved) &&
  isCount(l.reserved);

/**
 * The watcher's file (JSON lines) into a series. Every line that is not one
 * of the watcher's records — a truncated last line, a malformed record — is
 * counted in `unreadable`, and reading goes on.
 */
export function readSeries(text) {
  const series = {
    started: null,
    pid: null,
    pgid: null,
    limits: null,
    limitsRecorded: false,
    samples: [],
    failures: [],
    stopped: null,
    unreadable: 0,
  };
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      series.unreadable++;
      continue;
    }
    if (row === null || typeof row !== 'object') series.unreadable++;
    else if (isCount(row.started) && series.started === null) {
      series.started = row.started;
      series.pid = isCount(row.pid) ? row.pid : null;
      series.pgid = isCount(row.pgid) ? row.pgid : null;
    } else if (
      'limits' in row &&
      !series.limitsRecorded &&
      (row.limits === null || isLimits(row.limits))
    ) {
      series.limits = row.limits;
      series.limitsRecorded = true;
    } else if (
      isCount(row.at) &&
      Array.isArray(row.groups) &&
      row.groups.length > 0 &&
      row.groups.every(isGroup)
    ) {
      series.samples.push({ at: row.at, groups: row.groups });
    } else if (isCount(row.failed) && typeof row.reason === 'string') {
      series.failures.push({ at: row.failed, reason: row.reason });
    } else if (isCount(row.stopped) && series.stopped === null) series.stopped = row.stopped;
    else series.unreadable++;
  }
  series.samples.sort((a, b) => a.at - b.at);
  return series;
}

function total(groups, key) {
  return groups.reduce((sum, g) => sum + g[key], 0);
}

function tally(groups, key) {
  const counts = new Map();
  for (const g of groups) {
    const sessions = g.sessions - g.monitor;
    if (sessions > 0) counts.set(g[key], (counts.get(g[key]) ?? 0) + sessions);
  }
  return counts;
}

const top = (counts, limit) =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([name, n]) => `${name}=${n}`)
    .join(' ');

/**
 * Milliseconds of [from, to] that no sample vouches for: each sample covers
 * TIMING.coverMs after it, and the window opens at `from`, so a start-up with
 * no sample, a gap between samples and a silent end all count.
 */
export function uncoveredMs(from, to, sampleTimes) {
  let unknown = 0;
  let coveredUntil = from + TIMING.coverMs;
  for (const at of [...sampleTimes].sort((a, b) => a - b)) {
    if (at > to) break;
    if (at > coveredUntil) unknown += at - coveredUntil;
    coveredUntil = Math.max(coveredUntil, at + TIMING.coverMs);
  }
  if (to > coveredUntil) unknown += to - coveredUntil;
  return unknown;
}

const mib = (bytes) => `${Math.round(bytes / 1048576)} MiB`;

/**
 * The report's lines for a `series` (readSeries). `now` closes the window
 * when the watcher recorded no stop. `memory` is containerMemory()'s result.
 * `warnings` holds one text per `::warning::` the report should print.
 */
export function summarize(series, { cpus, now, memory = null }) {
  const lines = [];
  const warnings = [];
  const { limits, samples } = series;
  const usable = limits ? limits.maxConnections - limits.superuserReserved - limits.reserved : null;
  lines.push(
    limits
      ? `[pg-connections] max_connections=${limits.maxConnections} ` +
          `superuser_reserved_connections=${limits.superuserReserved} ` +
          `reserved_connections=${limits.reserved} usable_by_ordinary_roles=${usable} ` +
          `shared_memory_size=${limits.sharedMemory ?? 'unknown'} runner_cpus=${cpus}`
      : `[pg-connections] no readable max_connections (runner_cpus=${cpus}): no margin can be computed`,
  );

  // --- completeness -----------------------------------------------------------
  const from = series.started ?? samples[0]?.at ?? now;
  const to = series.stopped ?? now;
  const unknownS = Math.ceil(
    uncoveredMs(
      from,
      to,
      samples.map((s) => s.at),
    ) / 1000,
  );
  const problems = [];
  if (series.started === null) problems.push('no start record');
  if (!series.limitsRecorded) problems.push('no limits record');
  else if (limits === null) problems.push('max_connections unreadable');
  if (series.failures.length > 0) {
    const reasons = new Map();
    for (const f of series.failures) reasons.set(f.reason, (reasons.get(f.reason) ?? 0) + 1);
    problems.push(
      `${series.failures.length} failed sample(s) (` +
        `${[...reasons].map(([reason, n]) => `${reason} x${n}`).join(', ')})`,
    );
  }
  if (series.unreadable > 0) problems.push(`${series.unreadable} unreadable line(s)`);
  if (series.stopped === null) problems.push('the watcher recorded no stop');
  if (unknownS > 0) problems.push(`${unknownS} s without a sample`);
  const complete = problems.length === 0 && limits !== null;
  const windowS = Math.max(0, Math.round((to - from) / 1000));

  if (samples.length === 0) {
    lines.push(
      `[pg-connections] no sample was taken (${problems.join('; ') || 'no record at all'}): ` +
        `margin unknown for the whole run (${windowS} s)`,
    );
    warnings.push('the connection monitor took no sample: the margin of this run is unknown');
  } else {
    // --- workload: the suites' sessions, the monitor left out -----------------
    let workload = null;
    let occupied = null;
    const perDatabase = new Map();
    for (const sample of samples) {
      const all = total(sample.groups, 'sessions');
      const suites = all - total(sample.groups, 'monitor');
      if (!workload || suites > workload.sessions) workload = { sessions: suites, sample };
      // --- occupied: every client backend, on its own (the monitor's presence varies)
      if (!occupied || all > occupied.sessions) occupied = { sessions: all, sample };
      for (const [name, n] of tally(sample.groups, 'database')) {
        perDatabase.set(name, Math.max(perDatabase.get(name) ?? 0, n));
      }
    }
    const iso = (at) => new Date(at).toISOString();
    const sum = [...perDatabase.values()].reduce((a, b) => a + b, 0);
    lines.push(
      `[pg-connections] samples=${samples.length} over ${windowS} s (about 1 per second; a sampled peak is a lower bound)`,
      `[pg-connections] WORKLOAD PEAK ${workload.sessions} client sessions of the suites (monitor excluded) at ${iso(workload.sample.at)}`,
      `[pg-connections] at the workload peak, by database: ${top(tally(workload.sample.groups, 'database'), 8)}`,
      `[pg-connections] at the workload peak, by state: ${top(tally(workload.sample.groups, 'state'), 6)}`,
      `[pg-connections] per-database peak over the run: ${top(perDatabase, 8)} ` +
        `(sum of all ${perDatabase.size}: ${sum}; a sizing heuristic, not a bound)`,
    );
    if (usable !== null) {
      const headroom = usable - occupied.sessions;
      const percent = Math.round((100 * headroom) / usable);
      lines.push(
        `[pg-connections] OCCUPIED PEAK ${occupied.sessions} client backends (monitor included) ` +
          `at ${iso(occupied.sample.at)}: admission headroom ${headroom} of ${usable} usable slots (${percent}%)` +
          (complete ? '' : ' over the sampled time only'),
      );
      if (headroom < Math.ceil(usable * WARN_MARGIN)) {
        warnings.push(
          `admission headroom ${headroom} of ${usable} usable connection slots (${percent}%), ` +
            `below ${100 * WARN_MARGIN}%: see the [pg-connections] lines`,
        );
      }
    }
  }
  if (complete) {
    lines.push(
      '[pg-connections] telemetry complete: every second of the run is covered by a sample',
    );
  } else if (samples.length > 0) {
    // A problem that left no stretch without a sample (an unreadable line) still costs a second.
    const unknown = limits === null ? `the whole run (${windowS} s)` : `${Math.max(1, unknownS)} s`;
    lines.push(
      `[pg-connections] telemetry INCOMPLETE: ${problems.join('; ')}: margin unknown for ${unknown}`,
    );
    warnings.push(
      `connection telemetry incomplete (${problems.join('; ')}): margin unknown for ${unknown}`,
    );
  }
  if (memory) {
    lines.push(
      memory.peak === undefined
        ? `[pg-connections] postgres container memory: unmeasured (${memory.unmeasured})`
        : `[pg-connections] postgres container memory (cgroup v2): peak ${mib(memory.peak)} over its life, ` +
            `now ${mib(memory.current)} (anon ${mib(memory.anon)}, file ${mib(memory.file)} ` +
            `of which shmem ${mib(memory.shmem)})` +
            (memory.runnerTotal ? `; runner memory ${mib(memory.runnerTotal)}` : ''),
    );
  }
  return { lines, warnings, complete, unknownS, usable };
}

/** Where docker's two cgroup drivers put a container's cgroup v2 directory. */
export const containerCgroupDirs = (id) => [
  `/sys/fs/cgroup/system.slice/docker-${id}.scope`,
  `/sys/fs/cgroup/docker/${id}`,
];

/**
 * The service container's memory from its cgroup v2 files (`read` reads a
 * path, throws if absent): memory.peak over the container's life, current
 * use and its anon/file/shmem split. `{ unmeasured: reason }` otherwise —
 * never an estimate.
 */
export function containerMemory(id, read, memTotalBytes = null) {
  if (!/^[0-9a-f]{12,64}$/.test(String(id ?? ''))) return { unmeasured: 'no container id' };
  for (const dir of containerCgroupDirs(id)) {
    let peak;
    try {
      peak = read(`${dir}/memory.peak`);
    } catch {
      continue;
    }
    try {
      const stat = Object.fromEntries(
        read(`${dir}/memory.stat`)
          .split('\n')
          .map((line) => line.split(' '))
          .filter((parts) => parts.length === 2),
      );
      const value = { peak: Number(peak), current: Number(read(`${dir}/memory.current`)) };
      for (const key of ['anon', 'file', 'shmem']) value[key] = Number(stat[key]);
      if (!Object.values(value).every(isCount))
        return { unmeasured: `unreadable values in ${dir}` };
      return { ...value, runnerTotal: memTotalBytes };
    } catch {
      return { unmeasured: `incomplete cgroup files in ${dir}` };
    }
  }
  return { unmeasured: 'no cgroup v2 memory.peak for the container' };
}

/** True while `pid` (or, with `group`, the process group `pid`) has a live member. */
export function alive(pid, group = false) {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function until(predicate, ms) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

/**
 * Runs `command args` with `env`, stdout collected. Every way it can end is
 * bounded: past `deadlineMs`, or when `stop()` is called, it is sent TERM, and
 * KILL after `termGraceMs` if it has not exited. Resolves once the child has
 * exited (or `killWaitMs` after KILL): `{ ok, stdout, reason }`.
 * Returns `{ done, stop }`; `stop()` resolves when the child is gone.
 */
export function runBounded(command, args, { env, deadlineMs, termGraceMs, killWaitMs }) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  let exited = false;
  let stopping = null;
  let why = null;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ error: error.code ?? 'spawn error' }));
  }).then((result) => {
    exited = true;
    return result;
  });
  let settled;
  const stopSettled = new Promise((resolve) => {
    settled = resolve;
  });
  const stop = (reason) => {
    why ??= reason;
    stopping ??= (async () => {
      if (!exited) {
        child.kill('SIGTERM');
        const graceOver = delay(termGraceMs).then(() => false);
        if (!(await Promise.race([exit.then(() => true), graceOver]))) {
          child.kill('SIGKILL');
          await Promise.race([exit, delay(killWaitMs)]);
        }
      }
      settled();
    })();
    return stopping;
  };
  const deadline = setTimeout(() => stop('timeout'), deadlineMs);
  // Ends at the exit, or when a stop has run its course even if no exit was seen.
  const done = Promise.race([exit, stopSettled.then(() => ({}))]).then(async (result) => {
    clearTimeout(deadline);
    if (why) return { ok: false, stdout: '', reason: why };
    if (result.error) return { ok: false, stdout: '', reason: result.error };
    if (result.code !== 0) {
      return { ok: false, stdout: '', reason: result.signal ?? `exit ${result.code}` };
    }
    // The pipe can still hold the tail of the output after the exit.
    await Promise.race([
      new Promise((resolve) => child.stdout.once('close', resolve)),
      delay(1000),
    ]);
    return { ok: true, stdout, reason: null };
  });
  return { done, stop: () => stop('stopped') };
}

/**
 * What the report may signal for the watcher a series names: its pid, and its
 * process group when it leads one; null unless the pid is an integer above 1
 * (0 and -1 would address this process's group or every process of the user).
 */
export function watcherTargets({ pid, pgid }) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  return { pid, group: pgid === pid };
}

/**
 * Stops the watcher a series names: TERM to its pid, then wait (at most
 * `waitMs`) until the pid and — when it leads its own process group — the
 * group are gone; whatever is left gets KILL, the group included. Signals
 * only watcherTargets(). Returns what it did.
 */
export async function stopWatcher(recorded, { waitMs, killWaitMs }) {
  const targets = watcherTargets(recorded);
  if (!targets) return 'no watcher pid recorded: not stopped';
  const { pid, group } = targets;
  const gone = () => !alive(pid) && (!group || !alive(pid, true));
  if (gone()) return 'already exited';
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Exited in between: the wait below sees it.
  }
  if (await until(gone, waitMs)) return 'stopped';
  for (const target of group ? [-pid, pid] : [pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  return (await until(gone, killWaitMs))
    ? `killed after ${waitMs} ms`
    : `still present ${killWaitMs} ms after KILL`;
}

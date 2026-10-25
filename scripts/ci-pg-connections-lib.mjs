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
// while the suites run; `ci-pg-connections-report.mjs` prints the peak against
// the ceiling, so the margin is on every run's log before it is zero.
//
// Only counts and names of databases, roles and session states are recorded:
// never a query, a payload or a connection string.
//
// Sampled once a second, so a peak is a LOWER bound of the true one.
// -----------------------------------------------------------------------------

/** One sample per backend group: epoch ms | database | role | state | sessions | the monitor's own */
export const SAMPLE_SQL =
  "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint, coalesce(datname, ''), " +
  "coalesce(usename, ''), coalesce(state, ''), count(*), sum((pid = pg_backend_pid())::int) " +
  "FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 2, 3, 4";

/** The two server settings the ceiling is made of. */
export const LIMITS_SQL =
  "SELECT current_setting('max_connections') || '|' || " +
  "current_setting('superuser_reserved_connections')";

/** Fraction of the usable slots left below which the report warns. */
export const WARN_MARGIN = 0.2;

/** `max_connections|reserved` (a psql -At row) into numbers, or null. */
export function parseLimits(row) {
  const match = /^(\d+)\|(\d+)$/.exec(String(row).trim());
  return match ? { maxConnections: Number(match[1]), reserved: Number(match[2]) } : null;
}

/** Sample rows (a psql -At -F'|' output, one group per line) into one entry. */
export function parseSample(text) {
  const groups = [];
  for (const line of String(text).split('\n')) {
    const match = /^(\d+)\|([^|]*)\|([^|]*)\|([^|]*)\|(\d+)\|(\d+)$/.exec(line.trim());
    if (!match) continue;
    groups.push({
      at: Number(match[1]),
      database: match[2] || '(none)',
      role: match[3] || '(none)',
      state: match[4] || '(none)',
      sessions: Number(match[5]),
      monitor: Number(match[6]),
    });
  }
  if (groups.length === 0) return null;
  return { at: Math.max(...groups.map((g) => g.at)), groups };
}

const total = (groups, key) => groups.reduce((sum, g) => sum + g[key], 0);

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
 * The report's lines for `samples` (each `{ at, groups }`) against `limits`.
 * `warning` is set when the margin is below WARN_MARGIN of the usable slots.
 * Sessions of the monitor itself are left out of every figure.
 */
export function summarize(samples, limits, cpus) {
  if (!limits)
    return { lines: ['[pg-connections] no readable max_connections: no report'], warning: true };
  const usable = limits.maxConnections - limits.reserved;
  const header =
    `[pg-connections] max_connections=${limits.maxConnections} ` +
    `superuser_reserved_connections=${limits.reserved} usable_by_ordinary_roles=${usable} ` +
    `runner_cpus=${cpus}`;
  if (samples.length === 0) {
    return {
      lines: [header, '[pg-connections] no sample was taken: no peak to report'],
      warning: true,
    };
  }
  let peak = null;
  const perDatabase = new Map();
  for (const sample of samples) {
    const sessions = total(sample.groups, 'sessions') - total(sample.groups, 'monitor');
    if (!peak || sessions > peak.sessions) peak = { sessions, sample };
    for (const [name, n] of tally(sample.groups, 'database')) {
      perDatabase.set(name, Math.max(perDatabase.get(name) ?? 0, n));
    }
  }
  const margin = usable - peak.sessions;
  const warning = margin < Math.ceil(usable * WARN_MARGIN);
  const when = new Date(peak.sample.at).toISOString();
  const lines = [
    header,
    `[pg-connections] samples=${samples.length} (about 1 per second; a peak is a lower bound)`,
    `[pg-connections] PEAK ${peak.sessions} client sessions (monitor excluded) at ${when}: ` +
      `margin ${margin} of ${usable} usable slots (${Math.round((100 * margin) / usable)}%)`,
    `[pg-connections] at the peak, by database: ${top(tally(peak.sample.groups, 'database'), 8)}`,
    `[pg-connections] at the peak, by state: ${top(tally(peak.sample.groups, 'state'), 6)}`,
    `[pg-connections] per-database peak over the run: ${top(perDatabase, 8)}`,
  ];
  return { lines, warning, margin, peak: peak.sessions, usable, when };
}

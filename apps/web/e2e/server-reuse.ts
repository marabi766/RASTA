import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Whether Playwright may reuse a server that is already listening on a port the
 * browser suite needs (TASK 323, FU-021 from the review of #574).
 *
 * `reuseExistingServer: true` answers "is something there?" and nothing more. A
 * hand-run `next dev` on :3200 satisfied it, so the production build was skipped
 * and the suite ran against the wrong server (or against the build of another
 * worktree, or of an earlier run whose sources have since changed). The rule
 * here is the opposite way round and fails closed: **a listener is reused only
 * when this run can prove it started it; anything else that holds the port is
 * refused, by name, before Playwright starts anything.**
 *
 * The proof for the portal is two facts that a foreign server cannot both have:
 * the per-run id (`WEB_E2E_RUN_ID`, random, chosen once by the first process
 * that loads the config and inherited by every later one) is recorded by the
 * run's own start command next to the BUILD_ID it built (`record-server-run.mjs`),
 * and the listener answers for exactly that BUILD_ID. A dev server has no such
 * build; another worktree's or an earlier run's server has another BUILD_ID or
 * another run id.
 *
 * CI keeps its behaviour: it never reuses, and it is not inspected here.
 */

export type ServerDecision =
  { action: 'start' } | { action: 'reuse' } | { action: 'refuse'; message: string };

/** What is known about one port, gathered before the decision. */
export interface PortInspection {
  /** True when something accepts connections, or when that could not be ruled out. */
  occupied: boolean;
  /** Who holds it, for the refusal message: `pid 123 (next dev --port 3200)`. */
  occupant: string;
  /** Status the listener gave for the proof path; null when it did not answer or no path was asked. */
  status: number | null;
  /**
   * Status for a path no server has. 404 is the only answer that lets a 200 above count: a listener
   * that says 200 to everything (a catch-all, a proxy) has said nothing about this build.
   */
  controlStatus: number | null;
}

/**
 * The decision. Only a proven-own listener is reused; a free port starts the
 * server; every other case (a foreign listener, an unidentified one, a proof
 * that is missing or unreadable) refuses.
 */
export function decideServerStart(input: {
  name: string;
  port: number;
  occupied: boolean;
  occupant: string;
  own: boolean;
}): ServerDecision {
  if (!input.occupied) return { action: 'start' };
  if (input.own) return { action: 'reuse' };
  return {
    action: 'refuse',
    message:
      `Port ${input.port} (${input.name}) is already in use by ${input.occupant}, and this run cannot ` +
      'prove it is the server it started itself. Playwright would reuse it and skip the build, so ' +
      'the suite would run against the wrong server. Stop that process and run again.',
  };
}

/** What `record-server-run.mjs` wrote after this run's build. */
export interface RunMarker {
  runId: string;
  buildId: string;
}

/**
 * The path the portal must answer on for the listener to be this run's own, or
 * null when no proof is possible (no marker, another run's marker, a marker for
 * a build that is no longer on disk). Next serves a production build's manifest
 * under `/_next/static/<BUILD_ID>/`; a dev server and a different build do not.
 */
export function portalProofPath(input: {
  runId: string;
  marker: RunMarker | null;
  buildIdOnDisk: string | null;
}): string | null {
  const { runId, marker, buildIdOnDisk } = input;
  if (runId === '' || marker === null || buildIdOnDisk === null) return null;
  if (marker.runId !== runId) return null;
  if (marker.buildId === '' || marker.buildId !== buildIdOnDisk) return null;
  return `/_next/static/${encodeURIComponent(marker.buildId)}/_buildManifest.js`;
}

export interface ServerEntry {
  name: string;
  port: number;
  /** Path whose 200 proves the listener is this run's own; absent: nothing can prove it. */
  proofPath?: string | null;
}

/**
 * `reuseExistingServer` for each entry, under the entry's own key (so a wiring
 * slip cannot hand one server another's answer). Throws one error naming every
 * port that is held by a server this run cannot vouch for.
 */
export function planServerReuse<K extends string>(
  entries: Record<K, ServerEntry>,
  env: {
    ci: boolean;
    worker: boolean;
    inspect: (port: number, proofPath: string | null) => PortInspection;
  },
): Record<K, boolean> {
  const keys = Object.keys(entries) as K[];
  const plan = {} as Record<K, boolean>;
  // CI never reuses and is not looked at (its behaviour is unchanged); a worker
  // process loads the config again but starts no server.
  if (env.ci || env.worker) {
    for (const key of keys) plan[key] = false;
    return plan;
  }
  const refusals: string[] = [];
  for (const key of keys) {
    const entry = entries[key];
    const proofPath = entry.proofPath ?? null;
    const inspection = env.inspect(entry.port, proofPath);
    const decision = decideServerStart({
      name: entry.name,
      port: entry.port,
      occupied: inspection.occupied,
      occupant: inspection.occupant,
      own: proofPath !== null && inspection.status === 200 && inspection.controlStatus === 404,
    });
    if (decision.action === 'refuse') refusals.push(decision.message);
    plan[key] = decision.action === 'reuse';
  }
  if (refusals.length > 0) throw new Error(refusals.join('\n'));
  return plan;
}

// ---- Gathering the facts (the only part that touches the machine) ----

const PROBE_SCRIPT = join(__dirname, 'probe-port.mjs');

/** Where `record-server-run.mjs` keeps this worktree's marker for `port`. */
export function runMarkerFile(webDir: string, port: number): string {
  const key = createHash('sha256').update(resolve(webDir)).digest('hex').slice(0, 16);
  return join(tmpdir(), `rasta-web-e2e-run-${key}-${port}.json`);
}

/** The marker, or null when it is missing, unreadable or not the expected shape. */
export function readRunMarker(file: string): RunMarker | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { runId, buildId } = value as Record<string, unknown>;
    if (typeof runId !== 'string' || typeof buildId !== 'string') return null;
    return { runId, buildId };
  } catch {
    return null;
  }
}

/** The BUILD_ID of the build on disk, or null when there is none. */
export function readBuildId(webDir: string): string | null {
  try {
    const id = readFileSync(join(webDir, '.next', 'BUILD_ID'), 'utf8').trim();
    return id === '' ? null : id;
  } catch {
    return null;
  }
}

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** `pid 123 (next dev --port 3200)`, or an honest "could not identify". */
export function describeListener(port: number): string {
  const ss = run('ss', ['-H', '-ltnp', `sport = :${port}`]);
  let pid = ss === null ? undefined : /pid=(\d+)/.exec(ss)?.[1];
  if (pid === undefined) {
    const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
    pid = lsof === null ? undefined : /^p(\d+)$/m.exec(lsof)?.[1];
  }
  if (pid === undefined) {
    return 'a process that could not be identified (it may belong to another user)';
  }
  const command = run('ps', ['-o', 'args=', '-p', pid])?.trim();
  return command ? `pid ${pid} (${command})` : `pid ${pid}`;
}

/** Opens a socket to the port (and asks for `proofPath`) in a child, so the config can stay synchronous. */
export function inspectPort(port: number, proofPath: string | null): PortInspection {
  const control = `/_next/static/${randomBytes(12).toString('hex')}/_buildManifest.js`;
  const child = spawnSync(
    process.execPath,
    [PROBE_SCRIPT, String(port), proofPath ?? '', control],
    {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  type Answer = { occupied?: unknown; status?: unknown; controlStatus?: unknown };
  let parsed: Answer | null = null;
  try {
    parsed = JSON.parse(child.stdout) as Answer;
  } catch {
    parsed = null;
  }
  if (child.status !== 0 || parsed === null || typeof parsed.occupied !== 'boolean') {
    // Not knowing is not "free": refuse and say why.
    return {
      occupied: true,
      occupant: `an unknown listener (the port probe failed: ${child.error?.message || child.stderr.trim() || 'no answer'})`,
      status: null,
      controlStatus: null,
    };
  }
  return {
    occupied: parsed.occupied,
    occupant: parsed.occupied ? describeListener(port) : 'nobody',
    status: typeof parsed.status === 'number' ? parsed.status : null,
    controlStatus: typeof parsed.controlStatus === 'number' ? parsed.controlStatus : null,
  };
}

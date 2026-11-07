import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { signalChild, supervisorEndpoint, trackFixture, watchdogFixture } from './build-lifetime';

/**
 * What the build-binding specs share: the modules under `scripts/` are plain ESM that Jest
 * does not transform, so each case runs them in a child Node (`runModule`, one JSON line
 * back) or runs the real wrapper in a driver process (`startDriver`), against the real
 * `next build` (`plantApp`) or a fake one whose behaviour a plan file sets (`plantFakeNext`).
 */
export const WEB = join(__dirname, '../..');
export const SCRIPTS = join(WEB, 'scripts');
export const url = (file: string): string => pathToFileURL(join(SCRIPTS, file)).href;
export const LOCK = '.next.build-lock';

export function runModule(code: string): { out: unknown; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    cwd: tmpdir(),
    timeout: 120_000,
  });
  const stdout = run.stdout ?? '';
  return {
    out: stdout.trim() === '' ? undefined : JSON.parse(stdout.trim().split('\n').pop() as string),
    stdout,
    stderr: run.stderr ?? '',
  };
}

type ProcessTarget = number | { group: number };
const positivePid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;
const signalTarget = (target: ProcessTarget): number => {
  const pid = typeof target === 'number' ? target : target.group;
  if (!positivePid(pid))
    throw new Error(
      `invalid pid ${pid}: expected a positive integer; use { group: pgid } explicitly for a process group`,
    );
  return typeof target === 'number' ? pid : -pid;
};
const targetName = (target: ProcessTarget): string => {
  const pid = signalTarget(target);
  return `${pid < 0 ? 'process group' : 'pid'} ${Math.abs(pid)}`;
};

type ChildRecord = { pid: number; group: number; capturePath: string };
export function waitForPidFile(file: string, json?: false, ms?: number): Promise<number>;
export function waitForPidFile(file: string, json: true, ms?: number): Promise<ChildRecord>;
/** Existence is not readiness: retry empty/partial writes, but never return an invalid PID. */
export async function waitForPidFile(
  file: string,
  json = false,
  ms = 15_000,
): Promise<number | ChildRecord> {
  const deadline = performance.now() + ms;
  for (;;) {
    try {
      const text = readFileSync(file, 'utf8').trim();
      const value: ChildRecord | number = JSON.parse(
        json ? text : /^\d+$/.test(text) ? text : 'null',
      );
      if (!json && typeof value === 'number' && positivePid(value)) return value;
      if (json && value && typeof value === 'object') {
        const { pid, group, capturePath } = value;
        const validIds = positivePid(pid) && positivePid(group);
        if (validIds && typeof capturePath === 'string' && capturePath.length > 0) return value;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    if (performance.now() >= deadline)
      throw new Error(`pid file ${file}: no complete positive integer pid record within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Whether a process, or an explicitly selected process group, may exist. */
export const alive = (target: ProcessTarget): boolean => {
  const pid = signalTarget(target);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/**
 * A signal's effect is not visible to the signaller at once: the target has to run its exit,
 * and be reaped (a zombie still answers a signal-0 probe), after the sender's `kill` returned.
 * So "it ended" is a bounded wait, never a single probe (FU-038: an instant `alive()` right
 * after a group kill found the linger process still there and turned main red).
 * Fails, naming the pid or explicit group, when the target outlives `ms`.
 */
export async function waitGone(target: ProcessTarget, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (alive(target) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (alive(target)) {
    throw new Error(
      `${what}: ${targetName(target)} still alive ${ms} ms after it should have ended`,
    );
  }
}

/** Kernel task states that cannot write any more: zombie (`Z`) and dead (`X`, old kernels `x`). */
const NOT_LIVE = /^[ZXx]/;
/**
 * The whole `ps` STAT grammar: one state letter (procps: D I R S T t W X Z, old kernels K P x)
 * and its modifier letters (`<` `N` `L` `s` `l` `+`). Anything else is not a state, so it is
 * not classified at all (`Z-not-a-state` must not pass as a zombie).
 */
const STAT = /^[DIKPRSTtWXxZ][<NLsl+]*$/;
const UNPROVEN = 'cannot prove a writer is gone';

/**
 * Members of each of `targets` (a pid or an explicit process group) that are LIVE right
 * now, aligned with `targets`: ONE `ps` snapshot of pid, pgid and state for all of them (a
 * second snapshot taken later is a second moment, FU-040 r2 F1), minus zombies. A zombie has
 * released its memory and its files, so it cannot write, but it still answers `kill(pid, 0)`
 * until its parent reaps it; the signal probe cannot tell it from a running writer, the process
 * state can. `waitpid` is not an option: these are grandchildren of the build, not children of
 * the test. Fails closed: every row must be a complete `pid pgid stat` of the grammar, and the
 * calling process (known live) must be in the census, so a snapshot that cannot be taken, read
 * or is incomplete proves nothing and throws (`ps`: test seam).
 */
export function liveMembers(targets: readonly ProcessTarget[], ps = 'ps'): number[][] {
  const ids = targets.map(signalTarget);
  const census = spawnSync(ps, ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  if (census.status !== 0) throw new Error(`process census failed: ${UNPROVEN}`);
  const rows = census.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const cells = line.trim().split(/\s+/);
      const [pid, pgid, state] = cells;
      if (cells.length !== 3 || !/^\d+$/.test(pid) || !/^\d+$/.test(pgid) || !STAT.test(state)) {
        throw new Error(`process census unreadable: ${UNPROVEN}`);
      }
      return { pid: Number(pid), pgid: Number(pgid), live: !NOT_LIVE.test(state) };
    });
  if (!rows.some((row) => row.pid === process.pid && row.live)) {
    throw new Error(`process census incomplete (the calling process is missing): ${UNPROVEN}`);
  }
  return ids.map((target) =>
    rows
      .filter((row) => row.live && (target < 0 ? row.pgid === -target : row.pid === target))
      .map((row) => row.pid),
  );
}

/**
 * For the places where processes must be gone AT a boundary (the wrapper returned, the lock
 * was released): at this very moment no member of ANY target may still be running. ONE
 * census covers all targets and every live member is refused before anything is awaited: a
 * target checked after another one's reaping wait would regain `waitGone`'s eventual-exit
 * allowance (FU-040 r2 F1), so a single target per call cannot be expressed. A zombie
 * awaiting its parent's `wait` is allowed (it cannot write). Then `waitGone` for the full
 * disappearance of each, which may lag the boundary. Without the first step a writer stopped a
 * moment AFTER an early return and release would pass, as `waitGone` alone accepts any exit
 * within its budget (FU-040). No target proves nothing, so it throws.
 */
export async function goneAtBoundary(
  targets: ReadonlyArray<readonly [target: ProcessTarget, what: string]>,
  ms?: number,
): Promise<void> {
  if (targets.length === 0) throw new Error(`no process to check at the boundary: ${UNPROVEN}`);
  const live = liveMembers(targets.map(([target]) => target));
  const refused = targets.flatMap(([target, what], i) =>
    live[i].length === 0
      ? []
      : [
          `${what}: ${targetName(target)} still has a live writer (${live[i].join(', ')}) at the point the lock was released`,
        ],
  );
  if (refused.length > 0) throw new Error(refused.join('\n'));
  await Promise.all(targets.map(([target, what]) => waitGone(target, what, ms)));
}

export interface Result {
  /** Undefined when the driver died before printing its result. */
  status?: number;
  /** Measured inside the driver, from its first TERM request through joined cleanup. */
  shutdownElapsedMs?: number;
  problems: string[];
  printed: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface DriverOptions {
  controllerImportDelayMs?: number;
  inherit?: boolean;
  lockWaitMs?: number;
  env?: Record<string, string>;
  /** Where `next` is resolved from (the fake one's root); default the portal. */
  nextFrom?: string;
  settleMs?: number;
  stopGraceMs?: number;
  stopWaitMs?: number;
  handshakeMs?: number;
  unconfirmableProbe?: boolean;
  prematureAbsence?: boolean;
  afterReceipt?:
    | 'interrupt'
    | 'uncertain'
    | 'supervisor-death'
    | 'readonly-interrupt'
    | 'readonly-uncertain'
    | 'readonly-release'
    | 'readonly-marker';
  modelReuse?: boolean;
  interruptOnAbsence?: boolean;
  recordGroupEvents?: boolean;
  frozenWallClock?: boolean;
  censusFault?: 'error' | 'malformed' | 'missing-supervisor';
  mixedPublicationSignal?: boolean;
  /** Pause after a good build, before the receipt: writes `paused`, waits for `go`. */
  pauseDir?: string;
  /** Writes `{ pid, capturePath }` of `next build` here as soon as it started. */
  recordChild?: string;
  /** Between starting `next build` and publishing its group (the r3 F1 window). */
  afterSpawn?: 'kill' | 'throw' | 'readonly-lock' | 'interrupt' | 'mis-publish';
  /** After a good build, before the receipt (`steal-lock`: another owner replaces ours). */
  beforeReceipt?: 'readonly-lock' | 'readonly-scratch' | 'steal-lock';
}

const DRIVER = `
  import { chmodSync, existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
  import { dirname, join } from 'node:path';
  import { setTimeout as sleep } from 'node:timers/promises';
  import cp from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  const options = JSON.parse(process.env.DRIVER_OPTIONS ?? '{}');
  const dir = process.argv[1];
  const lockDir = join(dir, ${JSON.stringify(LOCK)});
  let scratch;
  let supervisorChild;
  const originalSpawn = cp.spawn;
  cp.spawn = (file, args, given) => {
    if (args?.[0] === ${JSON.stringify(join(SCRIPTS, 'build-supervisor.mjs'))}) {
      const bootstrap = 'import { supervise } from ' + JSON.stringify(${JSON.stringify(pathToFileURL(join(__dirname, 'build-controller.mjs')).href)})
        + '; await supervise(' + JSON.stringify(options.controlPath) + ', '
        + JSON.stringify(${JSON.stringify(url('build-supervisor.mjs'))}) + ', ' + JSON.stringify(options.controllerImportDelayMs ?? 0) + ');';
      supervisorChild = originalSpawn(file, ['--input-type=module', '-e', bootstrap], given);
      return supervisorChild;
    }
    return originalSpawn(file, args, given);
  };
  syncBuiltinESMExports();
  const { runWebBuild } = await import(${JSON.stringify(url('build-run.mjs'))});
  const signalSupervisor = () => {
    // Direct parent-held child; synchronous exit gate, never a recorded PID.
    if (supervisorChild?.exitCode === null && supervisorChild.signalCode === null) supervisorChild.kill('SIGKILL');
  };
  process.on('message', (message) => {
    if (message.kind === 'supervisor-death') signalSupervisor();
  });
  let uncertain = false;
  const afterSpawn = async ({ pid, group, capturePath }) => {
    scratch = dirname(capturePath);
    for (const file of [join(dir, 'driver-child-' + process.pid + '.json'), options.recordChild].filter(Boolean)) {
      writeFileSync(file + '.tmp', JSON.stringify({ pid, group, capturePath }));
      renameSync(file + '.tmp', file);
    }
    if (options.afterSpawn === 'kill') process.kill(process.pid, 'SIGKILL');
    if (options.afterSpawn === 'throw') throw new Error('injected');
    if (options.afterSpawn === 'readonly-lock') chmodSync(lockDir, 0o500);
    if (options.afterSpawn === 'mis-publish') {
      const [owner] = readdirSync(lockDir);
      const file = join(lockDir, owner);
      const { readFileSync } = await import('node:fs');
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...entry, group: pid }));
      await sleep(200);
      throw new Error('mis-published');
    }
    if (options.afterSpawn === 'interrupt') {
      process.kill(process.pid, 'SIGINT');
      await sleep(30);
      if (options.mixedPublicationSignal) process.kill(process.pid, 'SIGTERM');
    }
  };
  const beforeReceipt = async () => {
    groupEvents.push('before-receipt');
    if (options.pauseDir) {
      writeFileSync(join(options.pauseDir, 'paused'), '');
      for (let i = 0; i < 2400 && !existsSync(join(options.pauseDir, 'go')); i += 1) await sleep(100);
    }
    if (options.beforeReceipt === 'readonly-lock') chmodSync(lockDir, 0o500);
    if (options.beforeReceipt === 'readonly-scratch') chmodSync(scratch, 0o500);
    if (options.beforeReceipt === 'steal-lock') {
      const other = 'c'.repeat(24);
      const [entry] = readdirSync(lockDir);
      renameSync(join(lockDir, entry), join(lockDir, 'owner-' + other));
      writeFileSync(join(lockDir, 'owner-' + other), JSON.stringify({ pid: process.pid, nonce: other }));
    }
  };
  const originalKill = process.kill.bind(process);
  let signalsToReusedGroup = 0;
  let absent = false;
  if (options.modelReuse) process.kill = (target, signal) => {
    if (target < 0 && signal !== 0) { signalsToReusedGroup += 1; return true; }
    return originalKill(target, signal);
  };
  const probeGroup = (group) => {
    if (options.prematureAbsence) return false;
    if (options.unconfirmableProbe || uncertain) return true;
    if (options.modelReuse && absent) return true; // an unrelated group now owns that number
    try { originalKill(-group, 0); return true; } catch (error) {
      if (error.code !== 'ESRCH') return true;
      absent = true;
      if (options.interruptOnAbsence) {
        originalKill(process.pid, 'SIGTERM');
        originalKill(process.pid, 'SIGINT');
      }
      return false;
    }
  };
  const afterReceipt = async () => {
    groupEvents.push('receipt');
    if (options.afterReceipt?.startsWith('readonly-') && options.afterReceipt !== 'readonly-marker') chmodSync(join(dir, '.next'), 0o500);
    if (options.afterReceipt === 'readonly-release') chmodSync(lockDir, 0o500);
    if (options.afterReceipt === 'readonly-marker') chmodSync(dir, 0o500);
    if (options.afterReceipt === 'interrupt' || options.afterReceipt === 'readonly-interrupt') {
      process.kill(process.pid, 'SIGINT');
      await sleep(20);
      process.kill(process.pid, 'SIGTERM');
    }
    if (options.afterReceipt === 'uncertain' || options.afterReceipt === 'readonly-uncertain') uncertain = true;
    if (options.afterReceipt === 'supervisor-death') { signalSupervisor(); await sleep(20); }
  };
  const groupEvents = [];
  let shutdownStarted;
  if (options.frozenWallClock) Date.now = () => 0;
  if (options.censusFault) {
    const bin = join(dir, 'census-bin');
    // Test-only replacement for ps. Neither this nor probeGroup is read from production config.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(bin);
    const source = options.censusFault === 'error'
      ? 'process.stdout.write(process.ppid + " " + process.ppid + "\\\\n" + process.pid + " " + process.ppid + "\\\\n"); process.stderr.write("EIO /private/census-sentinel"); process.exit(1);'
      : options.censusFault === 'malformed'
        ? 'process.stdout.write("not-a-process-census");'
        : 'process.stdout.write("1 1\\\\n");';
    writeFileSync(join(bin, 'ps'), '#!' + process.execPath + '\\n' + source, { mode: 0o700 });
    process.env.PATH = bin + ':' + process.env.PATH;
  }
  const result = await runWebBuild(dir, {
    nextFrom: options.nextFrom ?? ${JSON.stringify(WEB)},
    stdio: options.inherit ? 'inherit' : 'ignore',
    lockWaitMs: options.lockWaitMs,
    settleMs: options.settleMs,
    stopGraceMs: options.stopGraceMs,
    stopWaitMs: options.stopWaitMs,
    handshakeMs: options.handshakeMs,
    env: { ...process.env, ...options.env },
    afterSpawn,
    beforeReceipt,
    afterReceipt,
    probeGroup,
    onGroupEvent: (event) => {
      if (event === 'send-term') shutdownStarted ??= performance.now();
      groupEvents.push(event);
    },
  });
  const shutdownElapsedMs = shutdownStarted === undefined ? undefined : performance.now() - shutdownStarted;
  if (options.recordGroupEvents) writeFileSync(join(dir, 'group-events.json'), JSON.stringify(groupEvents));
  if (options.modelReuse) {
    process.kill = originalKill;
    writeFileSync(join(dir, 'reuse.json'), JSON.stringify({ absent, signalsToReusedGroup }));
  }
  // Match the production entry point: a returned result ends the wrapper immediately.
  // Outstanding IPC handles/timers must not accidentally join missing cleanup in a test.
  if (!supervisorChild) await new Promise((resolve) => process.send({ kind: 'no-supervisor' }, resolve));
  process.stdout.write(JSON.stringify({ ...result, shutdownElapsedMs }) + '\\n', () => process.exit(result.status));
`;

/** Wrapper signals use the unreaped child; member/group signals use live controllers. */
export function startDriver(
  dir: string,
  options: DriverOptions = {},
): {
  done: Promise<Result>;
  controllerConnected: Promise<void>;
  /** The lifecycle outcome, once known; sends nothing. */
  ended: Promise<'COMPLETED' | 'LOST'>;
  signal(signal: NodeJS.Signals): boolean;
  root(signal: NodeJS.Signals): Promise<boolean>;
  killSupervisor(): boolean;
  watchdog(): Promise<never>;
  expireWatchdog(): void;
} {
  const endpoint = supervisorEndpoint();
  const child = spawn(process.execPath, ['--input-type=module', '-e', DRIVER, '--', dir], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      DRIVER_OPTIONS: JSON.stringify({ ...options, controlPath: endpoint.path }),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const fixture = {
    group: () => endpoint.request('group'),
    wrapper: (signal: NodeJS.Signals) => signalChild(child, signal),
    close: () => endpoint.close(),
  };
  trackFixture(fixture);
  let rejectDone: (error: Error) => void;
  let watchdogExpired = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = (ms: number): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      watchdogExpired = true;
      void watchdogFixture(fixture).catch((error: Error) => {
        rejectDone(error);
      });
    }, ms);
  };
  if (options.nextFrom) armWatchdog(20_000);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk));
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const done = new Promise<Result>((resolve, reject) => {
    rejectDone = reject;
    void endpoint.ready.catch(reject);
    child.on('message', (message: { kind: string }) => {
      if (message.kind === 'no-supervisor') endpoint.noSupervisor();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (watchdog) clearTimeout(watchdog);
      if (watchdogExpired) return;
      const last = stdout.trim().split('\n').pop() ?? '';
      const parsed = (last.startsWith('{') ? JSON.parse(last) : { problems: [] }) as {
        status?: number;
        problems: string[];
      };
      resolve({ ...parsed, printed: stdout + stderr, code, signal });
    });
  });
  return {
    done,
    controllerConnected: endpoint.connected,
    ended: endpoint.ended,
    signal: fixture.wrapper,
    watchdog: () => watchdogFixture(fixture),
    expireWatchdog: () => armWatchdog(0),
    root: (signal) => endpoint.request('root', signal),
    killSupervisor: () => {
      if (!child.connected) return false;
      child.send({ kind: 'supervisor-death' }, () => {});
      return true;
    },
  };
}

export const runDriver = (dir: string, options: DriverOptions = {}): Promise<Result> =>
  startDriver(dir, options).done;

/** A one-page app for the real `next build`; `stale` plants an earlier build's complete artifacts. */
export function plantApp(dir: string, config: string, page?: string, stale = false): void {
  mkdirSync(join(dir, 'app'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
  symlinkSync(join(WEB, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(
    join(dir, 'app/layout.jsx'),
    'export default function L({ children }) { return <html><body>{children}</body></html>; }\n',
  );
  writeFileSync(
    join(dir, 'app/page.jsx'),
    page ?? 'export default function P() { return <p>hi</p>; }\n',
  );
  writeFileSync(join(dir, 'next.config.mjs'), config);
  if (stale) {
    // A complete, self-consistent earlier build: BUILD_ID, manifest and a matching receipt.
    mkdirSync(join(dir, '.next/server'), { recursive: true });
    mkdirSync(join(dir, '.next/cache'), { recursive: true });
    writeFileSync(join(dir, '.next/cache/keep'), 'x');
    writeFileSync(join(dir, '.next/stale-marker'), 'x');
    writeFileSync(join(dir, '.next/BUILD_ID'), 'old-build');
    writeFileSync(join(dir, '.next/server/server-reference-manifest.json'), '{"node":{}}');
    runModule(
      `import { writeReceipt } from ${JSON.stringify(url('build-receipt.mjs'))};\nwriteReceipt(${JSON.stringify(dir)}, { distDir: '.next', tsconfigPath: 'tsconfig.json', cleanDistDir: true });\nconsole.log('null');`,
    );
  }
}

/**
 * What the fake `next build` does, read from `plan.json` in the package directory. Like
 * Next it catches a failing configuration load and ignores how its workers ended, so a
 * refusal cannot come from the build noticing anything itself.
 */
export interface Plan {
  /** Loads of the configuration in the build process itself (default 1). */
  rootLoads?: number;
  /** Workers, in order, each awaited: a forked process, a spawnSync'd process, a thread. */
  workers?: Array<'fork' | 'spawnSync' | 'thread'>;
  workerLoads?: number;
  /**
   * A process left running when the build exits: writes into `.next` every 50 ms for `ms`.
   * Started by `next build` itself (`detached` as asked), or, with `via`, by a synchronous
   * child started with `detached: true` that returns at once, leaving it running.
   */
  linger?: {
    ms: number;
    detached?: boolean;
    ignoreTerm?: boolean;
    /** A forced slow writer startup; readiness must be observed rather than guessed. */
    startupMs?: number;
    loadsAfterMs?: number;
    via?: 'spawnSync' | 'execFileSync' | 'execSync';
  };
  /** Stays alive this long before it writes its output (to be signalled meanwhile). */
  holdMs?: number;
  /**
   * Stays alive until the test calls `releaseHold(dir)` (FU-199), never on a timer: a case
   * that asserts a writer is STILL alive after waiting for something else must not race the
   * writer's own clock against a loaded runner. Nothing leaks if the test never releases it:
   * the writer also ends once the test process is gone.
   */
  holdUntilRelease?: boolean;
  unresponsive?: 'ignore' | 'sync';
  /** Exits with this code instead of writing the output. */
  exit?: number;
}

/**
 * A fake `next` under `root`: `next/dist/bin/next` writes `ran-<pid>` (it got past the
 * preload's handshake), loads the configuration through `next/dist/server/config.js` (the
 * module the preload wraps), runs its workers, then writes BUILD_ID and an empty manifest.
 * `fault.cjs` is a preload a case may add to NODE_OPTIONS: it makes appends of one record
 * kind fail with an errno, in one role (root, child process, worker thread), and follows the
 * build into every child and thread the way the real preload does.
 */
export function plantFakeNext(root: string): { nextFrom: string; fault: string } {
  const next = join(root, 'node_modules/next/dist');
  for (const sub of ['bin', 'server', 'build']) mkdirSync(join(next, sub), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"fake-host","version":"0.0.0"}');
  writeFileSync(
    join(root, 'node_modules/next/package.json'),
    '{"name":"next","version":"0.0.0-fake"}',
  );
  writeFileSync(
    join(next, 'server/config.js'),
    `exports.default = async () => ({ distDir: '.next', cleanDistDir: true, typescript: { tsconfigPath: 'tsconfig.json' } });\n`,
  );
  writeFileSync(
    join(next, 'build/worker.js'),
    `const plan = JSON.parse(require('fs').readFileSync(require('path').join(process.cwd(), 'plan.json'), 'utf8'));
(async () => {
  for (let i = 0; i < (plan.workerLoads ?? 1); i += 1) {
    try { await require('../server/config.js').default('phase-production-build', process.cwd()); } catch {}
  }
})();
`,
  );
  writeFileSync(
    join(next, 'build/linger.js'),
    `const fs = require('fs');
const [ms, loadsAfterMs, ignoreTerm, startupMs] = process.argv.slice(2).map(Number);
if (startupMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, startupMs);
if (ignoreTerm) process.on('SIGTERM', () => {});
// Atomic: a reader that sees linger.pid sees the whole pid (FU-095: an empty file read as pid 0,
// and kill(0, 0) probes the test's own group, so it never "ended").
fs.writeFileSync('linger.pid.tmp', String(process.pid));
fs.renameSync('linger.pid.tmp', 'linger.pid');
const timer = setInterval(() => { fs.mkdirSync('.next', { recursive: true }); fs.writeFileSync('.next/from-linger', String(Date.now())); }, 50);
if (loadsAfterMs > 0) setTimeout(() => require('../server/config.js').default('phase-production-build', process.cwd()).catch(() => {}), loadsAfterMs);
setTimeout(() => { clearInterval(timer); fs.writeFileSync('linger.done', ''); }, ms);
`,
  );
  // Starts its arguments as a process and returns at once, leaving it running.
  writeFileSync(
    join(next, 'build/start.js'),
    `require('child_process').spawn(process.execPath, process.argv.slice(2), { stdio: 'ignore' }).unref();\n`,
  );
  writeFileSync(
    join(next, 'bin/next'),
    `const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { Worker } = require('worker_threads');
const dir = process.cwd();
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const load = () => require('../server/config.js').default('phase-production-build', dir);
const worker = path.join(__dirname, '../build/worker.js');
(async () => {
  fs.writeFileSync(path.join(dir, 'ran-' + process.pid), '');
  for (let i = 0; i < (plan.rootLoads ?? 1); i += 1) { try { await load(); } catch {} }
  for (const via of plan.workers ?? []) {
    if (via === 'fork') await new Promise((r) => cp.fork(worker, [], { stdio: 'ignore' }).on('exit', r));
    if (via === 'spawnSync') cp.spawnSync(process.execPath, [worker], { stdio: 'ignore' });
    if (via === 'thread') await new Promise((r) => new Worker(worker).on('exit', r).on('error', r));
  }
  if (plan.linger) {
    const args = [path.join(__dirname, '../build/linger.js'), String(plan.linger.ms), String(plan.linger.loadsAfterMs ?? 0), String(Number(Boolean(plan.linger.ignoreTerm))), String(plan.linger.startupMs ?? 0)];
    const via = plan.linger.via;
    const sync = { stdio: 'ignore', detached: true };
    const starter = [path.join(__dirname, '../build/start.js'), ...args];
    if (via === 'spawnSync') cp.spawnSync(process.execPath, starter, sync);
    else if (via === 'execFileSync') cp.execFileSync(process.execPath, starter, sync);
    else if (via === 'execSync') cp.execSync([process.execPath, ...starter].map((a) => JSON.stringify(a)).join(' '), sync);
    else cp.spawn(process.execPath, args, { stdio: 'ignore', detached: Boolean(plan.linger.detached) }).unref();
    // The scenario requires an initialized writer. Root exit must never race its
    // startup, including the asynchronous descendant left by a synchronous child.
    for (let i = 0; i < 3000 && !fs.existsSync(path.join(dir, 'linger.pid')); i += 1) await new Promise((r) => setTimeout(r, 10));
    if (!fs.existsSync(path.join(dir, 'linger.pid'))) process.exit(71); // Bounded: never wait forever.
  }
  if (plan.unresponsive) process.on('SIGTERM', () => {});
  if (plan.unresponsive) fs.writeFileSync('unresponsive.ready', '');
  if (plan.unresponsive === 'sync') { for (;;) {} }
  if (plan.holdMs) await new Promise((r) => setTimeout(r, plan.holdMs));
  if (plan.releaseFile) {
    // Held by the test, not by a timer; ends early only if the test process itself is gone.
    while (!fs.existsSync(plan.releaseFile)) {
      try { process.kill(plan.ownerPid, 0); } catch (error) { if (error.code === 'ESRCH') process.exit(72); }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (plan.exit) process.exit(plan.exit);
  fs.mkdirSync(path.join(dir, '.next/server'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.next/BUILD_ID'), 'fake-' + process.pid);
  fs.writeFileSync(path.join(dir, '.next/server/server-reference-manifest.json'), '{"node":{},"edge":{}}');
})();
`,
  );
  const fault = join(root, 'fault.cjs');
  writeFileSync(
    fault,
    `// FAULT=kind:role:errno, role one of root | child | thread.
const fs = require('fs');
const cp = require('child_process');
const wt = require('worker_threads');
const [kind, role, code] = String(process.env.FAULT || '').split(':');
const mine = !wt.isMainThread ? 'thread' : process.env.FAULT_SEEN ? 'child' : 'root';
process.env.FAULT_SEEN = '1';
const real = fs.appendFileSync;
fs.appendFileSync = function (file, data) {
  if (kind && role === mine && String(data).includes('"kind":"' + kind + '"')) {
    const error = new Error(code + ': injected');
    error.code = code;
    throw error;
  }
  return real.apply(this, arguments);
};
const FLAG = '--require=' + JSON.stringify(__filename);
const first = (options) => (String(options || '').includes(__filename) ? options : (FLAG + ' ' + (options || '')).trim());
const spawnAsync = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (options) {
  const pairs = (options.envPairs || []).filter((p) => !p.startsWith('NODE_OPTIONS='));
  const current = (options.envPairs || []).find((p) => p.startsWith('NODE_OPTIONS='));
  pairs.push('NODE_OPTIONS=' + first(current && current.slice('NODE_OPTIONS='.length)));
  return spawnAsync.call(this, { ...options, envPairs: pairs });
};
const spawnSync = cp.spawnSync;
cp.spawnSync = function (file, args, options) {
  const given = { ...options, env: { ...((options && options.env) || process.env) } };
  given.env.NODE_OPTIONS = first(given.env.NODE_OPTIONS);
  return spawnSync.call(this, file, args, given);
};
const OriginalWorker = wt.Worker;
wt.Worker = class extends OriginalWorker {
  constructor(file, options = {}) {
    super(file, { ...options, execArgv: ['--require', __filename, ...(options.execArgv || process.execArgv)] });
  }
};
`,
  );
  return { nextFrom: root, fault };
}

const HOLD_RELEASE = 'hold-release';

/** A package directory for the fake `next`, with its plan. */
export function plantFakeApp(dir: string, plan: Plan): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
  const hold = plan.holdUntilRelease
    ? { releaseFile: join(dir, HOLD_RELEASE), ownerPid: process.pid }
    : {};
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ ...plan, ...hold }));
}

/**
 * Lets the fake `next` of `dir` finish. A directory planted without `holdUntilRelease` is a
 * test bug and throws, unless `lenient` (the end-of-case sweep over every directory).
 */
export function releaseHold(dir: string, lenient = false): void {
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as { releaseFile?: string };
  if (plan.releaseFile) writeFileSync(plan.releaseFile, '');
  else if (!lenient) throw new Error(`${dir}: planted without holdUntilRelease`);
}

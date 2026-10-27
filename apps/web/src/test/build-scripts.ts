import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** Whether a process (or, negative, a process group) may exist. */
export const alive = (target: number): boolean => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

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
        + JSON.stringify(${JSON.stringify(url('build-supervisor.mjs'))}) + ');';
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
    writeFileSync(join(dir, 'driver-child-' + process.pid + '.json'), JSON.stringify({ pid, group, capturePath }));
    if (options.recordChild) writeFileSync(options.recordChild, JSON.stringify({ pid, group, capturePath }));
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
  process.stdout.write(JSON.stringify({ ...result, shutdownElapsedMs }) + '\\n', () => process.exit(result.status));
`;

/** Wrapper signals use the unreaped child; member/group signals use live controllers. */
export function startDriver(
  dir: string,
  options: DriverOptions = {},
): {
  done: Promise<Result>;
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
  let watchdogError: Error | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = (ms: number): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      void watchdogFixture(fixture).catch((error: Error) => {
        watchdogError = error;
      });
    }, ms);
  };
  if (options.nextFrom) armWatchdog(20_000);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk));
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const done = new Promise<Result>((resolve, reject) => {
    void endpoint.ready.catch(reject);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      endpoint.wrapperEnded();
      if (watchdog) clearTimeout(watchdog);
      if (watchdogError) return reject(watchdogError);
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
fs.writeFileSync('linger.pid', String(process.pid));
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
    while (!fs.existsSync(path.join(dir, 'linger.pid'))) await new Promise((r) => setTimeout(r, 10));
  }
  if (plan.unresponsive) process.on('SIGTERM', () => {});
  if (plan.unresponsive) fs.writeFileSync('unresponsive.ready', '');
  if (plan.unresponsive === 'sync') { for (;;) {} }
  if (plan.holdMs) await new Promise((r) => setTimeout(r, plan.holdMs));
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

/** A package directory for the fake `next`, with its plan. */
export function plantFakeApp(dir: string, plan: Plan): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
}

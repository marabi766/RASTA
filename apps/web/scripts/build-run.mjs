// `pnpm build`: one invocation that owns the package's output from start to receipt.
//
//   0. take the package's build lock (build-lock.mjs); a second invocation waits a bounded
//      time and then refuses, so no other wrapper replaces `.next` underneath this one;
//   1. delete the previous receipt and the default output (`.next`, keeping Next's own
//      `cache`, as `cleanDistDir` does), so nothing an earlier build left can be read as
//      this build's;
//   2. run the real `next build` as the leader of a process group of its own, with
//      `capture-next-config.cjs` preloaded into it and into every process it starts; publish
//      that group in the lock (the build's first process waits for this before Next runs);
//      the preload records the configuration each process got and that each process started
//      (build-layout.mjs);
//   3. when `next build` has exited, the group must be empty: a process of the build still
//      alive could still write, so the build is refused (and that process stopped);
//   4. only if it exited 0, no process of it is left, no report failed, every started Node
//      process reported, the recorded layout is the supported one and the output is where
//      it was recorded, check that the lock is still ours and write the receipt for that
//      output;
//   5. on every path (failure, exception, SIGINT/SIGTERM/SIGHUP of this wrapper): stop the
//      whole group (SIGTERM, then SIGKILL) and wait until it is gone, THEN release the lock.
//      If the group cannot be confirmed gone, or the lock cannot be removed, the lock is kept
//      and the build refuses. A wrapper killed with SIGKILL cannot do this: its lock stays
//      held for as long as the group lives (build-lock.mjs), and may be taken over only after.
//
// The configuration is never evaluated by these scripts. Output of `next build` itself
// (including whatever the project's config prints while Next loads it) is Next's and is not
// touched here; every line these scripts print is a fixed sentence.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as afterIo, setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { layoutProblems, outputDirProblems, readCapture } from './build-layout.mjs';
import { acquireBuildLock, groupAlive } from './build-lock.mjs';
import { RECEIPT_FILE, writeReceipt } from './build-receipt.mjs';

const PRELOAD = fileURLToPath(new URL('./capture-next-config.cjs', import.meta.url));
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
const UNEXPECTED = 'build: unexpected failure (details withheld); refusing';

/**
 * Empties the default output except Next's `cache`; run before every build. The previous
 * receipt lives in it, so it goes too.
 */
export function invalidatePreviousOutput(webDir) {
  const out = join(webDir, '.next');
  let entries = [];
  try {
    entries = readdirSync(out);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== 'cache') rmSync(join(out, entry), { recursive: true, force: true });
  }
}

/** Waits until no process of `group` exists, at most `ms`. @returns whether it is gone */
async function groupGone(group, ms) {
  const deadline = Date.now() + ms;
  while (groupAlive(group)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

function signalGroup(group, signal) {
  try {
    process.kill(-group, signal);
  } catch {
    // gone already
  }
}

/** SIGTERM, then SIGKILL, and wait. @returns whether the group is confirmed gone */
async function stopGroup(group, { graceMs, waitMs }) {
  if (!groupAlive(group)) return true;
  signalGroup(group, 'SIGTERM');
  if (await groupGone(group, graceMs)) return true;
  signalGroup(group, 'SIGKILL');
  return groupGone(group, waitMs);
}

/**
 * @param {string} webDir
 * @param {{
 *   nextFrom?: string, env?: NodeJS.ProcessEnv, stdio?: 'inherit' | 'ignore', lockWaitMs?: number,
 *   settleMs?: number, stopGraceMs?: number, stopWaitMs?: number, handshakeMs?: number,
 *   afterSpawn?: (child: { pid: number, capturePath: string }) => Promise<void> | void,
 *   beforeReceipt?: () => Promise<void> | void,
 * }} [options]
 *   `afterSpawn` runs after `next build` started and before its group is published, and
 *   `beforeReceipt` after a good build and before the receipt is written: test seams, the two
 *   places where a crash or a competing invocation used to be able to break ownership.
 * @returns {Promise<{ status: number, problems: string[] }>}
 */
export async function runWebBuild(webDir, options = {}) {
  const locked = await acquireBuildLock(webDir, { waitMs: options.lockWaitMs });
  if (!locked.ok) return { status: 1, problems: [locked.problem] };
  const { lock } = locked;
  let group;
  let interrupted;
  let reportFailed = false;
  const onSignal = (signal) => {
    // A second signal stops the build at once; the wrapper still waits for it to be gone.
    if (group) signalGroup(group, interrupted ? 'SIGKILL' : 'SIGTERM');
    interrupted ??= signal;
  };
  const onReportFailure = () => {
    reportFailed = true;
  };
  for (const signal of Object.keys(SIGNALS)) process.on(signal, onSignal);
  process.on('SIGURG', onReportFailure);
  /** Lets a signal that is already pending reach its handler (it runs after I/O polling). */
  const settleSignals = () => afterIo();

  let scratch;
  let result;
  try {
    result = await build();
  } catch {
    result = { status: 1, problems: [UNEXPECTED] };
  }

  // Cleanup, in this order: no process of the build alive, scratch gone, lock released.
  const stopped =
    group === undefined ||
    (await stopGroup(group, {
      graceMs: options.stopGraceMs ?? 5_000,
      waitMs: options.stopWaitMs ?? 30_000,
    }));
  try {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  } catch {
    // not in the output; a leftover in the temp directory changes nothing that is checked
  }
  for (const signal of Object.keys(SIGNALS)) process.off(signal, onSignal);
  process.off('SIGURG', onReportFailure);
  if (!stopped) {
    return {
      status: 1,
      problems: [
        'build: processes of this build could not be confirmed stopped; the build lock is kept; refusing',
      ],
    };
  }
  if (!lock.release()) {
    // The receipt must not outlive a refusal.
    try {
      rmSync(join(webDir, RECEIPT_FILE), { force: true });
    } catch {
      // the refusal (status 1) stands
    }
    return {
      status: 1,
      problems: [
        ...result.problems,
        'build lock: could not be released (details withheld); it is free once this process has exited; refusing',
      ],
    };
  }
  return result;

  async function build() {
    if (interrupted) return interruptedResult();
    invalidatePreviousOutput(webDir);
    const require = createRequire(join(options.nextFrom ?? webDir, 'package.json'));
    const nextBin = require.resolve('next/dist/bin/next');
    scratch = mkdtempSync(join(tmpdir(), 'web-build-capture-'));
    const capturePath = join(scratch, 'config.jsonl');
    const nonce = randomBytes(12).toString('hex');
    const base = options.env ?? process.env;
    if (interrupted) return interruptedResult();
    const child = spawn(process.execPath, [nextBin, 'build'], {
      cwd: webDir,
      stdio: options.stdio ?? 'inherit',
      // setsid: `next build` leads a process group of its own, which every process it starts
      // stays in; the group, not one pid, is what the lock waits for. It also keeps a group
      // signal from ever reaching this wrapper, the shell or turbo above it.
      detached: true,
      env: {
        ...base,
        RASTA_BUILD_CAPTURE: capturePath,
        RASTA_BUILD_NONCE: nonce,
        RASTA_BUILD_WRAPPER: String(process.pid),
        RASTA_BUILD_ROOT: '1',
        RASTA_BUILD_OWNER_FILE: lock.ownerFile,
        ...(options.handshakeMs ? { RASTA_BUILD_HANDSHAKE_MS: String(options.handshakeMs) } : {}),
        NODE_OPTIONS: `${base.NODE_OPTIONS ?? ''} --require=${JSON.stringify(PRELOAD)}`.trim(),
      },
    });
    const exited = new Promise((resolve) => {
      child.on('error', () => resolve({ code: 1 }));
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    if (typeof child.pid !== 'number') {
      return { status: 1, problems: ['next build: could not be started; refusing'] };
    }
    group = child.pid;
    await options.afterSpawn?.({ pid: child.pid, capturePath });
    lock.publishGroup(group);
    if (interrupted) signalGroup(group, 'SIGTERM');
    const { code, signal } = await exited;
    // Next ends its workers before it exits; whatever is left of the group could still write.
    const left = !(await groupGone(group, options.settleMs ?? 2_000));
    await settleSignals();
    if (interrupted) return interruptedResult();
    if (reportFailed) return reportFailedResult();
    if (left) {
      return {
        status: 1,
        problems: ['next build: a process it started was still running after it exited; refusing'],
      };
    }
    if (signal) return { status: 1, problems: ['next build: ended by a signal; refusing'] };
    if (code !== 0) return { status: code ?? 1, problems: [] };
    const layout = readCapture(capturePath, { nonce, rootPid: child.pid });
    const problems = layoutProblems(layout);
    problems.push(...outputDirProblems(layout, join(webDir, '.next')));
    if (problems.length === 0) {
      await options.beforeReceipt?.();
      await settleSignals();
      if (interrupted) return interruptedResult();
      if (reportFailed) return reportFailedResult();
      lock.assertHeld();
      problems.push(...writeReceipt(webDir, layout));
    }
    return { status: problems.length > 0 ? 1 : 0, problems };
  }

  function interruptedResult() {
    return {
      status: 128 + SIGNALS[interrupted],
      problems: ['build: interrupted; the build was stopped before the lock was released'],
    };
  }

  function reportFailedResult() {
    return {
      status: 1,
      problems: ['next config: a build process could not write its report; refusing'],
    };
  }
}

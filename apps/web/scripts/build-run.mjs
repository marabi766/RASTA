// `pnpm build`: one invocation that owns the package's output from start to receipt.
//
//   0. take the package's build lock (build-lock.mjs); a second invocation waits a bounded
//      time and then refuses, so no other wrapper replaces `.next` underneath this one;
//   1. delete the previous receipt and the default output (`.next`, keeping Next's own
//      `cache`, as `cleanDistDir` does), so nothing an earlier build left can be read as
//      this build's;
//   2. run the real `next build` with `capture-next-config.cjs` preloaded into it and into
//      every process it starts; the preload records the configuration each process got and
//      that each process started (build-layout.mjs);
//   3. only if it exited 0, every started Node process reported, the recorded layout is the
//      supported one and the output is where it was recorded, check that the lock is still
//      ours and write the receipt for that output; then release the lock.
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
import { fileURLToPath } from 'node:url';

import { layoutProblems, outputDirProblems, readCapture } from './build-layout.mjs';
import { acquireBuildLock } from './build-lock.mjs';
import { writeReceipt } from './build-receipt.mjs';

const PRELOAD = fileURLToPath(new URL('./capture-next-config.cjs', import.meta.url));

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

/**
 * @param {string} webDir
 * @param {{ nextFrom?: string, env?: NodeJS.ProcessEnv, stdio?: 'inherit' | 'ignore', lockWaitMs?: number, beforeReceipt?: () => Promise<void> | void }} [options]
 *   `beforeReceipt` runs after a good build and before the receipt is written (a test seam: the
 *   place where a competing invocation used to be able to replace the output).
 * @returns {Promise<{ status: number, problems: string[] }>}
 */
export async function runWebBuild(webDir, options = {}) {
  const locked = await acquireBuildLock(webDir, { waitMs: options.lockWaitMs });
  if (!locked.ok) return { status: 1, problems: [locked.problem] };
  const { lock } = locked;
  let scratch;
  try {
    invalidatePreviousOutput(webDir);
    const require = createRequire(join(options.nextFrom ?? webDir, 'package.json'));
    const nextBin = require.resolve('next/dist/bin/next');
    scratch = mkdtempSync(join(tmpdir(), 'web-build-capture-'));
    const capturePath = join(scratch, 'config.jsonl');
    const nonce = randomBytes(12).toString('hex');
    const base = options.env ?? process.env;
    const child = spawn(process.execPath, [nextBin, 'build'], {
      cwd: webDir,
      stdio: options.stdio ?? 'inherit',
      env: {
        ...base,
        RASTA_BUILD_CAPTURE: capturePath,
        RASTA_BUILD_NONCE: nonce,
        NODE_OPTIONS: `${base.NODE_OPTIONS ?? ''} --require=${JSON.stringify(PRELOAD)}`.trim(),
      },
    });
    if (typeof child.pid !== 'number') {
      return { status: 1, problems: ['next build: could not be started; refusing'] };
    }
    const rootPid = child.pid;
    lock.setChildPid(rootPid);
    const status = await new Promise((resolve) => {
      child.on('error', () => resolve(1));
      child.on('close', (code) => resolve(code ?? 1));
    });
    if (status !== 0) return { status, problems: [] };
    const layout = readCapture(capturePath, { nonce, rootPid });
    const problems = layoutProblems(layout);
    problems.push(...outputDirProblems(layout, join(webDir, '.next')));
    if (problems.length === 0) {
      await options.beforeReceipt?.();
      lock.assertHeld();
      problems.push(...writeReceipt(webDir, layout));
    }
    return { status: problems.length > 0 ? 1 : 0, problems };
  } catch {
    return { status: 1, problems: ['build: unexpected failure (details withheld); refusing'] };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    lock.release();
  }
}

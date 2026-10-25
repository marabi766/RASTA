// `pnpm build`: one invocation that owns its output.
//
//   1. delete the previous receipt and the default output (`.next`, keeping Next's own
//      `cache`, as `cleanDistDir` does), so nothing an earlier build left can be read as
//      this build's;
//   2. run the real `next build` with `capture-next-config.cjs` preloaded, which records the
//      configuration Next's loader gave THIS build (build-layout.mjs);
//   3. only if it exited 0, the recorded layout is the supported one and the output is where
//      it was recorded, write the receipt for that output.
//
// The configuration is never evaluated by these scripts. Output of `next build` itself
// (including whatever the project's config prints while Next loads it) is Next's and is not
// touched here; every line these scripts print is a fixed sentence.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { layoutProblems, outputDirProblems, readCapture } from './build-layout.mjs';
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
 * @param {{ nextFrom?: string, env?: NodeJS.ProcessEnv, stdio?: 'inherit' | 'ignore' }} [options]
 * @returns {{ status: number, problems: string[] }}
 */
export function runWebBuild(webDir, options = {}) {
  invalidatePreviousOutput(webDir);
  const require = createRequire(join(options.nextFrom ?? webDir, 'package.json'));
  const nextBin = require.resolve('next/dist/bin/next');
  const scratch = mkdtempSync(join(tmpdir(), 'web-build-capture-'));
  const capturePath = join(scratch, 'config.jsonl');
  try {
    const base = options.env ?? process.env;
    const run = spawnSync(process.execPath, [nextBin, 'build'], {
      cwd: webDir,
      stdio: options.stdio ?? 'inherit',
      env: {
        ...base,
        RASTA_BUILD_CAPTURE: capturePath,
        NODE_OPTIONS: `${base.NODE_OPTIONS ?? ''} --require=${JSON.stringify(PRELOAD)}`.trim(),
      },
    });
    if (run.status !== 0) return { status: run.status ?? 1, problems: [] };
    const layout = readCapture(capturePath);
    const problems = layoutProblems(layout);
    problems.push(...outputDirProblems(layout, join(webDir, '.next')));
    if (problems.length === 0) problems.push(...writeReceipt(webDir, layout));
    return { status: problems.length > 0 ? 1 : 0, problems };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// What the web build REALLY did, as recorded by the build itself.
//
// The check after the build reads `.next/server/server-reference-manifest.json`. That is
// the manifest of THIS build only if the build wrote to `.next`, emptied it first, and
// used the default tsconfig. Nothing here evaluates `next.config.mjs`: re-evaluating it
// from another process cannot reproduce the environment the build ran in (Next's CLI sets
// NEXT_RUNTIME, NODE_ENV and more before it loads the config), so the answer is taken from
// the build process itself. `capture-next-config.cjs` is preloaded into `next build` and
// records the settings of the configuration Next's own loader returned to the build
// (`next/dist/server/config.js`, phase-production-build); `readCapture` reads that record.
//
// A diagnostic is a fixed sentence plus a key name; no config value is ever shown.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What the preload reported for ONE invocation, and whether that report is complete.
 *
 * Complete means: the `next build` process itself reported (`rootPid`), and every child
 * process or worker thread that any reporting process saw start AND that is a Node process
 * reported too. A started Node process runs the preload (it is forced into the child's
 * environment at spawn, see capture-next-config.cjs), and the preload writes the config record
 * from inside the function that hands the configuration to the process, so a process that
 * reported its start cannot have used a configuration without reporting it. A partial set of
 * records cannot pass: any Node child that was started but never reported leaves a `spawn`
 * record with no matching `start`. Processes that are not Node (a shell, git) load no Next
 * config; a Node process below them is still counted when it reports.
 *
 * @param {string} capturePath  file the preload appended to
 * @param {{ nonce: string, rootPid: number }} invocation
 * @returns {{ captured: false } | { captured: true, outputDir: string, distDir: unknown, tsconfigPath: unknown, cleanDistDir: unknown, consistent: boolean, missing: number }}
 */
export function readCapture(capturePath, invocation) {
  let lines;
  try {
    lines = readFileSync(capturePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { captured: false };
  }
  const records = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record === null || typeof record !== 'object') return { captured: false };
      // Another invocation's record (or a forged one without the nonce) is not evidence.
      if (record.nonce === invocation.nonce) records.push(record);
    } catch {
      return { captured: false };
    }
  }
  const starts = new Set(
    records.filter((r) => r.kind === 'start').map((r) => `${r.pid}:${r.tid ?? 0}`),
  );
  if (!starts.has(`${invocation.rootPid}:0`)) return { captured: false };
  const configs = records.filter((r) => r.kind === 'config');
  if (configs.length === 0) return { captured: false };
  const expected = records
    .filter((r) => r.kind === 'spawn' && r.node === true)
    .map((r) => (r.thread !== undefined ? `${r.pid}:${r.thread}` : `${r.child}:0`));
  const missing = new Set(expected.filter((key) => !starts.has(key))).size;
  const [first] = configs;
  const same = (a, b) =>
    a.outputDir === b.outputDir &&
    a.distDir === b.distDir &&
    a.tsconfigPath === b.tsconfigPath &&
    a.cleanDistDir === b.cleanDistDir;
  return {
    captured: true,
    outputDir: first.outputDir,
    distDir: first.distDir,
    tsconfigPath: first.tsconfigPath,
    cleanDistDir: first.cleanDistDir,
    // Next's build workers load the configuration too; a disagreement means the build was
    // not one consistent run of one configuration.
    consistent: configs.every((record) => same(record, first)),
    missing,
  };
}

/** Fixed sentences naming the offending key; empty when the layout is the supported one. */
export function layoutProblems(layout) {
  if (layout === null || typeof layout !== 'object' || layout.captured === false) {
    return ['next config: the build did not report the configuration it used; refusing'];
  }
  const problems = [];
  if (layout.missing !== 0) {
    problems.push('next config: a process the build started never reported; refusing');
  }
  if (layout.consistent === false) {
    problems.push('next config: the build processes disagree on the configuration; refusing');
  }
  if (layout.distDir !== '.next') {
    problems.push(
      'distDir: the build did not write to ".next"; only the default output is checked',
    );
  }
  if (layout.tsconfigPath !== undefined && layout.tsconfigPath !== 'tsconfig.json') {
    problems.push('typescript.tsconfigPath: the build used another tsconfig; refusing');
  }
  if (layout.cleanDistDir !== true) {
    problems.push('cleanDistDir: the build kept old artifacts; refusing');
  }
  return problems;
}

/** The directory Next reported writing to must be the one the checker reads. */
export function outputDirProblems(layout, expectedDir) {
  if (layout.captured !== true || layoutProblems(layout).length > 0) return [];
  const real = (path) => {
    try {
      return realpathSync(resolve(path));
    } catch {
      return null;
    }
  };
  return real(layout.outputDir) !== null && real(layout.outputDir) === real(expectedDir)
    ? []
    : ['distDir: the build did not write into this package\'s ".next"; refusing'];
}

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

const KINDS = new Set(['start', 'spawn', 'config-begin', 'config']);

/**
 * What the preload reported for ONE invocation, and whether that report is complete.
 *
 * Complete means:
 *  - the `next build` process itself reported its start (`rootPid`) and completed at least one
 *    load of the configuration;
 *  - every record comes from a process or worker thread that reported its start;
 *  - every load of the configuration that began (`config-begin`, one per loader call: pid,
 *    thread id, call number) also reported what it returned (`config`). A start record says
 *    nothing about the configuration: a participant that loaded it and could not report the
 *    result is refused, while one that never loads it (nothing to disagree with) is accepted;
 *  - every child process or worker thread that any reporting process saw start AND that is a
 *    Node process reported its start too. A started Node process runs the preload (it is
 *    forced into the child's environment at spawn, see capture-next-config.cjs), so any Node
 *    child that never reported leaves a `spawn` record with no matching `start`. Processes
 *    that are not Node (a shell, git) load no Next config; a Node process below them is still
 *    counted when it reports.
 * A record the preload could not write ends the build (capture-next-config.cjs, point 3), so
 * a missing record is never the only trace of a failure.
 *
 * @param {string} capturePath  file the preload appended to
 * @param {{ nonce: string, rootPid: number }} invocation
 * @returns {{ captured: false } | { captured: true, outputDir: string, distDir: unknown, tsconfigPath: unknown, cleanDistDir: unknown, consistent: boolean, missing: number, incomplete: number }}
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
  if (records.some((r) => !KINDS.has(r.kind))) return { captured: false };
  const who = (r) => `${r.pid}:${r.tid ?? 0}`;
  const starts = new Set(records.filter((r) => r.kind === 'start').map(who));
  const root = `${invocation.rootPid}:0`;
  if (!starts.has(root) || records.some((r) => !starts.has(who(r)))) return { captured: false };
  const call = (r) => `${who(r)}:${r.call}`;
  const begun = records.filter((r) => r.kind === 'config-begin').map(call);
  const configs = records.filter((r) => r.kind === 'config');
  const done = configs.map(call);
  const unique = (keys) => new Set(keys).size === keys.length;
  const begunSet = new Set(begun);
  if (!unique(begun) || !unique(done) || done.some((key) => !begunSet.has(key))) {
    return { captured: false };
  }
  if (!configs.some((r) => who(r) === root)) return { captured: false };
  const doneSet = new Set(done);
  const incomplete = begun.filter((key) => !doneSet.has(key)).length;
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
    incomplete,
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
  if (layout.incomplete !== 0) {
    problems.push(
      'next config: a build process loaded the configuration and never reported what it got; refusing',
    );
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

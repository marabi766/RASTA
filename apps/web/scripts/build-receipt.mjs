// A receipt the web build writes for ITSELF, so the check after the build reads the
// manifest of a build that succeeded, not whatever `.next` happens to hold.
//
// `pnpm build` is `node scripts/run-web-build.mjs` (build-run.mjs): it takes the package's
// build lock, deletes the previous receipt and the default output, runs `next build`, and only
// after `next build` exited 0 writes the receipt in the same invocation, still under the lock. The receipt names the build id, the SHA-256 of
// the manifest bytes it was written next to, and the layout the build itself reported (see
// build-layout.mjs), so the checker never has to evaluate the Next configuration.
//
// This guards against stale and mismatched artifacts. It is not a defence against someone
// who forges the three files on purpose, and it does not cover a `next build` run by hand.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildInProgress } from './build-lock.mjs';
import { layoutProblems } from './build-layout.mjs';

export const MANIFEST_FILE = '.next/server/server-reference-manifest.json';
export const BUILD_ID_FILE = '.next/BUILD_ID';
export const RECEIPT_FILE = '.next/server-action-build-receipt.json';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const defaultRead = (full) => {
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return readFileSync(full);
};

/**
 * The three files as bytes, each read ONCE. Everything after this (the hash, the parse, the
 * action list) works on these bytes, so nothing can be swapped between "checked" and "used".
 * @param {(fullPath: string) => Buffer | null} [read]  test seam: counts or swaps reads
 */
export function readSnapshot(webDir, read = defaultRead) {
  return {
    receipt: read(join(webDir, RECEIPT_FILE)),
    buildId: read(join(webDir, BUILD_ID_FILE)),
    manifest: read(join(webDir, MANIFEST_FILE)),
  };
}

/**
 * Receipt text for the build output in `webDir`, or the reasons there is none.
 * @param {{ distDir: unknown, tsconfigPath: unknown, cleanDistDir: unknown }} layout  what the build reported
 */
export function receiptFor(webDir, layout, snapshot = readSnapshot(webDir)) {
  const { buildId, manifest } = snapshot;
  const problems = [];
  if (buildId === null || buildId.toString('utf8').trim() === '') {
    problems.push(`${BUILD_ID_FILE}: missing or empty; the build did not finish`);
  }
  if (manifest === null) problems.push(`${MANIFEST_FILE}: missing`);
  if (problems.length > 0) return { problems };
  return {
    problems,
    text: `${JSON.stringify({
      version: 2,
      buildId: buildId.toString('utf8').trim(),
      manifestSha256: sha256(manifest),
      layout: {
        distDir: layout.distDir,
        tsconfigPath: layout.tsconfigPath,
        cleanDistDir: layout.cleanDistDir,
      },
    })}\n`,
  };
}

/**
 * Written by the build step after `next build` exits 0, while it still holds the build lock.
 * The receipt appears whole or not at all.
 */
export function writeReceipt(webDir, layout) {
  const made = receiptFor(webDir, layout);
  if (made.problems.length === 0) {
    const temp = join(webDir, `${RECEIPT_FILE}.tmp-${process.pid}`);
    writeFileSync(temp, made.text);
    renameSync(temp, join(webDir, RECEIPT_FILE));
  }
  return made.problems;
}

/** Why the bytes in `snapshot` cannot be trusted as one successful build; empty when they can. */
export function snapshotProblems(snapshot) {
  const raw = snapshot.receipt;
  if (raw === null) {
    return [
      `${RECEIPT_FILE}: missing; run the web build (\`pnpm build\` writes it after \`next build\`)`,
    ];
  }
  let receipt;
  try {
    receipt = JSON.parse(raw.toString('utf8'));
  } catch {
    return [`${RECEIPT_FILE}: not valid JSON`];
  }
  if (
    receipt === null ||
    typeof receipt !== 'object' ||
    receipt.version !== 2 ||
    typeof receipt.buildId !== 'string' ||
    typeof receipt.manifestSha256 !== 'string' ||
    receipt.layout === null ||
    typeof receipt.layout !== 'object'
  ) {
    return [`${RECEIPT_FILE}: unknown shape`];
  }
  const current = receiptFor(undefined, receipt.layout, snapshot);
  if (current.problems.length > 0) return current.problems;
  const now = JSON.parse(current.text);
  // The layout is the one the build recorded, not one derived here. A receipt exists only for
  // a complete, agreeing capture.
  const problems = layoutProblems({
    captured: true,
    consistent: true,
    missing: 0,
    incomplete: 0,
    ...receipt.layout,
  });
  if (receipt.buildId !== now.buildId) {
    problems.push(`${RECEIPT_FILE}: written by another build than ${BUILD_ID_FILE}`);
  }
  if (receipt.manifestSha256 !== now.manifestSha256) {
    problems.push(`${MANIFEST_FILE}: not the manifest the receipt was written for`);
  }
  return problems;
}

/** Same as `snapshotProblems` for the files currently on disk (one snapshot). */
export function receiptProblems(webDir) {
  return snapshotProblems(readSnapshot(webDir));
}

/**
 * What the checker uses: ONE snapshot of the artifacts, validated, and the very bytes it
 * validated as text. Refuses while a build owns the package (a build that started during
 * the read leaves a lock the second look sees).
 * @returns {{ problems: string[], manifestText?: string }}
 */
export function checkedSnapshot(webDir, io = {}) {
  const running = io.buildInProgress ?? buildInProgress;
  const busy = ['a build is running in this package (see its build lock); nothing was verified'];
  if (running(webDir)) return { problems: busy };
  const snapshot = readSnapshot(webDir, io.read);
  const problems = snapshotProblems(snapshot);
  if (running(webDir)) return { problems: busy };
  if (problems.length > 0) return { problems };
  return { problems, manifestText: snapshot.manifest.toString('utf8') };
}

// A receipt the web build writes for ITSELF, so the check after the build reads the
// manifest of a build that succeeded, not whatever `.next` happens to hold.
//
// `pnpm build` is `next build && node scripts/write-build-receipt.mjs`: the receipt exists
// only after `next build` exited 0. The build empties `.next` first (`cleanDistDir`, see
// build-layout.mjs), so a build that fails leaves no receipt, and a manifest or BUILD_ID
// from an earlier build cannot be paired with a newer receipt: the receipt names the build
// id and the SHA-256 of the manifest bytes it was written next to.
//
// This guards against stale and mismatched artifacts. It is not a defence against someone
// who forges the three files on purpose.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_FILE = '.next/server/server-reference-manifest.json';
export const BUILD_ID_FILE = '.next/BUILD_ID';
export const RECEIPT_FILE = '.next/server-action-build-receipt.json';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readFile(webDir, relative) {
  const full = join(webDir, relative);
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return readFileSync(full);
}

/** Receipt text for the build output in `webDir`, or the reasons there is none. */
export function receiptFor(webDir) {
  const buildId = readFile(webDir, BUILD_ID_FILE);
  const manifest = readFile(webDir, MANIFEST_FILE);
  const problems = [];
  if (buildId === null || buildId.toString('utf8').trim() === '') {
    problems.push(`${BUILD_ID_FILE}: missing or empty; the build did not finish`);
  }
  if (manifest === null) problems.push(`${MANIFEST_FILE}: missing`);
  if (problems.length > 0) return { problems };
  return {
    problems,
    text: `${JSON.stringify({
      version: 1,
      buildId: buildId.toString('utf8').trim(),
      manifestSha256: sha256(manifest),
    })}\n`,
  };
}

/** Written by the build step after `next build` exits 0. */
export function writeReceipt(webDir) {
  const made = receiptFor(webDir);
  if (made.problems.length === 0) writeFileSync(join(webDir, RECEIPT_FILE), made.text);
  return made.problems;
}

/** Why the artifacts cannot be trusted as one successful build; empty when they can. */
export function receiptProblems(webDir) {
  const raw = readFile(webDir, RECEIPT_FILE);
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
  const current = receiptFor(webDir);
  if (current.problems.length > 0) return current.problems;
  if (
    receipt === null ||
    typeof receipt !== 'object' ||
    receipt.version !== 1 ||
    typeof receipt.buildId !== 'string' ||
    typeof receipt.manifestSha256 !== 'string'
  ) {
    return [`${RECEIPT_FILE}: unknown shape`];
  }
  const now = JSON.parse(current.text);
  const problems = [];
  if (receipt.buildId !== now.buildId) {
    problems.push(`${RECEIPT_FILE}: written by another build than ${BUILD_ID_FILE}`);
  }
  if (receipt.manifestSha256 !== now.manifestSha256) {
    problems.push(`${MANIFEST_FILE}: not the manifest the receipt was written for`);
  }
  return problems;
}

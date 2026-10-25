// Ground-truth check of server-action refusal coverage, run after `next build`.
//
// The compiler is the authority: `next build` writes every server action it compiled to
// `.next/server/server-reference-manifest.json`. This script fails (exit 1) when that
// manifest names a (module, export) that `src/write-session-refusal.spec.ts` does not
// cover, and when the manifest cannot be trusted: Node too old to run this, no receipt of
// a successful build (or one that does not match BUILD_ID and the manifest, or whose
// recorded layout is not the default `.next` one), the manifest missing, unparseable,
// empty, an entry of an unknown shape, an export name that is not a plain identifier, a
// file that is gone or outside the repository.
//
// It proves refusal coverage of server actions only. It says nothing about money,
// tenancy or replay. It never prints the manifest (it holds `encryptionKey`).
//
// Needs Node >= 22.18 (runs the shared TypeScript modules by type stripping). The Node
// guard below runs BEFORE any `.ts` is imported: the imports after it are dynamic.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { receiptProblems } from './build-receipt.mjs';
import { nodeRefusal } from './node-guard.mjs';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webDir, '../..');

function fail(lines) {
  console.error('server-action coverage: FAILED');
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

const refusal = nodeRefusal(process.versions.node);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

try {
  const [{ actionKey, coveredActions, discoverServerActions }, manifestModule, fs] =
    await Promise.all([
      import('../src/test/server-action-discovery.ts'),
      import('../src/test/server-action-manifest.ts'),
      import('node:fs'),
    ]);
  const { MANIFEST_PATH, compiledActions, nextProjectDir, uncovered } = manifestModule;

  // The layout is the one the build recorded in its receipt; the Next config is not evaluated here.
  const binding = receiptProblems(webDir);
  if (binding.length > 0) fail(binding);

  const { actions, problems } = compiledActions(
    fs.readFileSync(join(webDir, MANIFEST_PATH), 'utf8'),
    nextProjectDir(webDir),
    repoRoot,
  );
  if (problems.length > 0) fail(problems);

  const covered = coveredActions(discoverServerActions(repoRoot, webDir));
  const missing = uncovered(actions, covered);
  if (missing.length > 0) {
    fail([
      'compiled server actions without refusal cases in src/write-session-refusal.spec.ts:',
      ...missing.map((label) => `- ${label}`),
    ]);
  }
  const modules = new Set(actions.map((action) => action.module));
  const pairs = new Set(actions.map((a) => actionKey(a.module, a.exportedName)));
  console.log(
    `server-action coverage: ok, ${pairs.size} compiled actions in ${modules.size} modules, all covered`,
  );
} catch {
  // An unexpected failure is a failure. Its message is not shown: it can quote a file's
  // content (the manifest holds `encryptionKey`).
  fail(['unexpected failure while checking (details withheld); nothing was verified']);
}

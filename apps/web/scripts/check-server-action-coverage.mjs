// Ground-truth check of server-action refusal coverage, run after `next build`.
//
// The compiler is the authority: `next build` writes every server action it compiled to
// `.next/server/server-reference-manifest.json`. This script fails (exit 1) when that
// manifest names a (module, export) that `src/write-session-refusal.spec.ts` does not
// cover, and when the manifest cannot be trusted (missing, unparseable, empty, an
// entry of an unknown shape, a file that is gone or outside the repository).
//
// It proves refusal coverage of server actions only. It says nothing about money,
// tenancy or replay. It never prints the manifest (it holds `encryptionKey`).
//
// Needs Node >= 22.18 (runs the shared TypeScript modules by type stripping).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  actionKey,
  coveredActions,
  discoverServerActions,
} from '../src/test/server-action-discovery.ts';
import {
  MANIFEST_PATH,
  compiledActions,
  nextProjectDir,
  uncovered,
} from '../src/test/server-action-manifest.ts';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webDir, '../..');

function fail(lines) {
  console.error('server-action coverage: FAILED');
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

try {
  const manifestFile = join(webDir, MANIFEST_PATH);
  if (!existsSync(manifestFile) || !statSync(manifestFile).isFile()) {
    fail([
      `${MANIFEST_PATH}: missing, run the web build (a cache hit without .next is not a pass)`,
    ]);
  }
  const { actions, problems } = compiledActions(
    readFileSync(manifestFile, 'utf8'),
    nextProjectDir(webDir),
    repoRoot,
  );
  if (problems.length > 0) fail(problems);

  const covered = coveredActions(discoverServerActions(repoRoot, webDir));
  const missing = uncovered(actions, covered, actionKey);
  if (missing.length > 0) {
    fail([
      'compiled server actions without refusal cases in src/write-session-refusal.spec.ts:',
      ...missing.map((key) => `- ${key}`),
    ]);
  }
  const modules = new Set(actions.map((action) => action.module));
  console.log(
    `server-action coverage: ok, ${new Set(actions.map((a) => actionKey(a.module, a.exportedName))).size} compiled actions in ${modules.size} modules, all covered`,
  );
} catch (error) {
  // An unexpected failure is a failure; only its message (never the manifest) is shown.
  fail([`unexpected: ${error instanceof Error ? error.message : 'unknown error'}`]);
}

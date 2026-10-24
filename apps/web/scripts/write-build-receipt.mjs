// Runs right after `next build` exits 0 (`pnpm build`). Refuses (exit 1, failing the build)
// when the effective Next configuration is not the supported layout, and writes the
// receipt `check-server-action-coverage.mjs` requires. No TypeScript, so it runs on any
// Node the build runs on.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { effectiveBuildLayout, layoutProblems } from './build-layout.mjs';
import { writeReceipt } from './build-receipt.mjs';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = layoutProblems(await effectiveBuildLayout(webDir));
if (problems.length === 0) problems.push(...writeReceipt(webDir));
if (problems.length > 0) {
  console.error('build receipt: NOT written');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('build receipt: written');

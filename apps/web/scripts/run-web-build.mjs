// `pnpm build` entry (see build-run.mjs). No TypeScript, so it runs on any Node the build runs on.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWebBuild } from './build-run.mjs';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { status, problems } = await runWebBuild(webDir);
if (problems.length > 0) {
  console.error('build receipt: NOT written');
  for (const problem of problems) console.error(`  ${problem}`);
} else if (status === 0) {
  console.log('build receipt: written');
}
process.exit(status);

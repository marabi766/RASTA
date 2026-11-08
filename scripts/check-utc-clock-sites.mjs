// pnpm check:utc-clock-sites: fails when a database clock can reach a timestamp(3)
// column in the session's zone. See utc-clock-sites-lib.mjs.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utcClockProblems } from './utc-clock-sites-lib.mjs';

const problems = utcClockProblems(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('utc clock sites: no session-dependent clock reaches a timestamp(3) column\n');

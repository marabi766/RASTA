import { parseArgs } from 'node:util';
import { scopeFromRoot } from './prepush-scope-lib.mjs';

try {
  const { values } = parseArgs({ options: { base: { type: 'string', default: 'origin/main' } } });
  // This command is a plan, never a passing pre-push verdict.
  process.stdout.write(
    `${JSON.stringify({ mode: 'selection-only', ...scopeFromRoot(process.cwd(), values.base) }, null, 2)}\n`,
  );
} catch {
  process.stderr.write(
    'Prepush scope: selection refused; check the base, workspace and Turbo configuration.\n',
  );
  process.exitCode = 1;
}

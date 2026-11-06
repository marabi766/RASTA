import { parseArgs } from 'node:util';
import { PnpmInputRefusal, runParity } from './prepush-parity-lib.mjs';

try {
  const { values } = parseArgs({ options: { base: { type: 'string', default: 'origin/main' } } });
  runParity(process.cwd(), values.base);
} catch (error) {
  // A pnpm-input refusal names only fixed text and package.json keys; anything else stays generic.
  if (error instanceof PnpmInputRefusal) process.stderr.write(`${error.message}\n`);
  process.stderr.write(
    'Prepush parity: refused; inspect CI coverage, selection and local checks.\n',
  );
  process.exitCode = 1;
}

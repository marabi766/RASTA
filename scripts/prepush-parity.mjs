import { parseArgs } from 'node:util';
import { runParity } from './prepush-parity-lib.mjs';

try {
  const { values } = parseArgs({ options: { base: { type: 'string', default: 'origin/main' } } });
  runParity(process.cwd(), values.base);
} catch {
  process.stderr.write(
    'Prepush parity: refused; inspect CI coverage, selection and local checks.\n',
  );
  process.exitCode = 1;
}

// FU-093: rewrite scripts/prepush-parity.json's pnpmInputs from the current repository, using the
// same projection code as the check (pnpmInputPins in prepush-parity-lib.mjs). Run it only after
// reviewing the change it pins; it prints which pins moved. Nothing is written when the
// projection cannot be computed (a referenced script missing, malformed package.json, ...).
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { collectPnpmInputs, pnpmInputPins } from './prepush-parity-lib.mjs';

const root = new URL('../', import.meta.url).pathname;
const read = (file) => readFileSync(`${root}${file}`, 'utf8');
const path = `${root}scripts/prepush-parity.json`;

try {
  const manifest = JSON.parse(read('scripts/prepush-parity.json'));
  const workflow = read('.github/workflows/ci.yml');
  const pins = pnpmInputPins(workflow, collectPnpmInputs(workflow, read));
  const moved = isDeepStrictEqual(manifest.pnpmInputs, pins) ? 'none' : 'pnpmInputs';
  manifest.pnpmInputs = pins;
  const text = await format(JSON.stringify(manifest, null, 2), {
    ...(await resolveConfig(path)),
    filepath: path,
  });
  writeFileSync(path, text);
  process.stdout.write(`Prepush parity pins rewritten; changed: ${moved}\n`);
} catch (error) {
  process.stderr.write(
    `${error?.name === 'PnpmInputRefusal' ? error.message : 'Prepush parity repin: refused'}\n`,
  );
  process.exitCode = 1;
}

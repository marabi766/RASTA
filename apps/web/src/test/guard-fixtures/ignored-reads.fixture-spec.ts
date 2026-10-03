import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UNDECLARED } from './targets';

it('reads what the cache does not need to know about, and is not reported', () => {
  // This package, a dependency, package.json metadata, and a file elsewhere.
  fs.readFileSync(path.join(__dirname, 'targets.ts'));
  fs.readFileSync(require.resolve('zod/package.json'));
  fs.readFileSync(path.join(path.dirname(path.dirname(UNDECLARED)), 'package.json'));
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'x.txt');
  fs.writeFileSync(elsewhere, 'x');
  fs.readFileSync(elsewhere);
});

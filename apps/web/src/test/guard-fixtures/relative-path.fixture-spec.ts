import fs from 'node:fs';
import path from 'node:path';
import { UNDECLARED } from './targets';

it('reads by a path relative to the working directory', () => {
  fs.readFileSync(path.relative(process.cwd(), UNDECLARED));
});

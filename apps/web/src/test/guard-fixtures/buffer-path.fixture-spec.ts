import fs from 'node:fs';
import { UNDECLARED } from './targets';

it('reads by a path given as a Buffer', () => {
  fs.readFileSync(Buffer.from(UNDECLARED));
});

import fs from 'node:fs';
import { UNDECLARED } from './targets';

it('reads', () => {
  fs.readFileSync(UNDECLARED);
});

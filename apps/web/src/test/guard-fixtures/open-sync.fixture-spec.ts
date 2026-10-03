import fs from 'node:fs';
import { UNDECLARED } from './targets';

it('opens', () => {
  fs.closeSync(fs.openSync(UNDECLARED, 'r'));
});

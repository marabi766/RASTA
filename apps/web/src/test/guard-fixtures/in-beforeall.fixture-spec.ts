import fs from 'node:fs';
import { UNDECLARED } from './targets';

beforeAll(() => {
  fs.readFileSync(UNDECLARED);
});

it('runs', () => undefined);

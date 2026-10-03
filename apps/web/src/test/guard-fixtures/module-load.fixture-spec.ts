import fs from 'node:fs';
import { UNDECLARED } from './targets';

// Read while the spec's own module loads, before any hook runs.
fs.readFileSync(UNDECLARED);

it('runs', () => undefined);

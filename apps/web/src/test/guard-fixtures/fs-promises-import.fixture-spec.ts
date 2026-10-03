import { UNDECLARED } from './targets';

import { readFile } from 'node:fs/promises';

it('reads', async () => {
  await readFile(UNDECLARED);
});

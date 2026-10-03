import fs from 'node:fs';
import { UNDECLARED } from './targets';

it('reads', async () => {
  await fs.promises.readFile(UNDECLARED);
});

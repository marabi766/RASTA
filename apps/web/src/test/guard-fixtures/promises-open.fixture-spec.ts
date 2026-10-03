import fs from 'node:fs';
import { UNDECLARED } from './targets';

it('opens', async () => {
  const handle = await fs.promises.open(UNDECLARED, 'r');
  await handle.close();
});

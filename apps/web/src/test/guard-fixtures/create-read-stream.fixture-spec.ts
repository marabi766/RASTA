import fs from 'node:fs';
import { UNDECLARED } from './targets';

it('reads', async () => {
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(UNDECLARED);
    stream.on('error', reject);
    stream.on('close', () => resolve());
    stream.resume();
  });
});

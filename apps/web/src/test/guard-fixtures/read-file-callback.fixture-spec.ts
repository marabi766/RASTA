import fs from 'node:fs';
import { UNDECLARED } from './targets';

it('reads', async () => {
  await new Promise<void>((resolve, reject) =>
    fs.readFile(UNDECLARED, (error) => (error ? reject(error) : resolve())),
  );
});

import fs from 'node:fs';
import { UNDECLARED } from './targets';

it('opens', async () => {
  await new Promise<void>((resolve, reject) =>
    fs.open(UNDECLARED, 'r', (error, fd) => {
      if (error) return reject(error);
      fs.close(fd, () => resolve());
    }),
  );
});

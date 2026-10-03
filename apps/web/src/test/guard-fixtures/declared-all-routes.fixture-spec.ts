import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { DECLARED } from './targets';

it('reads a declared file by every route, and is not reported', async () => {
  fs.readFileSync(DECLARED);
  fs.readFileSync(path.relative(process.cwd(), DECLARED));
  fs.readFileSync(pathToFileURL(DECLARED));
  fs.readFileSync(Buffer.from(DECLARED));
  fs.closeSync(fs.openSync(DECLARED, 'r'));
  await fs.promises.readFile(DECLARED);
  await readFile(DECLARED);
  await new Promise<void>((resolve, reject) =>
    fs.readFile(DECLARED, (error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(DECLARED);
    stream.on('error', reject);
    stream.on('close', () => resolve());
    stream.resume();
  });
  const handle = await fs.promises.open(DECLARED, 'r');
  await handle.close();
});

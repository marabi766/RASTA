import fs from 'node:fs';
import path from 'node:path';
import { UNDECLARED } from './targets';

it('reads by a path with .. segments', () => {
  const target = path.relative(path.dirname(UNDECLARED), UNDECLARED);
  fs.readFileSync(
    `${path.dirname(UNDECLARED)}/../${path.basename(path.dirname(UNDECLARED))}/${target}`,
  );
});

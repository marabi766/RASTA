import fs from 'node:fs';
import { UNDECLARED } from './targets';

import { pathToFileURL } from 'node:url';

it('reads by a file: URL', () => {
  fs.readFileSync(pathToFileURL(UNDECLARED));
});

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authoredFiles } = require('../../../../scripts/authored-source-inventory.cjs') as {
  authoredFiles: (dir: string) => string[];
};

/**
 * The class closed in code as in the database (FU-268): no source of this service takes an
 * advisory lock itself. Each goes through `lockReadCommitted`, so through the schema's READ
 * COMMITTED gate, and a lock added later anywhere under `src/` fails here, unlisted.
 */
const SRC = join(__dirname, '..');

describe('every advisory lock of economic-service is taken through the READ COMMITTED gate', () => {
  it('no authored source names an advisory lock function', () => {
    const offenders = authoredFiles(SRC)
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'))
      .filter((path) => /pg_(try_)?advisory_/i.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it('reads the sources the locks live in (the scan is not empty)', () => {
    const files = authoredFiles(SRC).map((path) => relative(SRC, path));
    expect(files).toEqual(
      expect.arrayContaining([
        join('reward', 'configuration-lock.ts'),
        join('reward', 'participation.service.ts'),
        join('prisma', 'read-committed-lock.ts'),
      ]),
    );
  });
});

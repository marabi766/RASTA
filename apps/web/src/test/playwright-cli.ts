import path from 'node:path';

/** CLI location only: specs get assertion functions through the guarded harnesses. */
export const PLAYWRIGHT_CLI = path.join(
  path.dirname(require.resolve('@playwright/test/package.json')),
  'cli.js',
);

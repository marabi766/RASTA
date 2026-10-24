import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** Supported atomic file runner; the test URL stays in env, never subprocess argv. */
export function applyMigration(url: string, schema: string, file: string): void {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { psqlFileRunner } from './scripts/verify-migration-reversible-lib.mjs';
      const result = psqlFileRunner(process.env.ANALYTICS_TEST_OWNER_URL, process.argv[1])(process.argv[2]);
      if (!result.ok) { process.stderr.write(result.output); process.exit(1); }
    `,
      schema,
      file,
    ],
    {
      encoding: 'utf8',
      cwd: join(__dirname, '..', '..', '..'),
      env: { ...process.env, ANALYTICS_TEST_OWNER_URL: url },
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Migration file failed: ${result.error?.message ?? result.stderr}`);
  }
}

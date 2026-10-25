import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [workspace, filename] of [
  ['services/api-gateway', 'src/transport-fixture.ts'],
  ['packages/nest-common', 'src/transport-fixture.ts'],
  ['services/api-gateway', 'dev/transport-fixture.ts'],
  ['services/economic-service', 'prisma/seed.ts'],
  ['tests/e2e', 'src/transport-fixture.ts'],
]) {
  test(`real workspace ESLint rejects an internal sender in ${workspace}/${filename}`, () => {
    const result = spawnSync(
      process.execPath,
      [
        `${root}node_modules/eslint/bin/eslint.js`,
        '--stdin',
        '--stdin-filename',
        filename,
        '--format',
        'json',
      ],
      {
        cwd: `${root}${workspace}`,
        input:
          "export const unsafe = (url: string, token: string) => fetch(url, { headers: { 'x-internal-token': token } });",
        encoding: 'utf8',
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const [{ messages }] = JSON.parse(result.stdout);
    assert.ok(
      messages.some(({ ruleId, severity }) => ruleId === 'internal/transport' && severity === 2),
      result.stdout,
    );
  });
}

test('the E2E hand-guard exemption is explicit and limited to src/http.ts', () => {
  for (const [filename, expected] of [
    ['src/http.ts', 0],
    ['src/actor.ts', 2],
  ]) {
    const result = spawnSync(
      process.execPath,
      [`${root}node_modules/eslint/bin/eslint.js`, '--print-config', filename],
      { cwd: `${root}tests/e2e`, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).rules['internal/transport'][0], expected);
  }
});

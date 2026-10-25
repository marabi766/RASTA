import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import transport from './internal-token-transport-rule.mjs';

const linter = new Linter();
const check = (code) =>
  linter.verify(code, [
    {
      plugins: { internal: { rules: { transport } } },
      rules: { 'internal/transport': 'error' },
    },
  ]);
for (const call of [
  'fetch(url, { headers })',
  'this.fetchImpl(url, { headers })',
  'fetchImpl(url, { headers })',
  'request(url, { headers })',
  'axios(url, { headers })',
  'alias(url, { headers })',
]) {
  test(`rejects unprotected internal call: ${call}`, () => {
    assert.ok(
      check(`const headers = { 'x-internal-token': token }; const alias = fetch; ${call};`).length,
    );
  });
}
for (const library of ['axios', 'undici', 'node:http', 'node:https', 'http', 'https']) {
  test(`rejects alternate raw transport: ${library}`, () => {
    assert.ok(
      check(
        `import transport from '${library}'; const headers = { 'X-Internal-Token': token }; transport(url, { headers });`,
      ).length,
    );
  });
}
test('allows the enforced transport with separately constructed headers', () => {
  assert.deepEqual(
    check(
      "const headers = { 'x-internal-token': token }; internalFetch(url, { headers }, this.fetchImpl);",
    ),
    [],
  );
});
test('leaves unauthenticated fetches alone', () => {
  assert.deepEqual(check('fetch(url);'), []);
});

for (const code of [
  'const transport = globalThis.fetch; transport(url, { headers });',
  'const transport = options.fetch ?? fetch; transport(url, { headers });',
  'class Client { send() { this.transport(url, { headers }); } constructor() { this.transport = options.fetch ?? fetch; } }',
  "globalThis['fetch'](url, { headers });",
]) {
  test(`rejects a raw transport alias: ${code}`, () => {
    assert.ok(check(`const headers = { 'x-internal-token': token }; ${code}`).length);
  });
}

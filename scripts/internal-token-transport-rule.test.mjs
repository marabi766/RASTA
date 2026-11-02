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

// Q-155: every credential kind, not only the internal token, needs the redirect-refusing transport.
const CREDENTIALS = {
  'bearer authorization': 'const headers = { authorization: `Bearer ${token}` };',
  'quoted Authorization key': "const headers = { 'Authorization': value };",
  'Basic header value': 'const headers = new Headers(); headers.set(name, `Basic ${pair}`);',
  'Headers.set authorization':
    "const headers = new Headers(); headers.set('Authorization', value);",
  'proxy-authorization': "const headers = { 'proxy-authorization': value };",
  cookie: 'const headers = { cookie: session };',
  'x-api-key': "const headers = { 'x-api-key': key };",
  apiKey: 'const headers = { apiKey: key };',
  'client_secret form': 'const body = new URLSearchParams({ client_secret: secret });',
  'client_assertion form':
    "const body = new URLSearchParams(); body.append('client_assertion', jwt);",
  'refresh_token form': 'const body = new URLSearchParams({ refresh_token: token });',
  'code_verifier form': 'const body = new URLSearchParams({ code_verifier: verifier });',
  'access_token form': "const body = new URLSearchParams([['access_token', token]]);",
  'subject_token form': 'const body = new URLSearchParams({ subject_token: token });',
  'password form': 'const body = new URLSearchParams({ password });',
};
for (const [kind, setup] of Object.entries(CREDENTIALS)) {
  for (const call of ['fetch(url, { headers, body })', 'fetchImpl(url, { headers, body })']) {
    test(`rejects a raw sender of ${kind}: ${call}`, () => {
      const messages = check(`${setup} ${call};`);
      assert.equal(messages.length, 1, JSON.stringify(messages));
      assert.equal(messages[0].ruleId, 'internal/transport');
    });
  }
  test(`rejects an alternate raw transport for ${kind}`, () => {
    assert.ok(
      check(`import { request } from 'undici'; ${setup} request(url, { headers });`).length,
    );
  });
  for (const call of [
    'credentialFetch(url, { headers, body }, fetchImpl)',
    'internalFetch(url, { headers, body }, this.fetchImpl)',
  ]) {
    test(`allows ${kind} through the redirect-refusing transport: ${call}`, () => {
      assert.deepEqual(check(`${setup} ${call};`), []);
    });
  }
}
for (const code of [
  // A credential name only in a comment, or as part of a longer word, is not a credential.
  '// authorization: Bearer x\nfetch(url);',
  "const label = 'password strength'; fetch(url);",
  "const query = 'access_token=LEAK'; fetch(url);",
  'const authorizationPolicy = load(); fetch(url);',
]) {
  test(`leaves a module without a credential alone: ${JSON.stringify(code)}`, () => {
    assert.deepEqual(check(code), []);
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [workspace, filename] of [
  ['services/api-gateway', 'src/transport-fixture.ts'],
  ['packages/nest-common', 'src/transport-fixture.ts'],
  ['services/api-gateway', 'dev/transport-fixture.ts'],
  ['services/economic-service', 'prisma/seed.ts'],
  ['tests/e2e', 'src/transport-fixture.ts'],
  ['apps/web', 'src/server/transport-fixture.ts'],
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

// Q-155: the real workspace configs — the services' shared one and the portal's own — reject a
// raw sender of every credential kind and accept the same request through the transport.
const SENDERS = {
  bearer: 'const headers = { authorization: `Bearer ${token}` };',
  cookie: "const headers = { 'Cookie': session };",
  'API key': "const headers = { 'x-api-key': key };",
  'Basic auth': 'const headers = { Authorization: `Basic ${pair}` };',
  'client secret form': 'const body = new URLSearchParams({ client_secret: secret });',
  'refresh token form': 'const body = new URLSearchParams({ refresh_token: token });',
  'code verifier form': 'const body = new URLSearchParams({ code_verifier: verifier });',
  'password form': "const body = new URLSearchParams(); body.append('password', password);",
};
const WORKSPACES = [
  ['services/identity-service', 'src/credential-fixture.ts', 'internalFetch'],
  ['services/api-gateway', 'dev/credential-fixture.ts', 'internalFetch'],
  ['packages/nest-common', 'src/credential-fixture.ts', 'internalFetch'],
  ['tests/e2e', 'src/credential-fixture.ts', 'internalFetch'],
  ['apps/web', 'src/server/credential-fixture.ts', 'credentialFetch'],
  ['apps/web', 'src/app/credential-fixture/page.tsx', 'credentialFetch'],
  ['.', 'scripts/credential-fixture.mjs', 'credentialFetch'],
];

/** The fixture module: a declared (TypeScript) or imported (script) transport, then one send. */
function fixture(filePath, transport, setup, call) {
  const prelude = filePath.endsWith('.mjs')
    ? `import { ${transport} } from './credential-fetch.mjs';\nlet token, session, key, pair, secret, verifier, password, url, fetchImpl;\n`
    : 'declare const token: string, session: string, key: string, pair: string, secret: string;\n' +
      'declare const verifier: string, password: string, url: string, fetchImpl: typeof fetch;\n' +
      `declare const ${transport}: (u: string, i: object, f?: typeof fetch) => Promise<Response>;\n`;
  return `${prelude}${setup}\nexport const send = () => ${call}(url, { headers, body }, fetchImpl);\n`;
}

/**
 * Lints `sources` with the workspace's real flat config, in a child process per workspace:
 * typescript-eslint keeps tsconfig-root state per process, so two workspaces cannot share one.
 * Returns, per source, the transport rule's findings and any parse failure (which would hide them).
 */
function lintInWorkspace(workspace, filePath, sources) {
  const script = `
    import { createRequire } from 'node:module';
    // The repository's eslint, as the CLI resolves it from any workspace.
    const { ESLint } = createRequire(process.env.ROOT_PACKAGE)('eslint');
    const eslint = new ESLint({ cwd: process.cwd() });
    const out = [];
    for (const text of JSON.parse(process.env.SOURCES)) {
      const [result] = await eslint.lintText(text, { filePath: process.env.FILE_PATH });
      out.push(result.messages
        .filter(({ ruleId, fatal }) => ruleId === 'internal/transport' || fatal)
        .map(({ ruleId, severity, message }) => ({ ruleId, severity, message })));
    }
    process.stdout.write(JSON.stringify(out));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: `${root}${workspace}`,
    encoding: 'utf8',
    env: {
      ...process.env,
      ROOT_PACKAGE: `${root}package.json`,
      SOURCES: JSON.stringify(sources),
      FILE_PATH: filePath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const [workspace, filePath, transport] of WORKSPACES) {
  test(`real ${workspace} ESLint: every credential kind needs ${transport} (${filePath})`, () => {
    // Each sender defines `headers` or `body`; the other is defined empty.
    const kinds = Object.entries(SENDERS).map(([kind, credential]) => [
      kind,
      `${credential}\nconst ${credential.includes('const body') ? 'headers = {}' : "body = ''"};`,
    ]);
    const findings = lintInWorkspace(
      workspace,
      filePath,
      kinds.flatMap(([, setup]) => [
        fixture(filePath, transport, setup, 'fetch'),
        fixture(filePath, transport, setup, transport),
      ]),
    );
    kinds.forEach(([kind], index) => {
      const [raw, safe] = [findings[2 * index], findings[2 * index + 1]];
      assert.deepEqual(
        raw.map(({ ruleId, severity }) => [ruleId, severity]),
        [['internal/transport', 2]],
        `${kind}, raw fetch: ${JSON.stringify(raw)}`,
      );
      assert.deepEqual(safe, [], `${kind}, through ${transport}: ${JSON.stringify(safe)}`);
    });
  });
}

const ruleIn = (workspace, filename, rule = 'internal/transport') => {
  const result = spawnSync(
    process.execPath,
    [`${root}node_modules/eslint/bin/eslint.js`, '--print-config', filename],
    { cwd: `${root}${workspace}`, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).rules?.[rule]?.[0];
};

test('the portal enforces the rule on production source, not on specs or test helpers', () => {
  for (const file of ['src/server/gateway.ts', 'src/server/oidc.ts', 'src/app/page.tsx'])
    assert.equal(ruleIn('apps/web', file), 2, file);
  for (const file of ['src/server/gateway.spec.ts', 'src/test/setup.ts'])
    assert.equal(ruleIn('apps/web', file), undefined, file);
});

test('the Keycloak exemption is one file and expires when that file uses internalFetch', () => {
  const exempt = 'src/keycloak/keycloak.client.ts';
  assert.equal(ruleIn('services/identity-service', 'src/identity/identity.service.ts'), 2);
  assert.equal(ruleIn('services/identity-service', 'src/keycloak/other.ts'), 2);
  const migrated = /\binternalFetch\b/.test(
    readFileSync(`${root}services/identity-service/${exempt}`, 'utf8'),
  );
  // Until PR #483 lands the client sends raw; once it uses internalFetch, delete the exemption.
  assert.equal(ruleIn('services/identity-service', exempt), migrated ? 2 : 0);
  // The transport boundary is suspended by the same block, for the same file, until the same day.
  assert.equal(ruleIn('services/identity-service', exempt, 'internal/raw-http'), migrated ? 2 : 0);
  assert.equal(
    ruleIn('services/identity-service', 'src/keycloak/other.ts', 'internal/raw-http'),
    2,
  );
});

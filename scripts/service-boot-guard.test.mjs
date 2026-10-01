// -----------------------------------------------------------------------------
// Every service refuses to start when its environment holds a database owner's
// credential (D-045, Codex review of #176).
//
//   pnpm test:boot-guard        (after `pnpm build`: it runs each dist/main.js)
//
// Two halves. The source half reads every services/*/src/main.ts and requires
// that it calls assertNoMigratorCredentials(process.env) before it loads its
// environment — and imports it above that call: the services compile to
// CommonJS, which keeps statement order, so an import placed lower would still
// be undefined when the call runs. The live half starts each service's built
// dist/main.js — what the container image runs — with an owner URL or password
// in its environment and nothing else, and requires it to exit naming the
// variable, never its value, before anything else can fail.
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = readdirSync(join(ROOT, 'services'))
  .filter((name) => existsSync(join(ROOT, 'services', name, 'src', 'main.ts')))
  .sort();

test('every service with an entry point is covered', () => {
  assert.ok(SERVICES.length >= 13, SERVICES.join(', '));
  assert.ok(SERVICES.includes('construction-service'));
  assert.ok(SERVICES.includes('api-gateway'));
});

for (const service of SERVICES) {
  test(`${service}: main.ts refuses an owner credential before it loads its environment`, () => {
    const lines = readFileSync(join(ROOT, 'services', service, 'src', 'main.ts'), 'utf8').split(
      '\n',
    );
    const at = (pattern) => lines.findIndex((line) => pattern.test(line));
    const imported = at(/^import \{ assertNoMigratorCredentials \} from '@rasta\/config';$/);
    const called = at(/^assertNoMigratorCredentials\(process\.env\);$/);
    const loaded = at(/^const env = load\w+Env\(/);
    assert.ok(imported >= 0, 'does not import assertNoMigratorCredentials from @rasta/config');
    assert.ok(called >= 0, 'never calls assertNoMigratorCredentials(process.env) at top level');
    assert.ok(loaded >= 0, 'no `const env = load…Env(` line to order against');
    assert.ok(imported < called, 'the import sits below the call');
    assert.ok(called < loaded, 'the environment is loaded before the guard runs');
  });

  test(`${service}: the built service exits on an owner credential, naming it and never its value`, () => {
    const main = join(ROOT, 'services', service, 'dist', 'main.js');
    assert.ok(existsSync(main), `${main} is missing — run \`pnpm build\` first`);
    for (const variable of ['DATABASE_URL_ECONOMIC_MIGRATOR', 'POSTGRES_PASSWORD_AUDIT_MIGRATOR']) {
      const value = 'postgresql://rasta_x_migrator:owner_secret_value@127.0.0.1:1/rasta_x';
      const result = spawnSync(process.execPath, [main], {
        cwd: join(ROOT, 'services', service),
        // Nothing else: were the guard not first, the service would fail on
        // its missing configuration instead, with a different message.
        env: { PATH: process.env.PATH, NODE_ENV: 'development', [variable]: value },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.notEqual(result.status, 0, `${variable}: the service did not refuse`);
      const output = result.stdout + result.stderr;
      assert.match(output, /MigratorCredentialInServiceError/, output.slice(0, 2000));
      assert.match(output, new RegExp(variable));
      assert.ok(!output.includes('owner_secret_value'), `${variable}: the value was printed`);
    }
  });
}

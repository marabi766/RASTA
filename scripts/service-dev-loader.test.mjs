// -----------------------------------------------------------------------------
// Every service's `pnpm dev` loads its TypeScript as CommonJS.
//
//   pnpm test:dev-loader
//
// The services are CommonJS: no "type" in their package.json, `module:
// commonjs` in tsconfig, a CommonJS dist. `dev` used to run them through
// `node --import @swc-node/register/esm-register`, which compiles the entry
// file as an ES module but hands a relative `./app.module` back to Node as
// CommonJS with no source of its own — Node then reads the untransformed
// TypeScript, finds no CommonJS exports in it, and refuses at link time:
//
//   SyntaxError: The requested module './app.module' does not provide an
//   export named 'AppModule'
//
// in every service, before a line of it ran. `node -r @swc-node/register`
// (what the CLIs and seeds already use) compiles every file to CommonJS.
//
// The live half runs each service's own dev loader flags — read from its
// package.json, minus --watch and --env-file — from the service directory (so
// swc-node reads that service's tsconfig) on a two-file TypeScript entry that
// imports a named class from a sibling, the shape of main.ts and app.module.ts.
// The static half requires the client to be generated first in every service
// with a Prisma schema: main.ts imports './generated/prisma', which a fresh
// checkout does not have.
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = readdirSync(join(ROOT, 'services'))
  .filter((name) => existsSync(join(ROOT, 'services', name, 'src', 'main.ts')))
  .sort();

const devScript = (service) =>
  JSON.parse(readFileSync(join(ROOT, 'services', service, 'package.json'), 'utf8')).scripts?.dev;

/** The node flags of a dev script that decide how modules load. */
function loaderFlags(script) {
  const command = /(?:^|&& )node (.*) src\/main\.ts$/.exec(script);
  assert.ok(command, `dev does not run \`node … src/main.ts\`: ${script}`);
  return command[1].split(/\s+/).filter((flag) => flag !== '--watch' && !/^--env-file/.test(flag));
}

test('every service with an entry point is covered', () => {
  assert.ok(SERVICES.length >= 15, SERVICES.join(', '));
  assert.ok(SERVICES.includes('fleet-service'));
  assert.ok(SERVICES.includes('api-gateway'));
});

test('the flags are read the way the dev scripts write them', () => {
  assert.deepEqual(
    loaderFlags(
      'prisma generate && node -r @swc-node/register --watch --env-file=../../.env src/main.ts',
    ),
    ['-r', '@swc-node/register'],
  );
  assert.throws(() => loaderFlags('nest start --watch'));
});

for (const service of SERVICES) {
  test(`${service}: dev links a named export from a sibling TypeScript module`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rasta-dev-loader-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{ "name": "dev-loader-fixture" }\n');
      writeFileSync(
        join(dir, 'app.module.ts'),
        "export class AppModule {\n  readonly name: string = 'linked';\n}\n",
      );
      writeFileSync(
        join(dir, 'main.ts'),
        "import { AppModule } from './app.module';\n\nconsole.log(new AppModule().name);\n",
      );
      const result = spawnSync(
        process.execPath,
        [...loaderFlags(devScript(service)), join(dir, 'main.ts')],
        {
          cwd: join(ROOT, 'services', service),
          env: { PATH: process.env.PATH },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      assert.equal(result.status, 0, (result.stdout + result.stderr).slice(0, 2000));
      assert.equal(result.stdout.trim(), 'linked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  if (existsSync(join(ROOT, 'services', service, 'prisma', 'schema.prisma'))) {
    test(`${service}: dev generates the Prisma client before it starts`, () => {
      assert.match(devScript(service), /^prisma generate && node /);
    });
  }
}

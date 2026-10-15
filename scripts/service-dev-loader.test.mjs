// -----------------------------------------------------------------------------
// Every service's `pnpm dev` loads its TypeScript as CommonJS, and starts
// telemetry before the application graph.
//
//   pnpm test:dev-loader        (after `pnpm build`: the order half loads main.ts)
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
// The order (Codex on #281): swc keeps ES import semantics and hoists every
// import in main.ts above its body, so `./app.module` — kafkajs, pg and http
// behind it — loaded before main.ts's initTelemetry() and was never
// instrumented. tsc keeps statement order, so the built service was right and
// `dev` was not. `dev` now preloads dev/telemetry.ts, main.ts's prologue.
//
// Four halves, all from each service's own dev script: its node flags — minus
// --watch and --env-file — from the service directory, so swc-node reads that
// service's tsconfig, in the environment .env.example documents.
//   - Linking: a two-file TypeScript entry that imports a named class from a
//     sibling, the shape of main.ts and app.module.ts.
//   - Order: the real src/main.ts behind a probe that stops the process the
//     moment `./app.module` is about to load — nothing of the application runs
//     — and reports whether the OpenTelemetry SDK had started by then.
//   - The preload's statements equal main.ts's prologue, so the two cannot
//     configure telemetry differently (the first call wins).
//   - The client is generated first in every service with a Prisma schema:
//     main.ts imports './generated/prisma', which a fresh checkout lacks.
// -----------------------------------------------------------------------------
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

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

/**
 * The documented development environment, with traces on and nothing sent:
 * spans go to the console (none ends before the probe exits), metrics and logs
 * nowhere. Nothing else from this machine.
 */
const DEV_ENV = (() => {
  const env = {
    ...parseEnv(readFileSync(join(ROOT, '.env.example'), 'utf8')),
    PATH: process.env.PATH,
    OTEL_TRACES_ENABLED: 'true',
    OTEL_TRACES_EXPORTER: 'console',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
  };
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return env;
})();

/**
 * Preloaded first. When `src/app.module.ts` is about to load, prints whether
 * the OpenTelemetry SDK has started — its tracer provider is @opentelemetry/
 * api's global, and its instrumentations have hooked require() (they patch a
 * module like kafkajs when it is required) — then exits before loading it. If
 * main.ts finishes without loading it, says so and exits all the same.
 */
const PROBE = `
const Module = require('node:module');
const { writeSync } = require('node:fs');
const { join } = require('node:path');
const appModule = join(process.cwd(), 'src', 'app.module.ts');
const plainRequire = Module.prototype.require;
const report = (outcome) => {
  writeSync(1, JSON.stringify(outcome) + '\\n');
  process.exit(0);
};
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (isMain) {
    load.apply(this, arguments);
    report({ appModuleLoaded: false });
  }
  let filename;
  try {
    filename = Module._resolveFilename(request, parent, isMain);
  } catch {}
  if (filename === appModule) {
    const api = globalThis[Symbol.for('opentelemetry.js.api.1')];
    report({
      appModuleLoaded: true,
      tracerProvider: Boolean(api && api.trace),
      requireHooked: Module.prototype.require !== plainRequire,
    });
  }
  return load.apply(this, arguments);
};
`;

let probeDir;
before(() => {
  probeDir = mkdtempSync(join(tmpdir(), 'rasta-dev-order-'));
  writeFileSync(join(probeDir, 'probe.cjs'), PROBE);
});
after(() => rmSync(probeDir, { recursive: true, force: true }));

/** main.ts's statements from the D-045 guard to the end of initTelemetry({…}). */
function prologue(source) {
  const start = source.indexOf('assertNoMigratorCredentials(process.env);\n');
  const init = source.indexOf('\ninitTelemetry({\n', start);
  const end = source.indexOf('\n});\n', init);
  assert.ok(start >= 0 && init > start && end > init, 'no guard → env → initTelemetry prologue');
  return source
    .slice(start, end + 4)
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
    .join('\n');
}

test('every service with an entry point is covered', () => {
  assert.ok(SERVICES.length >= 15, SERVICES.join(', '));
  assert.ok(SERVICES.includes('fleet-service'));
  assert.ok(SERVICES.includes('api-gateway'));
});

test('the flags are read the way the dev scripts write them', () => {
  assert.deepEqual(
    loaderFlags(
      'prisma generate && node -r @swc-node/register -r ./dev/telemetry.ts --watch --env-file=../../.env src/main.ts',
    ),
    ['-r', '@swc-node/register', '-r', './dev/telemetry.ts'],
  );
  assert.throws(() => loaderFlags('nest start --watch'));
});

for (const service of SERVICES) {
  const cwd = join(ROOT, 'services', service);

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
        { cwd, env: DEV_ENV, encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(result.status, 0, (result.stdout + result.stderr).slice(0, 2000));
      assert.equal(result.stdout.trim(), 'linked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${service}: dev starts telemetry before main.ts loads the application`, () => {
    const result = spawnSync(
      process.execPath,
      ['-r', join(probeDir, 'probe.cjs'), ...loaderFlags(devScript(service)), 'src/main.ts'],
      { cwd, env: DEV_ENV, encoding: 'utf8', timeout: 60_000 },
    );
    const output = (result.stdout + result.stderr).slice(0, 2000);
    assert.equal(result.status, 0, output);
    const line = result.stdout.split('\n').find((text) => text.startsWith('{"appModuleLoaded"'));
    assert.ok(line, output);
    assert.deepEqual(JSON.parse(line), {
      appModuleLoaded: true,
      tracerProvider: true,
      requireHooked: true,
    });
  });

  test(`${service}: the dev preload runs main.ts's own prologue`, () => {
    assert.ok(loaderFlags(devScript(service)).includes('./dev/telemetry.ts'));
    assert.equal(
      prologue(readFileSync(join(cwd, 'dev', 'telemetry.ts'), 'utf8')),
      prologue(readFileSync(join(cwd, 'src', 'main.ts'), 'utf8')),
    );
  });

  if (existsSync(join(cwd, 'prisma', 'schema.prisma'))) {
    test(`${service}: dev generates the Prisma client before it starts`, () => {
      assert.match(devScript(service), /^prisma generate && node /);
    });
  }
}

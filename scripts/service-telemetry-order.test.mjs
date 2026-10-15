// -----------------------------------------------------------------------------
// Every built service traces Kafka: by the time its application graph has
// loaded, the OpenTelemetry kafkajs instrumentation has wrapped kafkajs.
//
//   pnpm test:telemetry-order        (after `pnpm build`: it runs each dist/main.js)
//
// The instrumentation patches kafkajs (Kafka.prototype.producer and .consumer)
// when kafkajs is required after initTelemetry() has hooked require(). main.ts
// loads its environment before initTelemetry(), so whatever config/env imports
// loads first; audit-service's env read its consumer group from audit.mapper,
// which reached @rasta/nest-common and kafkajs, and nothing in audit-service
// requires kafkajs again later. Its Kafka consumers ran untraced, in the built
// service too (found by worker1 on #281).
//
// The probe is preloaded before dist/main.js — what the container image runs —
// in the environment .env.example documents, traces on and nothing sent. The
// moment dist/app.module.js has loaded it reports every loaded kafkajs copy and
// whether its Kafka.prototype.producer and .consumer are wrapped, then exits:
// bootstrap() never runs, nothing connects.
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

/**
 * The documented environment, with traces on and nothing sent: spans go to the
 * console (none ends before the probe exits), metrics and logs nowhere.
 */
const ENV = (() => {
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

const PROBE = `
const Module = require('node:module');
const { writeSync } = require('node:fs');
const { join } = require('node:path');
const appModule = join(process.cwd(), 'dist', 'app.module.js');
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
  const exports = load.apply(this, arguments);
  if (filename === appModule) {
    report({
      appModuleLoaded: true,
      kafkajs: Object.keys(require.cache)
        .filter((file) => /[\\\\/]kafkajs[\\\\/]index\\.js$/.test(file))
        .map((file) => {
          const kafka = require.cache[file].exports?.Kafka?.prototype;
          return {
            producer: Boolean(kafka?.producer?.__wrapped),
            consumer: Boolean(kafka?.consumer?.__wrapped),
          };
        }),
    });
  }
  return exports;
};
`;

let probeDir;
before(() => {
  probeDir = mkdtempSync(join(tmpdir(), 'rasta-telemetry-order-'));
  writeFileSync(join(probeDir, 'probe.cjs'), PROBE);
});
after(() => rmSync(probeDir, { recursive: true, force: true }));

test('every service with an entry point is covered', () => {
  assert.ok(SERVICES.length >= 15, SERVICES.join(', '));
  assert.ok(SERVICES.includes('audit-service'));
  assert.ok(SERVICES.includes('api-gateway'));
});

for (const service of SERVICES) {
  test(`${service}: kafkajs is instrumented once the application graph has loaded`, () => {
    const cwd = join(ROOT, 'services', service);
    assert.ok(existsSync(join(cwd, 'dist', 'main.js')), 'no dist/main.js — run `pnpm build`');
    const run = spawnSync(process.execPath, ['-r', join(probeDir, 'probe.cjs'), 'dist/main.js'], {
      cwd,
      env: ENV,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const line = run.stdout.split('\n').find((text) => text.startsWith('{"appModuleLoaded"'));
    assert.ok(line, `no report (exit ${run.status}): ${run.stderr.slice(-2000)}`);
    const outcome = JSON.parse(line);
    assert.equal(outcome.appModuleLoaded, true, 'dist/main.js never loaded dist/app.module.js');
    assert.ok(outcome.kafkajs.length > 0, 'kafkajs is not loaded by the application graph');
    for (const copy of outcome.kafkajs) {
      assert.deepEqual(
        copy,
        { producer: true, consumer: true },
        'kafkajs loaded before initTelemetry() hooked require(), and was never patched',
      );
    }
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandFailure } from '../packages/config/src/command-failure.js';
import { SENTINELS, assertNoSentinel } from './refusal-probes.mjs';

const root = resolve(import.meta.dirname, '..');
const reporters = [
  ['asset', 'insurance/reproject', 2],
  ['asset', 'insurance/drain-check', 2],
  ['asset', 'outbox/flush', 2],
  ['fleet', 'fleet/clear-transferred', 2],
  ['fleet', 'fleet/drain-check', 2],
  ['identity', 'keycloak/projection', 2],
  ['economic', 'transaction/resolved-dispute-backfill', 1],
];

// Real built entry points and their main/finally/exit decisions, with external
// work replaced at module boundaries. Mark each reached fault so an earlier
// environment/import refusal cannot make a disclosure regression pass.
const hook = `
const Module = require('node:module');
const load = Module._load;
const failure = () => Object.assign(new Error('${SENTINELS.join(' ')}'), {
  code: 'P2002', errorCode: '${SENTINELS[0]}', name: '${SENTINELS[1]}',
  cause: { input: '${SENTINELS[0]}' }, toString() { throw new Error('${SENTINELS[1]}'); },
});
const fault = phase => {
  if (process.env.PROBE_PHASE.split(',').includes(phase)) {
    process.stdout.write('reached:' + phase + '\\n');
    throw failure();
  }
};
const report = { drained: process.env.PROBE_DRAINED !== 'false', unpublished: 1,
  scanned: 0, emitted: 0, alreadyEmitted: 0, notCounting: 0,
  cleared: 0, invalidated: 0, skipped: 0, published: 0, accounts: 0,
  fences: { outstanding: 0 } };
class PrismaService {
  constructor() { this.client = {}; }
  async onModuleInit() { fault('connect'); }
  async onModuleDestroy() { fault('cleanup'); }
}
class Empty {}
class Relay extends Empty {
  async tick() { return 0; }
  async stop() { fault('cleanup'); }
}
const command = async () => { fault('command'); return report; };
const commandExports = {
  reprojectInsurance: command, clearTransferredInsurance: command,
  checkOutboxDrained: command, checkConsumerGroupDrained: command,
  flushOutbox: command, runProjectionCommand: command,
  backfillResolvedDisputes: command, backfillExitCode: () => 0,
  parseResolvedDisputeBackfillArgs: () => ({}),
  isClean: () => true, PROJECTION_COMMAND_POOLS: {}, RECOVERY_STOP_MS: 1000,
  tearDownProjectionCommand: async () => { fault('cleanup');
    return { recoveriesUnwinding: 0, transactionsUnsettled: 0, poolsAbandoned: 0 }; },
  INSURANCE_EVENT_TOPICS: [],
};
Module._load = function(id, ...args) {
  if (id === '@rasta/config') return load.call(this, id, ...args);
  if (id === '@rasta/logging') return { createLogger: () => ({ info() {}, error() {} }) };
  if (id === '@rasta/nest-common') return {
    preflightRuntimeRole: async () => fault('preflight'), OutboxRelay: Relay,
    kafkaConnection: () => ({}), kafkaClientConfig: () => ({}),
  };
  if (id === 'kafkajs') return { Kafka: class { admin() { return {
    connect: async () => fault('preflight'), disconnect: async () => fault('cleanup'),
  }; } } };
  if (id.endsWith('/config/env')) return {
    SERVICE_NAME: 'probe', ASSET_SYNC_TOPICS: [], loadAssetEnv: env,
    loadFleetEnv: env, loadIdentityEnv: env, loadEconomicEnv: env,
  };
  if (id.endsWith('/generated/prisma')) return { PrismaClient: Empty };
  if (id.endsWith('/prisma/prisma.service')) return { PrismaService };
  if (id.endsWith('.command') || id === './resolved-dispute-backfill') return commandExports;
  if (id.endsWith('.args')) return { parseReprojectArgs: () => ({}), parseClearTransferredArgs: () => ({}) };
  if (id.endsWith('.repository')) return { AssetRepository: Empty, FleetRepository: Empty, IdentityRepository: Empty };
  if (id === './keycloak.client') return { KeycloakAdminClient: Empty };
  if (id === './keycloak.projector') return { KeycloakProjector: Empty };
  if (id === './keycloak-write-fence') return { KeycloakWriteFences: Empty };
  if (id === './kafka.publisher') return { KafkaEventPublisher: class { async stop() {} } };
  if (id === './outbox.store') return { PrismaOutboxStore: Empty };
  return load.call(this, id, ...args);
};
function env() { return { DATABASE_URL: 'unused', KEYCLOAK_SYNC_ENABLED: true }; }
`;

function run(entry, phase, drained = true) {
  const dir = mkdtempSync(join(tmpdir(), 'command-disclosure-'));
  try {
    const preload = join(dir, 'hook.cjs');
    writeFileSync(preload, hook);
    const result = spawnSync(
      process.execPath,
      ['--require', preload, entry, ...(entry.includes('projection.cli') ? ['reconcile'] : [])],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, PROBE_PHASE: phase, PROBE_DRAINED: String(drained) },
      },
    );
    assert.equal(result.error, undefined);
    return { ...result, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [service, command, exit] of reporters) {
  for (const phase of ['preflight', 'command', 'cleanup']) {
    test(`${service}/${command}: ${phase} withholds whole foreign failure, exit ${exit}`, () => {
      const entry = `services/${service}-service/dist/${command}.cli.js`;
      const result = run(entry, phase);
      assert.equal(result.status, exit, result.output);
      assert.match(result.output, new RegExp(`reached:${phase}`));
      assert.match(
        result.stderr,
        /command failed \(code unknown\); diagnostics withheld; prior work may have committed/,
      );
      assertNoSentinel(result.output);
    });
  }
}

for (const service of ['asset', 'fleet']) {
  for (const drained of [false, true]) {
    test(`${service} drain-check: ${drained ? 'drained 0' : 'undrained 1'}`, () => {
      const command = service === 'asset' ? 'insurance' : 'fleet';
      const entry = `services/${service}-service/dist/${command}/drain-check.cli.js`;
      const result = run(entry, 'none', drained);
      assert.equal(result.status, drained ? 0 : 1, result.output);
      assert.match(result.stdout, new RegExp(`"drained":${drained}`));
    });
  }
}

test('closed sanitizer never coerces failures, unknown codes or unreadable getters', () => {
  for (const error of [
    SENTINELS.join(' '),
    new Error(SENTINELS[0]),
    {
      code: SENTINELS[0],
      toString() {
        throw new Error('coerced');
      },
    },
    {
      get code() {
        throw new Error(SENTINELS[1]);
      },
    },
    null,
  ]) {
    assert.equal(commandFailure(error), commandFailure(null));
    assertNoSentinel(commandFailure(error));
  }
  assert.match(commandFailure({ code: 'P1000', message: SENTINELS[0] }), /code P1000/);
});

// ESM hooks replace database I/O, keeping both real B2 CLI loops and summaries.
const b2Hook = `
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  if (url.endsWith('/outbox-b2-lib.mjs') && process.env.PROBE_PHASE === 'cleanup') {
    const result = next(url, context);
    return { ...result, source: String(result.source).replace('export async function runServiceBackfill', 'async function unusedBackfill') +
      \`\nexport async function runServiceBackfill({ service, emit }) {
        emit({ type: 'done', service, converged: true });
        return { applied: false, verified: { remaining: 0 }, batches: [] };
      }\` };
  }
  if (!url.endsWith('/outbox-b2-prisma-port.mjs')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: \`
    function fault(phase, service) {
      if (service === 'document' && process.env.PROBE_PHASE.split(',').includes(phase)) {
        process.stderr.write('reached:' + phase + '\\\\n');
        throw Object.assign(new Error('${SENTINELS.join(' ')}'), {
          code: 'P1000', input: '${SENTINELS[0]}', cause: new Error('${SENTINELS[1]}'),
        });
      }
    }
    export function prismaPort(service) {
      fault('construct', service);
      let n = 0;
      return {
        preflight: async () => fault('connect', service),
        query: async sql => {
          fault('connect', service);
          if (sql.includes('vacuum_count')) return [{ role: 'owner', qualified: 'public.outbox_message',
            may_vacuum: true, vacuum_count: ++n, analyze_count: n }];
          // Backfill B1 refusal happens only after the first real port query.
          return [];
        },
        execute: async () => undefined,
        close: async () => { process.stderr.write('closed:' + service + '\\\\n'); fault('cleanup', service); },
      };
    }
  \` };
} });
`;
for (const script of ['outbox-b2-backfill.mjs', 'outbox-b2-vacuum.mjs']) {
  for (const phase of ['construct', 'connect', 'cleanup', 'connect,cleanup']) {
    test(`${script}: ${phase} is sanitized, later services and summary survive, exit 1`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'b2-disclosure-'));
      try {
        const preload = join(dir, 'hook.mjs');
        writeFileSync(preload, b2Hook);
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith('DATABASE_URL') && !key.endsWith('_MIGRATOR'),
          ),
        );
        const suffix = script.includes('vacuum') ? '_MIGRATOR' : '';
        Object.assign(env, {
          NODE_ENV: 'test',
          PROBE_PHASE: phase,
          [`DATABASE_URL_DOCUMENT${suffix}`]: 'postgresql://rasta_document:x@localhost/document',
          [`DATABASE_URL_ECONOMIC${suffix}`]: 'postgresql://rasta_economic:x@localhost/economic',
        });
        const result = spawnSync(
          process.execPath,
          [
            '--import',
            preload,
            `scripts/${script}`,
            '--service',
            'document',
            '--service',
            'economic',
          ],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 15_000,
            env,
          },
        );
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        for (const reached of phase.split(','))
          assert.match(result.stderr, new RegExp(`reached:${reached}`));
        if (phase !== 'construct') assert.match(result.stderr, /closed:document/);
        assert.match(result.stderr, /closed:economic/);
        assertNoSentinel(result.stdout + result.stderr);
        const events = result.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const refused = events.filter(
          (event) => event.type === 'refused' && event.service === 'document',
        );
        assert.ok(refused.length > 0);
        if (phase.includes('cleanup')) assert.equal(refused.at(-1).phase, 'cleanup');
        assert.match(refused.at(-1).reason, /command failed \(code P1000\); diagnostics withheld/);
        const summary = events.at(-1);
        assert.equal(summary.type, 'summary');
        assert.equal(summary.services, 2);
        assert.equal(summary.refused, script.includes('vacuum') || phase === 'cleanup' ? 1 : 2);
        if (script.includes('backfill') && phase === 'cleanup') assert.equal(summary.ok, 1);
        if (script.includes('vacuum')) assert.equal(summary.verified, 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('Temporal unexpected exception discards stack, own properties and cause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temporal-stack-'));
  try {
    const preload = join(dir, 'hook.mjs');
    writeFileSync(
      preload,
      `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      cp.spawnSync = () => { process.stderr.write('reached:spawn\\n');
        throw Object.assign(new Error('${SENTINELS.join(' ')}'), { cause: '${SENTINELS[0]}' }); };
      syncBuiltinESMExports();
    `,
    );
    const result = spawnSync(
      process.execPath,
      ['--import', preload, 'scripts/marketplace-saga-drain-check.mjs'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          TEMPORAL_ADDRESS: 'unused',
          TEMPORAL_NAMESPACE: 'unused',
          MARKETPLACE_TEMPORAL_TASK_QUEUE: 'unused',
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /reached:spawn/);
    assert.match(result.stderr, /command failed \(code unknown\); diagnostics withheld/);
    assertNoSentinel(result.stdout + result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every setting of a service's own configuration reaches it through every
// turbo task that starts it (Codex r2 on #304).
//
// The trap of scripts/outbox-purge-turbo-env.test.mjs (D-052) and
// scripts/construction-turbo-env.test.mjs (#271), for every service at once:
// `pnpm dev` is `turbo run dev`, and turbo withholds from the child every
// variable the task does not declare. The service reads the root .env itself
// (`node --env-file`, where the shell's value wins), so a withheld setting
// still arrives from .env — only the operator's override is lost, silently.
// asset-service's claim-document policy (Q-128) arrived that way:
// `INSURANCE_CLAIM_MAX_DOCUMENTS=1 pnpm dev` ran on the .env limit of 20, and
// `INSURANCE_CLAIM_MAX_DOCUMENTS=0 pnpm dev` never met the boot refusal.
//
// The settings checked are the keys of each service's `.extend({ ... })` in
// src/config/env.ts, read from its source, so a new setting is held to the
// rule at once. The shared schemas it merges are held by their own tests
// (databaseEnvSchema: database-turbo-env, outboxPurgeEnvSchema:
// outbox-purge-turbo-env).
//
// Most services' own settings were withheld long before this check. Those are
// listed in service-env-turbo-withheld.json, exactly: a setting withheld and
// not listed fails (declare it in turbo.json), and a listed one turbo now
// passes fails too (delete the entry), so the list only shrinks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, allows, readJson, taskPatterns, turbo } from './turbo-env-lib.mjs';

const BASELINE_FILE = 'scripts/service-env-turbo-withheld.json';

/**
 * Turbo tasks whose command builds a service's configuration from its process
 * environment: `dev` runs `src/main.ts`, the integration suites (`test`,
 * `test:integration`, identity's `test:aggregation-stress`) build the
 * application from `process.env`. `start` is not a turbo task, and `test:e2e`
 * starts no service (CI starts each one directly, outside turbo).
 */
const TASKS_STARTING_A_SERVICE = ['dev', 'test', 'test:integration', 'test:aggregation-stress'];

/** The two settings Codex r2 on #304 found withheld. */
const CLAIM_DOCUMENT_SETTINGS = [
  'INSURANCE_CLAIM_MAX_DOCUMENTS',
  'INSURANCE_CLAIM_DOCUMENT_STATUSES',
];

/** Every service with a configuration: its directory name, package and env.ts source. */
function services() {
  const found = [];
  for (const entry of readdirSync(join(ROOT, 'services'), { withFileTypes: true })) {
    const dir = join(ROOT, 'services', entry.name);
    const envFile = join(dir, 'src', 'config', 'env.ts');
    if (!entry.isDirectory() || !existsSync(envFile)) continue;
    found.push({
      service: entry.name,
      dir,
      manifest: readJson(join(dir, 'package.json')),
      source: readFileSync(envFile, 'utf8'),
    });
  }
  return found;
}

/** The keys of the service's own `.extend({ ... })` block, read from its source. */
function ownSettings({ service, source }) {
  const schema = source.match(/^export const \w+EnvSchema = baseEnvSchema$/m);
  assert.ok(schema, `${service} env.ts no longer defines <name>EnvSchema = baseEnvSchema`);
  const start = source.indexOf('\n  .extend({\n', schema.index);
  assert.ok(start >= 0, `${service} env.ts: no .extend({ after the schema`);
  const end = source.indexOf('\n  })', start);
  const block = source.slice(start, end);
  // A spread would hide its keys from the reading below.
  assert.doesNotMatch(block, /^ {4}\.\.\./m, `${service} env.ts spreads into .extend; read it`);
  return [...new Set([...block.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]))];
}

/** Every withheld (service, task, setting), as `service task SETTING`. */
function withheldSettings() {
  const found = [];
  let checked = 0;
  for (const svc of services()) {
    assert.ok(
      !existsSync(join(svc.dir, 'turbo.json')),
      `${svc.manifest.name} has its own turbo.json; extend this test to read it`,
    );
    const settings = ownSettings(svc);
    for (const task of TASKS_STARTING_A_SERVICE) {
      if (!svc.manifest.scripts?.[task]) continue;
      assert.ok(turbo.tasks[task], `turbo.json has no "${task}" task`);
      checked += 1;
      const patterns = taskPatterns(task);
      for (const name of settings) {
        if (!allows(patterns, name)) found.push(`${svc.service} ${task} ${name}`);
      }
    }
  }
  assert.ok(checked >= 15 * 2, `only ${checked} service tasks checked: the check ran on nothing`);
  return found;
}

/** The listed withholdings, flattened as `service task SETTING`. */
function baseline() {
  const listed = readJson(join(ROOT, BASELINE_FILE));
  const entries = [];
  for (const [service, settings] of Object.entries(listed)) {
    if (service.startsWith('$')) continue;
    for (const [name, tasks] of Object.entries(settings)) {
      for (const task of tasks) entries.push(`${service} ${task} ${name}`);
    }
  }
  return entries;
}

/** The variables turbo's plan for `<package>#<task>` configures, given `env` (a dry run). */
function planConfigures(args, taskId, env) {
  const run = spawnSync('pnpm', [...args, '--dry=json'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(run.error, undefined, `pnpm did not start: ${run.error}`);
  assert.equal(run.status, 0, `turbo dry run failed:\n${run.stdout}\n${run.stderr}`);
  // `pnpm run` echoes the script line first; the plan is the JSON after it.
  const plan = JSON.parse(run.stdout.slice(run.stdout.search(/^\{/m)));
  const task = plan.tasks.find((t) => t.taskId === taskId);
  assert.ok(task, `no ${taskId} in the plan`);
  return new Set(
    task.environmentVariables.configured.map((entry) => entry.slice(0, entry.indexOf('='))),
  );
}

test('each service’s settings are read from its own schema', () => {
  const all = services();
  assert.ok(all.length >= 15, `only ${all.length} services with a configuration`);
  const read = new Map(all.map((svc) => [svc.service, ownSettings(svc)]));
  for (const [service, names] of read) assert.ok(names.length > 0, `${service}: no settings read`);
  // It keeps finding the ones it was written for, and some it did not cause.
  for (const name of [...CLAIM_DOCUMENT_SETTINGS, 'INSURANCE_CLAIM_DECISION_ROLES']) {
    assert.ok(read.get('asset-service').includes(name), `${name} not read from asset-service`);
  }
  assert.ok(read.get('construction-service').includes('CONSTRUCTION_TRANSACTION_TIMEOUT_MS'));
  assert.ok(read.get('api-gateway').includes('GATEWAY_TENDER_OPEN_TIMEOUT_MS'));
  // A loader's injected values (SERVICE_NAME, PORT) are not settings of the schema.
  assert.ok(!read.get('asset-service').includes('SERVICE_NAME'));
});

test('no task that starts a service withholds a setting of its schema beyond the listed ones', () => {
  const listed = new Set(baseline());
  const unlisted = withheldSettings().filter((entry) => !listed.has(entry));
  assert.deepEqual(
    unlisted,
    [],
    'declare each of these in turbo.json for that task (the list of old ones only shrinks)',
  );
});

test('the list of withheld settings holds only what turbo still withholds', () => {
  const withheld = new Set(withheldSettings());
  const stale = baseline().filter((entry) => !withheld.has(entry));
  assert.deepEqual(stale, [], `turbo passes these now: delete them from ${BASELINE_FILE}`);
});

test('every task that starts asset-service allows its claim-document settings', () => {
  const asset = services().find((svc) => svc.service === 'asset-service');
  assert.match(asset.manifest.scripts?.dev ?? '', /src\/main\.ts/, 'asset-service dev');
  const problems = [];
  let checked = 0;
  for (const task of TASKS_STARTING_A_SERVICE) {
    if (!asset.manifest.scripts?.[task]) continue;
    checked += 1;
    for (const name of CLAIM_DOCUMENT_SETTINGS) {
      if (!allows(taskPatterns(task), name))
        problems.push(`turbo.json "${task}" withholds ${name}`);
    }
  }
  assert.ok(checked >= 3, 'dev, test and test:integration not all checked');
  assert.deepEqual(problems, []);
  const listed = baseline().filter((entry) => entry.startsWith('asset-service '));
  for (const name of CLAIM_DOCUMENT_SETTINGS) {
    assert.ok(!listed.some((entry) => entry.endsWith(` ${name}`)), `${name} is listed as withheld`);
  }
});

test('the root commands resolve the claim-document settings for asset-service (turbo dry run)', () => {
  // Values the service refuses at boot, as in the finding: only turbo's
  // resolution is under test, and a dry run starts nothing.
  const env = {
    INSURANCE_CLAIM_MAX_DOCUMENTS: '0',
    INSURANCE_CLAIM_DOCUMENT_STATUSES: 'NOT_A_STATUS',
  };
  const filter = '--filter=@rasta/asset-service';
  for (const [args, taskId] of [
    [['run', 'dev', filter], '@rasta/asset-service#dev'],
    [['exec', 'turbo', 'run', 'test', filter], '@rasta/asset-service#test'],
    [['exec', 'turbo', 'run', 'test:integration', filter], '@rasta/asset-service#test:integration'],
  ]) {
    const configured = planConfigures(args, taskId, env);
    for (const name of CLAIM_DOCUMENT_SETTINGS) {
      assert.ok(configured.has(name), `turbo withholds ${name} from ${taskId}`);
    }
  }
});

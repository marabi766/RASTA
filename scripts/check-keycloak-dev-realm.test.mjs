import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_PLACEHOLDER, validateDevRealmGate } from './check-keycloak-dev-realm-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const GATE = resolve(root, 'infrastructure/docker/keycloak/dev-realm-gate.sh');
const REALM = resolve(root, 'infrastructure/docker/keycloak/rasta-realm.json');
const CLI = resolve(here, 'check-keycloak-dev-realm.mjs');

const gateText = readFileSync(GATE, 'utf8');
const realm = (enabled) => JSON.stringify({ realm: 'rasta', enabled });
const valid = (overrides = {}) => ({
  realmText: realm(GATE_PLACEHOLDER),
  gateScriptText: gateText,
  launchers: [
    {
      name: 'docker-compose.yml',
      text: "command: ['/opt/keycloak/data/import/dev-realm-gate.sh', 'start-dev', '--import-realm']",
    },
  ],
  ...overrides,
});

// ---- the checker ------------------------------------------------------------

test('the repository as committed passes', () => {
  const result = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gated/);
});

test('the committed realm carries the placeholder, not a literal true', () => {
  assert.equal(JSON.parse(readFileSync(REALM, 'utf8')).enabled, GATE_PLACEHOLDER);
});

test('a valid input has no problems', () => {
  assert.deepEqual(validateDevRealmGate(valid()), []);
});

for (const enabled of [true, 'true', false, '${RASTA_DEV_REALM_GATE:true}']) {
  test(`refuses a realm whose enabled is ${JSON.stringify(enabled)}`, () => {
    // A literal, or a placeholder with a default, imports without the gate.
    const errors = validateDevRealmGate(valid({ realmText: realm(enabled) }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"enabled"/);
  });
}

test('refuses a launcher that imports the realm directly', () => {
  const errors = validateDevRealmGate(
    valid({
      launchers: [{ name: 'ci.yml', text: 'x\n            start-dev --import-realm\n' }],
    }),
  );
  assert.deepEqual(errors, ['ci.yml:2 imports a realm without dev-realm-gate.sh']);
});

test('ignores a comment that mentions --import-realm', () => {
  const launchers = [{ name: 'ci.yml', text: '# the old start-dev --import-realm' }];
  assert.deepEqual(validateDevRealmGate(valid({ launchers })), []);
});

for (const [what, from, to] of [
  ['start-dev check', '"start-dev" ]]', '"start" ]]'],
  ['opt-in check', '"allow" ]]', '"yes" ]]'],
  ['gate export', 'export RASTA_DEV_REALM_GATE=true', 'true'],
]) {
  test(`refuses a gate script that lost its ${what}`, () => {
    const errors = validateDevRealmGate(valid({ gateScriptText: gateText.replace(from, to) }));
    assert.equal(errors.length, 1, errors.join('\n'));
  });
}

test('refuses a missing gate script', () => {
  assert.deepEqual(validateDevRealmGate(valid({ gateScriptText: '' })), [
    'dev-realm-gate.sh is missing',
  ]);
});

// ---- the gate script itself, run by bash with a stub Keycloak launcher -------

function runGate(args, env) {
  const dir = mkdtempSync(join(tmpdir(), 'dev-realm-gate-'));
  try {
    const launcher = join(dir, 'kc.sh');
    writeFileSync(
      launcher,
      '#!/bin/bash\necho "launched gate=${RASTA_DEV_REALM_GATE:-unset} args=$*"\n',
    );
    chmodSync(launcher, 0o755);
    return spawnSync('bash', [GATE, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, KEYCLOAK_LAUNCHER: launcher, ...env },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('gate: start-dev with the opt-in launches Keycloak with the realm opened', () => {
  const result = runGate(['start-dev', '--import-realm'], { RASTA_KEYCLOAK_DEV_REALM: 'allow' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'launched gate=true args=start-dev --import-realm');
});

test('gate: production mode is refused even with the opt-in', () => {
  const result = runGate(['start', '--import-realm'], { RASTA_KEYCLOAK_DEV_REALM: 'allow' });
  assert.equal(result.status, 64);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /not start-dev/);
});

for (const value of [undefined, '', 'true', 'ALLOW', 'yes']) {
  test(`gate: start-dev with RASTA_KEYCLOAK_DEV_REALM=${JSON.stringify(value)} is refused`, () => {
    const env = value === undefined ? {} : { RASTA_KEYCLOAK_DEV_REALM: value };
    const result = runGate(['start-dev', '--import-realm'], env);
    assert.equal(result.status, 64);
    assert.equal(result.stdout, '');
  });
}

test('gate: no command at all is refused', () => {
  const result = runGate([], { RASTA_KEYCLOAK_DEV_REALM: 'allow' });
  assert.equal(result.status, 64);
});

test('gate: a caller cannot pre-open the realm by setting the placeholder variable', () => {
  // The placeholder only matters to Keycloak; the gate still refuses first.
  const result = runGate(['start', '--import-realm'], {
    RASTA_KEYCLOAK_DEV_REALM: 'allow',
    RASTA_DEV_REALM_GATE: 'true',
  });
  assert.equal(result.status, 64);
});

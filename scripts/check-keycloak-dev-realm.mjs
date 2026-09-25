#!/usr/bin/env node
/**
 * Fails if the development Keycloak realm can be imported without its gate.
 *
 *   node scripts/check-keycloak-dev-realm.mjs
 *
 * Static: reads the realm, the gate script, docker-compose.yml and the CI
 * workflow as text; starts nothing. Runs in `pnpm verify` and CI. The
 * reasoning is in `check-keycloak-dev-realm-lib.mjs`. Never prints a value
 * from the realm.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDevRealmGate } from './check-keycloak-dev-realm-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => {
  try {
    return readFileSync(resolve(root, path), 'utf8');
  } catch {
    return '';
  }
};

const LAUNCHERS = ['docker-compose.yml', '.github/workflows/ci.yml'];

const errors = validateDevRealmGate({
  realmText: read('infrastructure/docker/keycloak/rasta-realm.json'),
  gateScriptText: read('infrastructure/docker/keycloak/dev-realm-gate.sh'),
  launchers: LAUNCHERS.map((name) => ({ name, text: read(name) })),
});

if (errors.length > 0) {
  console.error(
    `keycloak dev realm: ${errors.length} problem(s) — the realm could load outside dev.`,
  );
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(
  `keycloak dev realm: gated — placeholder in place, gate script intact, ${LAUNCHERS.length} launcher file(s) import only through it`,
);

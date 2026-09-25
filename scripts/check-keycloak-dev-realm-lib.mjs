/**
 * The contract that keeps the development Keycloak realm out of anything but a
 * disposable development or CI Keycloak (L1-05).
 *
 * `infrastructure/docker/keycloak/rasta-realm.json` enables the password grant
 * and seeds a SYSTEM_ADMIN with a password committed to this repository. Two
 * gates keep it contained, and this checker keeps the gates from being edited
 * away without anyone noticing:
 *
 *  1. The realm's `enabled` is the placeholder `${RASTA_DEV_REALM_GATE}`.
 *     Keycloak refuses to start when a boolean placeholder is unresolved, so
 *     the file cannot be imported by a path that does not set it.
 *  2. The only thing that sets it is `dev-realm-gate.sh`, which requires
 *     Keycloak's development mode (`start-dev`) and the explicit opt-in
 *     `RASTA_KEYCLOAK_DEV_REALM=allow`.
 *
 * So every place that imports the realm must go through the gate script, and
 * the script must still hold both checks. Pure: text in, problems out.
 */

export const GATE_PLACEHOLDER = '${RASTA_DEV_REALM_GATE}';
export const GATE_SCRIPT = 'dev-realm-gate.sh';

/** The checks `dev-realm-gate.sh` must keep, each as a fragment of its text. */
const GATE_SCRIPT_REQUIREMENTS = [
  ['refuses anything but start-dev', /\[\[\s*"\$\{1:-\}"\s*!=\s*"start-dev"\s*\]\]/],
  [
    'requires the explicit opt-in',
    /\[\[\s*"\$\{RASTA_KEYCLOAK_DEV_REALM:-\}"\s*!=\s*"allow"\s*\]\]/,
  ],
  ['opens the realm only after both checks', /export RASTA_DEV_REALM_GATE=true/],
  ['stops on the first failure', /set -euo pipefail/],
];

/**
 * @param {{ realmText: string, gateScriptText: string, launchers: Array<{ name: string, text: string }> }} input
 * @returns {string[]} problems; empty means the contract holds
 */
export function validateDevRealmGate({ realmText, gateScriptText, launchers }) {
  const errors = [];

  let realm;
  try {
    realm = JSON.parse(realmText);
  } catch {
    errors.push('rasta-realm.json is not valid JSON');
  }
  if (realm && realm.enabled !== GATE_PLACEHOLDER) {
    errors.push(
      `rasta-realm.json: "enabled" must be the string "${GATE_PLACEHOLDER}", so an ungated import fails; ` +
        `found ${JSON.stringify(realm.enabled)}`,
    );
  }

  if (typeof gateScriptText !== 'string' || gateScriptText.length === 0) {
    errors.push(`${GATE_SCRIPT} is missing`);
  } else {
    for (const [what, pattern] of GATE_SCRIPT_REQUIREMENTS) {
      if (!pattern.test(gateScriptText)) errors.push(`${GATE_SCRIPT} no longer ${what}`);
    }
  }

  for (const { name, text } of launchers) {
    text.split('\n').forEach((line, index) => {
      if (line.trimStart().startsWith('#')) return;
      if (line.includes('--import-realm') && !line.includes(GATE_SCRIPT)) {
        errors.push(`${name}:${index + 1} imports a realm without ${GATE_SCRIPT}`);
      }
    });
  }

  return errors;
}

/**
 * What `pnpm infra:up` checks before it starts the dev stack.
 *
 * The postgres image provisions roles only when its data volume is empty
 * (`infrastructure/docker/postgres/00-init-databases.sh`). Two mistakes are
 * therefore silent until something fails to log in much later:
 *
 *   - `POSTGRES_SERVICE_PASSWORD`, the one password every role shared before
 *     L7-33, is still set. On a fresh volume the bootstrap refuses it; on an
 *     existing volume nothing runs, and the roles keep that shared password
 *     while the connection strings name per-role ones. That is a **warning**,
 *     naming the non-destructive fix: `pnpm db:rotate-role-passwords`.
 *   - Two roles, or a role and the superuser, are given the same password.
 *     Separate roles are then a formality. That is an **error**: the bootstrap
 *     and the rotation command would both refuse it anyway, and refusing here
 *     is earlier.
 *
 * The role list is read from `lib/role-passwords.bash`, so this check and the
 * bootstrap cannot disagree about which roles exist. Messages name variables,
 * never values.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROLE_LIBRARY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'infrastructure/docker/postgres/lib/role-passwords.bash',
);

/**
 * `rasta_<service>` for every entry of `RASTA_SERVICES=( … )`, then the two
 * migrators (audit, supplier) — the order `rasta_roles` prints them in.
 */
export function rolesFromLibrary(text = readFileSync(ROLE_LIBRARY, 'utf8')) {
  const block = /^RASTA_SERVICES=\(([\s\S]*?)^\)/m.exec(text);
  if (!block) throw new Error('RASTA_SERVICES=( … ) not found in the role library');
  const services = block[1]
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
  return [
    ...services.map((service) => `rasta_${service}`),
    'rasta_audit_migrator',
    'rasta_supplier_migrator',
  ];
}

export const passwordVariable = (role) =>
  `POSTGRES_PASSWORD_${role.replace(/^rasta_/, '').toUpperCase()}`;

/** docker-compose.yml's defaults, used when a variable is unset or empty. */
const SUPERUSER_VARIABLE = 'POSTGRES_SUPERUSER_PASSWORD';
const SUPERUSER_DEFAULT = 'rasta_dev_password';
const LEGACY_VARIABLE = 'POSTGRES_SERVICE_PASSWORD';

/**
 * `env` is what compose will substitute: the `.env` file overlaid by the shell.
 * Returns `{ errors, warnings }`; neither ever contains a value.
 */
export function checkInfraEnv(env, roles = rolesFromLibrary()) {
  const errors = [];
  const warnings = [];
  const value = (name, fallback) => (env[name] ? String(env[name]) : fallback);

  if (env[LEGACY_VARIABLE]) {
    warnings.push(
      `${LEGACY_VARIABLE} is still set, and nothing reads it any more: every role has its own ` +
        'POSTGRES_PASSWORD_<ROLE>. Remove it. If your postgres volume was created while it was ' +
        'set, its roles still have that shared password: after `pnpm infra:up`, run ' +
        '`pnpm db:rotate-role-passwords` to apply the per-role ones. It keeps your data; ' +
        '`pnpm infra:reset` does not.',
    );
  }

  const superuser = value(SUPERUSER_VARIABLE, SUPERUSER_DEFAULT);
  const seen = new Map();
  for (const role of roles) {
    const variable = passwordVariable(role);
    const password = value(variable, `${role}_dev_password`);
    if (password === superuser) {
      errors.push(`${variable} equals ${SUPERUSER_VARIABLE}; every role needs its own password`);
    }
    if (seen.has(password)) {
      errors.push(`${variable} equals ${seen.get(password)}; every role needs its own password`);
    } else {
      seen.set(password, variable);
    }
  }
  return { errors, warnings };
}

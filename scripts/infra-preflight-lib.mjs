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
 * bootstrap cannot disagree about which roles exist.
 *
 * A third mistake is about Kafka, and is also silent: a `.env` copied before
 * the local broker started authenticating (#131, SASL/SCRAM over TLS) still
 * says PLAINTEXT. Compose's own defaults give the broker its credentials, so
 * the stack starts and the ACLs apply; it is every service and integration
 * suite loading `.env` that then cannot connect. That is a **warning** naming
 * what to copy from `.env.example` (`checkKafkaClientEnv`).
 *
 * Messages name variables, never values.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceStem } from './check-kafka-credential-scope-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ROLE_LIBRARY = resolve(ROOT, 'infrastructure/docker/postgres/lib/role-passwords.bash');

export const KAFKA_PRINCIPALS = resolve(
  ROOT,
  'infrastructure/docker/kafka/principals.development.txt',
);

/** The entries of a bash array `NAME=( … )` in the role library. */
function bashArray(text, name) {
  const block = new RegExp(`^${name}=\\(([\\s\\S]*?)^\\)`, 'm').exec(text);
  if (!block) throw new Error(`${name}=( … ) not found in the role library`);
  return block[1]
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

/** `RASTA_SERVICES`: every service with a database and a runtime role. */
export function servicesFromLibrary(text = readFileSync(ROLE_LIBRARY, 'utf8')) {
  return bashArray(text, 'RASTA_SERVICES');
}

/**
 * `PRIVILEGE_SPLIT_SERVICES` (D-045): services whose runtime role owns nothing
 * and whose `rasta_<svc>_migrator` owns the database.
 */
export function splitServicesFromLibrary(text = readFileSync(ROLE_LIBRARY, 'utf8')) {
  return bashArray(text, 'PRIVILEGE_SPLIT_SERVICES');
}

/**
 * `rasta_<service>` for every entry of `RASTA_SERVICES=( … )`, then audit's
 * migrator, then one migrator per `PRIVILEGE_SPLIT_SERVICES` entry — the order
 * `rasta_roles` prints them in.
 */
export function rolesFromLibrary(text = readFileSync(ROLE_LIBRARY, 'utf8')) {
  return [
    ...servicesFromLibrary(text).map((service) => `rasta_${service}`),
    'rasta_audit_migrator',
    ...splitServicesFromLibrary(text).map((service) => `rasta_${service}_migrator`),
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

/** The broker's service principals (`fleet-service`, …), each with a password in `.env`. */
export function kafkaServicesFromPrincipals(text = readFileSync(KAFKA_PRINCIPALS, 'utf8')) {
  return text.split('\n').filter((line) => line.endsWith('-service'));
}

/** How `@rasta/config` reads a boolean variable. */
const isOn = (value) => /^(true|1|yes|on)$/i.test(String(value ?? '').trim());
const isSet = (value) => String(value ?? '').trim() !== '';

/**
 * What a service loading this environment needs to reach the local broker,
 * which accepts only SASL/SCRAM over TLS with a certificate from its own CA.
 * `env` is `.env` overlaid by the shell, as a service sees it. Returns
 * warnings only: the stack itself starts either way. Never contains a value.
 */
export function checkKafkaClientEnv(env, services = kafkaServicesFromPrincipals()) {
  const missing = [];
  if (!isOn(env.KAFKA_SSL)) missing.push('KAFKA_SSL is not true');
  if (!isSet(env.KAFKA_SSL_CA_FILE)) missing.push('KAFKA_SSL_CA_FILE is unset');
  const unset = services
    .map((service) => `KAFKA_SASL_PASSWORD_${serviceStem(service)}`)
    .filter((variable) => !isSet(env[variable]));
  if (unset.length === services.length && unset.length > 0) {
    missing.push('no KAFKA_SASL_PASSWORD_<SERVICE> is set');
  } else if (unset.length > 0) {
    missing.push(`${unset.join(', ')} ${unset.length === 1 ? 'is' : 'are'} unset`);
  }

  const warnings = [];
  if (missing.length > 0) {
    warnings.push(
      '.env predates the authenticated local broker (#131): the stack starts, but every service ' +
        `and integration suite that loads .env will fail to reach Kafka: ${missing.join('; ')}. ` +
        'Copy the "Broker credentials" block of .env.example into .env — every ' +
        'KAFKA_SASL_PASSWORD_<SERVICE> line, KAFKA_SSL and KAFKA_SSL_CA_FILE — replacing the ' +
        'commented-out placeholders. Their values are development-only and must agree with the ' +
        "broker's, which compose takes from the same .env.",
    );
  }
  if (isOn(env.KAFKA_ALLOW_PLAINTEXT)) {
    warnings.push(
      'KAFKA_ALLOW_PLAINTEXT is on, and the local broker accepts no PLAINTEXT client. Delete it ' +
        'from .env (.env.example no longer sets it): with it, a service missing its credential ' +
        'tries PLAINTEXT and loses the connection instead of refusing at boot with a message ' +
        'naming the variable.',
    );
  }
  return warnings;
}

/**
 * A `.env` copied before D-045's env split still carries database owner
 * credentials (`*_MIGRATOR`). Every service loads `.env`, and every service now
 * refuses to start with one in its environment
 * (@rasta/config assertNoMigratorCredentials) — so say so here, by name only.
 * Compose no longer reads them from `.env` either: the postgres container takes
 * them from .env.migrator.example / .env.migrator.
 */
export function migratorCredentialsInEnvFile(fromEnvFile) {
  const names = Object.keys(fromEnvFile)
    .filter((name) => /^(?:DATABASE_URL|POSTGRES_PASSWORD)_[A-Z0-9_]+_MIGRATOR$/.test(name))
    .sort();
  if (names.length === 0) return [];
  return [
    `.env holds database owner credentials (${names.join(', ')}), and every service refuses to ` +
      'start with one in its environment (D-045). Move them to .env.migrator ' +
      '(see .env.migrator.example) and delete them from .env.',
  ];
}

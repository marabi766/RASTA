/**
 * A service process must never hold its database owner's credential (D-045,
 * Codex review of #176).
 *
 * Since D-045 each service connects as `rasta_<svc>`, which holds DML and owns
 * nothing, while `rasta_<svc>_migrator` owns the database and every object in
 * it — the role that can DISABLE a trigger, DROP a constraint or rewrite the
 * migration ledger. That split is a barrier only while the owner's credential
 * stays out of the service: a process that can read
 * `DATABASE_URL_<SVC>_MIGRATOR` (or `POSTGRES_PASSWORD_<SVC>_MIGRATOR`, from
 * which the URL is one string away) from its own environment can simply
 * connect as the owner.
 *
 * So the owner credentials live apart from what a service loads — in
 * `.env.migrator`, read by `scripts/prisma.mjs` and the integration suites,
 * never by a service's `start` or `dev` — and every service's `main.ts` calls
 * {@link assertNoMigratorCredentials} before it loads anything else, refusing
 * to start when one is present anyway. Supplier and audit additionally check
 * the role they actually connected as (`assertRuntimeRole`).
 *
 * Two layers (#421 r1 F2). By VALUE: any variable holding a `postgres://` or
 * `postgresql://` URL is refused unless it connects as one of the services'
 * runtime roles ({@link RUNTIME_DATABASE_ROLES}) — a migrator's, the
 * superuser's, a test harness's admin URL, whatever its name. A value that
 * names such a URL but cannot be read as one is refused too. By NAME: the
 * variables that carry an owner's, the superuser's or a test harness's
 * credential without a URL to read (a password). Either way the refusal names
 * variables only from a closed list, and counts the rest — never a value.
 *
 * A configuration check, not business logic (AGENTS.md A-03).
 */
import { tryReadUrl } from './url-reader';

/**
 * The environment variables that carry a privileged database credential by
 * name: an owner's or admin's URL, a migrator's password, a test harness's
 * superuser URL (`TEST_ANALYTICS_ADMIN_URL`), the bootstrap's superuser
 * password (`POSTGRES_SUPERUSER_PASSWORD`, the postgres image's
 * `POSTGRES_PASSWORD`) and libpq's `PGPASSWORD`. No service reads any of them.
 */
export const MIGRATOR_CREDENTIAL_PATTERN =
  /^(?:DATABASE_URL_(?:[A-Z0-9_]+_)?(?:ADMIN|TEST_ADMIN|MIGRATOR|SUPERUSER|OWNER|DBA|ROOT)|POSTGRES_PASSWORD_[A-Z0-9_]+_MIGRATOR|TEST_(?:[A-Z0-9_]+_)?ADMIN_URL|POSTGRES_SUPERUSER_PASSWORD|POSTGRES_PASSWORD|PGPASSWORD)$/;

/** The URL suffixes {@link MIGRATOR_CREDENTIAL_PATTERN} refuses by name. */
const PRIVILEGED_URL_SUFFIXES = ['ADMIN', 'TEST_ADMIN', 'SUPERUSER', 'OWNER', 'DBA', 'ROOT'];

/**
 * The services that own a database, as their variables spell them
 * (`DATABASE_URL_<SERVICE>`): one per `services/<name>-service/prisma`, held to
 * that list by `owner-credentials.spec.ts`. A constant, so a refusal can name a
 * variable without the name having come from the environment it refuses.
 */
export const DATABASE_SERVICES = Object.freeze([
  'ANALYTICS',
  'ASSET',
  'AUDIT',
  'CONSTRUCTION',
  'CONTRACT',
  'DOCUMENT',
  'ECONOMIC',
  'FLEET',
  'IDENTITY',
  'INVENTORY',
  'MAINTENANCE',
  'MARKETPLACE',
  'NOTIFICATION',
  'ORGANIZATION',
  'PROCUREMENT',
  'SUPPLIER',
] as const);

/**
 * The only database users a service process may connect as: each service's
 * runtime role, `rasta_<service>` — the RASTA_SERVICES of
 * lib/role-passwords.bash, held to it by `owner-credentials.spec.ts`. Never a
 * `*_migrator`, never the superuser.
 */
export const RUNTIME_DATABASE_ROLES: ReadonlySet<string> = new Set(
  DATABASE_SERVICES.map((service) => `rasta_${service.toLowerCase()}`),
);

/**
 * The variables a refusal may name: the privileged names of each database
 * service (its migrator's URL and password, its admin, owner and superuser
 * URLs, its test harness's admin URL), the unprefixed ones, the superuser
 * passwords, and the runtime URL variables — refused by value when they name
 * another role. A closed list built from constants (#385 r6): any other name
 * either layer finds is counted, never named.
 */
export const REGISTERED_MIGRATOR_CREDENTIALS: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'DATABASE_URL_MIGRATOR',
  ...PRIVILEGED_URL_SUFFIXES.map((suffix) => `DATABASE_URL_${suffix}`),
  'TEST_ADMIN_URL',
  'POSTGRES_SUPERUSER_PASSWORD',
  'POSTGRES_PASSWORD',
  'PGPASSWORD',
  ...DATABASE_SERVICES.flatMap((service) => [
    `DATABASE_URL_${service}`,
    `DATABASE_URL_${service}_MIGRATOR`,
    `POSTGRES_PASSWORD_${service}_MIGRATOR`,
    ...PRIVILEGED_URL_SUFFIXES.map((suffix) => `DATABASE_URL_${service}_${suffix}`),
    `TEST_${service}_ADMIN_URL`,
  ]),
]);

/** The privileged-credential variables set (non-empty) in `env`, by NAME, sorted. */
export function migratorCredentialsIn(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => MIGRATOR_CREDENTIAL_PATTERN.test(name) && Boolean(env[name]))
    .sort();
}

const DATABASE_URL_SCHEME = /postgres(?:ql)?:\/\//i;
const DATABASE_URL_START = /^postgres(?:ql)?:\/\//i;

/**
 * Whether `value` carries a database URL a service may not hold: one that
 * connects as anything but a runtime role — by its user, or by a `user`
 * query parameter — or that names the scheme and cannot be read (embedded
 * in other text, malformed, a percent-encoded user, no user at all,
 * whereupon the client would pick one). Nothing of the value is kept.
 */
function isPrivilegedDatabaseUrl(value: string): boolean {
  if (!DATABASE_URL_SCHEME.test(value)) return false;
  if (!DATABASE_URL_START.test(value)) return true;
  const url = tryReadUrl(value);
  if (url === null) return true;
  // The user as written: a runtime role's name needs no percent-encoding, so an
  // encoded one — even of a runtime role — is refused, never decoded.
  const users = [url.username, ...url.searchParams.getAll('user')];
  return users.some((user) => !RUNTIME_DATABASE_ROLES.has(user));
}

/**
 * The variables in `env` whose VALUE is a database URL for anything but a
 * runtime role (or names the scheme and cannot be read), sorted — whatever the
 * variable is called.
 */
export function privilegedDatabaseUrlsIn(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => {
      const value = env[name];
      return typeof value === 'string' && isPrivilegedDatabaseUrl(value);
    })
    .sort();
}

/**
 * Thrown at boot when a service's environment holds an owner credential.
 *
 * Detection is by {@link MIGRATOR_CREDENTIAL_PATTERN} and by value
 * ({@link privilegedDatabaseUrlsIn}), broad on purpose; the message is not. It
 * names only {@link REGISTERED_MIGRATOR_CREDENTIALS} and counts the rest: a
 * name no service owns came from the environment, and is repeated neither in
 * the message nor on the error (#385 r4).
 */
export class MigratorCredentialInServiceError extends Error {
  /** The registered variables found, by either layer, by name, sorted. */
  readonly variables: readonly string[];
  /** How many more were found by name whose names are not registered: counted, never named. */
  readonly unregistered: number;
  /** How many more hold a privileged database URL under a name not registered: counted. */
  readonly unregisteredUrls: number;

  /**
   * @param found the variables found by name
   * @param urls the variables found by value (a database URL for no runtime role)
   */
  constructor(found: readonly string[], urls: readonly string[] = []) {
    const byValue = urls.filter((name) => !found.includes(name));
    const variables = [...found, ...byValue]
      .filter((name) => REGISTERED_MIGRATOR_CREDENTIALS.has(name))
      .sort();
    const unregistered = found.filter((name) => !REGISTERED_MIGRATOR_CREDENTIALS.has(name)).length;
    const unregisteredUrls = byValue.filter(
      (name) => !REGISTERED_MIGRATOR_CREDENTIALS.has(name),
    ).length;
    const named = [
      ...variables,
      ...(unregistered > 0
        ? [`${unregistered} more *_MIGRATOR variable(s) named for no service`]
        : []),
      ...(unregisteredUrls > 0
        ? [`${unregisteredUrls} more variable(s) holding a database URL for no runtime role`]
        : []),
    ];
    super(
      `Refusing to start: this service's environment holds a database owner credential ` +
        `(${named.join(', ')}). A service connects only as its runtime role; the ` +
        `migrator's URL and password belong to migration tooling, in .env.migrator ` +
        `(docs/runbooks/db-role-split.md, D-045).`,
    );
    this.name = 'MigratorCredentialInServiceError';
    this.variables = variables;
    this.unregistered = unregistered;
    this.unregisteredUrls = unregisteredUrls;
  }
}

/**
 * Throws {@link MigratorCredentialInServiceError} — naming the registered
 * variables, counting the others, never a value — when `env` holds any owner
 * credential, by name or by value. Call it first in `main.ts`.
 */
export function assertNoMigratorCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const found = migratorCredentialsIn(env);
  const urls = privilegedDatabaseUrlsIn(env);
  if (found.length > 0 || urls.length > 0) {
    throw new MigratorCredentialInServiceError(found, urls);
  }
}

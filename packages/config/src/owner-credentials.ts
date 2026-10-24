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
 * A configuration check, not business logic (AGENTS.md A-03).
 */

/** The environment variables that carry a database owner's credential. */
export const MIGRATOR_CREDENTIAL_PATTERN =
  /^(?:DATABASE_URL_[A-Z0-9_]+_MIGRATOR|POSTGRES_PASSWORD_[A-Z0-9_]+_MIGRATOR)$/;

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

/** The owner-credential variables a refusal may name: the two of each database service. */
export const REGISTERED_MIGRATOR_CREDENTIALS: ReadonlySet<string> = new Set(
  DATABASE_SERVICES.flatMap((service) => [
    `DATABASE_URL_${service}_MIGRATOR`,
    `POSTGRES_PASSWORD_${service}_MIGRATOR`,
  ]),
);

/** The owner-credential variables set (non-empty) in `env`, by name, sorted. */
export function migratorCredentialsIn(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => MIGRATOR_CREDENTIAL_PATTERN.test(name) && Boolean(env[name]))
    .sort();
}

/**
 * Thrown at boot when a service's environment holds an owner credential.
 *
 * Detection is by {@link MIGRATOR_CREDENTIAL_PATTERN}, broad on purpose; the
 * message is not. It names only {@link REGISTERED_MIGRATOR_CREDENTIALS} and
 * counts the rest: a name the pattern matched but no service owns came from the
 * environment, and is repeated neither in the message nor on the error (#385 r4).
 */
export class MigratorCredentialInServiceError extends Error {
  /** The registered owner-credential variables found, by name, sorted. */
  readonly variables: readonly string[];
  /** How many more were found whose names are not registered: counted, never named. */
  readonly unregistered: number;

  constructor(found: readonly string[]) {
    const variables = found.filter((name) => REGISTERED_MIGRATOR_CREDENTIALS.has(name)).sort();
    const unregistered = found.length - variables.length;
    const named = [
      ...variables,
      ...(unregistered > 0
        ? [`${unregistered} more *_MIGRATOR variable(s) named for no service`]
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
  }
}

/**
 * Throws {@link MigratorCredentialInServiceError} — naming the registered
 * variables, counting the others, never a value — when `env` holds any owner
 * credential. Call it first in `main.ts`.
 */
export function assertNoMigratorCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const found = migratorCredentialsIn(env);
  if (found.length > 0) throw new MigratorCredentialInServiceError(found);
}

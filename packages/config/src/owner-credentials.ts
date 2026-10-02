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

/** The owner-credential variables set (non-empty) in `env`, by name, sorted. */
export function migratorCredentialsIn(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => MIGRATOR_CREDENTIAL_PATTERN.test(name) && Boolean(env[name]))
    .sort();
}

/** Thrown at boot when a service's environment holds an owner credential. */
export class MigratorCredentialInServiceError extends Error {
  constructor(readonly variables: readonly string[]) {
    super(
      `Refusing to start: this service's environment holds a database owner credential ` +
        `(${variables.join(', ')}). A service connects only as its runtime role; the ` +
        `migrator's URL and password belong to migration tooling, in .env.migrator ` +
        `(docs/runbooks/db-role-split.md, D-045).`,
    );
    this.name = 'MigratorCredentialInServiceError';
  }
}

/**
 * Throws {@link MigratorCredentialInServiceError} — naming the variables, never
 * a value — when `env` holds any owner credential. Call it first in `main.ts`.
 */
export function assertNoMigratorCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const found = migratorCredentialsIn(env);
  if (found.length > 0) throw new MigratorCredentialInServiceError(found);
}

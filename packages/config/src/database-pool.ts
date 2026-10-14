/**
 * The runtime connection pool's size and wait, from configuration.
 *
 * Prisma sizes a client's pool from two connection-string parameters:
 * `connection_limit` (default `num_physical_cpus * 2 + 1`) and `pool_timeout`
 * (seconds a query waits for a free connection before failing with P2024;
 * default 10). Left to that default, a service's pool follows the core count
 * of whatever node it lands on — and the paths that depend on a bounded pool
 * (the 409 a claim answers when no connection is free, transactions' lock
 * waits) behave differently from one node to the next.
 *
 * `DATABASE_POOL_SIZE` and `DATABASE_POOL_TIMEOUT_SECONDS` (`databaseEnvSchema`)
 * set them, and `loadEnv` writes them into `DATABASE_URL` through
 * {@link withDatabasePool}, so every client a service opens on that URL — the
 * runtime pool, the startup role check, a CLI — gets the same pool. Unset,
 * nothing is written and Prisma's defaults stay exactly as they were.
 *
 * Infrastructure, not business logic (A-03): it decides how a connection is
 * opened, never what is done on it. The migrators' URLs never pass through
 * here (D-045): `scripts/prisma.mjs` reads them, not `loadEnv`.
 */

/** The configured pool; an absent field leaves Prisma's default for it. */
export interface DatabasePool {
  /** Prisma `connection_limit`. */
  readonly size?: number;
  /** Prisma `pool_timeout`, in whole seconds — the unit Prisma reads. */
  readonly timeoutSeconds?: number;
}

/** Each configured field, with its connection-string parameter and the variable that sets it. */
export const DATABASE_POOL_PARAMETERS = [
  { field: 'size', parameter: 'connection_limit', variable: 'DATABASE_POOL_SIZE' },
  {
    field: 'timeoutSeconds',
    parameter: 'pool_timeout',
    variable: 'DATABASE_POOL_TIMEOUT_SECONDS',
  },
] as const satisfies ReadonlyArray<{
  field: keyof DatabasePool;
  parameter: string;
  variable: string;
}>;

/**
 * The URL already sets a pool parameter (or, `withStatementTimeout`, the
 * statement timeout) to a different value than its variable — or, from
 * `database-session.ts`, is written in a form whose `options` the driver would
 * read differently (a raw control character, a repeated `options` parameter).
 *
 * Two places for one number, disagreeing, is refused rather than resolved: an
 * operator who changed one of them believes it is the one in effect. The
 * message names the parameter and the variable, never the URL — it carries the
 * runtime role's password (S-09).
 */
export class DatabaseUrlConflictError extends Error {
  constructor(
    public readonly variable: string,
    public readonly parameter: string,
    message = `DATABASE_URL already sets ${parameter} to a different value than ${variable}; ` +
      'set it in one place',
  ) {
    super(message);
    this.name = 'DatabaseUrlConflictError';
  }
}

/**
 * `url` with the configured pool parameters.
 *
 * A parameter the URL does not carry is appended; one it carries with the
 * same value is left as written; one it carries with another value throws
 * {@link DatabaseUrlConflictError}. Everything else is kept byte for byte, as
 * `withUtcSession` keeps it. With nothing configured the URL is returned
 * unchanged.
 */
export function withDatabasePool(url: string, pool: DatabasePool): string {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const hasQuery = beforeHash.includes('?');
  const pairs = hasQuery
    ? beforeHash
        .slice(beforeHash.indexOf('?') + 1)
        .split('&')
        .filter(Boolean)
    : [];

  const added: string[] = [];
  for (const { field, parameter, variable } of DATABASE_POOL_PARAMETERS) {
    const value = pool[field];
    if (value === undefined) continue;
    const present = pairs
      .filter((pair) => decodeComponent(pair.split('=')[0] ?? '') === parameter)
      .map((pair) => decodeComponent(pair.slice(pair.indexOf('=') + 1 || pair.length)));
    if (present.length === 0) {
      added.push(`${parameter}=${value}`);
    } else if (present.some((written) => written !== String(value))) {
      throw new DatabaseUrlConflictError(variable, parameter);
    }
  }

  if (added.length === 0) return url;
  const separator = !hasQuery
    ? '?'
    : beforeHash.endsWith('?') || beforeHash.endsWith('&')
      ? ''
      : '&';
  return `${beforeHash}${separator}${added.join('&')}${hash}`;
}

/** A query component as `application/x-www-form-urlencoded` reads it: `+` is a space. */
function decodeComponent(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

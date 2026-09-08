import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@rasta/config';

export const SERVICE_NAME = 'audit-service';

/** The port `.env.example` (`PORT_AUDIT`) and `AUDIT_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3115';

/**
 * audit-service configuration — bootstrap only.
 *
 * Deliberately built from `baseEnvSchema` alone, and the three schemas it does
 * **not** merge are the point:
 *
 *   `databaseEnvSchema`  would make `DATABASE_URL` mandatory. This service owns
 *                        no schema, opens no client and runs no migration, so
 *                        requiring the variable would stop the container from
 *                        starting over a dependency it never touches — and
 *                        would state, in the one file an operator reads to find
 *                        out, that a database is in use. `rasta_audit` exists
 *                        and `DATABASE_URL_AUDIT` is registered in CI; both are
 *                        waiting for AUD-001, not being used here.
 *
 *   `kafkaEnvSchema`     would advertise a broker connection. ADR-053 has this
 *                        service consuming every domain topic, and it consumes
 *                        none today. A configured client id with no consumer is
 *                        the shape that makes a dead service look alive.
 *
 *   `authEnvSchema`      would require a JWKS endpoint for token verification.
 *                        The only routes here are the two health probes, which
 *                        are `@Public` by definition, so there is no token to
 *                        verify. AUD-002 brings the query API and its guard,
 *                        and this schema grows then.
 *
 * Adding any of them now would be configuration describing behaviour that does
 * not exist (AGENTS.md § 9).
 */
export const auditEnvSchema = baseEnvSchema.extend({
  CORS_ORIGINS: z.string().default(''),
});

export type AuditEnv = z.infer<typeof auditEnvSchema>;

/**
 * Loads and validates the environment, once, at startup.
 *
 * `PORT` falls back to `PORT_AUDIT` and then to 3115, which is the platform
 * convention: the repo-root `.env` names every service's port separately so one
 * file describes the whole platform, while a container sets `PORT` alone.
 */
export function loadAuditEnv(source: NodeJS.ProcessEnv = process.env): AuditEnv {
  return loadEnv(auditEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
    PORT: source.PORT ?? source.PORT_AUDIT ?? DEFAULT_PORT,
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: AuditEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

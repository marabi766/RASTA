import { z } from 'zod';
import { DOMAIN_PROJECTOR_CONSUMER } from '../audit/audit.mapper';
import { baseEnvSchema, databaseEnvSchema, kafkaEnvSchema, loadEnv } from '@rasta/config';

export const SERVICE_NAME = 'audit-service';

/** The port `.env.example` (`PORT_AUDIT`) and `AUDIT_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3115';

/**
 * audit-service configuration.
 *
 * AUD-001 turns this service on: it owns a schema, opens a client and consumes
 * ten domain topics, so `databaseEnvSchema` and `kafkaEnvSchema` are merged
 * here now. The scaffold comment that said they were absent because nothing
 * used them was true of PR #38 and is not true any more.
 *
 * **`DATABASE_URL` resolves from `DATABASE_URL_AUDIT` and never from
 * `DATABASE_URL_AUDIT_MIGRATOR`.** That is the whole append-only design in one
 * line. The migrator role owns schema `audit` and can drop it; the runtime role
 * holds only SELECT and INSERT and, owning nothing, cannot grant itself more.
 * A fallback to the migrator url "so it works in development" would hand the
 * service exactly the powers ADR-053 § 6 exists to withhold, and it would fail
 * open — silently, and only in the environment nobody watches.
 *
 * `authEnvSchema` is still not merged, and still deliberately. The only routes
 * are the two health probes, which are `@Public`, so there is no token to
 * verify. AUD-002 brings the first private endpoint and its guard, and this
 * schema grows then.
 */
export const auditEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .extend({
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
    // Never DATABASE_URL_AUDIT_MIGRATOR. That connection owns the schema and
    // may drop it; this process must only ever hold the role that can insert
    // and select. Falling back to it would quietly undo the whole split.
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_AUDIT,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? DOMAIN_PROJECTOR_CONSUMER,
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: AuditEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** The broker list, as the platform's Kafka clients expect it. */
export function brokersOf(env: AuditEnv): string[] {
  return env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

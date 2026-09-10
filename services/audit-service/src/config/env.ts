import { z } from 'zod';
import { DOMAIN_PROJECTOR_CONSUMER } from '../audit/audit.mapper';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';
import { DEFAULT_MAX_QUERY_WINDOW_DAYS } from '../audit/audit.query.dto';

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
 * `authEnvSchema` is merged as of AUD-002. The service now serves two private
 * read endpoints behind a global `AuthGuard` and `RolesGuard`, so it verifies
 * JWTs against the platform JWKS and mints nothing it cannot verify. The
 * scaffold comment that said it was absent because no route needed a token was
 * true of AUD-001 and is not true any more.
 */
export const auditEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /**
     * The widest `from`..`to` an audit query may cover, in days.
     *
     * `audit_event` is partitioned monthly across years, so an unbounded range
     * scans every partition — which ADR-053 § 10 names as an accidental denial
     * of service, not merely a slow query. The ceiling is what makes partition
     * pruning effective, and exceeding it is a `400 VALIDATION_FAILED` that
     * quotes this value rather than a silent truncation (`docs/06` § 6.5).
     *
     * Configurable because retention windows and investigation practice are an
     * operator's decision, not a constant. Bounded at both ends so a
     * misconfiguration cannot disable the control: below one day no
     * investigation is possible, and 366 keeps the widest permitted query
     * inside a year of partitions.
     */
    AUDIT_MAX_QUERY_WINDOW_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(366)
      .default(DEFAULT_MAX_QUERY_WINDOW_DAYS),
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

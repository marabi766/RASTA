import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

export const SERVICE_NAME = 'supplier-service';

/** Every event this service publishes goes to one topic (docs/07 § 7.2). */
export const SUPPLIER_TOPIC = 'rasta.supplier.v1';

/** The port `.env.example` and the gateway's `SUPPLIER_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3108';

/**
 * supplier-service configuration.
 *
 * Nothing domain-specific is configurable yet, and that absence is deliberate.
 *
 * The obvious candidate would be the performance-score weights, which `docs/04`
 * § 4.10 requires to be configurable. They are not here because Q-12 — what the
 * weights are — is open, and a configuration key with a default is a decision:
 * whatever ships as the default becomes the policy every deployment runs. The
 * "equal weights" note in `docs/24` is a temporary placeholder in an open
 * question, not an approved production policy, and encoding it here would turn
 * it into one silently (AGENTS.md § 9).
 *
 * The second candidate would be a qualification validity period. There is none,
 * for the same reason: no accepted document states one, so there is nothing to
 * make configurable.
 */
export const supplierEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),
  });

export type SupplierEnv = z.infer<typeof supplierEnvSchema>;

/**
 * Loads and validates the environment, once, at startup.
 *
 * The fallbacks are the platform's convention and each one matters:
 *
 *   PORT          falls back to `PORT_SUPPLIER` then to 3108. The repo-root
 *                 `.env` names every service's port separately so one file can
 *                 describe the whole platform; a container sets `PORT` alone.
 *   DATABASE_URL  falls back to `DATABASE_URL_SUPPLIER` and to nothing else.
 *                 There is deliberately no default: a service that silently
 *                 connected to some other database would violate A-01 quietly,
 *                 and `postgresUrlSchema` refuses an absent value loudly.
 *
 * `KAFKA_CONSUMER_GROUP` is set even though this service registers no consumer
 * (see `app.module.ts`): the value is part of the service's identity on the
 * broker, and defining it here means the first real consumer inherits the
 * platform-standard name rather than inventing one.
 */
export function loadSupplierEnv(source: NodeJS.ProcessEnv = process.env): SupplierEnv {
  return loadEnv(supplierEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
    PORT: source.PORT ?? source.PORT_SUPPLIER ?? DEFAULT_PORT,
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_SUPPLIER,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? `${SERVICE_NAME}.main`,
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: SupplierEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function brokersOf(env: SupplierEnv): string[] {
  return env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

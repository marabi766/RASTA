import { z } from 'zod';
import {
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  kafkaEnvSchema,
  authEnvSchema,
  loadEnv,
} from '@rasta/config';

/**
 * identity-service configuration.
 *
 * Composed from the shared schemas plus the Keycloak admin credentials this
 * service needs to provision accounts. Validated once at startup so a missing
 * value fails the deployment rather than the first request that needs it.
 */
export const identityEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    KEYCLOAK_URL: z.string().url(),
    KEYCLOAK_REALM: z.string().min(1),
    KEYCLOAK_BACKEND_CLIENT_ID: z.string().min(1),
    KEYCLOAK_BACKEND_CLIENT_SECRET: z.string().min(1),

    /**
     * When false, account provisioning is recorded locally and the Keycloak
     * call is skipped. That is for isolated unit and API test environments
     * that have no identity provider. A deployed environment must never
     * disable synchronisation — hence the default of true.
     */
    KEYCLOAK_SYNC_ENABLED: booleanEnv(true),

    CORS_ORIGINS: z.string().default(''),

    /**
     * ADR-053 § 4 — how long a refusal may wait for its `security_event_outbox`
     * row before the `403` is returned without it.
     *
     * Applied twice: as the transaction's `statement_timeout` and as a hard
     * deadline around the whole write, so neither a slow statement nor a slow
     * pool acquisition can hold a refusal longer. Short on purpose — capture is
     * best-effort, and the refusal itself never waits on audit for long. The
     * ceiling keeps a misconfiguration from turning every `403` into a stall.
     */
    SECURITY_EVENT_CAPTURE_TIMEOUT_MS: z.coerce.number().int().min(10).max(5000).default(250),

    /** How often the refusal relay polls `security_event_outbox`. */
    SECURITY_EVENT_FLUSH_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),

    /** Rows one refusal-relay claim may take. */
    SECURITY_EVENT_FLUSH_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  });

export type IdentityEnv = z.infer<typeof identityEnvSchema>;

export function loadIdentityEnv(source: NodeJS.ProcessEnv = process.env): IdentityEnv {
  // Each service reads its own DATABASE_URL_* variable, so a single .env can
  // describe every service without any of them being able to open another
  // service's database by accident (ADR-005).
  return loadEnv(identityEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? 'identity-service',
    PORT: source.PORT ?? source.PORT_IDENTITY ?? '3101',
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_IDENTITY,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'identity-service',
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'identity-service.main',
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: IdentityEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'identity-service';
export const IDENTITY_TOPIC = 'rasta.identity.v1';

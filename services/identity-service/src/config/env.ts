import { z } from 'zod';
import {
  baseEnvSchema,
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
     * call is skipped. Lets unit and API tests run without an identity
     * provider; never true in a deployed environment.
     */
    KEYCLOAK_SYNC_ENABLED: z.coerce.boolean().default(true),

    CORS_ORIGINS: z.string().default(''),
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

import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

/**
 * organization-service configuration.
 *
 * No Keycloak admin credentials here: this service never provisions accounts.
 * It verifies tokens, which needs only the public JWKS endpoint.
 */
export const organizationEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /**
     * Maximum depth of the organization tree.
     *
     * Country → Province → County → Municipality → Organization → Unit is six.
     * The limit exists to stop a cycle or a bad import producing an unbounded
     * chain that makes every subtree query pathological.
     */
    MAX_HIERARCHY_DEPTH: z.coerce.number().int().min(1).max(20).default(8),
  });

export type OrganizationEnv = z.infer<typeof organizationEnvSchema>;

export function loadOrganizationEnv(source: NodeJS.ProcessEnv = process.env): OrganizationEnv {
  return loadEnv(organizationEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? 'organization-service',
    PORT: source.PORT ?? source.PORT_ORGANIZATION ?? '3102',
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_ORGANIZATION,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'organization-service',
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'organization-service.main',
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: OrganizationEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'organization-service';
export const ORGANIZATION_TOPIC = 'rasta.organization.v1';

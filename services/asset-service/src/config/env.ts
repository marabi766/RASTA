import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

/**
 * asset-service configuration.
 */
export const assetEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /**
     * How far ahead to warn about an expiring insurance policy or inspection.
     *
     * Configurable rather than fixed: a dehyari renewing through the platform
     * needs more notice than one renewing at a counter, and the right number
     * is the client's call, not the platform's.
     */
    EXPIRY_WARNING_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  });

export type AssetEnv = z.infer<typeof assetEnvSchema>;

export function loadAssetEnv(source: NodeJS.ProcessEnv = process.env): AssetEnv {
  return loadEnv(assetEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? 'asset-service',
    PORT: source.PORT ?? source.PORT_ASSET ?? '3103',
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_ASSET,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'asset-service',
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'asset-service.main',
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: AssetEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'asset-service';

/** This service publishes to two topics: the asset stream and, from the
 *  insurance module, its own. Separate topics keep the extraction seam clean
 *  (docs/04 § 4.1) — a consumer that only cares about policies need not read
 *  every asset update. */
export const ASSET_TOPIC = 'rasta.asset.v1';
export const INSURANCE_TOPIC = 'rasta.insurance.v1';

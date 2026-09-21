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

    /**
     * Who may decide an insurance claim and record its settlement.
     *
     * The product document names no approval authority for claims, and the
     * platform does not invent one (AGENTS.md § 1, principle 2): the roles come
     * from configuration and the question is recorded as docs/24 Q-59. The
     * default is the narrow reading — the organization's own administrators —
     * not the fleet manager who files the claim.
     */
    INSURANCE_CLAIM_DECISION_ROLES: z
      .string()
      .default('ORGANIZATION_ADMIN,UNION_ADMIN')
      .transform((raw) => raw.split(',').map((role) => role.trim()))
      .pipe(z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).nonempty()),

    /**
     * The largest amount the configured roles may approve, in minor units.
     *
     * Empty means no ceiling. When a higher authority exists for larger claims
     * it is set here, and an approval above it is refused rather than granted
     * by whoever happened to hold the role (Q-59). Parsed as a bigint: rial
     * amounts leave the safe-integer range quickly.
     */
    INSURANCE_CLAIM_APPROVAL_CEILING_MINOR: z
      .string()
      .trim()
      .regex(/^\d{0,30}$/, 'Must be a non-negative integer in minor units, or empty')
      .default('')
      .transform((raw) => (raw === '' ? null : BigInt(raw))),
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

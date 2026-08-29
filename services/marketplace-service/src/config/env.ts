import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

/**
 * marketplace-service configuration.
 *
 * Every window and every threshold below is configuration rather than a
 * constant, because none of them is a fact the product document states. The
 * defaults come from `docs/08` § 8.4, which labels them ASSUMPTION in the
 * document itself (AGENTS.md § 9).
 */
export const marketplaceEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /** Where the order saga sends its financial commands (ADR-040). */
    ECONOMIC_SERVICE_URL: z.string().url().default('http://localhost:3112'),

    /**
     * How long a call to economic-service may take before the activity fails
     * and Temporal retries it.
     */
    ECONOMIC_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),

    // ---- Temporal ---------------------------------------------------------

    TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    /**
     * The queue this service's worker owns; nobody else polls it (ADR-039).
     *
     * Deliberately **not** the platform-wide `TEMPORAL_TASK_QUEUE`, which
     * `.env.example` sets to `rasta-main`. A shared queue means one service's
     * worker is handed another service's workflow tasks and cannot execute
     * them — and reading the generic variable here made exactly that happen
     * silently, with the worker reporting that it was polling normally.
     */
    MARKETPLACE_TEMPORAL_TASK_QUEUE: z.string().default('rasta-order'),
    /**
     * Whether the worker starts with the service.
     *
     * Off means orders are created and then do not advance — an explicit,
     * visible state rather than a silent failure. A developer running the API
     * without Temporal gets that, and knows it.
     */
    MARKETPLACE_TEMPORAL_ENABLED: z.coerce.boolean().default(true),

    // ---- Order windows (ADR-043, Q-11) -----------------------------------

    /**
     * Days a supplier has to record fulfilment before the order is counted
     * overdue. Expiry records a reminder; it never cancels and never moves
     * money.
     */
    MARKETPLACE_FULFILLMENT_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(7),

    /**
     * Days the buyer has to confirm receipt before the order is counted
     * overdue.
     *
     * There is no automatic confirmation at the end of it. Q-11: automatic
     * confirmation would release money without the buyer's explicit consent.
     */
    MARKETPLACE_RECEIPT_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(3),

    /** How often a reminder is recorded once a window has elapsed. */
    MARKETPLACE_REMINDER_INTERVAL_DAYS: z.coerce.number().int().min(1).max(90).default(3),

    /** Retention for stored `Idempotency-Key` responses (docs/06 § 6.8). */
    MARKETPLACE_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  });

export type MarketplaceEnv = z.infer<typeof marketplaceEnvSchema>;

export function loadMarketplaceEnv(source: NodeJS.ProcessEnv = process.env): MarketplaceEnv {
  return loadEnv(marketplaceEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? 'marketplace-service',
    PORT: source.PORT ?? source.PORT_MARKETPLACE ?? '3106',
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_MARKETPLACE,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'marketplace-service',
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'marketplace-service.main',
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: MarketplaceEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'marketplace-service';

/** Everything this service publishes goes to one topic (docs/04 § 4.1). */
export const MARKETPLACE_TOPIC = 'rasta.marketplace.v1';

/** The service the saga sends financial commands to (ADR-040). */
export const ECONOMIC_SERVICE = 'economic-service';

import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

/**
 * economic-service configuration.
 *
 * Note what is *not* here: no commission rate, no reward conversion rate, no
 * approval threshold. Those are governance decisions and they live in database
 * tables where they can be versioned and audited (ADR-023). An environment
 * variable holding a commission rate would be a hard-coded rate with extra
 * steps.
 */
export const economicEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /**
     * The organization that plays the platform operator role.
     *
     * Escrow, commission revenue, reward expense and the payment clearing
     * account belong to it. It is configuration rather than a constant because
     * the platform must stay organization-agnostic (AGENTS.md A-05): which
     * organization operates the platform is a deployment fact, and encoding
     * "the union" here would be exactly the structural assumption
     * `PROJECT_MEMORY` § 1 forbids.
     */
    ECONOMIC_PLATFORM_ORGANIZATION_ID: z.string().min(1).default('ORG-PLATFORM'),

    /**
     * Which payment provider is wired in.
     *
     * `mock` is the only implementation that exists (ADR-024). The variable is
     * here so that adding a real provider is a configuration change plus a new
     * class, and so that the running service can *report* which one it is
     * using — `GET /v1/payment-intents/provider` says so out loud, and the
     * value ends up on every payment intent row.
     *
     * A value other than `mock` is rejected at boot rather than falling back,
     * because a silent fallback to a simulated provider in an environment that
     * expected a real one is the worst possible failure here.
     */
    ECONOMIC_PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),

    /**
     * Deterministic simulated latency for the mock provider, in milliseconds.
     *
     * Zero by default so tests are fast. Set it in a demo environment to make
     * the loading states real. It is a fixed delay, never a random one — a
     * random delay makes a test flaky rather than realistic.
     */
    ECONOMIC_MOCK_PAYMENT_LATENCY_MS: z.coerce.number().int().min(0).max(10_000).default(0),

    /**
     * Cashback rewards.
     *
     * The product document conditions cashback on a regulatory review
     * ("در صورت امکان و پس از بررسی مقرراتی"), so `RewardType.CASHBACK` sits
     * behind this flag with the default off (docs/24 Q-07, docs/10 § 10.8).
     * With it off, creating or activating a CASHBACK rule is *refused* rather
     * than silently ignored — a rule that exists and does nothing is a control
     * that claims something it does not have.
     */
    ECONOMIC_REWARD_CASHBACK_ENABLED: z
      .string()
      .default('false')
      .transform((value) => value === 'true'),

    /** How long a stored idempotency key is honoured (docs/06 § 6.8). */
    ECONOMIC_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

    /**
     * Whether this instance runs the ledger/wallet reconciliation.
     *
     * docs/10 § 10.3 asks for a daily `LedgerBalanceAuditWorkflow` that
     * recomputes every wallet balance from the ledger and raises a critical
     * alert on any deviation. Temporal is not running on this platform yet
     * (ADR-027, ADR-031), so the audit runs in-process on a timer. It is
     * read-only — it never repairs a balance, because a wallet that disagrees
     * with the ledger is an incident for a human, not a number to quietly
     * correct.
     */
    ECONOMIC_BALANCE_AUDIT_ENABLED: z
      .string()
      .default('true')
      .transform((value) => value !== 'false'),

    /** How often the reconciliation runs, in seconds. */
    ECONOMIC_BALANCE_AUDIT_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(86_400)
      .default(3600),

    /** How many wallets one reconciliation pass checks. Bounds the query. */
    ECONOMIC_BALANCE_AUDIT_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  });

export type EconomicEnv = z.infer<typeof economicEnvSchema>;

export function loadEconomicEnv(source: NodeJS.ProcessEnv = process.env): EconomicEnv {
  return loadEnv(economicEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? 'economic-service',
    PORT: source.PORT ?? source.PORT_ECONOMIC ?? '3112',
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_ECONOMIC,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'economic-service',
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'economic-service.main',
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: EconomicEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'economic-service';

/** Everything this service publishes goes to one topic (docs/04 § 4.1). */
export const ECONOMIC_TOPIC = 'rasta.economic.v1';

/** Where a message this service cannot process is parked (docs/07 § 7.9). */
export const ECONOMIC_DLQ_TOPIC = 'rasta.economic.v1.dlq';

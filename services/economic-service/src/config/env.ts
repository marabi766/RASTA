import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
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
     * How long a refund in flight is left alone before its reconciliation task
     * falls due (ADR-064 step B), in seconds.
     *
     * The task is written when the refund holds its amount, before the
     * provider is asked; the grace keeps the reconciler away from a refund
     * whose provider call is still running. An outcome the request path could
     * not record *without* an answer (`REFUND_UNKNOWN`) waits the same grace,
     * since the provider may still be processing it; a known one is due at
     * once. Step B2 adds the provider call timeout and refuses a grace of less
     * than twice it.
     */
    ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(86_400)
      .default(300),

    /**
     * The payment reconciler (ADR-064 step B2): an in-process sweeper over
     * `payment_reconciliation_task`. On by default — a stranded refund keeps
     * its hold until something asks the provider — and safe on every replica
     * (`SKIP LOCKED`, a lease and a fencing token), so no leader election.
     */
    ECONOMIC_PAYMENT_RECONCILER_ENABLED: booleanEnv(true),
    /** How often a sweep runs, in seconds. */
    ECONOMIC_PAYMENT_RECONCILER_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(5)
      .max(3600)
      .default(60),
    /** Tasks claimed per sweep. With the provider timeout, the bound on one sweep. */
    ECONOMIC_PAYMENT_RECONCILER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
    /** How long a claim holds before another sweeper may take the task back. */
    ECONOMIC_PAYMENT_RECONCILER_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(10)
      .max(3600)
      .default(120),
    /** Delay after the first unresolved attempt; doubles per attempt up to the maximum. */
    ECONOMIC_PAYMENT_RECONCILER_BACKOFF_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(60),
    ECONOMIC_PAYMENT_RECONCILER_BACKOFF_MAX_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(3600),
    /**
     * After this many unresolved attempts, or this long since the task was
     * opened, it is escalated to a person with `PAYMENT_RECONCILIATION_ESCALATED`.
     * The hold stays: escalation changes who decides, not where the money is.
     */
    ECONOMIC_PAYMENT_RECONCILER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
    ECONOMIC_PAYMENT_RECONCILER_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(72),

    /**
     * The deadline on every payment provider call, in milliseconds (ADR-064
     * step B2). A call past it is an unknown outcome, which the reconciler
     * resolves by asking; it never hangs a request.
     */
    ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(10_000),

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
    ECONOMIC_REWARD_CASHBACK_ENABLED: booleanEnv(false),

    /**
     * Whether the payee's financial administrator may return escrowed funds
     * to the payer (docs/24 Q-62).
     *
     * On by default: returning money one is owed harms nobody but the one who
     * returns it, which is the interim decision recorded in Q-62. Turned off,
     * a refund needs platform scope or the order saga. The payer is never
     * allowed either way, and a disputed transaction always needs platform
     * scope — those are controls (docs/10 § 10.5), not settings.
     */
    ECONOMIC_REFUND_BY_PAYEE_ENABLED: booleanEnv(true),

    /**
     * The services that own the facts this service makes money from (ADR-061 § 4).
     *
     * Required, with no default. Without them, the settlement consumer cannot
     * confirm an approval, so it could never record an obligation. That is
     * better found at boot than as a DLQ full of good events.
     */
    MAINTENANCE_SERVICE_URL: z.string().url(),
    FLEET_SERVICE_URL: z.string().url(),

    /** One source read, body included. A timeout is retried, never acted on. */
    ECONOMIC_SOURCE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),

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
    ECONOMIC_BALANCE_AUDIT_ENABLED: booleanEnv(true),

    /** How often the reconciliation runs, in seconds. */
    ECONOMIC_BALANCE_AUDIT_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(86_400)
      .default(3600),

    /** How many wallets one reconciliation pass checks. Bounds the query. */
    ECONOMIC_BALANCE_AUDIT_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  })
  .superRefine((env, ctx) => {
    // The grace keeps the reconciler off a refund whose provider call is still
    // running: longer than twice the longest call.
    if (
      env.ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS * 1000 <=
      2 * env.ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS'],
        message: 'must be more than twice ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS',
      });
    }
    // A claim must outlive the provider question and the write that follows,
    // or another sweeper takes the task back mid-work (the fence still holds,
    // but every such sweep is wasted).
    if (
      env.ECONOMIC_PAYMENT_RECONCILER_LEASE_SECONDS * 1000 <
      env.ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS + 5000
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ECONOMIC_PAYMENT_RECONCILER_LEASE_SECONDS'],
        message: 'must exceed ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS by at least 5 seconds',
      });
    }
    if (
      env.ECONOMIC_PAYMENT_RECONCILER_BACKOFF_MAX_SECONDS <
      env.ECONOMIC_PAYMENT_RECONCILER_BACKOFF_SECONDS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ECONOMIC_PAYMENT_RECONCILER_BACKOFF_MAX_SECONDS'],
        message: 'must not be below ECONOMIC_PAYMENT_RECONCILER_BACKOFF_SECONDS',
      });
    }
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

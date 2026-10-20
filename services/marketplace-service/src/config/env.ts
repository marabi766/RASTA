import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  kafkaEnvSchema,
  kafkaSaslConfigured,
  loadEnv,
  outboxPurgeEnvSchema,
  PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS,
} from '@rasta/config';
import { marketplaceOperationBudgets } from './operation-budgets';

/**
 * marketplace-service configuration.
 *
 * Every window and every threshold below is configuration rather than a
 * constant, because none of them is a fact the product document states. The
 * defaults come from `docs/08` § 8.4, which labels them ASSUMPTION in the
 * document itself (AGENTS.md § 9).
 */
/** Half the transaction the hierarchy question is asked in (`MARKETPLACE_ORGANIZATION_REQUEST_TIMEOUT_MS`). */
export const ORGANIZATION_REQUEST_CEILING_MS = Math.floor(
  PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS / 2,
);

export const marketplaceEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(outboxPurgeEnvSchema)
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

    /**
     * Where a union administrator's subtree is confirmed before it decides a
     * dispute (docs/24 Q-136): organization-service, the owner of the
     * hierarchy (A-13), asked as economic-service asks it.
     */
    ORGANIZATION_SERVICE_URL: z.string().url().default('http://localhost:3102'),

    /**
     * How long that question may take, body included. It is asked under the
     * order's row lock, inside a transaction with Prisma's default budget
     * (`PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS`, 5 s), so the ceiling keeps it
     * at half of that; no answer in time refuses the decision with 504 and
     * nothing is written (fail closed).
     */
    MARKETPLACE_ORGANIZATION_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(ORGANIZATION_REQUEST_CEILING_MS)
      .default(2_000),

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
    MARKETPLACE_TEMPORAL_ENABLED: booleanEnv(true),

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

    /**
     * Days after an order COMPLETED within which its buyer may ask to return goods (RUN-005,
     * ADR-048, Q-132). **Unset by default, and then returns are refused**: the window is a
     * business fact the product document does not give (Q-33), so no number is invented and a
     * deployment opts in with the one its operations decided. Counted from the order's
     * `completedAt`; a request is judged against it when it is made, not when it is decided.
     */
    MARKETPLACE_RETURN_WINDOW_DAYS: z.coerce.number().int().min(1).max(730).optional(),

    /**
     * The return mirror (RUN-005 PR 3): consumes inventory-service's `RETURN_SHIPMENT_*` events
     * and moves the buyer's request through IN_TRANSIT … RESOLVED. **Off by default, and it fails
     * closed**: a supplier-tenant event moves a buyer-tenant request, so it may run only where the
     * broker authenticates who publishes on `rasta.inventory.v1` (ADR-061 § 3, RUN-006) — the
     * same gate as supplier-service's performance consumer. Turning it on anywhere else is refused
     * at startup (`assertReturnMirrorMayStart`).
     */
    MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED: booleanEnv(false),

    /**
     * Whether a return shipment may carry only part of what was authorized (Q-133 (8), RUN-005
     * PR 3). **`false` by default**: the shipment must name every line of the request with exactly
     * the quantity authorized — fewer arriving is said by the receipt, not by the dispatch (Q-133
     * (4)). `true` lets it name a subset of the lines, each at most what was authorized. A line
     * the request does not return, or more than it authorized, is refused either way.
     */
    MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED: booleanEnv(false),

    /** How often a reminder is recorded once a window has elapsed. */
    MARKETPLACE_REMINDER_INTERVAL_DAYS: z.coerce.number().int().min(1).max(90).default(3),

    /**
     * Hours between the saga's own re-reads of a waiting order (ADR-039 § 3).
     *
     * A command commits before its signal is sent, and a signal can be lost:
     * Temporal unreachable, or a process gone between the commit and the send.
     * The saga does not depend on the signal. It re-reads the order at least
     * this often, so a lost signal delays the order by at most this long.
     * Shorter is quicker to recover and makes a longer workflow history. An
     * order can wait indefinitely for its buyer (ADR-043), and one re-read a
     * day keeps a year-long wait to a few hundred history events.
     */
    MARKETPLACE_SAGA_RECHECK_HOURS: z.coerce.number().int().min(1).max(168).default(24),

    /** Retention for stored `Idempotency-Key` responses (docs/06 § 6.8). */
    MARKETPLACE_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

    /**
     * How long a claim still **in flight** holds its key before a retry may take
     * it over under a new token (docs/06 § 6.8, #253). Only a completed response
     * lives `MARKETPLACE_IDEMPOTENCY_TTL_HOURS`; a claim whose release failed, or
     * whose process died, blocks identical retries for this long and no longer.
     *
     * The floor keeps it well above the longest a healthy request holds its
     * claim — the claim budget plus one interactive transaction — so a slow but
     * live request is not taken over; a holder that is anyway can no longer
     * complete (its token is gone) and its work rolls back. The cross-field rule
     * below keeps it shorter than the retention. Out of range refuses to start.
     */
    MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3_600)
      .default(60),
  })
  .refine(
    (env) =>
      env.MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS <
      env.MARKETPLACE_IDEMPOTENCY_TTL_HOURS * 60 * 60,
    {
      path: ['MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS'],
      message:
        'MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS must be shorter than MARKETPLACE_IDEMPOTENCY_TTL_HOURS',
    },
  );

export type MarketplaceEnv = z.infer<typeof marketplaceEnvSchema>;

export function loadMarketplaceEnv(source: NodeJS.ProcessEnv = process.env): MarketplaceEnv {
  const env = loadEnv(
    marketplaceEnvSchema,
    {
      ...source,
      SERVICE_NAME: source.SERVICE_NAME ?? 'marketplace-service',
      PORT: source.PORT ?? source.PORT_MARKETPLACE ?? '3106',
      DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_MARKETPLACE,
      KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'marketplace-service',
      KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'marketplace-service.main',
      CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
    },
    { operationBudgets: marketplaceOperationBudgets },
  );
  assertReturnMirrorMayStart(env);
  return env;
}

/**
 * Whether this service's Kafka client authenticates to the broker as itself — its SASL
 * credential, over TLS, without the development PLAINTEXT opt-out — so that the broker, not the
 * envelope, says who published what it reads (ADR-061 § 3). The rule supplier-service's
 * performance consumer applies (`brokerConnectionIsAuthenticated` there).
 */
export function brokerConnectionIsAuthenticated(
  env: Pick<
    MarketplaceEnv,
    | 'SERVICE_NAME'
    | 'KAFKA_SASL_USERNAME'
    | 'KAFKA_SASL_PASSWORD'
    | 'KAFKA_SSL'
    | 'KAFKA_ALLOW_PLAINTEXT'
  >,
): boolean {
  return (
    !env.KAFKA_ALLOW_PLAINTEXT &&
    env.KAFKA_SSL &&
    kafkaSaslConfigured(env) &&
    env.KAFKA_SASL_USERNAME === env.SERVICE_NAME
  );
}

/**
 * Refuses to start with the return mirror enabled over a connection the broker does not
 * authenticate. Without it, anyone who can reach the broker could publish on
 * `rasta.inventory.v1` as inventory-service, in the supplier's name, and move a buyer's return
 * request — so the flag is a gate, not a warning.
 */
export function assertReturnMirrorMayStart(env: MarketplaceEnv): void {
  if (env.MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED && !brokerConnectionIsAuthenticated(env)) {
    throw new Error(
      'MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED=true is refused: the Kafka client does not ' +
        'authenticate to the broker as this service (its SASL credential, KAFKA_SSL=true, and no ' +
        'KAFKA_ALLOW_PLAINTEXT), so a return shipment event could be forged in any supplier’s ' +
        'name (RUN-006, ADR-061 § 3).',
    );
  }
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

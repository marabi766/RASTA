import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
  outboxPurgeEnvSchema,
  serviceUrlSchema,
} from '@rasta/config';
import {
  CONSUMER_SESSION_TIMEOUT_MS,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_RETRIES,
} from '@rasta/nest-common';
import { INSURANCE_COVERAGES, type DispatchPolicy } from '../fleet/dispatch-blocks';
import { fleetOperationBudgets } from './operation-budgets';

/**
 * fleet-service configuration.
 */
export const fleetEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(outboxPurgeEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /**
     * asset-service, asked whether a transfer was recorded when an assignment
     * meets an expired transfer fence (ADR-062 § 3b). Required, with no
     * default: a missing one is found at boot, not at the first expired fence.
     */
    ASSET_SERVICE_URL: serviceUrlSchema,

    /**
     * maintenance-service, asked whether a repair is in progress when a
     * replayed `MAINTENANCE_STARTED` / `MAINTENANCE_COMPLETED` refreshes the
     * replica's in-maintenance flag (D-039). Required, like the asset one.
     */
    MAINTENANCE_SERVICE_URL: serviceUrlSchema,

    /**
     * identity-service, asked whether a user is a live member of the
     * organization before that user is registered as a driver (task 095).
     * Required, like the two above: a fleet that cannot ask registers nobody,
     * and a missing URL is found at boot, not at the first registration.
     */
    IDENTITY_SERVICE_URL: httpUrlSchema,

    /** That one question, body included. A timeout refuses the registration. */
    FLEET_IDENTITY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),

    /** One such question, body included. A timeout refuses the assignment. */
    ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(3000),

    /**
     * Default window for the utilization report, in days.
     *
     * Configurable rather than fixed because "how busy has the fleet been"
     * means a month to a fleet manager and a quarter to a union administrator,
     * and neither is the platform's call to make.
     */
    UTILIZATION_DEFAULT_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    /**
     * Hours per day a machine is counted as available when computing
     * utilization.
     *
     * A working day is a business fact the product document does not state, so
     * it is configuration with a conservative default rather than a constant
     * buried in a formula (AGENTS.md § 9). An organization running two shifts
     * sets this to 16 without a code change.
     */
    UTILIZATION_AVAILABLE_HOURS_PER_DAY: z.coerce.number().min(1).max(24).default(8),

    /**
     * Insurance coverages whose lapse withdraws a machine from dispatch,
     * comma-separated.
     *
     * Which coverages are legally required is a regulatory fact the product
     * document does not state (docs/24 Q-65), so it is configuration, not code
     * (AGENTS.md § 9). The default is all four coverages, the behaviour before
     * Q-65. An unknown name stops the service at startup rather than silently
     * blocking nothing. A lapse whose coverage is not known blocks whatever
     * this says.
     */
    FLEET_DISPATCH_BLOCKING_COVERAGES: z
      .string()
      .default(INSURANCE_COVERAGES.join(','))
      .transform((value) =>
        value
          .split(',')
          .map((coverage) => coverage.trim())
          .filter((coverage) => coverage.length > 0),
      )
      .pipe(z.array(z.enum(INSURANCE_COVERAGES)).min(1)),

    /**
     * Insurance coverages that must have a policy **in force** for a machine to
     * be dispatched, comma-separated (docs/24 Q-101; temporary decision).
     *
     * Not the same question as the blocking list above: that decides which
     * *lapses* block, this which coverages are *required*. Unset: the same
     * set as `FLEET_DISPATCH_BLOCKING_COVERAGES` (if a lapse blocks, absence
     * blocks too), failing closed. Set to the empty string to require none.
     * An unknown name stops the service at startup. Machines whose replica
     * predates the recorded windows need `insurance:reproject` in
     * asset-service run before this is on (runbooks/insurance-reprojection.md).
     */
    FLEET_DISPATCH_REQUIRED_COVERAGES: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined
          ? undefined
          : value
              .split(',')
              .map((coverage) => coverage.trim())
              .filter((coverage) => coverage.length > 0),
      )
      .pipe(z.array(z.enum(INSURANCE_COVERAGES)).optional()),

    /**
     * How long a **completed** `POST /v1/fleet/availability` under an
     * `Idempotency-Key` is replayed, in hours (EXP-002 slice 7). Past it the
     * key is free again. Counted from the response, not from the claim.
     */
    FLEET_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

    /**
     * How long a claim on an `Idempotency-Key` stays **in flight**, in seconds:
     * the lease after which an abandoned claim (its process died between the
     * claim and the window) is taken over by a retry under a new token.
     */
    FLEET_IDEMPOTENCY_CLAIM_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),

    /**
     * Parked `INSURANCE_RECORDED` events (#240 r8): asset-service answered for a
     * later owner than the replica has seen, so the event waits for the
     * transfer. The transfer's handler makes them due at once and the sweep below
     * decides them (#240 r10); otherwise, how old a parked event (and its last
     * attempt) must be before the sweep tries it, in seconds.
     */
    FLEET_INSURANCE_PARKED_MIN_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(86_400)
      .default(300),

    /**
     * Attempts after which a parked event is dead-lettered as
     * `PARKED_VERIFICATION_EXHAUSTED` — never applied unverified. With the
     * default age that is about an hour of the source staying ahead.
     */
    FLEET_INSURANCE_PARKED_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1_000).default(12),

    /** How often the sweep runs, in seconds, and how many parked events it tries per run. */
    FLEET_INSURANCE_PARKED_SWEEP_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(5)
      .max(3_600)
      .default(60),
    FLEET_INSURANCE_PARKED_SWEEP_BATCH: z.coerce.number().int().min(1).max(1_000).default(50),

    /**
     * The asset-sync consumer's transactions that hold a machine's lock while
     * asset-service or maintenance-service is asked — since #240 r10 only a
     * replayed state event's refresh — and the insurance decisions (live and
     * parked) that ask nobody but may wait on that lock behind one. Must cover
     * the refresh's chain of calls plus a margin, and every attempt of one
     * delivery must still fit in the consumer's session timeout
     * ({@link assetSyncBudgetProblem}); the service refuses to start otherwise.
     * The default, 14.2 s, satisfies both at the default upstream timeout and
     * start wait (#240 r11, r12).
     */
    FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(CONSUMER_SESSION_TIMEOUT_MS)
      .default(14_200),

    /**
     * How long each asset-sync transaction may wait to start (Prisma's `maxWait`:
     * a pool connection), every one of them, and how long the reads an
     * `INSURANCE_RECORDED` makes before its transaction may take together
     * (#240 r12). Longer, the attempt fails and is retried. Counted twice per
     * attempt in the delivery budget ({@link assetSyncDeliveryWorstCaseMs}).
     */
    FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(10_000)
      .default(500),
  });

export type FleetEnv = z.infer<typeof fleetEnvSchema>;

/** The dispatch rule the environment asks for; required defaults to the blocking set. */
export function dispatchPolicyFromEnv(
  env: Pick<FleetEnv, 'FLEET_DISPATCH_BLOCKING_COVERAGES' | 'FLEET_DISPATCH_REQUIRED_COVERAGES'>,
): DispatchPolicy {
  return {
    blockingCoverages: env.FLEET_DISPATCH_BLOCKING_COVERAGES,
    requiredCoverages:
      env.FLEET_DISPATCH_REQUIRED_COVERAGES ?? env.FLEET_DISPATCH_BLOCKING_COVERAGES,
  };
}

/** The parked-insurance sweep's bounds (#240 r8). */
export function parkingFromEnv(
  env: Pick<
    FleetEnv,
    | 'FLEET_INSURANCE_PARKED_MIN_AGE_SECONDS'
    | 'FLEET_INSURANCE_PARKED_MAX_ATTEMPTS'
    | 'FLEET_INSURANCE_PARKED_SWEEP_INTERVAL_SECONDS'
    | 'FLEET_INSURANCE_PARKED_SWEEP_BATCH'
  >,
): { minAgeSeconds: number; maxAttempts: number; sweepIntervalMs: number; batchSize: number } {
  return {
    minAgeSeconds: env.FLEET_INSURANCE_PARKED_MIN_AGE_SECONDS,
    maxAttempts: env.FLEET_INSURANCE_PARKED_MAX_ATTEMPTS,
    sweepIntervalMs: env.FLEET_INSURANCE_PARKED_SWEEP_INTERVAL_SECONDS * 1000,
    batchSize: env.FLEET_INSURANCE_PARKED_SWEEP_BATCH,
  };
}

/**
 * The most upstream calls one asset-sync transaction makes while it holds a
 * machine's lock, one after another. Only a replayed state event's refresh
 * still asks under the lock (#240 r10: an `INSURANCE_RECORDED`, live or parked,
 * asks before it): asset-service for the snapshot, maintenance-service for the
 * in-maintenance flag, and asset-service whether a stale fence's transfer was
 * recorded. Each is bounded by `ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS`.
 */
export const ASSET_SYNC_UPSTREAM_CALLS_UNDER_LOCK = 3;

/** What every asset-sync transaction timeout must leave beyond those calls, for its own statements. */
export const ASSET_SYNC_TRANSACTION_MARGIN_MS = 5_000;

/** What one delivery must leave of the session timeout after its attempts: its dead letter and commit. */
export const ASSET_SYNC_DELIVERY_MARGIN_MS = 3_000;

type AssetSyncTimeouts = Pick<
  FleetEnv,
  | 'FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS'
  | 'FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS'
  | 'ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS'
>;

/**
 * The longest one asset-sync delivery can take inside the consumer's handler
 * (#240 r11, r12). An attempt is at most:
 *
 *   - the reads before its transaction (an `INSURANCE_RECORDED`'s marker and
 *     replica), bounded together by the start wait;
 *   - one upstream call made before its transaction (that event's
 *     verification);
 *   - the wait for the transaction to start (`maxWait`, every asset-sync
 *     transaction);
 *   - the transaction, which its timeout ends — and a transaction ended while
 *     its refresh waits on a call returns once that call does, which the upstream
 *     term covers, a replay making no call before its transaction.
 *
 * The consumer makes {@link DEFAULT_MAX_RETRIES} attempts with growing pauses
 * between them. Each question to another service and each pause is also
 * bracketed by the consumer's heartbeat (r12), so the session no longer rests
 * on this sum alone; it is still held to it.
 */
export function assetSyncDeliveryWorstCaseMs(env: AssetSyncTimeouts): number {
  const attempt =
    2 * env.FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS +
    env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS +
    env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS;
  let pauses = 0;
  for (let failed = 1; failed < DEFAULT_MAX_RETRIES; failed += 1)
    pauses += DEFAULT_BACKOFF_MS * failed;
  return DEFAULT_MAX_RETRIES * attempt + pauses;
}

/**
 * Why the asset-sync timeouts cannot work together, or undefined when they can
 * (#240 r9–r11).
 *
 *   - A replay's refresh asks upstream under the lock and must outlive every
 *     call it makes: shorter, every replay of a state event would expire
 *     mid-call and roll back. The insurance decisions ask nobody; they share the
 *     timeout only so that one waiting on the lock behind a replay outlives it.
 *   - One delivery's attempts must end within the consumer's session timeout
 *     ({@link CONSUMER_SESSION_TIMEOUT_MS}), less a margin for its dead letter:
 *     kafkajs does not heartbeat while a handler runs, and a longer delivery has
 *     the member evicted and the partition rebalanced mid-message.
 *
 * Together they bound the upstream timeout too: at most about 3.1 s with the
 * default start wait while the refresh asks under the lock
 * (docs/runbooks/replay-dlq.md, known limitation).
 */
export function assetSyncBudgetProblem(env: AssetSyncTimeouts): string | undefined {
  const needed =
    ASSET_SYNC_UPSTREAM_CALLS_UNDER_LOCK * env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS +
    ASSET_SYNC_TRANSACTION_MARGIN_MS;
  if (env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS <= needed) {
    return (
      `FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS (${env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS} ms) must exceed ` +
      `${ASSET_SYNC_UPSTREAM_CALLS_UNDER_LOCK} × ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS ` +
      `(${env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS} ms) + ${ASSET_SYNC_TRANSACTION_MARGIN_MS} ms = ${needed} ms`
    );
  }
  const worst = assetSyncDeliveryWorstCaseMs(env);
  const allowed = CONSUMER_SESSION_TIMEOUT_MS - ASSET_SYNC_DELIVERY_MARGIN_MS;
  if (worst > allowed) {
    return (
      `one asset-sync delivery can take ${DEFAULT_MAX_RETRIES} × (2 × FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS ` +
      `(${env.FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS} ms) + ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS ` +
      `(${env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS} ms) + FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS ` +
      `(${env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS} ms)) + pauses = ${worst} ms, more than the ` +
      `consumer session timeout (${CONSUMER_SESSION_TIMEOUT_MS} ms) less ${ASSET_SYNC_DELIVERY_MARGIN_MS} ms = ${allowed} ms`
    );
  }
  return undefined;
}

export function loadFleetEnv(source: NodeJS.ProcessEnv = process.env): FleetEnv {
  const env = loadEnv(
    fleetEnvSchema,
    {
      ...source,
      SERVICE_NAME: source.SERVICE_NAME ?? 'fleet-service',
      PORT: source.PORT ?? source.PORT_FLEET ?? '3104',
      DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_FLEET,
      KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'fleet-service',
      KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'fleet-service.main',
      CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
    },
    { operationBudgets: fleetOperationBudgets },
  );
  // Fail closed at startup: an invalid combination would fail every replay of
  // a state event at run time instead (#240 r9, r10).
  const problem = assetSyncBudgetProblem(env);
  if (problem) throw new Error(`Invalid fleet-service configuration: ${problem}`);
  return env;
}

export function corsOrigins(env: FleetEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'fleet-service';

/** Everything this service publishes goes to one topic (docs/04 § 4.1). */
export const FLEET_TOPIC = 'rasta.fleet.v1';

/**
 * The asset-sync consumer's group and the topics it reads. One group per
 * (service, purpose), never shared (docs/07 § 7.10). Named here so the module
 * that starts the consumer and `insurance:drain-check`, which reads the same
 * group's lag, cannot drift apart.
 */
export const ASSET_SYNC_GROUP = 'fleet-service.asset-sync';
/** Where the asset-sync consumer, and the parked-insurance sweep through the outbox, dead-letter. */
export const ASSET_SYNC_DEAD_LETTER_TOPIC = 'rasta.fleet.v1.dlq';
export const ASSET_SYNC_TOPICS = [
  'rasta.asset.v1',
  'rasta.insurance.v1',
  'rasta.maintenance.v1',
] as const;

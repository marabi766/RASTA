import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  httpUrlSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';
import { INSURANCE_COVERAGES, type DispatchPolicy } from '../fleet/dispatch-blocks';

/**
 * fleet-service configuration.
 */
export const fleetEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /**
     * asset-service, asked whether a transfer was recorded when an assignment
     * meets an expired transfer fence (ADR-062 § 3b). Required, with no
     * default: a missing one is found at boot, not at the first expired fence.
     */
    ASSET_SERVICE_URL: httpUrlSchema,

    /**
     * maintenance-service, asked whether a repair is in progress when a
     * replayed `MAINTENANCE_STARTED` / `MAINTENANCE_COMPLETED` refreshes the
     * replica's in-maintenance flag (D-039). Required, like the asset one.
     */
    MAINTENANCE_SERVICE_URL: httpUrlSchema,

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
     * transfer. The transfer's handler re-verifies them at once; the sweep below
     * catches the rest. How old a parked event (and its last attempt) must be
     * before the sweep tries it, in seconds.
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
     * asset-service or maintenance-service is asked (a replayed state event, a
     * live `INSURANCE_RECORDED`), and those that wait on that lock to decide a
     * parked event (#240 r9). Must cover the longest chain of such calls plus a
     * margin ({@link assetSyncBudgetProblem}); the service refuses to start
     * otherwise.
     */
    FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
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
 * machine's lock, one after another: a replayed state event asks asset-service
 * for the snapshot, maintenance-service for the in-maintenance flag, and
 * asset-service whether a stale fence's transfer was recorded. Each is bounded
 * by `ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS`.
 */
export const ASSET_SYNC_UPSTREAM_CALLS_UNDER_LOCK = 3;

/** What every asset-sync transaction timeout must leave beyond those calls, for its own statements. */
export const ASSET_SYNC_TRANSACTION_MARGIN_MS = 5_000;

/**
 * Why `FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS` cannot work with the upstream
 * timeout, or undefined when it can (#240 r9). A transaction that asks upstream
 * under the lock must outlive every call it makes; one that only waits on that
 * lock (deciding a parked event) must outlive the holder. Shorter, the
 * transaction expires mid-call, rolls back and records nothing — a parked
 * event's attempts would then never advance.
 */
export function assetSyncBudgetProblem(
  env: Pick<
    FleetEnv,
    'FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS' | 'ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS'
  >,
): string | undefined {
  const needed =
    ASSET_SYNC_UPSTREAM_CALLS_UNDER_LOCK * env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS +
    ASSET_SYNC_TRANSACTION_MARGIN_MS;
  if (env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS > needed) return undefined;
  return (
    `FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS (${env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS} ms) must exceed ` +
    `${ASSET_SYNC_UPSTREAM_CALLS_UNDER_LOCK} × ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS ` +
    `(${env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS} ms) + ${ASSET_SYNC_TRANSACTION_MARGIN_MS} ms = ${needed} ms`
  );
}

export function loadFleetEnv(source: NodeJS.ProcessEnv = process.env): FleetEnv {
  const env = loadEnv(fleetEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? 'fleet-service',
    PORT: source.PORT ?? source.PORT_FLEET ?? '3104',
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_FLEET,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'fleet-service',
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'fleet-service.main',
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
  // Fail closed at startup: an invalid combination would fail every
  // re-verification at run time instead (#240 r9).
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

import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  httpUrlSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';
import { INSURANCE_COVERAGES } from '../fleet/dispatch-blocks';

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
  });

export type FleetEnv = z.infer<typeof fleetEnvSchema>;

export function loadFleetEnv(source: NodeJS.ProcessEnv = process.env): FleetEnv {
  return loadEnv(fleetEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? 'fleet-service',
    PORT: source.PORT ?? source.PORT_FLEET ?? '3104',
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_FLEET,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'fleet-service',
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'fleet-service.main',
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: FleetEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'fleet-service';

/** Everything this service publishes goes to one topic (docs/04 § 4.1). */
export const FLEET_TOPIC = 'rasta.fleet.v1';

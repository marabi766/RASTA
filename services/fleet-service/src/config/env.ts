import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

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

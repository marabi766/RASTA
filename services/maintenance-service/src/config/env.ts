import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

/**
 * maintenance-service configuration.
 */
export const maintenanceEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /**
     * How far ahead of its due point a schedule announces itself, when the
     * schedule does not state a lead of its own.
     *
     * The product asks for a warning *before* the deadline — "هشدار پیش از
     * موعد" (docs/17) — but says nothing about how far before, because that is
     * an organizational preference: a village with one grader and a workshop
     * two hours away wants more notice than a union with a yard full of
     * machines. Configuration with a conservative default rather than a
     * constant buried in the evaluator (AGENTS.md § 9), and any schedule may
     * override it.
     */
    MAINTENANCE_DEFAULT_LEAD_DAYS: z.coerce.number().int().min(0).max(365).default(7),

    /**
     * Whether this instance evaluates time-based schedules on a timer.
     *
     * Usage-based schedules need no timer — they are evaluated when
     * `USAGE_RECORDED` arrives, which is what docs/08 § 8.7 prescribes. Only
     * the time-based half needs something to notice that a date has passed,
     * and docs/08 assigns that to `MaintenanceDueScanWorkflow` in Temporal,
     * which no service on this platform runs yet.
     *
     * Until it does, the scan runs in-process. It is safe to leave on across
     * replicas because the announcement is a guarded update — see ADR-027 —
     * and it is switchable so that turning the Temporal workflow on later is a
     * configuration change followed by a deletion, not a migration.
     */
    MAINTENANCE_DUE_SCAN_ENABLED: z
      .string()
      .default('true')
      .transform((value) => value !== 'false'),

    /** How often the time-based scan runs, in seconds. */
    MAINTENANCE_DUE_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),

    /** How many schedules one scan pass evaluates. Bounds the query. */
    MAINTENANCE_DUE_SCAN_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),
  });

export type MaintenanceEnv = z.infer<typeof maintenanceEnvSchema>;

export function loadMaintenanceEnv(source: NodeJS.ProcessEnv = process.env): MaintenanceEnv {
  return loadEnv(maintenanceEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? 'maintenance-service',
    PORT: source.PORT ?? source.PORT_MAINTENANCE ?? '3105',
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_MAINTENANCE,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'maintenance-service',
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'maintenance-service.main',
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: MaintenanceEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'maintenance-service';

/** Everything this service publishes goes to one topic (docs/04 § 4.1). */
export const MAINTENANCE_TOPIC = 'rasta.maintenance.v1';

/** Where a message this service cannot process is parked (docs/07 § 7.9). */
export const MAINTENANCE_DLQ_TOPIC = 'rasta.maintenance.v1.dlq';

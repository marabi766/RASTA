import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  httpUrlSchema,
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
     * asset-service, asked whether a transfer was recorded when a work-start
     * meets an expired transfer fence (ADR-062 § 3b). Required, with no
     * default: a missing one is found at boot, not at the first expired fence.
     */
    ASSET_SERVICE_URL: httpUrlSchema,

    /** One such question, body included. A timeout refuses the work. */
    ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(3000),

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
    MAINTENANCE_DUE_SCAN_ENABLED: booleanEnv(true),

    /** How often the time-based scan runs, in seconds. */
    MAINTENANCE_DUE_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),

    /** How many schedules one scan pass evaluates. Bounds the query. */
    MAINTENANCE_DUE_SCAN_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),

    /**
     * How long an `Idempotency-Key` on `POST /v1/maintenance-requests` is
     * honoured, in hours (#157, docs/06 § 6.8: 24 by default, configurable).
     * Within it a retry replays the original 201; after it the key is free.
     */
    MAINTENANCE_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

    /**
     * How long a claim on an `Idempotency-Key` stays **in flight**, in seconds:
     * the lease a request holds while it works, separate from the hours a
     * *completed* response is kept (above).
     *
     * A process that dies after its claim committed and before its write did
     * leaves the claim behind. Without a lease of its own that claim lasted as
     * long as a stored response — a day — and every retry was a retryable 409
     * until then. Past the lease, a retry takes the claim over under a new
     * fencing token; the first holder's late work is refused by the token, never
     * committed beside the retry's.
     *
     * Floor 30 s: well above a gateway's upstream timeout (3 s by default), so a
     * request that is merely slow keeps its claim. Ceiling one hour. The default
     * is two minutes — long enough for any write here, short enough that a
     * crashed one is retried at once.
     */
    MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3_600)
      .default(120),
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

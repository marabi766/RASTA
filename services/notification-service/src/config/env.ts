import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  httpUrlSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

export const SERVICE_NAME = 'notification-service';

/** The port `.env.example` (`PORT_NOTIFICATION`) and `NOTIFICATION_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3113';

/** The service whose API resolves recipients (ADR-054 § 1). */
export const IDENTITY_SERVICE = 'identity-service';

/**
 * The consumer group, by the name `docs/07` § 7.10 already reserves for it.
 * One group across every subscribed topic (ADR-054 § 8).
 */
export const DISPATCHER_CONSUMER_GROUP = 'notification-service.dispatcher';

/** This service's own dead-letter topic (`create-topics.sh`). */
export const NOTIFICATION_DLQ_TOPIC = 'rasta.notification.v1.dlq';

/**
 * notification-service configuration.
 *
 * NTF-001 turns this service on: it owns a schema, opens a client, consumes
 * two domain topics and calls identity-service, so `databaseEnvSchema`,
 * `kafkaEnvSchema` and `authEnvSchema` are merged now. The scaffold comment
 * that said they were absent because nothing used them was true of the
 * bootstrap and is not true any more.
 *
 * `authEnvSchema` is merged for the **outbound** half of ADR-020 only: the
 * `INTERNAL_TOKEN_*` values mint the `SERVICE` token identity-service verifies.
 * No route here yet verifies an inbound token — the first one arrives with the
 * read API in NTF-002, together with the global `AuthGuard`.
 *
 * **No email provider setting appears here, and that is a decision, not an
 * omission.** ADR-054 § 6 records Q-37 — no production provider and no sender
 * identity has been chosen — as open. A key with a default would settle it
 * silently, because whatever ships as the default becomes the policy every
 * deployment runs (AGENTS.md § 9). NTF-004 is built against Mailpit and must
 * not target real recipients until Q-37 is answered.
 *
 * Every tunable below has a bounded range so a misconfiguration cannot
 * disable the control it belongs to.
 */
export const notificationEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /** Where recipient resolution goes. Never the gateway (D-007). */
    IDENTITY_SERVICE_URL: httpUrlSchema,

    /** Per-call ceiling on the identity request. */
    NOTIFICATION_IDENTITY_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(60_000)
      .default(5_000),

    /**
     * Hard ceiling on recipients per intent (ADR-054 § 1). A resolution that
     * returns more is truncated, recorded and alerted on; unbounded fan-out is
     * a self-inflicted notification storm.
     */
    NOTIFICATION_MAX_RECIPIENTS_PER_INTENT: z.coerce.number().int().min(1).max(10_000).default(500),

    /** Short cache per `(organization, role)` so a burst is not N identical calls. */
    NOTIFICATION_RECIPIENT_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3_600).default(60),

    /**
     * How long `notification_dedupe` rows are kept (ADR-054 § 3). Longer than
     * the 30-day insurance warning window and the 7-day topic retention, so a
     * replay within retention cannot re-notify a window that already fired.
     */
    NOTIFICATION_DEDUPE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(45),

    /** How long an unread in-app row stays visible before the sweep may remove it. */
    NOTIFICATION_IN_APP_TTL_DAYS: z.coerce.number().int().min(1).max(3_650).default(60),

    // Resolution worker — the claim-based loop of ADR-050's shape.
    NOTIFICATION_RESOLUTION_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
    NOTIFICATION_RESOLUTION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
    NOTIFICATION_RESOLUTION_LEASE_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),
    /** Ceiling of the retry backoff when identity is unavailable. */
    NOTIFICATION_RESOLUTION_BACKOFF_MAX_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(600),
  });

export type NotificationEnv = z.infer<typeof notificationEnvSchema>;

/**
 * Loads and validates the environment, once, at startup.
 *
 * The fallbacks are the platform's convention and each one matters:
 *
 *   PORT          falls back to `PORT_NOTIFICATION` then to 3113. The repo-root
 *                 `.env` names every service's port separately so one file can
 *                 describe the whole platform; a container sets `PORT` alone.
 *   DATABASE_URL  falls back to `DATABASE_URL_NOTIFICATION` and to nothing
 *                 else. A service that silently connected to some other
 *                 database would violate A-01 quietly.
 */
export function loadNotificationEnv(source: NodeJS.ProcessEnv = process.env): NotificationEnv {
  return loadEnv(notificationEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
    PORT: source.PORT ?? source.PORT_NOTIFICATION ?? DEFAULT_PORT,
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_NOTIFICATION,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? DISPATCHER_CONSUMER_GROUP,
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: NotificationEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** The broker list, as the platform's Kafka clients expect it. */
export function brokersOf(env: NotificationEnv): string[] {
  return env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

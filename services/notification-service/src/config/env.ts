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

/**
 * The domain topic this service publishes on.
 *
 * It had none until `NTF-002`'s audit events: this service consumed and never
 * produced, so only the dead-letter topic below existed. The name follows the
 * platform's `rasta.<domain>.v1` form, which is what `audit-service` subscribes
 * to and what `create-topics.sh` already creates.
 */
export const NOTIFICATION_TOPIC = 'rasta.notification.v1';

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
 * **The mail settings below do not answer Q-37, and are shaped so they
 * cannot.** ADR-054 § 6 records that question — which production provider,
 * which sender identity — as open, and it stays open: the adapter enum accepts
 * one value and refuses boot on any other, and the shipped sender is a
 * `.invalid` address that can never resolve. What a default settles becomes
 * the policy every deployment runs (AGENTS.md § 9), so the default here is one
 * that fails rather than one that sends as somebody. NTF-004 is built and
 * proven against Mailpit.
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

    // Mail worker — the same claim shape, against a mail server (NTF-004).
    //
    // Its own tunables rather than the resolution worker's, because the two
    // wait on different things: identity answers in milliseconds, a mail
    // server may take seconds per message. Sharing a lease length would size
    // one of them wrongly, and the one sized wrongly would be the one whose
    // leases expire mid-send.
    NOTIFICATION_MAIL_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
    /**
     * How many messages one tick may send.
     *
     * Small on purpose: a tick sends them one after another, and a batch of
     * fifty against a slow server holds a lease long enough to lose it.
     */
    NOTIFICATION_MAIL_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    NOTIFICATION_MAIL_LEASE_SECONDS: z.coerce.number().int().min(10).max(3_600).default(120),
    NOTIFICATION_MAIL_BACKOFF_MAX_SECONDS: z.coerce.number().int().min(1).max(86_400).default(600),

    // Mail channel (ADR-054 § 6, `docs/24` Q-37) ---------------------------
    /**
     * Which adapter is bound behind `MailChannel`.
     *
     * `smtp` is the only accepted value, and any other **refuses boot** —
     * exactly as `ECONOMIC_PAYMENT_PROVIDER` does for `mock` (ADR-024). The
     * failure this prevents is the worst one available here: an environment
     * configured for a real provider falling back silently to a development
     * one and reporting that it told people things it did not tell them.
     *
     * Widening this enum is how a provider is chosen, and it is not an
     * engineering decision — Q-37 stays open until somebody with the authority
     * to sign a contract makes it.
     */
    NOTIFICATION_MAIL_ADAPTER: z.enum(['smtp']).default('smtp'),

    NOTIFICATION_SMTP_HOST: z.string().min(1).default('localhost'),
    NOTIFICATION_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
    /** Implicit TLS on connect. False for Mailpit; true for a submission port. */
    NOTIFICATION_SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /** Both or neither. A user with no password is a misconfiguration, not anonymous auth. */
    NOTIFICATION_SMTP_USER: z.string().default(''),
    NOTIFICATION_SMTP_PASSWORD: z.string().default(''),
    NOTIFICATION_SMTP_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),

    /**
     * The sender identity, which **has no real default and must not get one**.
     *
     * No sender identity has been chosen for this platform (Q-37), so the
     * shipped value is a `.invalid` address: RFC 2606 reserves that TLD so it
     * can never resolve, anywhere, by accident. A misconfigured deployment
     * therefore fails to send rather than sending as somebody.
     *
     * Choosing a real domain here is half of answering Q-37; the other half is
     * the provider that is allowed to send for it.
     */
    NOTIFICATION_MAIL_FROM_ADDRESS: z.string().min(3).default('notifications@rasta.invalid'),
    NOTIFICATION_MAIL_FROM_NAME: z.string().default('رستا'),
  })
  .superRefine((env, ctx) => {
    // Credentials are a pair. One without the other is a deployment that
    // believes it is authenticating and is not — and an anonymous session to a
    // relay that expected a login fails later, further away, and less clearly.
    const user = env.NOTIFICATION_SMTP_USER.length > 0;
    const password = env.NOTIFICATION_SMTP_PASSWORD.length > 0;
    if (user !== password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOTIFICATION_SMTP_USER'],
        message:
          'NOTIFICATION_SMTP_USER and NOTIFICATION_SMTP_PASSWORD must be set together or not at all',
      });
    }
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

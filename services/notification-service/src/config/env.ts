import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@rasta/config';

export const SERVICE_NAME = 'notification-service';

/** The port `.env.example` (`PORT_NOTIFICATION`) and `NOTIFICATION_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3113';

/**
 * notification-service configuration — bootstrap only.
 *
 * Deliberately built from `baseEnvSchema` alone. What it does **not** merge is
 * the substance of this comment:
 *
 *   `databaseEnvSchema`  would make `DATABASE_URL` mandatory. This service owns
 *                        no schema and runs no migration yet, so requiring the
 *                        variable would stop the container from starting over a
 *                        dependency it never opens. `rasta_notification` exists
 *                        and `DATABASE_URL_NOTIFICATION` is registered in CI;
 *                        both are waiting for NTF-001.
 *
 *   `kafkaEnvSchema`     would advertise a broker connection and an outbox
 *                        relay. ADR-054 gives this service both — a dispatcher
 *                        consumer group and a transactional outbox — and it has
 *                        neither today. `OUTBOX_*` tuning for a relay that does
 *                        not run is configuration describing nothing.
 *
 *   `authEnvSchema`      would require a JWKS endpoint. The only routes are the
 *                        two health probes, which are `@Public`, so there is no
 *                        token to verify until NTF-002 brings the read API.
 *
 * **No email provider setting appears here, and that is a decision, not an
 * omission.** ADR-054 § 6 records Q-37 — no production provider and no sender
 * identity has been chosen — as open. A key with a default would settle it
 * silently, because whatever ships as the default becomes the policy every
 * deployment runs (AGENTS.md § 9). NTF-004 is built against Mailpit and must
 * not target real recipients until Q-37 is answered.
 */
export const notificationEnvSchema = baseEnvSchema.extend({
  CORS_ORIGINS: z.string().default(''),
});

export type NotificationEnv = z.infer<typeof notificationEnvSchema>;

/**
 * Loads and validates the environment, once, at startup.
 *
 * `PORT` falls back to `PORT_NOTIFICATION` and then to 3113, which is the
 * platform convention: the repo-root `.env` names every service's port
 * separately so one file describes the whole platform, while a container sets
 * `PORT` alone.
 */
export function loadNotificationEnv(source: NodeJS.ProcessEnv = process.env): NotificationEnv {
  return loadEnv(notificationEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
    PORT: source.PORT ?? source.PORT_NOTIFICATION ?? DEFAULT_PORT,
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

export function corsOrigins(env: NotificationEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

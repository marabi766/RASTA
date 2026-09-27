import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

export const SERVICE_NAME = 'supplier-service';

/** Every event this service publishes goes to one topic (docs/07 § 7.2). */
export const SUPPLIER_TOPIC = 'rasta.supplier.v1';

/** The port `.env.example` and the gateway's `SUPPLIER_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3108';

/**
 * supplier-service configuration.
 *
 * Nothing domain-specific is configurable yet, and that absence is deliberate.
 *
 * The obvious candidate would be the performance-score weights, which `docs/04`
 * § 4.10 requires to be configurable. They are not here because Q-12 — what the
 * weights are — is open, and a configuration key with a default is a decision:
 * whatever ships as the default becomes the policy every deployment runs. The
 * "equal weights" note in `docs/24` is a temporary placeholder in an open
 * question, not an approved production policy, and encoding it here would turn
 * it into one silently (AGENTS.md § 9).
 *
 * The second candidate would be a qualification validity period. There is none,
 * for the same reason: no accepted document states one, so there is nothing to
 * make configurable.
 */
export const supplierEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),
    /**
     * The ADR-052 step-5 performance consumer. **Off by default, and it fails
     * closed**: it writes append-only facts into the tenant a payload names,
     * so it stays off until the broker authenticates who publishes
     * (ADR-061 § 3, RUN-006). Turning it on without that is refused at
     * startup — see `assertPerformanceConsumerMayStart`. Codex review of #126.
     */
    SUPPLIER_PERFORMANCE_CONSUMER_ENABLED: booleanEnv(false),
  });

export type SupplierEnv = z.infer<typeof supplierEnvSchema>;

/**
 * Loads and validates the environment, once, at startup.
 *
 * The fallbacks are the platform's convention and each one matters:
 *
 *   PORT          falls back to `PORT_SUPPLIER` then to 3108. The repo-root
 *                 `.env` names every service's port separately so one file can
 *                 describe the whole platform; a container sets `PORT` alone.
 *   DATABASE_URL  falls back to `DATABASE_URL_SUPPLIER` and to nothing else.
 *                 There is deliberately no default: a service that silently
 *                 connected to some other database would violate A-01 quietly,
 *                 and `postgresUrlSchema` refuses an absent value loudly.
 *
 * `KAFKA_CONSUMER_GROUP` is the platform-standard default. The one consumer this
 * service registers (`app.module.ts`) names its own group,
 * `supplier-service.performance`, because its `processed_event` key is that
 * same name and must not change with an environment variable.
 */
export function loadSupplierEnv(source: NodeJS.ProcessEnv = process.env): SupplierEnv {
  const env = loadEnv(supplierEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
    PORT: source.PORT ?? source.PORT_SUPPLIER ?? DEFAULT_PORT,
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_SUPPLIER,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? `${SERVICE_NAME}.main`,
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
  assertPerformanceConsumerMayStart(env);
  return env;
}

/**
 * Whether this service's Kafka client authenticates to the broker, so that
 * the broker — not the envelope — says who published (ADR-061 § 3).
 *
 * **Always `false` today**: RUN-006 (SASL/SCRAM and per-topic ACLs) has not
 * landed, and no configuration on `main` makes the client authenticate. When
 * it lands, this reads the setting it adds, and nothing else changes.
 */
export function brokerConnectionIsAuthenticated(_env: SupplierEnv): boolean {
  return false;
}

/**
 * Refuses to start with the performance consumer enabled over a broker that
 * does not authenticate producers (Codex review of #126, finding 1).
 *
 * Until then anyone who can reach the broker can publish on
 * `rasta.marketplace.v1` as marketplace-service, with a buyer tenant that
 * passes ADR-061 § 5 and any supplier they like — and the fact would land,
 * append-only and uncleanable, in that supplier's tenant. So the flag is not
 * a warning; it is a gate.
 */
export function assertPerformanceConsumerMayStart(env: SupplierEnv): void {
  if (env.SUPPLIER_PERFORMANCE_CONSUMER_ENABLED && !brokerConnectionIsAuthenticated(env)) {
    throw new Error(
      'SUPPLIER_PERFORMANCE_CONSUMER_ENABLED=true is refused: the Kafka client is not configured ' +
        'to authenticate to the broker, so a performance fact could be forged in any supplier’s ' +
        'name. Enable it only once RUN-006 (SASL/ACL, ADR-061 § 3) is in place — or once facts are ' +
        'verified at source (docs/23 D-036).',
    );
  }
}

export function corsOrigins(env: SupplierEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function brokersOf(env: SupplierEnv): string[] {
  return env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

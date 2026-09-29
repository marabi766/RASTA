import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  kafkaEnvSchema,
  kafkaSaslConfigured,
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
     * so it may run only where the broker authenticates who publishes
     * (ADR-061 § 3, RUN-006). Turning it on anywhere else is refused at
     * startup — see `assertPerformanceConsumerMayStart`. Codex review of #126.
     * Default stays `false` even where it may run: enabling it is a
     * deployment decision (docs/23 D-036).
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
 * True exactly when this service connects **as itself, with its SASL
 * credential, over TLS**: a username and password (`kafkaSaslConfigured`), the
 * username this service's own name (the one principal the broker's ACLs know
 * it by; `kafkaConnection` refuses any other), and `KAFKA_SSL`. Anything less
 * is refused, and so is the development/test PLAINTEXT opt-out
 * (`KAFKA_ALLOW_PLAINTEXT`): an environment that sets it asserts nothing about
 * who may publish, whatever else it sets.
 *
 * What it relies on beyond this client (RUN-006, #128/#131): the broker
 * authenticates every client with SASL/SCRAM over TLS, and the only principal
 * with WRITE on `rasta.marketplace.v1` is `marketplace-service` — so a fact on
 * that topic was published by marketplace-service, and `EventConsumer`'s
 * producer check (ADR-061 § 2) agrees with the broker rather than trusting the
 * envelope. `scripts/kafka-acl.broker.test.mjs` proves that ACL on a live
 * broker in CI.
 */
export function brokerConnectionIsAuthenticated(
  env: Pick<
    SupplierEnv,
    | 'SERVICE_NAME'
    | 'KAFKA_SASL_USERNAME'
    | 'KAFKA_SASL_PASSWORD'
    | 'KAFKA_SSL'
    | 'KAFKA_ALLOW_PLAINTEXT'
  >,
): boolean {
  return (
    !env.KAFKA_ALLOW_PLAINTEXT &&
    env.KAFKA_SSL &&
    kafkaSaslConfigured(env) &&
    env.KAFKA_SASL_USERNAME === env.SERVICE_NAME
  );
}

/**
 * Refuses to start with the performance consumer enabled over a connection
 * the broker does not authenticate (Codex review of #126, finding 1).
 *
 * Without it anyone who can reach the broker can publish on
 * `rasta.marketplace.v1` as marketplace-service, with a buyer tenant that
 * passes ADR-061 § 5 and any supplier they like — and the fact would land,
 * append-only and uncleanable, in that supplier's tenant. So the flag is not
 * a warning; it is a gate.
 */
export function assertPerformanceConsumerMayStart(env: SupplierEnv): void {
  if (env.SUPPLIER_PERFORMANCE_CONSUMER_ENABLED && !brokerConnectionIsAuthenticated(env)) {
    throw new Error(
      'SUPPLIER_PERFORMANCE_CONSUMER_ENABLED=true is refused: the Kafka client does not ' +
        'authenticate to the broker as this service (its SASL credential, KAFKA_SSL=true, and no ' +
        'KAFKA_ALLOW_PLAINTEXT), so a performance fact could be forged in any supplier’s name ' +
        '(RUN-006, ADR-061 § 3, docs/23 D-036).',
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

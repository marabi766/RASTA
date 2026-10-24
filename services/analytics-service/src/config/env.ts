import { z } from 'zod';
// main.ts loads this before initTelemetry(): nothing imported here may reach @rasta/nest-common
// or kafkajs. kafkajs loaded that early is never patched, because nothing in this service's graph
// requires it again afterwards (scripts/service-telemetry-order.test.mjs) — which is why the role
// names below are checked against PLATFORM_ROLES by `DashboardAccess` at boot, not here.
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  fixedEnvMessages,
  kafkaEnvSchema,
  kafkaSaslConfigured,
  loadEnv,
} from '@rasta/config';
import { analyticsOperationBudgets } from './operation-budgets';

/** The fixed texts this schema refuses with; `loadEnv` keeps only these verbatim (#385 r2 F2). */
const { fixed, seal } = fixedEnvMessages();

export const SERVICE_NAME = 'analytics-service';

/**
 * Where this service dead-letters what it cannot process: its own topic (ADR-061 § 3).
 * It publishes nothing else — no domain event, no outbox (ADR-071 § 1).
 */
export const ANALYTICS_DEAD_LETTER_TOPIC = 'rasta.analytics.v1.dlq';

/** The port `.env.example` and the gateway's `ANALYTICS_SERVICE_URL` both name. */
export const DEFAULT_PORT = '3116';

/**
 * The oversight role. Refused by every tenant view whatever the configuration says:
 * a tenant dashboard is the aggregate of **one** organization, which is that
 * organization's detail (`docs/09` § 9.3, ADR-071 § 4). Naming it in a reader list is
 * a configuration error, not a grant.
 */
const REFUSED_ROLE = 'AUDITOR';

/** A comma-separated list, trimmed, with empty elements dropped. */
function commaList() {
  return z.string().transform((raw) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

/** A role name's shape: upper-case words. Whether the platform has it is `DashboardAccess`'s check. */
const ROLE_NAME = /^[A-Z][A-Z_]{1,63}$/;

/** A list of role names that names at least one and never the oversight role. */
function roleList(name: string) {
  return commaList().pipe(
    z
      .array(z.string().regex(ROLE_NAME, fixed(`Not a role name in ${name}`)))
      .min(1, fixed(`${name} must name at least 1 role`))
      .refine((roles) => !roles.includes(REFUSED_ROLE), {
        message: fixed(
          `${name} may not name ${REFUSED_ROLE}: the oversight role reads aggregate governance views only`,
        ),
      }),
  );
}

/**
 * analytics-service configuration.
 *
 * Every domain setting is a provisional answer the documents leave open, the narrowest
 * that still works, changeable without a code change (ADR-023, AGENTS.md § 9):
 *
 *   ANALYTICS_FLEET_DASHBOARD_ROLES     Who, in the organization a request acts for, reads
 *                                       its fleet dashboard. Default
 *                                       `ORGANIZATION_ADMIN,FLEET_MANAGER` — the audience
 *                                       `docs/16` § 16.7 names and the role `docs/09` § 9.3
 *                                       gives everything in its own organization.
 *                                       SYSTEM_ADMIN is always accepted for an organization it
 *                                       selected; AUDITOR, an unknown role or an empty list
 *                                       stops startup.
 *   ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED
 *                                       The MAINTENANCE_COMPLETED projection. **Off by default,
 *                                       and it fails closed**: a fact is written into the tenant
 *                                       an envelope names, so it may run only where the broker
 *                                       authenticates who publishes (ADR-061 § 3, RUN-006) — see
 *                                       {@link assertConsumerMayStart}. Enabling it is a
 *                                       deployment decision, as for supplier-service's consumer.
 *
 * KPI readers use the same configured roles (ADR-071 § 4). KPI definitions live in code;
 * baseline writing remains absent pending Q-142 (1). Governance thresholds belong to later PRs.
 */
export const analyticsEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),
    ANALYTICS_FLEET_DASHBOARD_ROLES: roleList('ANALYTICS_FLEET_DASHBOARD_ROLES').default(
      'ORGANIZATION_ADMIN,FLEET_MANAGER',
    ),
    ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED: booleanEnv(false),
  });

export const ANALYTICS_ENV_MESSAGES = seal();

export type AnalyticsEnv = z.infer<typeof analyticsEnvSchema>;

/**
 * Loads and validates the environment, once, at startup.
 *
 *   PORT          falls back to `PORT_ANALYTICS` then to 3116.
 *   DATABASE_URL  falls back to `DATABASE_URL_ANALYTICS` and to nothing else: a service
 *                 that silently connected to some other database would break A-01 quietly.
 *
 * `KAFKA_CONSUMER_GROUP` is the platform-standard default only. The consumer names its own
 * group, `analytics-service.maintenance-facts`, because that name is also its
 * `processed_event` key and must not change with an environment variable.
 */
export function loadAnalyticsEnv(source: NodeJS.ProcessEnv = process.env): AnalyticsEnv {
  const env = loadEnv(
    analyticsEnvSchema,
    {
      ...source,
      SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
      PORT: source.PORT ?? source.PORT_ANALYTICS ?? DEFAULT_PORT,
      DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_ANALYTICS,
      KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
      KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? `${SERVICE_NAME}.main`,
      CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
    },
    { operationBudgets: analyticsOperationBudgets, fixedMessages: ANALYTICS_ENV_MESSAGES },
  );
  assertConsumerMayStart(env);
  return env;
}

/**
 * Whether this service's Kafka client authenticates to the broker as itself — its SASL
 * credential, over TLS, and no development PLAINTEXT opt-out — so that the broker, not the
 * envelope, says who published (ADR-061 § 3). The same rule as supplier-service's, stated
 * here because services share no source (A-02).
 */
export function brokerConnectionIsAuthenticated(
  env: Pick<
    AnalyticsEnv,
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
 * Refuses to start with the projection enabled over a connection the broker does not
 * authenticate. Without it anyone who reaches the broker could publish on
 * `rasta.maintenance.v1` as maintenance-service and land an append-only fact in any
 * organization's dashboard. A gate, not a warning.
 */
export function assertConsumerMayStart(env: AnalyticsEnv): void {
  if (env.ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED && !brokerConnectionIsAuthenticated(env)) {
    throw new Error(
      'ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED=true is refused: the Kafka client does not ' +
        'authenticate to the broker as this service (its SASL credential, KAFKA_SSL=true, and no ' +
        'KAFKA_ALLOW_PLAINTEXT), so a maintenance fact could be forged in any organization’s name ' +
        '(RUN-006, ADR-061 § 3, ADR-071 § 1).',
    );
  }
}

export function corsOrigins(env: AnalyticsEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

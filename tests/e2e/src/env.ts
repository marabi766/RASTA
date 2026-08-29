/**
 * Where the stack under test is.
 *
 * Every value is read from the environment with a default that matches
 * `.env.example`, so a developer who ran `pnpm infra:up` and started the two
 * services needs no extra configuration — and CI, which uses different ports
 * and a different Kafka listener, needs no code change.
 *
 * Nothing here has a credential baked in. The one password these tests need is
 * the throwaway one the development realm already publishes, and it is read
 * from that realm file at runtime rather than copied into a second place —
 * see `keycloak.ts`.
 */

function required(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    throw new Error(
      `${name} is not set and has no default. These tests run against a real stack; ` +
        'see tests/e2e/README.md.',
    );
  }
  return value;
}

export interface E2eConfig {
  /** The api-gateway base URL. Every request in these tests goes through it. */
  gatewayUrl: string;
  /** economic-service directly — used only for health gating, never for assertions. */
  economicUrl: string;
  keycloakUrl: string;
  realm: string;
  /** The public client with direct access grants enabled in the dev realm. */
  clientId: string;
  kafkaBrokers: string[];
  /** Topic economic-service publishes to. */
  economicTopic: string;
  /** Keycloak admin, used once to reconcile the E2E users into an imported realm. */
  keycloakAdmin: { username: string; password: string };
  /**
   * The shared secret internal service tokens are signed with.
   *
   * Needed because one scenario acts as `marketplace-service` rather than as a
   * person, which is the path `docs/08` § 8.6 specifies for the order saga.
   * It is the same throwaway development value the running services are
   * configured with — the suite has to hold it to mint a token they will
   * accept, exactly as a real calling service would.
   */
  internalTokenSecret: string;
}

export function e2eConfig(): E2eConfig {
  const gatewayPort = process.env.PORT_API_GATEWAY?.trim() || '3000';

  return {
    gatewayUrl: required('E2E_GATEWAY_URL', `http://localhost:${gatewayPort}`).replace(/\/+$/, ''),
    economicUrl: required(
      'E2E_ECONOMIC_URL',
      `http://localhost:${process.env.PORT_ECONOMIC?.trim() || '3112'}`,
    ).replace(/\/+$/, ''),
    keycloakUrl: required('KEYCLOAK_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    realm: required('KEYCLOAK_REALM', 'rasta'),
    clientId: required('KEYCLOAK_WEB_CLIENT_ID', 'rasta-web'),
    kafkaBrokers: required('KAFKA_BROKERS', 'localhost:9092')
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean),
    economicTopic: 'rasta.economic.v1',
    keycloakAdmin: {
      username: required('KEYCLOAK_ADMIN', 'admin'),
      password: required('KEYCLOAK_ADMIN_PASSWORD', 'admin_dev_password'),
    },
    internalTokenSecret: required(
      'INTERNAL_TOKEN_SECRET',
      'internal_dev_secret_change_me_at_least_32_chars',
    ),
  };
}

/**
 * The four organizations these tests act for.
 *
 * `ORG-DEH-0001` and `ORG-DEH-0002` are both in organization-service's seed, so
 * the cross-tenant assertions are between two tenants that genuinely exist
 * rather than between a tenant and an empty set.
 */
export const ORG = {
  /** Tenant A — the payer in the critical path. */
  a: 'ORG-DEH-0001',
  /** Tenant B — the payee, and the tenant that must never see A's records. */
  b: 'ORG-DEH-0002',
  /** Platform scope. Reads the trial balance. */
  platform: 'ORG-UNION-YAZD',
  /** The oversight tenant. Its role must reach nothing in this service. */
  oversight: 'ORG-PROVINCE-YAZD',
} as const;

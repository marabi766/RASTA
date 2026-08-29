import { request } from '@playwright/test';
import { Kafka, logLevel } from 'kafkajs';
import { e2eConfig } from './src/env';
import { accessToken, ensureTenantBUser, E2E_USERS } from './src/keycloak';
import { waitFor } from './src/events';

/**
 * Refuses to start unless the whole stack is genuinely there.
 *
 * Every check below is positive: it asks a component to do the thing the tests
 * depend on and fails with the reason if it cannot. That is deliberate. The
 * failure mode this exists to prevent is a suite that quietly skips — a green
 * E2E stage that ran nothing is worse than a red one, because it is read as
 * evidence (PROJECT_MEMORY § 19).
 *
 * There is no `--pass-with-no-tests` anywhere in this package, and nothing here
 * degrades to a mock when a dependency is missing.
 */
export default async function globalSetup(): Promise<void> {
  const config = e2eConfig();
  const started = Date.now();

  const context = await request.newContext();
  try {
    // ---- economic-service ---------------------------------------------------
    // Its readiness probe reports the database and the broker separately, so a
    // failure here names the dependency rather than the service.
    await waitFor(
      `economic-service to be ready at ${config.economicUrl}/health/ready`,
      async () => {
        const response = await context.get(`${config.economicUrl}/health/ready`, {
          failOnStatusCode: false,
        });
        return response.status() === 200;
      },
      120_000,
    );

    // ---- api-gateway --------------------------------------------------------
    // The gateway owns no health endpoint — it serves `/v1/*` and nothing else
    // (ADR-009). Probing it with an unauthenticated call to a closed route
    // proves three things at once: the process is up, the routing table
    // resolves the economic prefix, and the endpoint is closed by default
    // (AGENTS.md S-02).
    await waitFor(
      `api-gateway to answer 401 for an unauthenticated GET ${config.gatewayUrl}/v1/wallets/me`,
      async () => {
        const response = await context.get(`${config.gatewayUrl}/v1/wallets/me`, {
          failOnStatusCode: false,
        });
        return response.status() === 401;
      },
      120_000,
    );

    // ---- Keycloak -----------------------------------------------------------
    await waitFor(
      `Keycloak realm ${config.realm} to be reachable`,
      async () => {
        const response = await context.get(
          `${config.keycloakUrl}/realms/${config.realm}/.well-known/openid-configuration`,
          { failOnStatusCode: false },
        );
        return response.status() === 200;
      },
      180_000,
    );

    const reconciled = await ensureTenantBUser(config);
    console.warn(`[e2e] second-tenant user ${E2E_USERS.tenantB}: ${reconciled}`);

    // Prove every actor can actually authenticate before a single scenario
    // runs. A token failure inside a test reads as a domain failure.
    for (const username of Object.values(E2E_USERS)) {
      await accessToken(username, config);
    }

    // ---- Kafka --------------------------------------------------------------
    // Required, not optional. The correlation scenario asserts on what the
    // service published, and a broker that is merely assumed to be there turns
    // that scenario into one that silently proves nothing.
    const kafka = new Kafka({
      clientId: 'e2e-global-setup',
      brokers: config.kafkaBrokers,
      logLevel: logLevel.ERROR,
    });
    const admin = kafka.admin();
    await admin.connect();
    try {
      const topics = await admin.listTopics();
      if (!topics.includes(config.economicTopic)) {
        throw new Error(
          `Topic ${config.economicTopic} does not exist on ${config.kafkaBrokers.join(', ')}. ` +
            'Auto-creation is off by design (ADR-006); create it with ' +
            'infrastructure/docker/kafka/create-topics.sh.',
        );
      }
    } finally {
      await admin.disconnect();
    }

    console.warn(`[e2e] stack verified in ${Date.now() - started}ms`);
  } finally {
    await context.dispose();
  }
}

import { request } from '@playwright/test';
import { Kafka, logLevel } from 'kafkajs';
import { e2eConfig } from './src/env';
import { accessToken, ensureTenantBUser, E2E_USERS, verifyDisposableRealm } from './src/keycloak';
import { waitFor } from './src/events';
import { assertDisposableE2eTarget } from './src/target-guard';

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
 *
 * **Every check runs before the first write** (Codex review of #117,
 * finding 3): each service including marketplace, the gateway, Keycloak and
 * its disposable-realm marker, the Kafka cluster and every topic a scenario
 * reads. Only then does anything write — `ensureTenantBUser` — or ask for a
 * token. A stack that fails any check is left exactly as it was.
 */
export default async function globalSetup(): Promise<void> {
  const config = e2eConfig();
  // Before any request: this suite creates a Keycloak user, may rewrite the
  // realm's user profile, and moves money. It runs only as an explicit test
  // run against a stack that is entirely on loopback (src/target-guard.ts).
  assertDisposableE2eTarget(config);
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

    // ---- marketplace-service ------------------------------------------------
    // The order scenarios read its saga view directly and tap its topic; a
    // suite that started without it would fail as a timeout in a scenario.
    await waitFor(
      `marketplace-service to be ready at ${config.marketplaceUrl}/health/ready`,
      async () => {
        const response = await context.get(`${config.marketplaceUrl}/health/ready`, {
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

    // ---- document-service ---------------------------------------------------
    // Its readiness probe reports the database and object storage separately.
    // ADR-014 puts the file outside the service, so a bucket that is not there
    // makes every upload scenario fail at the PUT — a failure that names MinIO
    // here rather than looking like a broken signed URL later.
    await waitFor(
      `document-service to be ready at ${config.documentUrl}/health/ready`,
      async () => {
        const response = await context.get(`${config.documentUrl}/health/ready`, {
          failOnStatusCode: false,
        });
        return response.status() === 200;
      },
      120_000,
    );

    // ---- audit-service ------------------------------------------------------
    // Its readiness probe answers 200 only once the domain projector has
    // actually joined its consumer group. Gated here rather than inside a
    // scenario, because a suite that started before the projector was
    // consuming would look for a record nothing could have written yet and
    // fail as a timeout blaming the query API.
    await waitFor(
      `audit-service to be ready at ${config.auditUrl}/health/ready`,
      async () => {
        const response = await context.get(`${config.auditUrl}/health/ready`, {
          failOnStatusCode: false,
        });
        return response.status() === 200;
      },
      120_000,
    );

    // ---- identity-service -----------------------------------------------------
    // AUD-004 Phase C1: the refusal scenario needs identity-service's refusal
    // relay actually running, or a refusal published nothing and the audit
    // scenario times out blaming the wrong component (see audit-service
    // above for the same reasoning on its own consumer).
    await waitFor(
      `identity-service to be ready at ${config.identityUrl}/health/ready`,
      async () => {
        const response = await context.get(`${config.identityUrl}/health/ready`, {
          failOnStatusCode: false,
        });
        return response.status() === 200;
      },
      120_000,
    );

    // ---- construction-service -------------------------------------------------
    // The project lifecycle scenario drives it through the gateway and taps its
    // topic; its readiness probe reports the database and the broker.
    await waitFor(
      `construction-service to be ready at ${config.constructionUrl}/health/ready`,
      async () => {
        const response = await context.get(`${config.constructionUrl}/health/ready`, {
          failOnStatusCode: false,
        });
        return response.status() === 200;
      },
      120_000,
    );

    // ---- organization-service -------------------------------------------------
    // construction-service asks it whether an organization is within a
    // policy author's union (Q-70 (7)); without it every union write would be
    // refused (fail closed) and the approval scenario would fail far from here.
    await waitFor(
      `organization-service to be ready at ${config.organizationUrl}/health/ready`,
      async () => {
        const response = await context.get(`${config.organizationUrl}/health/ready`, {
          failOnStatusCode: false,
        });
        return response.status() === 200;
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

    // The realm must be the disposable development one: a non-mutating admin
    // GET, before anything below writes to it (src/target-guard.ts).
    await verifyDisposableRealm(config);

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
      // The cluster answers as a cluster, not merely a port that accepts TCP.
      const cluster = await admin.describeCluster();
      if (cluster.brokers.length === 0) {
        throw new Error(`Kafka at ${config.kafkaBrokers.join(', ')} reports no brokers.`);
      }
      const topics = await admin.listTopics();
      // Every topic a scenario taps — marketplace's too.
      for (const topic of [
        config.economicTopic,
        config.marketplaceTopic,
        config.documentTopic,
        config.constructionTopic,
      ]) {
        if (!topics.includes(topic)) {
          throw new Error(
            `Topic ${topic} does not exist on ${config.kafkaBrokers.join(', ')}. ` +
              'Auto-creation is off by design (ADR-006); create it with ' +
              'infrastructure/docker/kafka/create-topics.sh.',
          );
        }
      }
    } finally {
      await admin.disconnect();
    }

    console.warn(`[e2e] stack verified in ${Date.now() - started}ms`);

    // ---- writes, only now ---------------------------------------------------
    const reconciled = await ensureTenantBUser(config);
    console.warn(`[e2e] second-tenant user ${E2E_USERS.tenantB}: ${reconciled}`);

    // Prove every actor can actually authenticate before a single scenario
    // runs. A token failure inside a test reads as a domain failure.
    for (const username of Object.values(E2E_USERS)) {
      await accessToken(username, config);
    }
  } finally {
    await context.dispose();
  }
}

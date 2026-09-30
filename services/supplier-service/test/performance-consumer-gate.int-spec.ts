import { Test, type TestingModule } from '@nestjs/testing';
import { Kafka, type Producer } from 'kafkajs';
import type { EventEnvelope } from '@rasta/contracts';
import { kafkaClientConfig, kafkaConnectionFor, OutboxRelay } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { SERVICE_NAME } from '../src/config/env';
import { PerformanceEventRepository } from '../src/performance/performance-event.repository';
import { PERFORMANCE_CONSUMED_TOPICS } from '../src/performance/performance.consumer';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asSupplier, brokers, databaseUrl, newOrganizationId, newPrisma } from './helpers';

/**
 * The performance consumer's gate against the authenticated broker (RUN-006,
 * docs/23 D-036, ADR-052 § 25).
 *
 * The rest of the suite builds the consumer by hand; this one boots the real
 * `AppModule` from `process.env`, exactly as a deployment does, so the path
 * under test is the whole one: `loadSupplierEnv` → the gate
 * (`brokerConnectionIsAuthenticated`) → `kafkaConnection` → a SASL/SCRAM join
 * over TLS as `supplier-service`, reading a fact marketplace-service published.
 *
 * What the gate relies on beyond this client — that no principal but
 * marketplace-service may write `rasta.marketplace.v1` — is proven on the
 * same broker by `scripts/kafka-acl.broker.test.mjs` ("3. only a topic's
 * owner writes it": supplier-service, economic-service and ops-replay are
 * refused TOPIC_AUTHORIZATION_FAILED), which CI runs in the same job.
 */

const brokerList = brokers();
const describeWithKafka = brokerList ? describe : describe.skip;
if (!brokerList) {
  console.warn('[performance-consumer-gate] KAFKA_BROKERS is not set — skipping the broker tests');
}

/** What the booted application reads, set for one boot and restored after. */
const APPLICATION_ENV = [
  'SERVICE_NAME',
  'DATABASE_URL',
  'OIDC_ISSUER_URL',
  'OIDC_JWKS_URI',
  'OIDC_AUDIENCE',
  'INTERNAL_TOKEN_SECRET',
  'SUPPLIER_PERFORMANCE_CONSUMER_ENABLED',
  'KAFKA_ALLOW_PLAINTEXT',
  'NODE_ENV',
] as const;

function withApplicationEnv(overrides: Partial<Record<(typeof APPLICATION_ENV)[number], string>>) {
  const saved = Object.fromEntries(APPLICATION_ENV.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    SERVICE_NAME,
    DATABASE_URL: databaseUrl(),
    OIDC_ISSUER_URL: 'http://gatetest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://gatetest.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'performance_consumer_gate_suite_secret_32',
    NODE_ENV: 'test',
  });
  delete process.env.KAFKA_ALLOW_PLAINTEXT;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const inertRelay = { start: () => undefined, stop: async () => undefined };

function compile(): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OutboxRelay)
    .useValue(inertRelay)
    .compile();
}

async function eventually<T>(
  what: string,
  probe: () => Promise<T | undefined | null>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describeWithKafka('the performance consumer gate, on the authenticated broker', () => {
  beforeAll(() => {
    // A broker here authenticates (compose and CI, RUN-006): a run without
    // this service's credential is misconfigured, not a reason to skip.
    if (!process.env.KAFKA_SASL_PASSWORD_SUPPLIER && !process.env.KAFKA_SASL_PASSWORD) {
      throw new Error(
        'KAFKA_SASL_PASSWORD_SUPPLIER is not set: this suite needs supplier-service’s broker credential',
      );
    }
    if (process.env.KAFKA_SSL !== 'true') {
      throw new Error('KAFKA_SSL is not true: the authenticated broker is reached over TLS only');
    }
  });

  it('refuses to boot with the consumer enabled under the PLAINTEXT opt-out', async () => {
    const restore = withApplicationEnv({
      SUPPLIER_PERFORMANCE_CONSUMER_ENABLED: 'true',
      KAFKA_ALLOW_PLAINTEXT: 'true',
    });
    try {
      await expect(compile()).rejects.toThrow(
        /SUPPLIER_PERFORMANCE_CONSUMER_ENABLED=true is refused/,
      );
    } finally {
      restore();
    }
  });

  describe('enabled, over this service’s own SASL credential and TLS', () => {
    let restore: () => void;
    let moduleRef: TestingModule;
    let prisma: PrismaService;
    let producer: Producer;

    beforeAll(async () => {
      restore = withApplicationEnv({ SUPPLIER_PERFORMANCE_CONSUMER_ENABLED: 'true' });
      moduleRef = await compile();
      // onModuleInit: the gate has already let the consumer through; this
      // starts it, joining `supplier-service.performance` as supplier-service.
      await moduleRef.init();

      prisma = newPrisma();
      const marketplace = new Kafka({
        ...kafkaClientConfig(kafkaConnectionFor('marketplace-service', 'supplier-gate-itest')),
        logLevel: 1,
      });
      producer = marketplace.producer({ idempotent: true, maxInFlightRequests: 1 });
      await producer.connect();
    }, 120_000);

    afterAll(async () => {
      await producer?.disconnect();
      await moduleRef?.close();
      await prisma?.onModuleDestroy();
      restore?.();
    }, 60_000);

    it('records a fact marketplace-service published', async () => {
      const buyer = newOrganizationId();
      const supplier = newOrganizationId();
      const orderId = `ORD_${ulid()}`;
      const events = new PerformanceEventRepository(prisma);
      const review = (): EventEnvelope => ({
        eventId: `EVT_${ulid()}`,
        eventName: 'REVIEW_SUBMITTED',
        eventVersion: 1,
        occurredAt: '2026-09-29T08:00:00.000Z',
        producer: 'marketplace-service',
        producerVersion: '1.0.0',
        aggregateType: 'Order',
        aggregateId: orderId,
        tenantId: buyer,
        correlationId: `COR_${ulid()}`,
        payload: {
          orderId,
          buyerOrganizationId: buyer,
          supplierOrganizationId: supplier,
          reviewId: `REV_${ulid()}`,
          rating: 4,
          submittedAt: '2026-09-29T08:00:00.000Z',
        },
      });

      // The group reads from the beginning (ADR-052 § 12), so this run's fact
      // may wait behind what the shared broker already holds; it is published
      // again until one lands, and each is recorded at most once.
      const facts = await eventually(
        'the consumer to record the fact',
        async () => {
          await producer.send({
            topic: PERFORMANCE_CONSUMED_TOPICS[0],
            messages: [{ key: orderId, value: JSON.stringify(review()) }],
          });
          const rows = await asSupplier(supplier, () =>
            events.listInWindow(new Date('2000-01-01'), new Date('2100-01-01')),
          );
          return rows.length > 0 ? rows : undefined;
        },
        180_000,
      );
      expect(facts[0]).toMatchObject({ component: 'CUSTOMER_SATISFACTION', rating: 4 });
    }, 240_000);
  });
});

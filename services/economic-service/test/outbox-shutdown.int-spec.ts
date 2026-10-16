import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eventEnvelopeSchema } from '@rasta/contracts';
import {
  AUTH_OPTIONS,
  EventConsumer,
  installGracefulShutdown,
  OutboxPurgeScheduler,
  OutboxRelay,
  type AuthGuardOptions,
  type InternalTokenService,
  type OutboxClaim,
  type OutboxRow,
  type PurgePublishedBatch,
  type TokenVerifier,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { ENV, SOURCE_FACTS } from '../src/tokens';
import { loadEconomicEnv, SERVICE_NAME, type EconomicEnv } from '../src/config/env';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { PaymentReconciliationSweeper } from '../src/payment/payment-reconciliation.sweeper';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import type { SourceFacts } from '../src/provenance/source-facts.client';
import { databaseUrl, PLATFORM_ORGANIZATION_ID } from './helpers';

/**
 * The whole shutdown path through the real AppModule, with both Kafka
 * consumers on the real `EventConsumer`.
 *
 * Codex r1 on #277 (Medium): `SettlementAuthorityConsumer` and
 * `RewardTriggerConsumer` each stopped in their own `onApplicationShutdown`
 * with no bound, after `OutboxShutdown` had drained the relay, the purge and
 * the payment sweep in the destroy phase. kafkajs's `disconnect()` waits for
 * the message in flight, so a handler still running when the drain ended — one
 * still waiting on maintenance-service or fleet-service, say — held the close
 * past SHUTDOWN_TIMEOUT_MS into the forced exit. Both consumers are now
 * `OutboxShutdown` workers, stopped beside the relay and the purge by the one
 * deadline (#270's `stop({ deadlineAt })`); their own hooks only join that
 * stop, and a message they abandon is not committed — the group delivers it
 * again.
 *
 * The settings make the old order fail by construction: relay grace 6 s, purge
 * batch bound 5.2 s (100 ms wait + 100 ms statement + 5 s margin), budget 7 s,
 * timeout 9 s. A handler that never finishes, stopped after the drain: never.
 *
 * Stand-ins: the outbox store and the publisher (the relay and the purge claim
 * and delete across the whole table by design, so the shared database's own
 * outbox is left alone); the payment sweep (it would sweep rows other suites
 * assert on; its own stop is proven in its spec); maintenance-service and
 * fleet-service as the facts' owners; and kafkajs under the real
 * `EventConsumer` — a fake that, as kafkajs does, commits a message only when
 * its `eachMessage` returned, so no broker is reached and the shared groups are
 * left alone. The consumers' wiring, their handlers and the close are the real
 * ones; each handler is held on the owner's answer.
 */
const SHUTDOWN_TIMEOUT_MS = 9000;
const GRACE_SECONDS = 6;
/** `outboxShutdownBudgetMs`: the timeout less the 2 s reserve. */
const BUDGET_MS = 7000;

const probeRow = (): OutboxRow => ({
  id: 'SHUTDOWN-PROBE',
  aggregateType: 'Probe',
  aggregateId: 'SHUTDOWN-PROBE',
  eventName: 'PROBE',
  eventVersion: 1,
  topic: 'rasta.economic.v1',
  partitionKey: 'SHUTDOWN-PROBE',
  payload: {},
  headers: {},
  organizationId: 'ORG-SHUTDOWN-PROBE',
  correlationId: 'SHUTDOWN-PROBE',
  createdAt: new Date(),
  publishedAt: null,
  attempts: 0,
  lastError: null,
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A MAINTENANCE_APPROVED, as maintenance-service publishes it. */
const maintenanceApproved = (): Buffer => {
  const organizationId = `ORG-SHUTDOWN-${ulid()}`;
  const requestId = `MNT_${ulid()}`;
  return Buffer.from(
    JSON.stringify(
      eventEnvelopeSchema.parse({
        eventId: ulid(),
        eventName: 'MAINTENANCE_APPROVED',
        occurredAt: new Date().toISOString(),
        producer: 'maintenance-service',
        aggregateType: 'MaintenanceRequest',
        aggregateId: requestId,
        tenantId: organizationId,
        correlationId: ulid(),
        payload: {
          requestId,
          assetId: `AST_${ulid()}`,
          organizationId,
          approvedBy: 'USR-SHUTDOWN',
          approvedAt: new Date().toISOString(),
          workshopOrganizationId: `ORG-SHUTDOWN-${ulid()}`,
          totalCostMinor: '450000',
          currency: 'IRR',
        },
      }),
    ),
  );
};

/** A USAGE_RECORDED, as fleet-service publishes it. */
const usageRecorded = (): Buffer => {
  const organizationId = `ORG-SHUTDOWN-${ulid()}`;
  const usageRecordId = `USG_${ulid()}`;
  return Buffer.from(
    JSON.stringify(
      eventEnvelopeSchema.parse({
        eventId: ulid(),
        eventName: 'USAGE_RECORDED',
        occurredAt: new Date().toISOString(),
        producer: 'fleet-service',
        aggregateType: 'UsageRecord',
        aggregateId: usageRecordId,
        tenantId: organizationId,
        correlationId: ulid(),
        payload: {
          usageRecordId,
          assetId: `AST_${ulid()}`,
          organizationId,
          hours: '8',
        },
      }),
    ),
  );
};

type EachMessage = (payload: {
  topic: string;
  partition: number;
  message: { value: Buffer; headers: Record<string, never>; offset: string; key: null };
  heartbeat: () => Promise<void>;
  pause: () => () => void;
}) => Promise<void>;

/** kafkajs's consumer, reduced to what decides the outcome: commit only on return. */
class FakeKafkaConsumer {
  readonly committed: string[] = [];
  readonly uncommitted: string[] = [];
  private eachMessage?: EachMessage;
  private inFlight: Promise<void> = Promise.resolve();
  constructor(private readonly topic: string) {}
  async connect(): Promise<void> {}
  async subscribe(): Promise<void> {}
  async run(config: { eachMessage: EachMessage }): Promise<void> {
    this.eachMessage = config.eachMessage;
  }
  deliver(offset: string, value: Buffer): Promise<void> {
    if (!this.eachMessage) throw new Error('the consumer is not running');
    this.inFlight = this.eachMessage({
      topic: this.topic,
      partition: 0,
      message: { value, headers: {}, offset, key: null },
      heartbeat: async () => undefined,
      pause: () => () => undefined,
    }).then(
      () => void this.committed.push(offset),
      () => void this.uncommitted.push(offset),
    );
    return this.inFlight;
  }
  /** Like kafkajs: waits for the message in flight before it resolves. */
  async disconnect(): Promise<void> {
    await this.inFlight;
  }
}

interface Booted {
  app: INestApplication;
  env: EconomicEnv;
  calls: { publish: number; purge: number; maintenance: number; usage: number };
  settlements: FakeKafkaConsumer;
  rewards: FakeKafkaConsumer;
}

const inert = { start: () => undefined, stop: async () => undefined };

/**
 * The real AppModule with the stand-ins above. `maintenanceRequest` and
 * `usageRecord` answer for the facts' owners, and `relayRow` decides whether
 * the relay claims a probe whose publish never returns.
 */
async function boot(options: {
  maintenanceRequest: () => Promise<null>;
  usageRecord: () => Promise<null>;
  relayRow: boolean;
}): Promise<Booted> {
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    // Nothing connects: kafkajs is the fake below (RUN-006 opt-out, test only).
    KAFKA_ALLOW_PLAINTEXT: 'true',
    OIDC_ISSUER_URL: 'http://economictest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://economictest.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: `itest-${'x'.repeat(40)}`,
    // Never dialled: SOURCE_FACTS is the stand-in below.
    MAINTENANCE_SERVICE_URL: 'http://127.0.0.1:9',
    FLEET_SERVICE_URL: 'http://127.0.0.1:9',
    ECONOMIC_PLATFORM_ORGANIZATION_ID: PLATFORM_ORGANIZATION_ID,
    // The balance audit's own stop is not this suite's (and not this PR's).
    ECONOMIC_BALANCE_AUDIT_ENABLED: 'false',
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    OUTBOX_SHUTDOWN_GRACE_SECONDS: String(GRACE_SECONDS),
    OUTBOX_POLL_INTERVAL_MS: '50',
    OUTBOX_PURGE_MAX_WAIT_MS: '100',
    OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '100',
    // No scheduled run: the test puts the one batch in flight itself.
    OUTBOX_PURGE_INTERVAL_SECONDS: '86400',
  };
  const env = loadEconomicEnv(source);

  const calls = { publish: 0, purge: 0, maintenance: 0, usage: 0 };
  let claimed = !options.relayRow;
  const store: Partial<Record<keyof PrismaOutboxStore, unknown>> = {
    claimPending: async (): Promise<OutboxClaim> => {
      if (claimed) return { token: null, rows: [], reclaimed: 0 };
      claimed = true;
      return { token: 'tok-shutdown', rows: [probeRow()], reclaimed: 0 };
    },
    markPublished: async (ids: readonly string[]) => ids.length,
    markFailed: async () => 1,
    release: async (ids: readonly string[]) => ids.length,
    renew: async (ids: readonly string[]) => [...ids],
    oldestPendingAgeSeconds: async () => 0,
    pendingCount: async () => 0,
    activeLeaseCount: async () => 0,
    purgePublished: (): Promise<PurgePublishedBatch> => {
      calls.purge += 1;
      return never();
    },
  };

  // The real EventConsumers the AppModule builds, each with kafkajs swapped for
  // its own fake before it connects. No dead letter is reached here.
  const fakes = new Map<string, FakeKafkaConsumer>([
    [SettlementAuthorityConsumer.CONSUMER_NAME, new FakeKafkaConsumer('rasta.maintenance.v1')],
    [RewardTriggerConsumer.CONSUMER_NAME, new FakeKafkaConsumer('rasta.fleet.v1')],
  ]);
  const realStart = EventConsumer.prototype.start;
  jest.spyOn(EventConsumer.prototype, 'start').mockImplementation(function (this: EventConsumer) {
    const { groupId } = (this as unknown as { options: { groupId: string } }).options;
    const fake = fakes.get(groupId);
    if (!fake) throw new Error(`no fake broker for ${groupId}`);
    (this as unknown as { kafka: unknown }).kafka = {
      consumer: () => fake,
      producer: () => {
        throw new Error('no dead letter is expected in this suite');
      },
    };
    return realStart.call(this);
  });
  const sources: SourceFacts = {
    maintenanceRequest: () => {
      calls.maintenance += 1;
      return options.maintenanceRequest();
    },
    usageRecord: () => {
      calls.usage += 1;
      return options.usageRecord();
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaOutboxStore)
    .useValue(store)
    .overrideProvider(KafkaEventPublisher)
    .useValue({
      publish: () => {
        calls.publish += 1;
        return never<void>();
      },
      isHealthy: async () => true,
    })
    .overrideProvider(SOURCE_FACTS)
    .useValue(sources)
    .overrideProvider(PaymentReconciliationSweeper)
    .useValue({ ...inert, onModuleInit: () => undefined })
    .overrideProvider(AUTH_OPTIONS)
    .useValue({
      serviceName: SERVICE_NAME,
      tokenVerifier: {} as unknown as TokenVerifier,
      internalTokens: {} as unknown as InternalTokenService,
    } satisfies AuthGuardOptions)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    env,
    calls,
    settlements: fakes.get(SettlementAuthorityConsumer.CONSUMER_NAME)!,
    rewards: fakes.get(RewardTriggerConsumer.CONSUMER_NAME)!,
  };
}

async function closeUnderDeadline(
  booted: Booted,
): Promise<{ exits: number[]; errors: string[]; tookMs: number }> {
  const exits: number[] = [];
  const errors: string[] = [];
  const shutdown = installGracefulShutdown(booted.app, {
    serviceName: SERVICE_NAME,
    timeoutMs: booted.env.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => exits.push(code),
    signalSource: new EventEmitter(),
    logger: { warn: () => undefined, error: (message) => errors.push(message) },
  });
  const startedAt = Date.now();
  await shutdown.shutdown('SIGTERM');
  return { exits, errors, tookMs: Date.now() - startedAt };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('economic-service shutdown: relay, purge and both consumers by one deadline (D-052)', () => {
  let booted: Booted | undefined;

  afterEach(async () => {
    // Closed by the test; a second close is a no-op either way.
    await booted?.app.close().catch(() => undefined);
    booted = undefined;
    jest.restoreAllMocks();
  });

  it('finishes the close under SHUTDOWN_TIMEOUT_MS with a publish, a purge batch and both consumers’ handlers never ending', async () => {
    booted = await boot({ maintenanceRequest: never, usageRecord: never, relayRow: true });
    const { app, calls, settlements, rewards } = booted;
    expect(app.get(OutboxRelay)).toBeInstanceOf(OutboxRelay);
    const purge = app.get(OutboxPurgeScheduler);
    expect(purge.stopBoundMs).toBe(5200);

    // The relay's poll claims the probe and its publish hangs; the purge's
    // batch hangs too; and neither owner ever answers.
    void purge.runOnce();
    void settlements.deliver('101', maintenanceApproved());
    void rewards.deliver('102', usageRecorded());
    await until(
      () => calls.publish > 0 && calls.purge > 0 && calls.maintenance > 0 && calls.usage > 0,
    );
    expect(calls).toMatchObject({ publish: 1, purge: 1, maintenance: 1, usage: 1 });

    const { exits, errors, tookMs } = await closeUnderDeadline(booted);

    // A clean close, not the timeout: exit 0 and nothing logged as an error.
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // The consumers were waited for until the shared deadline, beside the
    // relay's grace and the purge, not after them.
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1500);
    // And started nothing new while closing; neither message was committed,
    // so the groups deliver them again.
    expect(calls).toMatchObject({ publish: 1, purge: 1, maintenance: 1, usage: 1 });
    expect(settlements.committed).toEqual([]);
    expect(rewards.committed).toEqual([]);
  }, 30_000);

  it('an owner that answers after the close: the approval is still not committed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    booted = await boot({
      // No such request: answered at once, it would be dead-lettered — and the
      // dead letter would be a commit. Answered after the deadline, nothing is.
      maintenanceRequest: async () => {
        await gate;
        return null;
      },
      usageRecord: never,
      relayRow: false,
    });
    const { settlements } = booted;
    const delivered = settlements.deliver('103', maintenanceApproved());
    await until(() => booted!.calls.maintenance > 0);

    const { exits, errors, tookMs } = await closeUnderDeadline(booted);

    // Nothing else waits here, so the time is the consumer's, held to the
    // shared budget.
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1500);

    // It answers now, after the deadline. The stop gave the message up, so
    // nothing new starts for it (no dead letter), `eachMessage` throws and
    // kafkajs keeps the offset; the redelivery asks the owner again.
    release();
    await delivered;
    expect(settlements.committed).toEqual([]);
    expect(settlements.uncommitted).toEqual(['103']);
  }, 30_000);
});

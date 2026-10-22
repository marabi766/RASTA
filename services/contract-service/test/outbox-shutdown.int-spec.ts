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
import { AWARD_SOURCE, ENV } from '../src/tokens';
import { loadContractEnv, SERVICE_NAME, type ContractEnv } from '../src/config/env';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { PolicySuspensionService } from '../src/policy/policy-suspension.service';
import { PolicyReconciliationSweeper } from '../src/policy/policy-reconciliation.sweeper';
import type { AwardSource } from '../src/award/award-source.client';
import {
  ORGANIZATION_MOVES_CONSUMER,
  ORGANIZATION_MOVES_TOPICS,
} from '../src/events/organization-moved.consumer';
import {
  TENDER_AWARDED_CONSUMER,
  TENDER_AWARDED_TOPICS,
} from '../src/events/tender-awarded.consumer';
import {
  SETTLEMENT_COMPLETED_CONSUMER,
  SETTLEMENT_COMPLETED_TOPICS,
} from '../src/events/settlement-completed.consumer';
import { SettlementRepository } from '../src/settlement/settlement.repository';
import { databaseUrl, newAward, newOrganizationId, tenderAwarded } from './helpers';

/**
 * The whole shutdown path through the real AppModule, with the Kafka consumers
 * on the real `EventConsumer` — since CON-003 PR 6c three, the third the
 * `SETTLEMENT_COMPLETED` consumer, held here where it reads its statements.
 *
 * Codex r1 on #277 (Medium): `AppModule.onApplicationShutdown` stopped
 * `TenderAwardedConsumer` and then `OrganizationMovedConsumer` with no bound,
 * after `OutboxShutdown` had drained the relay, the purge and the sweep in the
 * destroy phase. kafkajs's `disconnect()` waits for the message in flight, so a
 * handler still running when the drain ended — an award still waiting on
 * construction-service, say — held the close past SHUTDOWN_TIMEOUT_MS into the
 * forced exit. Both consumers are now `OutboxShutdown` workers, stopped beside
 * the relay and the purge by the one deadline (#270's `stop({ deadlineAt })`),
 * and a message they abandon is not committed — the group delivers it again.
 *
 * The settings make the old order fail by construction: relay grace 6 s, purge
 * batch bound 5.2 s (100 ms wait + 100 ms statement + 5 s margin), budget 7 s,
 * timeout 9 s. A handler that never finishes, stopped after the drain: never.
 *
 * Stand-ins: the outbox store and the publisher (the relay and the purge claim
 * and delete across the whole table by design, so the shared database's own
 * outbox is left alone); the reconciliation sweep (it would sweep rows other
 * suites assert on; its own stop is proven in its spec); construction-service
 * as the award's owner; and kafkajs under the real `EventConsumer` — a fake
 * that, as kafkajs does, commits a message only when its `eachMessage` returned,
 * so no broker is reached and the shared groups are left alone. The consumers'
 * wiring, their handlers and the close are the real ones; the award handler is
 * held on the owner's answer, the move handler where its database write would
 * be.
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
  topic: 'rasta.contract.v1',
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

/** A TENDER_AWARDED, as construction-service publishes it. */
const awarded = (): Buffer =>
  Buffer.from(JSON.stringify(tenderAwarded(newAward(newOrganizationId()))));

/** An ORGANIZATION_MOVED envelope, as organization-service publishes it. */
const organizationMoved = (): Buffer => {
  const organizationId = newOrganizationId();
  return Buffer.from(
    JSON.stringify(
      eventEnvelopeSchema.parse({
        eventId: ulid(),
        eventName: 'ORGANIZATION_MOVED',
        occurredAt: new Date().toISOString(),
        producer: 'organization-service',
        aggregateType: 'Organization',
        aggregateId: organizationId,
        tenantId: organizationId,
        correlationId: ulid(),
        payload: {
          organizationId,
          previousParentId: null,
          newParentId: null,
          previousPath: null,
          newPath: null,
          affectedCount: 1,
          reason: 'reorganisation',
          hierarchyVersion: 2,
        },
      }),
    ),
  );
};

/** A SETTLEMENT_COMPLETED envelope, as economic-service publishes it. */
const settlementCompleted = (): Buffer => {
  const organizationId = newOrganizationId();
  return Buffer.from(
    JSON.stringify(
      eventEnvelopeSchema.parse({
        eventId: ulid(),
        eventName: 'SETTLEMENT_COMPLETED',
        occurredAt: new Date().toISOString(),
        producer: 'economic-service',
        aggregateType: 'Settlement',
        aggregateId: `STL_${ulid()}`,
        tenantId: organizationId,
        correlationId: ulid(),
        payload: {
          settlementId: `STL_${ulid()}`,
          transactionId: `TXN_${ulid()}`,
          organizationId,
          payerOrganizationId: organizationId,
          payeeOrganizationId: newOrganizationId(),
          journalId: `JNL_${ulid()}`,
          grossAmountMinor: '1000',
          commissionAmountMinor: '10',
          netAmountMinor: '990',
          currency: 'IRR',
          settledAt: new Date().toISOString(),
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
  env: ContractEnv;
  calls: { publish: number; purge: number; awards: number; moves: number; settlements: number };
  awarded: FakeKafkaConsumer;
  moves: FakeKafkaConsumer;
  settlements: FakeKafkaConsumer;
}

const inert = { start: () => undefined, stop: async () => undefined };

/**
 * The real AppModule with the stand-ins above. `award` answers for
 * construction-service, `enqueueMove` replaces the move handler's database
 * write, and `relayRow` decides whether the relay claims a probe whose publish
 * never returns.
 */
async function boot(options: {
  award: () => Promise<null>;
  enqueueMove: () => Promise<unknown>;
  relayRow: boolean;
}): Promise<Booted> {
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    // Nothing connects: kafkajs is the fake below (RUN-006 opt-out, test only).
    KAFKA_ALLOW_PLAINTEXT: 'true',
    OIDC_ISSUER_URL: 'http://contracttest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://contracttest.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: `itest-${'x'.repeat(40)}`,
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    OUTBOX_SHUTDOWN_GRACE_SECONDS: String(GRACE_SECONDS),
    OUTBOX_POLL_INTERVAL_MS: '50',
    OUTBOX_PURGE_MAX_WAIT_MS: '100',
    OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '100',
    // No scheduled run: the test puts the one batch in flight itself.
    OUTBOX_PURGE_INTERVAL_SECONDS: '86400',
  };
  const env = loadContractEnv(source);

  const calls = { publish: 0, purge: 0, awards: 0, moves: 0, settlements: 0 };
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
    [TENDER_AWARDED_CONSUMER, new FakeKafkaConsumer(TENDER_AWARDED_TOPICS[0])],
    [ORGANIZATION_MOVES_CONSUMER, new FakeKafkaConsumer(ORGANIZATION_MOVES_TOPICS[0])],
    [SETTLEMENT_COMPLETED_CONSUMER, new FakeKafkaConsumer(SETTLEMENT_COMPLETED_TOPICS[0])],
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
  jest.spyOn(PolicySuspensionService.prototype, 'enqueueMove').mockImplementation(() => {
    calls.moves += 1;
    return options.enqueueMove() as never;
  });
  const awards: AwardSource = {
    award: () => {
      calls.awards += 1;
      return options.award();
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
      // OutboxShutdown closes the publisher after the drain (D-052 phase 4b).
      stop: async () => undefined,
    })
    .overrideProvider(AWARD_SOURCE)
    .useValue(awards)
    // The settlement handler is held where it first reads its statements.
    .overrideProvider(SettlementRepository)
    .useValue({
      findSettledBy: () => {
        calls.settlements += 1;
        return never();
      },
    })
    .overrideProvider(PolicyReconciliationSweeper)
    .useValue(inert)
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
    awarded: fakes.get(TENDER_AWARDED_CONSUMER)!,
    moves: fakes.get(ORGANIZATION_MOVES_CONSUMER)!,
    settlements: fakes.get(SETTLEMENT_COMPLETED_CONSUMER)!,
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

describe('contract-service shutdown: relay, purge and both consumers by one deadline (D-052)', () => {
  let booted: Booted | undefined;

  afterEach(async () => {
    // Closed by the test; a second close is a no-op either way.
    await booted?.app.close().catch(() => undefined);
    booted = undefined;
    jest.restoreAllMocks();
  });

  it('finishes the close under SHUTDOWN_TIMEOUT_MS with a publish, a purge batch and both consumers’ handlers never ending', async () => {
    booted = await boot({ award: never, enqueueMove: never, relayRow: true });
    const { app, calls, awarded: awards, moves, settlements } = booted;
    expect(app.get(OutboxRelay)).toBeInstanceOf(OutboxRelay);
    const purge = app.get(OutboxPurgeScheduler);
    expect(purge.stopBoundMs).toBe(5200);

    // The relay's poll claims the probe and its publish hangs; the purge's
    // batch hangs too; construction-service never answers for the award, the
    // move's write never returns, and neither does the settlement's first read.
    void purge.runOnce();
    void awards.deliver('91', awarded());
    void moves.deliver('92', organizationMoved());
    void settlements.deliver('94', settlementCompleted());
    await until(
      () =>
        calls.publish > 0 &&
        calls.purge > 0 &&
        calls.awards > 0 &&
        calls.moves > 0 &&
        calls.settlements > 0,
    );
    expect(calls).toMatchObject({ publish: 1, purge: 1, awards: 1, moves: 1, settlements: 1 });

    const { exits, errors, tookMs } = await closeUnderDeadline(booted);

    // A clean close, not the timeout: exit 0 and nothing logged as an error.
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // The consumers were waited for until the shared deadline, beside the
    // relay's grace and the purge, not after them nor one after the other.
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1500);
    // And started nothing new while closing; neither message was committed,
    // so the groups deliver them again.
    expect(calls).toMatchObject({ publish: 1, purge: 1, awards: 1, moves: 1, settlements: 1 });
    expect(awards.committed).toEqual([]);
    expect(moves.committed).toEqual([]);
    expect(settlements.committed).toEqual([]);
  }, 30_000);

  it('an owner that answers after the close: the award is still not committed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    booted = await boot({
      // No such award: answered at once, it would be dead-lettered — and the
      // dead letter would be a commit. Answered after the deadline, nothing is.
      award: async () => {
        await gate;
        return null;
      },
      enqueueMove: never,
      relayRow: false,
    });
    const { awarded: awards } = booted;
    const delivered = awards.deliver('93', awarded());
    await until(() => booted!.calls.awards > 0);

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
    expect(awards.committed).toEqual([]);
    expect(awards.uncommitted).toEqual(['93']);
  }, 30_000);
});

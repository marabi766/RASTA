import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { EventEnvelope } from '@rasta/contracts';
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
import { AppModule, ENV, FENCE_PRISMA, SAMPLER_PRISMA } from '../src/app.module';
import { IDENTITY_TOPIC, loadIdentityEnv, SERVICE_NAME, type IdentityEnv } from '../src/config/env';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import { MembershipExpiryScanner } from '../src/identity/membership-expiry.scanner';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import { KeycloakFenceSampler } from '../src/keycloak/keycloak-fence-sampler';
import { KeycloakProjectionConsumer } from '../src/keycloak/keycloak-projection.consumer';
import { OutboxGauges } from '../src/observability/outbox-gauges';
import { PrismaService } from '../src/prisma/prisma.service';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { SecurityEventOutboxStore } from '../src/security-events/security-event-outbox.store';
import { databaseUrl } from './helpers';

/**
 * The whole shutdown path through the real AppModule (D-052).
 *
 * identity-service runs five background loops: the domain relay, the refusal
 * relay (`security_event_outbox`), the purge, the membership expiry scanner
 * and the Keycloak projection consumer. Before, the relays stopped in
 * `onApplicationShutdown`, after the consumer's own unbounded stop, and the
 * scanner only cleared its timer, so a pass in flight went on writing outbox
 * rows through the close. All five are now stopped by `OutboxShutdown` in the
 * destroy phase, by one deadline.
 *
 * The settings make a sequential stop fail by construction: relay grace 6 s,
 * purge batch bound 5.2 s (100 ms wait + 100 ms statement + 5 s margin),
 * budget 7 s, timeout 9 s. A scanner lapse or a projection that never ends,
 * waited for without the deadline: never.
 *
 * Stand-ins: both outbox stores and the publisher (the relays and the purge
 * work across the whole table by design, so the shared database's own rows are
 * left alone), the repository's lapse query and the projection handler (held
 * where the transaction and the Keycloak write would be), and kafkajs under
 * the real `EventConsumer` — a fake that, as kafkajs does, commits a message
 * only when its `eachMessage` returned. Keycloak sync is on, so the projection
 * consumer exists; nothing reaches Keycloak or a broker.
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
  topic: IDENTITY_TOPIC,
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

/** A membership event, as this service's own relay publishes it. */
const membershipCreated = (): Buffer => {
  const envelope: EventEnvelope = {
    eventId: `EVT_${ulid()}`,
    eventName: 'MEMBERSHIP_CREATED',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: SERVICE_NAME,
    producerVersion: '0.1.0-itest',
    aggregateType: 'Membership',
    aggregateId: `MBR_${ulid()}`,
    tenantId: 'ORG-SHUTDOWN-PROBE',
    correlationId: `COR_${ulid()}`,
    payload: { userId: `USR_${ulid()}` },
  };
  return Buffer.from(JSON.stringify(envelope));
};

const lapse = (id: string) => ({
  id,
  userId: `USR_${id}`,
  organizationId: 'ORG-SHUTDOWN-PROBE',
  validUntil: new Date(0),
});

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
  async connect(): Promise<void> {}
  async subscribe(): Promise<void> {}
  async run(config: { eachMessage: EachMessage }): Promise<void> {
    this.eachMessage = config.eachMessage;
  }
  deliver(offset: string, value: Buffer): Promise<void> {
    if (!this.eachMessage) throw new Error('the consumer is not running');
    this.inFlight = this.eachMessage({
      topic: IDENTITY_TOPIC,
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

interface Calls {
  publish: number;
  purge: number;
  securityClaims: number;
  lapseQueries: number;
  lapses: string[];
  projected: number;
}

interface Booted {
  app: INestApplication;
  env: IdentityEnv;
  calls: Calls;
  kafka: FakeKafkaConsumer;
}

/**
 * The real AppModule with the stand-ins above. `project` replaces the
 * projection consumer's handler, `expire` the handling of one lapse;
 * `relayRow` decides whether the domain relay claims a probe whose publish
 * never returns.
 */
async function boot(options: {
  project: () => Promise<void>;
  expire: (id: string) => Promise<boolean>;
  relayRow: boolean;
}): Promise<Booted> {
  const env = loadIdentityEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    SERVICE_VERSION: '0.1.0-itest',
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    KAFKA_CLIENT_ID: `identity-shutdown-itest-${ulid().slice(-8)}`,
    // Nothing connects: kafkajs is the fake below.
    KAFKA_ALLOW_PLAINTEXT: 'true',
    OIDC_ISSUER_URL: 'http://identitytest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://identitytest.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: randomBytes(24).toString('hex'),
    KEYCLOAK_URL: 'http://identitytest.invalid',
    KEYCLOAK_REALM: 'rasta',
    KEYCLOAK_BACKEND_CLIENT_ID: 'identity-itest',
    KEYCLOAK_BACKEND_CLIENT_SECRET: randomBytes(16).toString('hex'),
    // On, so the projection consumer is built; the handler is held below.
    KEYCLOAK_SYNC_ENABLED: 'true',
    AUDIT_SERVICE_URL: 'http://127.0.0.1:9',
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    OUTBOX_SHUTDOWN_GRACE_SECONDS: String(GRACE_SECONDS),
    OUTBOX_POLL_INTERVAL_MS: '50',
    SECURITY_EVENT_FLUSH_INTERVAL_MS: '50',
    OUTBOX_PURGE_MAX_WAIT_MS: '100',
    OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '100',
    // No scheduled run of either: the test puts the one batch and the one pass
    // in flight itself.
    OUTBOX_PURGE_INTERVAL_SECONDS: '86400',
    MEMBERSHIP_EXPIRY_SCAN_INTERVAL_SECONDS: '3600',
  });

  const calls: Calls = {
    publish: 0,
    purge: 0,
    securityClaims: 0,
    lapseQueries: 0,
    lapses: [],
    projected: 0,
  };
  let claimed = !options.relayRow;
  const quiet = {
    oldestPendingAgeSeconds: async () => 0,
    pendingCount: async () => 0,
    activeLeaseCount: async () => 0,
  };
  const store: Partial<Record<keyof PrismaOutboxStore, unknown>> = {
    ...quiet,
    claimPending: async (): Promise<OutboxClaim> => {
      if (claimed) return { token: null, rows: [], reclaimed: 0 };
      claimed = true;
      return { token: 'tok-shutdown', rows: [probeRow()], reclaimed: 0 };
    },
    markPublished: async (ids: readonly string[]) => ids.length,
    markFailed: async () => 1,
    release: async (ids: readonly string[]) => ids.length,
    renew: async (ids: readonly string[]) => [...ids],
    purgePublished: (): Promise<PurgePublishedBatch> => {
      calls.purge += 1;
      return never();
    },
  };
  // The refusal relay's claim never answers: its poll is in flight at the close.
  const securityStore: Partial<Record<keyof SecurityEventOutboxStore, unknown>> = {
    ...quiet,
    aggregationBacklog: async () => ({
      openWindows: 0,
      closedBacklog: 0,
      closedBacklogAgeSeconds: 0,
    }),
    claimPending: (): Promise<OutboxClaim> => {
      calls.securityClaims += 1;
      return never();
    },
  };

  const kafka = new FakeKafkaConsumer();
  // The real EventConsumer the AppModule builds, with kafkajs swapped for the
  // fake before it connects. No dead letter is reached here.
  const realStart = EventConsumer.prototype.start;
  jest.spyOn(EventConsumer.prototype, 'start').mockImplementation(function (this: EventConsumer) {
    (this as unknown as { kafka: unknown }).kafka = {
      consumer: () => kafka,
      producer: () => {
        throw new Error('no dead letter is expected in this suite');
      },
    };
    return realStart.call(this);
  });
  jest.spyOn(KeycloakProjectionConsumer.prototype, 'handle').mockImplementation(async () => {
    calls.projected += 1;
    await options.project();
  });
  jest.spyOn(IdentityRepository.prototype, 'findLapsedMemberships').mockImplementation(async () => {
    calls.lapseQueries += 1;
    // Only what the scanner reads of a membership; the rest is never looked at.
    return [lapse('MBR_SHUTDOWN_1'), lapse('MBR_SHUTDOWN_2')] as unknown as Awaited<
      ReturnType<IdentityRepository['findLapsedMemberships']>
    >;
  });
  jest
    .spyOn(IdentityService.prototype, 'expireLapsedMembership')
    .mockImplementation(async (membership) => {
      calls.lapses.push(membership.id);
      return options.expire(membership.id);
    });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaOutboxStore)
    .useValue(store)
    .overrideProvider(SecurityEventOutboxStore)
    .useValue(securityStore)
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
    .overrideProvider(AUTH_OPTIONS)
    .useValue({
      serviceName: SERVICE_NAME,
      tokenVerifier: {} as unknown as TokenVerifier,
      internalTokens: {} as unknown as InternalTokenService,
    } satisfies AuthGuardOptions)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, env, calls, kafka };
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

describe('identity-service shutdown: both relays, purge, expiry scanner and projection consumer by one deadline (D-052)', () => {
  let booted: Booted | undefined;

  afterEach(async () => {
    // Closed by the test; a second close is a no-op either way.
    await booted?.app.close().catch(() => undefined);
    booted = undefined;
    jest.restoreAllMocks();
  });

  it('finishes the close under SHUTDOWN_TIMEOUT_MS with a publish, a refusal claim, a purge batch, a lapse and a projection that never end', async () => {
    booted = await boot({ project: () => never(), expire: () => never(), relayRow: true });
    const { app, calls, kafka } = booted;
    expect(app.get(OutboxRelay)).toBeInstanceOf(OutboxRelay);
    const purge = app.get(OutboxPurgeScheduler);
    expect(purge.stopBoundMs).toBe(5200);

    // The domain relay's poll claims the probe and its publish hangs; the
    // refusal relay's claim hangs; the purge's batch hangs; the scanner's
    // first lapse never ends; and the projection never returns.
    void purge.runOnce();
    void app.get(MembershipExpiryScanner).scan();
    void kafka.deliver('41', membershipCreated());
    await until(
      () =>
        calls.publish > 0 &&
        calls.securityClaims > 0 &&
        calls.purge > 0 &&
        calls.lapses.length > 0 &&
        calls.projected > 0,
    );
    expect(calls).toMatchObject({
      publish: 1,
      securityClaims: 1,
      purge: 1,
      lapseQueries: 1,
      lapses: ['MBR_SHUTDOWN_1'],
      projected: 1,
    });

    const { exits, errors, tookMs } = await closeUnderDeadline(booted);

    // A clean close, not the timeout: exit 0 and nothing logged as an error.
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // The lapse and the projection have no bound of their own, so the shared
    // budget ended them, beside the relays' grace and the purge's bound rather
    // than after them.
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1500);
    // And started nothing new while closing; the message was not committed,
    // so the group delivers it again.
    expect(calls).toMatchObject({
      publish: 1,
      securityClaims: 1,
      purge: 1,
      lapseQueries: 1,
      lapses: ['MBR_SHUTDOWN_1'],
      projected: 1,
    });
    expect(kafka.committed).toEqual([]);
  }, 30_000);

  it('a lapse and a projection that finish after the close: no further lapse, and the message is not committed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    booted = await boot({
      project: () => gate,
      expire: async () => {
        await gate;
        return true;
      },
      relayRow: false,
    });
    const { app, calls, kafka } = booted;
    const pass = app.get(MembershipExpiryScanner).scan();
    const delivered = kafka.deliver('42', membershipCreated());
    await until(() => calls.lapses.length > 0 && calls.projected > 0);

    const { exits, errors, tookMs } = await closeUnderDeadline(booted);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1500);

    // Both answer now, after the deadline. The pass reaches no second lapse —
    // it stays for the next pass, on any replica. The stop gave the message
    // up, so `eachMessage` throws and kafkajs keeps the offset; the projection
    // is rebuilt from the database on redelivery.
    release();
    await expect(pass).resolves.toBe(1);
    await delivered;
    expect(calls.lapses).toEqual(['MBR_SHUTDOWN_1']);
    expect(kafka.committed).toEqual([]);
    expect(kafka.uncommitted).toEqual(['42']);
  }, 30_000);

  it('closes the three pools last — after every worker and timer returned — and nothing runs on them afterwards (#458 r2 F2)', async () => {
    booted = await boot({
      project: async () => undefined,
      expire: async () => true,
      relayRow: false,
    });
    const { app } = booted;
    const order: string[] = [];
    const returned = (name: string, prototype: object) => {
      const target = prototype as { stop: (...args: unknown[]) => Promise<unknown> };
      const real = target.stop;
      jest.spyOn(target, 'stop').mockImplementation(async function (this: unknown, ...args) {
        try {
          return await real.apply(this, args);
        } finally {
          order.push(`${name} returned`);
        }
      });
    };
    returned('scanner', MembershipExpiryScanner.prototype);
    returned('consumer', KeycloakProjectionConsumer.prototype);
    returned('projector', KeycloakProjector.prototype);
    returned('sampler', KeycloakFenceSampler.prototype);
    returned('gauges', OutboxGauges.prototype);
    const realClose = PrismaService.prototype.stop;
    jest.spyOn(PrismaService.prototype, 'stop').mockImplementation(function (
      this: PrismaService,
      options,
    ) {
      order.push('pool closing');
      return realClose.call(this, options);
    });

    const { exits, errors } = await closeUnderDeadline(booted);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    // Nest ran every destroy hook at once; the pools still closed after every
    // worker and timer that uses them had returned, each once.
    const firstClose = order.indexOf('pool closing');
    expect(order.filter((step) => step === 'pool closing')).toHaveLength(3);
    for (const name of ['scanner', 'consumer', 'projector', 'sampler', 'gauges']) {
      const at = order.indexOf(`${name} returned`);
      expect({ name, returnedBeforeAnyPoolClosed: at >= 0 && at < firstClose }).toEqual({
        name,
        returnedBeforeAnyPoolClosed: true,
      });
    }
    // Closed is closed: a request still being served gets a refusal, and no
    // pool reconnects behind the close.
    for (const token of [PrismaService, FENCE_PRISMA, SAMPLER_PRISMA]) {
      const pool = app.get<PrismaService>(token);
      await expect(pool.client.user.count()).rejects.toThrow(/pool is closed/);
      // Refused before anything begins, as a cancelled scope refuses it.
      expect(() => pool.transaction(async () => 1)).toThrow(/pool is closed/);
    }
  }, 30_000);
});

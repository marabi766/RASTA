import 'reflect-metadata';
import { APP_GUARD } from '@nestjs/core';
import { AUDIT_TRAIL_TOPIC } from '@rasta/contracts';
import {
  AuthGuard,
  AUTH_OPTIONS,
  InternalTokenService,
  RolesGuard,
  TokenVerifier,
} from '@rasta/nest-common';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { DomainProjectorConsumer } from './consumers/domain-projector.consumer';
import { AuditTrailConsumer } from './consumers/audit-trail.consumer';
import { AuditRepository } from './audit/audit.repository';
import { AuditController } from './audit/audit.controller';
import { AuditInternalController } from './audit/audit-internal.controller';
import {
  AuditEventDetailQueryPipe,
  AuditEventQueryPipe,
  AuditVerifyQueryPipe,
} from './audit/audit.query.pipes';
import { AuditVerificationService } from './audit/audit.verification.service';
import { HealthController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import type { AuditEnv } from './config/env';
import {
  AUDIT_DEAD_LETTER_TOPIC,
  DOMAIN_PROJECTOR_CONSUMER,
  DOMAIN_TOPICS,
} from './audit/audit.mapper';
import { AUDIT_TRAIL_CONSUMER } from './audit/audit-trail.mapper';

/**
 * The composition root, exercised rather than assumed.
 *
 * A Nest module is usually left uncovered on the grounds that it is "just
 * wiring", and that is exactly why a broken factory here surfaces as a
 * container error at boot rather than as a failing test. Every provider below
 * is constructed for real — no broker connection and no database connection is
 * opened by construction, so this stays a unit test.
 */

interface FactoryProvider {
  provide: unknown;
  useFactory?: (...args: unknown[]) => unknown;
  useClass?: unknown;
  inject?: unknown[];
}

/** The options an `EventConsumer` was constructed with. */
interface BuiltConsumerOptions {
  topics: string[];
  groupId: string;
  fromBeginning?: boolean;
  deadLetterTopic?: string;
}

// Heterogeneous on purpose: most providers are factory objects, but the two
// query pipes are registered as bare classes because a class-referenced
// enhancer is the only form Nest resolves from a route decorator.
const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as unknown[];

function providerFor(token: unknown): FactoryProvider {
  const found = providers.find(
    (p): p is FactoryProvider =>
      typeof p === 'object' && p !== null && (p as FactoryProvider).provide === token,
  );
  if (!found) throw new Error(`no provider registered for ${String(token)}`);
  return found;
}

/**
 * Builds one of the two consumers through its real factory, then invokes the
 * builder it was handed — which is what constructs the `EventConsumer`, and
 * construction opens no socket.
 */
function consumerOptions(token: typeof DomainProjectorConsumer | typeof AuditTrailConsumer): {
  consumer: DomainProjectorConsumer | AuditTrailConsumer;
  options: BuiltConsumerOptions;
} {
  const env = providerFor(ENV).useFactory?.();
  const logger = providerFor(LOGGER).useFactory?.(env);
  const repository = new AuditRepository({} as PrismaService);

  const consumer = providerFor(token).useFactory?.(env, logger, repository) as
    DomainProjectorConsumer | AuditTrailConsumer;

  const built = (
    consumer as unknown as {
      createConsumer: (handler: () => Promise<void>) => { options: BuiltConsumerOptions };
    }
  ).createConsumer(async () => undefined);

  return { consumer, options: built.options };
}

/**
 * What Nest hands a query pipe. Only `type` is read by these pipes, but the
 * shape is stated in full so it is the real contract and not a cast.
 */
const QUERY_ARGUMENT = { type: 'query' } as const;

const ENVIRONMENT = {
  DATABASE_URL_AUDIT: 'postgresql://rasta_audit:pw@localhost:5433/rasta_audit?schema=audit',
  KAFKA_BROKERS: 'localhost:9092',
  NODE_ENV: 'test',
  // Required as of AUD-002: the service now serves two private endpoints behind
  // a global `AuthGuard`, so it verifies tokens and must be configured to.
  OIDC_ISSUER_URL: 'http://auth.invalid/realms/rasta',
  OIDC_JWKS_URI: 'http://auth.invalid/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'x'.repeat(48),
};

/** A consumer stand-in that records when it was started. */
function startable(name: string, order: string[], fail = false) {
  return {
    start: async () => {
      order.push(name);
      if (fail) throw new Error('This server does not host this topic-partition');
    },
    isRunning: () => !fail,
  };
}

const idleRepository = {
  partitionRowCounts: async () => [{ partition: 'audit_event_default', rows: 0 }],
} as unknown as AuditRepository;

describe('audit-service composition root', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, ...ENVIRONMENT };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('registers exactly the health probes, the read API and the internal target lookup', () => {
    // Pinned rather than left open: another controller here is either a write
    // surface `docs/04` § 4.15 forbids or an export route nothing builds yet,
    // and both should have to change this line before they ship. AUD-004 Phase
    // B added a consumer, not a controller. AUD-003 correction adds one internal *read*,
    // reserved for identity-service's service token — still no write surface.
    const controllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
    expect(controllers).toEqual([HealthController, AuditController, AuditInternalController]);
  });

  it('registers the guards globally, authentication before authorization', () => {
    // The order is the security property: `RolesGuard` reads a context that
    // only `AuthGuard` populates, so a graph that ran them the other way round
    // would judge roles nobody had verified. Nest runs `APP_GUARD` providers in
    // registration order.
    const guards = providers
      .filter((p) => (p as FactoryProvider).provide === APP_GUARD)
      .map((p) => (p as FactoryProvider).useClass);
    expect(guards).toEqual([AuthGuard, RolesGuard]);
  });

  it('builds the auth options from the validated environment', () => {
    const env = providerFor(ENV).useFactory?.() as Record<string, unknown>;
    const internalTokens = providerFor(InternalTokenService).useFactory?.(env);
    const options = providerFor(AUTH_OPTIONS).useFactory?.(env, internalTokens) as {
      serviceName: string;
      tokenVerifier: unknown;
      internalTokens: unknown;
    };

    expect(options.serviceName).toBe('audit-service');
    expect(options.tokenVerifier).toBeInstanceOf(TokenVerifier);
    // Verifiable and deliberately never sufficient: no route carries
    // `@AllowService`, so a valid internal token is refused by `RolesGuard` and
    // again by `assertNotServiceCaller()`.
    expect(options.internalTokens).toBeInstanceOf(InternalTokenService);
  });

  it('registers both query pipes as classes the injector can construct', () => {
    // The controller reaches these as `@Query(AuditEventQueryPipe)`. Nest
    // resolves a class-referenced enhancer from the metatype it scanned off the
    // route and never consults a same-token `useFactory`, so registering them
    // as factory providers left the container constructing the class itself
    // against an unresolvable `number` parameter — the service failed to boot.
    // Registered as classes, with `ENV` as a real injected dependency, it does
    // not.
    expect(providers).toContain(AuditEventQueryPipe);
    expect(providers).toContain(AuditEventDetailQueryPipe);
    expect(providers).toContain(AuditVerifyQueryPipe);

    // `@Inject(ENV)` is what gives the parameter a token to resolve. Asserted
    // on the metadata Nest actually reads, so removing the decorator fails here
    // rather than at boot.
    for (const pipe of [AuditEventQueryPipe, AuditEventDetailQueryPipe, AuditVerifyQueryPipe]) {
      expect(Reflect.getMetadata('self:paramtypes', pipe)).toEqual([{ index: 0, param: ENV }]);
    }
  });

  it('registers the verification service the third route depends on', () => {
    // Registered as a class, like the two query services: the controller
    // reaches it by constructor injection, and a missing registration is a
    // container error at boot rather than a failing request.
    expect(providers).toContain(AuditVerificationService);
  });

  it('builds the verification pipe at the configured window ceiling', () => {
    // The verification endpoint carries the same mandatory window as search,
    // and the 400 must name the value this deployment runs rather than the
    // default.
    const env = providerFor(ENV).useFactory?.() as AuditEnv;
    const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' };

    expect(() => new AuditVerifyQueryPipe(env).transform(window, QUERY_ARGUMENT)).not.toThrow();
    expect(() =>
      new AuditVerifyQueryPipe({ ...env, AUDIT_MAX_QUERY_WINDOW_DAYS: 7 }).transform(
        window,
        QUERY_ARGUMENT,
      ),
    ).toThrow();
  });

  it('gives the verification service the record ceiling from the environment', () => {
    // The walk ceiling is configuration, and the refusal names the configured
    // number. A service that read a constant would quote a number the operator
    // did not choose.
    const env = providerFor(ENV).useFactory?.() as AuditEnv;

    expect(env.AUDIT_MAX_VERIFICATION_RECORDS).toBe(100_000);
  });

  it('builds both query pipes at the configured window ceiling', () => {
    // The 400 for an over-wide window must name the value this deployment runs,
    // not the default — so the ceiling has to come from the injected
    // environment. Proved behaviourally: a pipe built at a seven-day ceiling
    // refuses a thirty-day window that the default ceiling would accept.
    const env = providerFor(ENV).useFactory?.() as AuditEnv;
    expect(env.AUDIT_MAX_QUERY_WINDOW_DAYS).toBe(90);

    const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' };

    expect(() => new AuditEventQueryPipe(env).transform(window, QUERY_ARGUMENT)).not.toThrow();
    expect(() =>
      new AuditEventQueryPipe({ ...env, AUDIT_MAX_QUERY_WINDOW_DAYS: 7 }).transform(
        window,
        QUERY_ARGUMENT,
      ),
    ).toThrow();
  });

  it('builds the environment', () => {
    const env = providerFor(ENV).useFactory?.() as { PORT: number; DATABASE_URL: string };

    expect(env.PORT).toBe(3115);
    expect(env.DATABASE_URL).toContain('rasta_audit:');
    expect(env.DATABASE_URL).not.toContain('rasta_audit_migrator');
  });

  it('builds a logger', () => {
    const env = providerFor(ENV).useFactory?.();
    const logger = providerFor(LOGGER).useFactory?.(env);

    expect(logger).toBeDefined();
    expect(typeof (logger as { info: unknown }).info).toBe('function');
  });

  it('builds the Prisma service against the runtime url', () => {
    const env = providerFor(ENV).useFactory?.();
    const prisma = providerFor(PrismaService).useFactory?.(env);

    expect(prisma).toBeInstanceOf(PrismaService);
  });

  it('builds the projector over exactly the ten domain topics', () => {
    // The wiring assertion that matters most: a consumer built over the wrong
    // topic set records the wrong evidence, and nothing else would notice.
    const { consumer, options } = consumerOptions(DomainProjectorConsumer);

    expect(consumer).toBeInstanceOf(DomainProjectorConsumer);
    expect(options.topics).toEqual([...DOMAIN_TOPICS]);
    expect(options.topics).not.toContain(AUDIT_TRAIL_TOPIC);
    expect(options.groupId).toBe(DOMAIN_PROJECTOR_CONSUMER);
    // Replay must be safe and must be on: the store rebuilds from the log.
    expect(options.fromBeginning).toBe(true);
    // Without this a malformed message is logged and dropped.
    expect(options.deadLetterTopic).toBe('rasta.audit.v1.dlq');
    expect(consumer.isRunning()).toBe(false);
  });

  it('builds the audit-trail consumer over exactly the trail topic, as its own group', () => {
    // AUD-004 Phase B. Pinned to the literals as well as to the constants, so
    // renaming a constant cannot quietly move the group or the topic: the group
    // name is also the path-B `processed_event` key.
    const { consumer, options } = consumerOptions(AuditTrailConsumer);

    expect(consumer).toBeInstanceOf(AuditTrailConsumer);
    expect(options.topics).toEqual([AUDIT_TRAIL_TOPIC]);
    expect(options.topics).toEqual(['rasta.audit.trail.v1']);
    expect(options.groupId).toBe(AUDIT_TRAIL_CONSUMER);
    expect(options.groupId).toBe('audit-service.trail');
    // Replay-safe, and a refused message is kept rather than dropped.
    expect(options.fromBeginning).toBe(true);
    expect(options.deadLetterTopic).toBe(AUDIT_DEAD_LETTER_TOPIC);
    expect(consumer.isRunning()).toBe(false);
  });

  it('keeps the two paths in separate groups over disjoint topics', () => {
    // One group over both would share a rebalance and one idempotency
    // namespace; overlapping topics would record the same message twice under
    // two contracts.
    const projector = consumerOptions(DomainProjectorConsumer).options;
    const trail = consumerOptions(AuditTrailConsumer).options;

    expect(trail.groupId).not.toBe(projector.groupId);
    expect(trail.topics.filter((topic) => projector.topics.includes(topic))).toEqual([]);
  });

  it('never lets KAFKA_CONSUMER_GROUP rename either group', () => {
    // The platform environment has one consumer-group variable and this service
    // runs two groups. The variable is honoured by the environment loader —
    // asserted, so this test cannot pass merely because it was ignored — and
    // read by neither factory.
    process.env.KAFKA_CONSUMER_GROUP = 'operator-chosen-group';
    expect((providerFor(ENV).useFactory?.() as AuditEnv).KAFKA_CONSUMER_GROUP).toBe(
      'operator-chosen-group',
    );

    expect(consumerOptions(DomainProjectorConsumer).options.groupId).toBe(
      'audit-service.domain-projector',
    );
    expect(consumerOptions(AuditTrailConsumer).options.groupId).toBe('audit-service.trail');
  });

  it('injects both consumers into the readiness probe', () => {
    // Nest resolves the controller's constructor from `design:paramtypes`. A
    // probe whose third parameter lost its type would fail to boot — or, worse,
    // be handed the wrong object — so the order is asserted on the metadata the
    // container reads.
    expect(Reflect.getMetadata('design:paramtypes', HealthController)).toEqual([
      PrismaService,
      DomainProjectorConsumer,
      AuditTrailConsumer,
    ]);
  });

  it('gives both consumers a shutdown hook Nest will call', () => {
    // Stopping on shutdown is each consumer's own `onModuleDestroy`, which Nest
    // calls for every provider. Both are registered, so both are stopped.
    expect(providerFor(DomainProjectorConsumer)).toBeDefined();
    expect(providerFor(AuditTrailConsumer)).toBeDefined();
    expect(typeof DomainProjectorConsumer.prototype.onModuleDestroy).toBe('function');
    expect(typeof AuditTrailConsumer.prototype.onModuleDestroy).toBe('function');
  });

  it('starts both consumers on init, the projector first', async () => {
    const order: string[] = [];
    const module = new AppModule(
      startable('projector', order) as unknown as DomainProjectorConsumer,
      startable('trail', order) as unknown as AuditTrailConsumer,
      idleRepository,
    );

    await module.onModuleInit();
    await module.onApplicationShutdown();

    expect(order).toEqual(['projector', 'trail']);
  });

  it('fails startup when the audit-trail consumer cannot start', async () => {
    // A service that came up with path B silently absent would pass every
    // check that looked only at path A. The failure propagates, so `main.ts`
    // exits rather than serving.
    const order: string[] = [];
    const module = new AppModule(
      startable('projector', order) as unknown as DomainProjectorConsumer,
      startable('trail', order, true) as unknown as AuditTrailConsumer,
      idleRepository,
    );

    await expect(module.onModuleInit()).rejects.toThrow(/does not host this topic-partition/);
    await module.onApplicationShutdown();

    expect(order).toEqual(['projector', 'trail']);
  });

  it('stops its capacity sampler on shutdown', async () => {
    // A timer left running keeps the process alive and keeps querying a
    // database that is shutting down.
    const order: string[] = [];
    const projector = startable('projector', order) as unknown as DomainProjectorConsumer;

    const module = new AppModule(
      projector,
      startable('trail', order) as unknown as AuditTrailConsumer,
      idleRepository,
    );
    await module.onModuleInit();
    await module.onApplicationShutdown();

    // Nothing to assert beyond completing without a leaked handle; Jest fails
    // the run if the interval keeps the loop alive.
    expect(projector.isRunning()).toBe(true);
  });

  it('never lets a capacity-sampling failure take the service down', async () => {
    // Upkeep must not be able to stop ingestion. The sampler swallows, and the
    // ingestion counters carry the real signal.
    const repository = {
      partitionRowCounts: async () => {
        throw new Error('catalogue unavailable');
      },
    } as unknown as AuditRepository;
    const order: string[] = [];

    const module = new AppModule(
      startable('projector', order) as unknown as DomainProjectorConsumer,
      startable('trail', order) as unknown as AuditTrailConsumer,
      repository,
    );
    await expect(module.onModuleInit()).resolves.toBeUndefined();
    await module.onApplicationShutdown();
  });
});

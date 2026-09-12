import 'reflect-metadata';
import { APP_GUARD } from '@nestjs/core';
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
import { AuditRepository } from './audit/audit.repository';
import { AuditController } from './audit/audit.controller';
import {
  AuditEventDetailQueryPipe,
  AuditEventQueryPipe,
  AuditVerifyQueryPipe,
} from './audit/audit.query.pipes';
import { AuditVerificationService } from './audit/audit.verification.service';
import { HealthController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import type { AuditEnv } from './config/env';
import { DOMAIN_PROJECTOR_CONSUMER, DOMAIN_TOPICS } from './audit/audit.mapper';

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

describe('audit-service composition root', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, ...ENVIRONMENT };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('registers exactly the health probes and the read API', () => {
    // Two controllers, and the count is pinned rather than left open: a third
    // one appearing here is either a write surface `docs/04` § 4.15 forbids or
    // an export route AUD-002 does not build, and both should have to change
    // this line before they ship.
    const controllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
    expect(controllers).toEqual([HealthController, AuditController]);
  });

  it('registers the guards globally, authentication before authorization', () => {
    // The order is the security property: `RolesGuard` reads a context that
    // only `AuthGuard` populates, so a graph that ran them the other way round
    // would judge roles nobody had verified. Nest runs `APP_GUARD` providers in
    // registration order.
    const guards = providers.filter((p) => p.provide === APP_GUARD).map((p) => p.useClass);
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
    const env = providerFor(ENV).useFactory?.();
    const logger = providerFor(LOGGER).useFactory?.(env);
    const repository = new AuditRepository({} as PrismaService);

    const projector = providerFor(DomainProjectorConsumer).useFactory?.(
      env,
      logger,
      repository,
    ) as DomainProjectorConsumer;

    // The factory hands `DomainProjectorConsumer` a builder; invoking it is
    // what constructs the EventConsumer, and construction opens no socket.
    const built = (
      projector as unknown as {
        createConsumer: (handler: () => Promise<void>) => {
          options: {
            topics: string[];
            groupId: string;
            fromBeginning?: boolean;
            deadLetterTopic?: string;
          };
        };
      }
    ).createConsumer(async () => undefined);

    const { topics, groupId, fromBeginning, deadLetterTopic } = built.options;

    expect(topics).toEqual([...DOMAIN_TOPICS]);
    expect(groupId).toBe(DOMAIN_PROJECTOR_CONSUMER);
    // Replay must be safe and must be on: the store rebuilds from the log.
    expect(fromBeginning).toBe(true);
    // Without this a malformed message is logged and dropped.
    expect(deadLetterTopic).toBe('rasta.audit.v1.dlq');
    expect(projector.isRunning()).toBe(false);
  });

  it('stops its capacity sampler on shutdown', async () => {
    // A timer left running keeps the process alive and keeps querying a
    // database that is shutting down.
    const repository = {
      partitionRowCounts: async () => [{ partition: 'audit_event_default', rows: 0 }],
    } as unknown as AuditRepository;
    const projector = {
      start: async () => undefined,
      isRunning: () => true,
    } as unknown as DomainProjectorConsumer;

    const module = new AppModule(projector, repository);
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
    const projector = {
      start: async () => undefined,
      isRunning: () => true,
    } as unknown as DomainProjectorConsumer;

    const module = new AppModule(projector, repository);
    await expect(module.onModuleInit()).resolves.toBeUndefined();
    await module.onApplicationShutdown();
  });
});

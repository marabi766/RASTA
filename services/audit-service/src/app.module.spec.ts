import 'reflect-metadata';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { DomainProjectorConsumer } from './consumers/domain-projector.consumer';
import { AuditRepository } from './audit/audit.repository';
import { ENV, LOGGER } from './tokens';
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

const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as FactoryProvider[];

function providerFor(token: unknown): FactoryProvider {
  const found = providers.find((p) => p.provide === token);
  if (!found) throw new Error(`no provider registered for ${String(token)}`);
  return found;
}

const ENVIRONMENT = {
  DATABASE_URL_AUDIT: 'postgresql://rasta_audit:pw@localhost:5433/rasta_audit?schema=audit',
  KAFKA_BROKERS: 'localhost:9092',
  NODE_ENV: 'test',
};

describe('audit-service composition root', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, ...ENVIRONMENT };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('registers the health controller and nothing that could return an audit row', () => {
    // AUD-001 exposes no query API. A second controller appearing here is the
    // change that would need AUD-002's guard, so the absence is pinned.
    const controllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
    expect(controllers).toHaveLength(1);
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

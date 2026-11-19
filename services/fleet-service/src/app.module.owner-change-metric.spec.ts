import 'reflect-metadata';
import type { EventEnvelope } from '@rasta/contracts';
import type { FleetRepository } from './fleet/fleet.repository';

const metricName = 'rasta_drift_evidence_owner_changes_total';

// Each isolated module graph owns an actual registry; no counter/registry resets.
describe('Fleet owner-change counter startup', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('shared imports and non-Fleet consumers leave the Fleet series absent', async () => {
    await jest.isolateModulesAsync(async () => {
      const { registry, eventsPublishedTotal } = await import('@rasta/observability');
      const { EventConsumer } = await import('@rasta/nest-common');
      new EventConsumer(
        {
          brokers: ['localhost:9092'],
          clientId: 'maintenance-service',
          groupId: 'maintenance-service.usage',
          topics: ['rasta.fleet.v1'],
          deadLetterTopic: 'rasta.maintenance.v1.dlq',
        },
        async () => undefined,
        { log: () => undefined, warn: () => undefined, error: () => undefined },
      );
      eventsPublishedTotal.inc({ service: 'inventory-service', topic: 'rasta.inventory.v1' });
      expect((await registry.getSingleMetric(metricName)?.get())?.values).toEqual([]);
      expect(await registry.getSingleMetricAsString(metricName)).not.toContain(
        'service="fleet-service"',
      );
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it('the real broker-disabled hook initializes zero and preserves prior occurrences', async () => {
    await jest.isolateModulesAsync(async () => {
      const { AssetSyncConsumer } = await import('./consumers/asset-sync.consumer');
      const { registry, driftEvidenceOwnerChangesTotal } = await import('@rasta/observability');
      const consumer = new AssetSyncConsumer(null, {} as FleetRepository);
      const samples = async () => (await registry.getSingleMetric(metricName)?.get())?.values;
      try {
        expect(await samples()).toEqual([]);
        await consumer.onModuleInit();
        expect(await samples()).toEqual([{ labels: { service: 'fleet-service' }, value: 0 }]);
        driftEvidenceOwnerChangesTotal.inc();
        await consumer.onModuleInit();
        expect(await samples()).toEqual([{ labels: { service: 'fleet-service' }, value: 1 }]);
      } finally {
        await consumer.stop();
      }
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it.each(['accepted', 'rejected'] as const)(
    'actual Nest init retains the Kafka startup failure boundary: %s',
    async (mode) => {
      await jest.isolateModulesAsync(async () => {
        const { Test } = await import('@nestjs/testing');
        const { AppModule } = await import('./app.module');
        const { AssetSyncConsumer } = await import('./consumers/asset-sync.consumer');
        const { PrismaService } = await import('./prisma/prisma.service');
        const { ENV, LOGGER } = await import('./tokens');
        const { loadFleetEnv } = await import('./config/env');
        const { EventConsumer, OutboxRelay, OutboxPurgeScheduler, OutboxShutdown } =
          await import('@rasta/nest-common');
        const { registry, driftEvidenceOwnerChangesTotal } = await import('@rasta/observability');
        const samples = async () => (await registry.getSingleMetric(metricName)?.get())?.values;
        const value = (count: number) => [{ labels: { service: 'fleet-service' }, value: count }];
        const env = loadFleetEnv({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          KAFKA_BROKERS: 'localhost:9092',
          KAFKA_ALLOW_PLAINTEXT: 'true',
          REDIS_URL: 'redis://localhost:6379',
          OIDC_ISSUER_URL: 'http://localhost:8080',
          OIDC_JWKS_URI: 'http://localhost:8080/certs',
          OIDC_AUDIENCE: 'test',
          INTERNAL_TOKEN_SECRET: 'x'.repeat(48),
          ASSET_SERVICE_URL: 'http://localhost:3103',
          MAINTENANCE_SERVICE_URL: 'http://localhost:3105',
          IDENTITY_SERVICE_URL: 'http://localhost:3101',
        });
        let releaseStart!: () => void;
        const startReady = new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
        let entered!: () => void;
        const starting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const role = jest.fn(async () => undefined);
        const relay = { start: jest.fn() };
        const purge = { start: jest.fn() };
        const increment = jest.spyOn(driftEvidenceOwnerChangesTotal, 'inc');
        // Only the event's business effect is mocked. Exercise the real provider's
        // factory callback from transport start, before Nest can finish init.
        const callback = jest
          .spyOn(AssetSyncConsumer.prototype, 'handle')
          .mockImplementation(async () => {
            expect(await samples()).toEqual(value(0));
            driftEvidenceOwnerChangesTotal.inc();
            return 'SKIPPED';
          });
        const consume = jest
          .spyOn(EventConsumer.prototype, 'start')
          .mockImplementation(async function (this: InstanceType<typeof EventConsumer>) {
            entered();
            expect(await samples()).toEqual(value(callback.mock.calls.length === 0 ? 0 : 1));
            await startReady;
            if (mode === 'rejected') throw new Error('KAFKA_START_REJECTED');
            if (callback.mock.calls.length === 0) {
              // Narrow test seam into the actual EventConsumer callback; no Kafka I/O.
              const transport = this as unknown as {
                handler(event: EventEnvelope): Promise<unknown>;
              };
              await transport.handler({ eventName: 'TEST' } as EventEnvelope);
            }
          });
        jest.spyOn(EventConsumer.prototype, 'stop').mockResolvedValue(undefined);
        const replacements = new Map<unknown, unknown>([
          [ENV, env],
          [LOGGER, { info: jest.fn(), warn: jest.fn(), error: jest.fn() }],
          [PrismaService, { assertRuntimeRole: role }],
          [OutboxRelay, relay],
          [OutboxPurgeScheduler, purge],
          [OutboxShutdown, { stop: async () => undefined }],
        ]);
        const create = async () => {
          const builder = Test.createTestingModule({ imports: [AppModule] });
          const providers = Reflect.getMetadata('providers', AppModule) as (
            { provide: unknown } | (new (...args: never[]) => unknown)
          )[];
          for (const provider of providers) {
            const token = typeof provider === 'function' ? provider : provider.provide;
            if (token !== AssetSyncConsumer)
              builder.overrideProvider(token).useValue(replacements.get(token) ?? {});
          }
          return builder.compile();
        };
        const app = await create();
        const close = async (context: typeof app) => {
          await context.get(AssetSyncConsumer).stop();
          await context.get(AppModule).onApplicationShutdown();
          // Nest close joins the rejected initialization promise before teardown.
          await context.close().catch((error: unknown) => {
            if (mode !== 'rejected') throw error;
            expect(error).toEqual(new Error('KAFKA_START_REJECTED'));
          });
        };
        let initialized: Promise<unknown> | undefined;
        try {
          expect(await samples()).toEqual([]);
          initialized = app.init();
          const outcome = initialized.then(
            () => null,
            (error: unknown) => error,
          );
          await starting;
          expect(role).not.toHaveBeenCalled();
          expect(relay.start).not.toHaveBeenCalled();
          expect(purge.start).not.toHaveBeenCalled();
          expect(callback).not.toHaveBeenCalled();
          expect(jest.getTimerCount()).toBe(0);
          releaseStart();
          const error = await outcome;
          if (mode === 'rejected') {
            expect(error).toEqual(new Error('KAFKA_START_REJECTED'));
            expect(await samples()).toEqual(value(0));
            expect(role).not.toHaveBeenCalled();
            expect(relay.start).not.toHaveBeenCalled();
            expect(purge.start).not.toHaveBeenCalled();
            expect(callback).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(0); // Neither sweep nor AppModule gauge.
          } else {
            expect(error).toBeNull();
            expect(increment.mock.calls).toEqual([[0], []]);
            expect(await samples()).toEqual(value(1));
            expect(await registry.getSingleMetricAsString(metricName)).toContain(
              `${metricName}{service="fleet-service"} 1`,
            );
            expect(role).toHaveBeenCalledTimes(1);
            expect(relay.start).toHaveBeenCalledTimes(1);
            expect(purge.start).toHaveBeenCalledTimes(1);
            expect(jest.getTimerCount()).toBe(2);
            await close(app);
            expect(jest.getTimerCount()).toBe(0);
            const restarted = await create();
            try {
              await restarted.init();
              expect(await samples()).toEqual(value(1));
              expect(increment.mock.calls).toEqual([[0], [], [0]]);
              expect(consume).toHaveBeenCalledTimes(2);
            } finally {
              await close(restarted);
            }
          }
        } finally {
          releaseStart();
          await initialized?.catch(() => undefined);
          await close(app);
        }
        expect(jest.getTimerCount()).toBe(0);
      });
    },
  );
});

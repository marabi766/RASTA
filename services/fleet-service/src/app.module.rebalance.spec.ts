import 'reflect-metadata';
import type { EventConsumer } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { AssetSyncConsumer } from './consumers/asset-sync.consumer';
import { assetSyncRebalanceTimeoutMs, loadFleetEnv } from './config/env';

it('only asset-sync opts into its startup-computed rebalance budget', async () => {
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
  const providers = Reflect.getMetadata('providers', AppModule) as {
    provide?: unknown;
    useFactory?: (...args: unknown[]) => unknown;
  }[];
  const factory = providers.find((p) => p.provide === AssetSyncConsumer)?.useFactory;
  if (!factory) throw new Error('asset-sync factory missing');
  const holdRefusedExhaustion = jest.fn().mockResolvedValue(undefined);
  const sync = factory(env, {}, { holdRefusedExhaustion }, {}) as {
    consumerFactory: (handler: () => Promise<void>) => EventConsumer;
  };
  const consumer = sync.consumerFactory(async () => undefined) as unknown as {
    options: {
      rebalanceTimeoutMs?: number;
      beforeExhaustion: (event: { eventId: string; payload?: unknown }) => Promise<void>;
    };
  };
  expect(consumer.options.rebalanceTimeoutMs).toBe(assetSyncRebalanceTimeoutMs(env));
  expect(consumer.options.rebalanceTimeoutMs).toBe(300_000);
  await consumer.options.beforeExhaustion({ eventId: 'EVT' });
  expect(holdRefusedExhaustion).toHaveBeenLastCalledWith('EVT', undefined);
  await consumer.options.beforeExhaustion({ eventId: 'EVT', payload: { assetId: 'AST' } });
  expect(holdRefusedExhaustion).toHaveBeenLastCalledWith('EVT', 'AST');
  await consumer.options.beforeExhaustion({ eventId: 'EVT', payload: { assetId: 42 } });
  expect(holdRefusedExhaustion).toHaveBeenLastCalledWith('EVT', undefined);
});

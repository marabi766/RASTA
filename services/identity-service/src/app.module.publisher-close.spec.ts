import 'reflect-metadata';
import { OutboxShutdown } from '@rasta/nest-common';
import {
  publisherCloseProblems,
  runOutboxShutdownProvider,
  type ShutdownFactoryProvider,
} from '@rasta/testing';
import { AppModule, ENV, FENCE_PRISMA, SAMPLER_PRISMA } from './app.module';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { PrismaService } from './prisma/prisma.service';

/**
 * D-052 phase 4b (Codex r1 on #293, F1): AppModule's `OutboxShutdown` closes
 * the Kafka publisher last — once the relay, the purge and every worker have
 * returned — by their deadline, and once. Before, the publisher closed in its
 * own `onModuleDestroy` by a budget of its own, beside the drain; where the
 * relay still drained in `onApplicationShutdown`, the two budgets ran one after
 * the other past SHUTDOWN_TIMEOUT_MS. This calls AppModule's own factory with
 * stand-ins; the whole close through real kafkajs and Nest is fleet-service's
 * and inventory-service's `kafka.publisher.shutdown.spec.ts`.
 */
describe('AppModule closes the Kafka publisher after the outbox drain (D-052 phase 4b)', () => {
  it('last, after every other participant has stopped, by the same deadline, once', async () => {
    const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as unknown[];
    const provider = providers.find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        (candidate as { provide?: unknown }).provide === OutboxShutdown,
    ) as ShutdownFactoryProvider | undefined;
    expect(provider).toBeDefined();

    const stops = await runOutboxShutdownProvider(provider!, {
      env: { SHUTDOWN_TIMEOUT_MS: 25_000 },
      envToken: ENV,
    });

    // The three pools close after it, last of all (#458 r2 F2).
    expect(
      publisherCloseProblems(stops, KafkaEventPublisher, [
        PrismaService,
        FENCE_PRISMA,
        SAMPLER_PRISMA,
      ]),
    ).toEqual([]);
  });
});

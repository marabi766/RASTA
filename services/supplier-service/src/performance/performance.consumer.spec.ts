import type { EventConsumer } from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConcludedOutcomeRepository } from './concluded-outcome.repository';
import type { PerformanceEventRepository } from './performance-event.repository';
import {
  PERFORMANCE_CONSUMER_DISABLED,
  PerformanceConsumer,
  performanceConsumerFactory,
  type EventConsumerFactory,
} from './performance.consumer';

/**
 * Disabled by default (Codex review of #126, finding 1): with the flag off
 * there is no broker-facing consumer at all — no subscription, nothing read,
 * nothing recorded — and the startup log says why.
 */
describe('the performance consumer while disabled', () => {
  function counting(): { build: EventConsumerFactory; built: () => number } {
    let count = 0;
    const build: EventConsumerFactory = () => {
      count += 1;
      return {
        start: async () => undefined,
        stop: async () => undefined,
      } as unknown as EventConsumer;
    };
    return { build, built: () => count };
  }

  it('builds no broker consumer when the flag is off', () => {
    const { build, built } = counting();

    expect(
      performanceConsumerFactory({ SUPPLIER_PERFORMANCE_CONSUMER_ENABLED: false }, build),
    ).toBeNull();
    expect(built()).toBe(0);
  });

  it('starts nothing, and logs why', async () => {
    const warnings: string[] = [];
    const consumer = new PerformanceConsumer(
      performanceConsumerFactory(
        { SUPPLIER_PERFORMANCE_CONSUMER_ENABLED: false },
        counting().build,
      ),
      {} as PrismaService,
      {} as PerformanceEventRepository,
      {} as ConcludedOutcomeRepository,
      {
        info: () => undefined,
        debug: () => undefined,
        warn: (m: string) => warnings.push(m),
      } as never,
    );

    await consumer.start();
    await consumer.stop();

    expect(warnings).toEqual([PERFORMANCE_CONSUMER_DISABLED]);
    expect(PERFORMANCE_CONSUMER_DISABLED).toMatch(/RUN-006/);
  });

  it('hands over the broker consumer only when the flag is on', () => {
    const { build } = counting();
    expect(performanceConsumerFactory({ SUPPLIER_PERFORMANCE_CONSUMER_ENABLED: true }, build)).toBe(
      build,
    );
  });
});

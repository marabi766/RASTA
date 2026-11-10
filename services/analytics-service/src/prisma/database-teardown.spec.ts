import { describeDatabaseTeardown } from '@rasta/testing';
import { AppModule } from '../app.module';
import { PrismaClient } from '../generated/prisma';
import { PrismaService } from './prisma.service';

describeDatabaseTeardown(
  () => new PrismaService('postgresql://test:test@127.0.0.1:1/test'),
  PrismaClient.prototype,
  async (prisma) => {
    expect('onApplicationShutdown' in prisma).toBe(false);
    const module = new AppModule(
      prisma as PrismaService,
      {
        stop: async () => {
          await new Promise((resolve) => setTimeout(resolve, 22_000));
        },
      } as never,
      { SHUTDOWN_TIMEOUT_MS: 25_000 } as never,
    );
    await module.onModuleDestroy();
    await module.onApplicationShutdown();
  },
);

it('uses the configured budget even when only the application hook is invoked', async () => {
  const disconnect = jest.fn(async (_options?: { deadlineAt?: number }) => undefined);
  const module = new AppModule(
    { disconnect } as never,
    {} as never,
    { SHUTDOWN_TIMEOUT_MS: 6000 } as never,
  );
  const before = Date.now();
  await module.onApplicationShutdown();
  expect(disconnect).toHaveBeenCalledTimes(1);
  const deadlineAt = disconnect.mock.calls[0]?.[0]?.deadlineAt;
  expect(deadlineAt).toBeGreaterThanOrEqual(before + 4000);
  expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 4000);
});

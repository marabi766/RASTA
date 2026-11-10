import { describeDatabaseTeardown } from '@rasta/testing';
import { PrismaClient } from '../generated/prisma';
import { PrismaService } from './prisma.service';

describeDatabaseTeardown(
  () => new PrismaService('postgresql://test:test@127.0.0.1:1/test'),
  PrismaClient.prototype,
  (pool) => {
    const prisma = pool as PrismaService;
    prisma.beforeDisconnect(() => new Promise((resolve) => setTimeout(resolve, 22_000)));
    return prisma.onModuleDestroy();
  },
);

it('includes stalled pre-close hooks in the configured shutdown budget', async () => {
  jest.useFakeTimers();
  const disconnect = jest.spyOn(PrismaClient.prototype, '$disconnect').mockResolvedValue();
  try {
    const prisma = new PrismaService('postgresql://test:test@127.0.0.1:1/test', 6000);
    prisma.beforeDisconnect(() => new Promise<void>(() => undefined));
    let returned = false;
    const closing = prisma.onModuleDestroy().then(() => {
      returned = true;
    });
    await jest.advanceTimersByTimeAsync(4000);
    expect(returned).toBe(true);
    await closing;
    expect(prisma.onModuleDestroy()).toBe(prisma.onModuleDestroy());
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    jest.restoreAllMocks();
    jest.useRealTimers();
  }
});

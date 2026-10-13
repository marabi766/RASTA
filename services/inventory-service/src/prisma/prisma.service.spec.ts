import { PrismaService } from './prisma.service';

/**
 * The two behaviours of `PrismaService` that need no database: readiness never throws, and a
 * transaction's bounds reach Prisma as given. The rest — the tenant guard on real rows, the
 * runtime-role check — is the integration suites'.
 */
describe('PrismaService', () => {
  it('reports an unreachable database as not ready, without throwing', async () => {
    const prisma = new PrismaService(
      'postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1',
    );
    await expect(prisma.isHealthy()).resolves.toBe(false);
    await prisma.onModuleDestroy();
  });

  it('passes a transaction’s isolation, timeout and connection wait to Prisma, and nothing it was not given', async () => {
    const prisma = new PrismaService('postgresql://nobody:nothing@127.0.0.1:1/none');
    const $transaction = jest.fn(async (fn: (tx: unknown) => unknown, _options?: object) =>
      fn('tx'),
    );
    Object.defineProperty(prisma, 'client', { value: { $transaction } });

    await prisma.transaction(async () => 'done');
    await prisma.transaction(async () => 'done', {
      isolationLevel: 'RepeatableRead',
      timeoutMs: 30_000,
      maxWaitMs: 5_000,
    });

    expect($transaction.mock.calls.map((call) => call[1])).toEqual([
      {},
      { isolationLevel: 'RepeatableRead', timeout: 30_000, maxWait: 5_000 },
    ]);
  });
});

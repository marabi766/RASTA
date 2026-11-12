import { ulid } from 'ulid';
import { WorkerBoundary, WorkerAbandonedError, runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl } from './helpers';

it('FU-321: refuses lazy model/raw queries, transaction continuations and reconnect after shutdown', async () => {
  const prisma = new PrismaService(databaseUrl(), 30_000);
  const worker = new WorkerBoundary(jest.fn());
  const eventId = ulid();
  try {
    await expect(
      worker.run(() =>
        prisma.transaction(async (tx) => {
          await tx.processedEvent.create({ data: { eventId, consumerName: 'FU-321' } });
          await tx.$queryRaw`SELECT 1`;
          const lazy = tx.$queryRaw`SELECT 2`;
          worker.abandon();
          await expect(lazy).rejects.toBeInstanceOf(WorkerAbandonedError);
          await expect(
            runUnscoped('FU-321 refusal probe', () => tx.project.count()),
          ).rejects.toBeInstanceOf(WorkerAbandonedError);
        }),
      ),
    ).rejects.toBeInstanceOf(WorkerAbandonedError);
    expect(await prisma.client.processedEvent.count({ where: { eventId } })).toBe(0);
    // Another worker is unaffected, even on the same client.
    const other = new WorkerBoundary(jest.fn());
    await expect(other.run(() => prisma.client.$queryRaw`SELECT 1`)).resolves.toEqual([
      { '?column?': 1 },
    ]);
    await prisma.stop();
    await expect(other.run(() => prisma.client.$queryRaw`SELECT 1`)).rejects.toThrow(
      'Database shutdown',
    );
  } finally {
    await prisma.stop();
  }
});

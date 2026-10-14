import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { transactionNow } from './clock';

const clientAnswering = (rows: unknown): ExtendedPrismaClient =>
  ({ $queryRawUnsafe: jest.fn(async () => rows) }) as unknown as ExtendedPrismaClient;

describe('transactionNow', () => {
  it('returns the database’s instant', async () => {
    const at = new Date('2026-10-05T10:00:00.000Z');
    expect(await transactionNow(clientAnswering([{ now: at }]))).toBe(at);
  });

  it.each([[[]], [[{ now: '2026-10-05T10:00:00Z' }]], [[{}]]])(
    'refuses to fall back to the application clock when the answer is %j',
    async (rows) => {
      await expect(transactionNow(clientAnswering(rows))).rejects.toThrow(
        /refusing to fall back to the application clock/,
      );
    },
  );
});

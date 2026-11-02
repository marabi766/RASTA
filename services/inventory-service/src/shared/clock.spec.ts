import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { databaseClock, transactionNow } from './clock';

const clientAnswering = (rows: unknown): ExtendedPrismaClient =>
  ({ $queryRawUnsafe: jest.fn(async () => rows) }) as unknown as ExtendedPrismaClient;

describe.each([transactionNow, databaseClock])('%p', (readClock) => {
  it('returns the database’s instant', async () => {
    const at = new Date('2026-10-05T10:00:00.000Z');
    expect(await readClock(clientAnswering([{ now: at }]))).toBe(at);
  });

  it.each([[[]], [[{ now: '2026-10-05T10:00:00Z' }]], [[{}]], [[{ now: new Date(Number.NaN) }]]])(
    'refuses to fall back to the application clock when the answer is %j',
    async (rows) => {
      await expect(readClock(clientAnswering(rows))).rejects.toThrow(
        /refusing to fall back to the application clock/,
      );
    },
  );
});

it('uses the advancing database wall clock for deadline decisions', async () => {
  const tx = clientAnswering([{ now: new Date('2026-10-05T10:00:00.000Z') }]);
  await databaseClock(tx);
  expect(tx.$queryRawUnsafe).toHaveBeenCalledWith('SELECT clock_timestamp() AS now');
});

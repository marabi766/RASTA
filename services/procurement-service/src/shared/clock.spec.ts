import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { DatabaseClock } from './clock';

const clientAnswering = (rows: unknown) => {
  const query = jest.fn(async () => rows);
  return { client: { $queryRawUnsafe: query } as unknown as ExtendedPrismaClient, query };
};

describe('DatabaseClock', () => {
  it('returns the database’s instant, read with clock_timestamp() at millisecond precision', async () => {
    const at = new Date('2026-10-16T10:00:00.000Z');
    const { client, query } = clientAnswering([{ now: at }]);
    expect(await new DatabaseClock().now(client)).toBe(at);
    expect(query).toHaveBeenCalledWith('SELECT clock_timestamp()::timestamptz(3) AS now');
  });

  it.each([[[]], [[{ now: '2026-10-16T10:00:00Z' }]], [[{}]]])(
    'refuses to fall back to the application clock when the answer is %j',
    async (rows) => {
      await expect(new DatabaseClock().now(clientAnswering(rows).client)).rejects.toThrow(
        /refusing to fall back to the application clock/,
      );
    },
  );
});

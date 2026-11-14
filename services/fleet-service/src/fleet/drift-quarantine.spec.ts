import { EventHandlingUnconfirmedError } from '@rasta/nest-common';
import { Prisma } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { quarantineTransaction } from './drift-quarantine';

describe('source evidence window has closed entry causes', () => {
  it.each(['begin', 'seal', 'cleanup', 'savepoint', 'callback'] as const)(
    'rethrows ordinary infrastructure unchanged at %s',
    async (stage) => {
      const failure = new Prisma.PrismaClientKnownRequestError('test', {
        code: stage === 'begin' ? 'P1001' : 'P2010',
        clientVersion: 'test',
        meta: { code: stage === 'cleanup' ? '55P03' : '57014' },
      });
      const query = jest.fn().mockResolvedValue([{ run_id: 'RUN' }]);
      const execute = jest.fn().mockResolvedValue(0);
      if (stage === 'seal') query.mockRejectedValue(failure);
      if (stage === 'savepoint') execute.mockRejectedValue(failure);
      const tx = { $queryRaw: query, $executeRaw: execute } as unknown as ExtendedPrismaClient;
      const transaction = async (fn: (client: ExtendedPrismaClient) => Promise<unknown>) => {
        if (stage === 'begin') throw failure;
        return fn(tx);
      };
      await expect(
        quarantineTransaction(
          transaction,
          'EVT',
          async () => {
            if (stage === 'callback') throw failure;
          },
          {
            lock: async () => {
              if (stage === 'cleanup') throw failure;
            },
            discard: async () => undefined,
          },
        ),
      ).rejects.toBe(failure);
      expect(failure).not.toBeInstanceOf(EventHandlingUnconfirmedError);
    },
  );
});

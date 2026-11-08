import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { PrismaService } from '../prisma/prisma.service';
import { WalletRepository } from './wallet.repository';

describe('WalletRepository.isHoldFunded', () => {
  const asked = (rows: unknown[]) =>
    new WalletRepository({ client: {} } as unknown as PrismaService).isHoldFunded(
      { $queryRaw: async () => rows } as unknown as ExtendedPrismaClient,
      'HLD_1',
    );

  it('is funded only on an explicit yes', async () => {
    await expect(asked([{ funded: true }])).resolves.toBe(true);
    for (const rows of [[], [{ funded: false }], [{ funded: null }], [{ funded: 'true' }], [{}]]) {
      await expect(asked(rows)).resolves.toBe(false);
    }
  });
});

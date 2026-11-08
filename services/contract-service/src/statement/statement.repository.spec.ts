import { Prisma } from '../generated/prisma';
import type { ExtendedPrismaClient, PrismaService } from '../prisma/prisma.service';
import { StatementRepository } from './statement.repository';

describe('FU-089 rulesInForce', () => {
  const query = jest.fn();
  const tx = { $queryRaw: query } as unknown as ExtendedPrismaClient;
  const repository = new StatementRepository({} as PrismaService);
  beforeEach(() => {
    query.mockReset();
  });

  it('locks the selected tenant rules in C id order in the supplied transaction', async () => {
    const rows = [{ id: 'DDR_a', name: 'Retention', rateBp: 500, base: 'GROSS' }];
    query.mockResolvedValue(rows);
    await expect(
      repository.rulesInForce(tx, 'ORG_employer', ['DDR_z', 'DDR_a', 'DDR_a']),
    ).resolves.toBe(rows);
    const sql = query.mock.calls[0]![0] as Prisma.Sql;
    expect(sql.text).toMatch(/organization_id = \$1/);
    expect(sql.text).toMatch(/retired_at IS NULL/);
    expect(sql.text).toMatch(/ORDER BY id COLLATE "C" FOR SHARE/);
    expect(sql.values).toEqual(['ORG_employer', 'DDR_a', 'DDR_z']);
  });

  it('an empty selection needs no lock; no rule is applied', async () => {
    await expect(repository.rulesInForce(tx, 'ORG_employer', [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not turn an unreadable rule set into an empty successful read', async () => {
    query.mockRejectedValue(new Error('database unavailable'));
    await expect(repository.rulesInForce(tx, 'ORG_employer', ['DDR_a'])).rejects.toThrow(
      'database unavailable',
    );
  });
});

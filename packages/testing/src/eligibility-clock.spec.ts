import { expireClaim, makeDue } from './eligibility-clock';

// Counts are also checked against PostgreSQL by the durable-claim integration suite.
describe.each([expireClaim, makeDue])('%p fixture row counts', (setEligibility) => {
  const client = { $executeRawUnsafe: jest.fn<Promise<number>, [string, ...unknown[]]>() };
  const prisma = { client };

  it.each([0, 1, 3])('refuses %i updates for two distinct fixture ids', async (updated) => {
    client.$executeRawUnsafe.mockResolvedValue(updated);
    await expect(setEligibility(prisma, ['one', 'two'])).rejects.toThrow(
      'must update every requested fixture',
    );
  });

  it('counts duplicate ids once and keeps ids bound', async () => {
    client.$executeRawUnsafe.mockResolvedValue(2);
    await expect(setEligibility(prisma, ['one', 'two', 'one'])).resolves.toBeUndefined();
    expect(client.$executeRawUnsafe).toHaveBeenLastCalledWith(
      expect.stringContaining('ANY($1::text[])'),
      ['one', 'two', 'one'],
    );
  });

  it('accepts an empty fixture set only when no rows change', async () => {
    client.$executeRawUnsafe.mockResolvedValue(0);
    await expect(setEligibility(prisma, [])).resolves.toBeUndefined();
    client.$executeRawUnsafe.mockResolvedValue(1);
    await expect(setEligibility(prisma, [])).rejects.toThrow('must update every requested fixture');
  });

  it('rejects an unknown table before executing SQL', async () => {
    client.$executeRawUnsafe.mockClear();
    // @ts-expect-error Verify the runtime allowlist for untyped callers too.
    await expect(setEligibility(prisma, ['one'], 'unknown_table')).rejects.toThrow(
      'unknown eligibility table',
    );
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

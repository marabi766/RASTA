import {
  expireClaim,
  makeDue,
  setEligibilityFixture,
  eligibilityClockSql,
  eligibilityClockWrite,
  eligibilityClockTag,
} from './eligibility-clock';

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

describe('static eligibility mutation fixtures', () => {
  const fixtures = [
    'resolutionDue',
    'resolutionParked',
    'policyReleased',
    'awardDue',
    'awardExpired',
    'tenderDue',
    'tenderExpired',
    'scanDue',
    'scanExpired',
    'paymentPendingDue',
    'paymentDue',
    'paymentExpired',
    'paymentReleasedDue',
    'outboxLeasedPast',
    'outboxRetryPast',
    'outboxPairedPast',
  ] as const;
  const client = { $executeRawUnsafe: jest.fn<Promise<number>, [string, ...unknown[]]>() };

  it.each(fixtures)('%s binds ids and counts distinct fixture rows', async (fixture) => {
    client.$executeRawUnsafe.mockResolvedValue(2);
    await expect(
      setEligibilityFixture({ client }, fixture, ['one', 'two', 'one']),
    ).resolves.toBeUndefined();
    expect(client.$executeRawUnsafe).toHaveBeenLastCalledWith(
      expect.stringContaining('ANY($1::text[])'),
      ['one', 'two', 'one'],
    );
    expect(client.$executeRawUnsafe.mock.calls.at(-1)![0]).not.toMatch(/one|two/);
  });

  it.each(fixtures.flatMap((fixture) => [0, 1, 3].map((count) => [fixture, count] as const)))(
    '%s refuses %i updates for two rows',
    async (fixture, count) => {
      client.$executeRawUnsafe.mockResolvedValue(count);
      await expect(setEligibilityFixture({ client }, fixture, ['one', 'two'])).rejects.toThrow(
        'must update every requested fixture',
      );
    },
  );

  it.each(['__proto__', 'toString', 'unknown'])(
    'refuses unknown fixture %s before SQL',
    async (fixture) => {
      client.$executeRawUnsafe.mockClear();
      // @ts-expect-error Exercise the untyped runtime boundary.
      await expect(setEligibilityFixture({ client }, fixture, ['one'])).rejects.toThrow(
        'unknown eligibility fixture',
      );
      expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it('accepts an empty fixture set only with a zero row count', async () => {
    client.$executeRawUnsafe.mockResolvedValue(0);
    await expect(setEligibilityFixture({ client }, 'awardDue', [])).resolves.toBeUndefined();
    client.$executeRawUnsafe.mockResolvedValue(1);
    await expect(setEligibilityFixture({ client }, 'awardDue', [])).rejects.toThrow(
      'must update every requested fixture',
    );
  });
});

describe('reviewed SQL probe templates', () => {
  it('refuses unreviewed string, executor and Prisma.sql templates before executing', () => {
    const execute = jest.fn();
    const client = { $executeRawUnsafe: execute };
    expect(() => eligibilityClockSql`unreviewed SQL`).toThrow('unreviewed eligibility SQL probe');
    expect(() => eligibilityClockWrite(client)`unreviewed SQL`).toThrow(
      'unreviewed eligibility SQL probe',
    );
    expect(() => eligibilityClockTag(execute)`unreviewed SQL`).toThrow(
      'unreviewed eligibility SQL probe',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

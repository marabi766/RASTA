import {
  expireClaim,
  makeDue,
  setEligibilityFixture,
  setTenantEligibilityFixture,
  insertTransferFixture,
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

  it('refuses an empty fixture set before executing SQL (0 rows for 0 ids is no proof)', async () => {
    client.$executeRawUnsafe.mockClear();
    client.$executeRawUnsafe.mockResolvedValue(0);
    await expect(setEligibility(prisma, [])).rejects.toThrow('needs at least one fixture key');
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
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
    'membershipStartedHourAgo',
    'membershipStartedDayAgo',
    'membershipEndsInTenSeconds',
    'membershipEndedMinuteAgo',
    'membershipHeldTwoDaysToTenMinutesAgo',
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

  it('refuses an empty fixture set before executing SQL', async () => {
    client.$executeRawUnsafe.mockClear();
    client.$executeRawUnsafe.mockResolvedValue(0);
    await expect(setEligibilityFixture({ client }, 'awardDue', [])).rejects.toThrow(
      'needs at least one fixture key',
    );
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('tenant-keyed eligibility fixtures (real key, one organization)', () => {
  const client = { $executeRawUnsafe: jest.fn<Promise<number>, [string, ...unknown[]]>() };

  it.each([
    ['transferFenceExpired', 'asset_id = ANY($2::text[])'],
    ['dedupeWindowExpired', 'dedupe_key = ANY($2::text[])'],
  ] as const)('%s binds the organization and keys by %s', async (fixture, selector) => {
    client.$executeRawUnsafe.mockResolvedValue(2);
    await expect(
      setTenantEligibilityFixture({ client }, fixture, 'ORG-1', ['k1', 'k2', 'k1']),
    ).resolves.toBeUndefined();
    const [sql, ...values] = client.$executeRawUnsafe.mock.calls.at(-1)!;
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain(selector);
    expect(sql).not.toMatch(/ORG-1|k1|k2/);
    expect(values).toEqual(['ORG-1', ['k1', 'k2', 'k1']]);
  });

  it('ages a dedupe window inside ck_dedupe_window_ordered, last_seen_at before expires_at', async () => {
    client.$executeRawUnsafe.mockResolvedValue(1);
    await setTenantEligibilityFixture({ client }, 'dedupeWindowExpired', 'ORG-1', ['k']);
    const sql = client.$executeRawUnsafe.mock.calls.at(-1)![0];
    expect(sql).toContain("first_seen_at = now() - interval '46 days'");
    expect(sql).toContain("last_seen_at = now() - interval '46 days'");
    expect(sql).toContain("expires_at = now() - interval '1 day'");
  });

  it.each([0, 1, 3])('refuses %i updated rows for two keys', async (count) => {
    client.$executeRawUnsafe.mockResolvedValue(count);
    await expect(
      setTenantEligibilityFixture({ client }, 'transferFenceExpired', 'ORG-1', ['a', 'b']),
    ).rejects.toThrow('must update every requested fixture');
  });

  it('refuses an empty key set and an unknown fixture before SQL', async () => {
    client.$executeRawUnsafe.mockClear();
    await expect(
      setTenantEligibilityFixture({ client }, 'transferFenceExpired', 'ORG-1', []),
    ).rejects.toThrow('needs at least one fixture key');
    await expect(
      // @ts-expect-error Exercise the untyped runtime boundary.
      setTenantEligibilityFixture({ client }, 'toString', 'ORG-1', ['a']),
    ).rejects.toThrow('unknown eligibility fixture');
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('transfer fence and release inserts dated by the database clock', () => {
  const client = { $executeRawUnsafe: jest.fn<Promise<number>, [string, ...unknown[]]>() };
  const rows = [
    { assetId: 'AST-1', fenceId: 'TRF-1' },
    { assetId: 'AST-2', fenceId: 'TRF-2' },
  ];

  it.each(['fenceExpired', 'fenceLive', 'releaseExpired', 'releaseLive'] as const)(
    '%s binds organization, assets and fences, and inserts exactly the rows asked for',
    async (fixture) => {
      client.$executeRawUnsafe.mockResolvedValue(2);
      await expect(insertTransferFixture(client, fixture, 'ORG-1', rows)).resolves.toBeUndefined();
      const [sql, ...values] = client.$executeRawUnsafe.mock.calls.at(-1)!;
      expect(sql).toMatch(/now\(\)/);
      expect(sql).not.toMatch(/ORG-1|AST-|TRF-/);
      expect(values).toEqual(['ORG-1', ['AST-1', 'AST-2'], ['TRF-1', 'TRF-2']]);
    },
  );

  it.each([0, 1, 3])('refuses %i inserted rows for two', async (count) => {
    client.$executeRawUnsafe.mockResolvedValue(count);
    await expect(insertTransferFixture(client, 'releaseExpired', 'ORG-1', rows)).rejects.toThrow(
      'must insert every requested row',
    );
  });

  it('refuses no rows and an unknown fixture before SQL', async () => {
    client.$executeRawUnsafe.mockClear();
    await expect(insertTransferFixture(client, 'fenceLive', 'ORG-1', [])).rejects.toThrow(
      'needs at least one fixture key',
    );
    // @ts-expect-error Exercise the untyped runtime boundary.
    await expect(insertTransferFixture(client, 'unknown', 'ORG-1', rows)).rejects.toThrow(
      'unknown eligibility fixture',
    );
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
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

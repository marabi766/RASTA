import {
  MAX_AMOUNT_MINOR,
  amountOf,
  awardFactSchema,
  confirmAward,
  confirmTenant,
  type AwardClaim,
  type AwardFact,
} from './award-confirm';

const claim: AwardClaim = {
  tenderId: 'TND_1',
  organizationId: 'ORG_OWNER',
  winningBidId: 'BID_1',
  winnerOrganizationId: 'ORG_WINNER',
  matrixDigest: 'a'.repeat(64),
  awardedBy: 'USR_1',
  awardedAt: '2026-10-03T09:30:00.000Z',
};

const fact: AwardFact = {
  tenderId: 'TND_1',
  status: 'AWARDED',
  bidId: 'BID_1',
  bidderOrganizationId: 'ORG_WINNER',
  amountMinor: '4500000000',
  matrixDigest: 'a'.repeat(64),
  awardedAt: '2026-10-03T09:30:00.000Z',
  awardedBy: 'USR_1',
};

describe('confirmTenant', () => {
  it('confirms an envelope whose tenant is the payload’s organization', () => {
    expect(confirmTenant('ORG_OWNER', 'ORG_OWNER')).toEqual({ confirmed: true });
  });

  it.each([['ORG_OTHER'], [undefined], ['']])('refuses tenant %p', (tenant) => {
    expect(confirmTenant(tenant, 'ORG_OWNER')).toEqual({
      confirmed: false,
      mismatch: 'tenant_mismatch',
    });
  });
});

describe('confirmAward', () => {
  it('confirms an answer that agrees with the event on every field', () => {
    expect(confirmAward(claim, fact)).toEqual({ confirmed: true });
  });

  it('treats the same instant written two ways as the same award time', () => {
    expect(confirmAward(claim, { ...fact, awardedAt: '2026-10-03T13:00:00.000+03:30' })).toEqual({
      confirmed: true,
    });
  });

  it.each<[string, Partial<AwardFact> | null, string]>([
    ['no award at all', null, 'not_found'],
    ['another tender', { tenderId: 'TND_2' }, 'tender_mismatch'],
    ['a tender that is not awarded', { status: 'EVALUATED' }, 'status_mismatch'],
    ['another bid', { bidId: 'BID_2' }, 'bid_mismatch'],
    ['another contractor', { bidderOrganizationId: 'ORG_X' }, 'contractor_mismatch'],
    ['another digest', { matrixDigest: 'b'.repeat(64) }, 'digest_mismatch'],
    ['another awarding person', { awardedBy: 'USR_2' }, 'awarded_by_mismatch'],
    ['another award time', { awardedAt: '2026-10-04T09:30:00.000Z' }, 'awarded_at_mismatch'],
    ['a zero amount', { amountMinor: '0' }, 'amount_invalid'],
    ['an amount beyond bigint', { amountMinor: '9223372036854775808' }, 'amount_invalid'],
  ])('refuses %s', (_label, change, mismatch) => {
    const answer = change === null ? null : { ...fact, ...change };
    expect(confirmAward(claim, answer)).toEqual({ confirmed: false, mismatch });
  });

  it('refuses a contract with oneself: the winner is the owner', () => {
    expect(
      confirmAward(
        { ...claim, winnerOrganizationId: 'ORG_OWNER' },
        { ...fact, bidderOrganizationId: 'ORG_OWNER' },
      ),
    ).toEqual({ confirmed: false, mismatch: 'contractor_mismatch' });
  });

  it('refuses an unparseable award time instead of passing it', () => {
    expect(confirmAward(claim, { ...fact, awardedAt: 'yesterday' })).toEqual({
      confirmed: false,
      mismatch: 'awarded_at_mismatch',
    });
  });
});

describe('amountOf', () => {
  it('reads a positive decimal string as a bigint, exactly', () => {
    expect(amountOf({ amountMinor: '9007199254740993' })).toBe(9007199254740993n);
  });

  it('accepts the largest bigint and nothing above it', () => {
    expect(amountOf({ amountMinor: MAX_AMOUNT_MINOR.toString() })).toBe(MAX_AMOUNT_MINOR);
    expect(amountOf({ amountMinor: (MAX_AMOUNT_MINOR + 1n).toString() })).toBeNull();
  });

  it.each(['0', '-1', '1.5', '1e9', ' 5', '', '0x10', '12345678901234567890'])(
    'is null for %p: never guessed, rounded or defaulted',
    (amountMinor) => {
      expect(amountOf({ amountMinor })).toBeNull();
    },
  );
});

describe('awardFactSchema', () => {
  it('parses the owner’s answer and ignores a field it has no use for', () => {
    expect(awardFactSchema.parse({ ...fact, awardJustification: 'x' })).toEqual(fact);
  });

  it.each([
    'tenderId',
    'status',
    'bidId',
    'bidderOrganizationId',
    'amountMinor',
    'matrixDigest',
    'awardedAt',
    'awardedBy',
  ])('is unusable without %s (fail closed)', (field) => {
    const { [field as keyof AwardFact]: _omitted, ...rest } = fact;
    expect(awardFactSchema.safeParse(rest).success).toBe(false);
  });

  it('refuses an amount sent as a JSON number: money is a string', () => {
    expect(awardFactSchema.safeParse({ ...fact, amountMinor: 4500000000 }).success).toBe(false);
  });
});

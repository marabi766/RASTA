import { AGGREGATE_OF, AGGREGATE_TYPE, resolvePartitionKey } from './routing';
import { CONTRACT_EVENT_SCHEMAS, CONTRACT_EVENTS, validateContractPayload } from './events';

const drafted = {
  contractId: 'CTR_1',
  tenderId: 'TND_1',
  projectId: 'PRJ_1',
  organizationId: 'ORG_OWNER',
  contractorOrganizationId: 'ORG_WINNER',
  winningBidId: 'BID_1',
  draftedAt: '2026-10-05T10:00:00.000Z',
};

const signed = {
  contractId: 'CTR_1',
  tenderId: 'TND_1',
  projectId: 'PRJ_1',
  organizationId: 'ORG_OWNER',
  contractorOrganizationId: 'ORG_WINNER',
  winningBidId: 'BID_1',
  employerSignedAt: '2026-10-05T10:00:00.000Z',
  contractorSignedAt: '2026-10-05T11:00:00.000Z',
  signedAt: '2026-10-05T11:00:00.000Z',
};

const cancelled = {
  contractId: 'CTR_1',
  tenderId: 'TND_1',
  projectId: 'PRJ_1',
  organizationId: 'ORG_OWNER',
  contractorOrganizationId: 'ORG_WINNER',
  reasonCode: 'TERMS_NOT_AGREED',
  cancelledAt: '2026-10-05T12:00:00.000Z',
};

describe('the contract events', () => {
  it('are the four of the lifecycle so far, each with a schema and the contract as aggregate', () => {
    const names = [
      'CONTRACT_DRAFTED',
      'CONTRACT_SIGNATURE_RECORDED',
      'CONTRACT_SIGNED',
      'CONTRACT_CANCELLED',
    ];
    expect(Object.keys(CONTRACT_EVENTS)).toEqual(names);
    expect(Object.keys(CONTRACT_EVENT_SCHEMAS)).toEqual(names);
    expect(Object.keys(AGGREGATE_OF)).toEqual(names);
  });
});

describe('CONTRACT_SIGNATURE_RECORDED', () => {
  const recorded = {
    contractId: 'CTR_01',
    organizationId: 'ORG_EMPLOYER',
    side: 'CONTRACTOR',
    signerOrganizationId: 'ORG_CONTRACTOR',
    signedBy: 'USR_SIGNER',
    authorityRole: 'CONTRACTOR',
    signedAt: '2026-10-05T10:00:00.000Z',
  };

  it('accepts the payload as published, naming the signer by user id', () => {
    expect(validateContractPayload('CONTRACT_SIGNATURE_RECORDED', recorded)).toEqual(recorded);
  });

  it.each(['amountMinor', 'amount', 'signedByIssuer', 'signedBySubject', 'note', 'email'])(
    'refuses a payload with %s: no amount, no identity pair, no free text',
    (field) => {
      expect(() =>
        validateContractPayload('CONTRACT_SIGNATURE_RECORDED', { ...recorded, [field]: '1' }),
      ).toThrow(/does not match its published contract/);
    },
  );

  it.each(Object.keys(recorded))('refuses a payload without %s', (field) => {
    const { [field as keyof typeof recorded]: _omitted, ...rest } = recorded;
    expect(() => validateContractPayload('CONTRACT_SIGNATURE_RECORDED', rest)).toThrow();
  });

  it('refuses a side that is not one of the two, and a role that is not a code', () => {
    expect(() =>
      validateContractPayload('CONTRACT_SIGNATURE_RECORDED', { ...recorded, side: 'WITNESS' }),
    ).toThrow();
    expect(() =>
      validateContractPayload('CONTRACT_SIGNATURE_RECORDED', {
        ...recorded,
        authorityRole: 'not a role',
      }),
    ).toThrow();
  });
});

describe('CONTRACT_SIGNED', () => {
  it('accepts the payload as published', () => {
    expect(validateContractPayload('CONTRACT_SIGNED', signed)).toEqual(signed);
  });

  it.each(['amountMinor', 'amount', 'signedBy', 'signers', 'userId', 'note'])(
    'refuses a payload with %s: no amount and no person on a shared topic',
    (field) => {
      expect(() => validateContractPayload('CONTRACT_SIGNED', { ...signed, [field]: '1' })).toThrow(
        /does not match its published contract/,
      );
    },
  );

  it.each(Object.keys(signed))('refuses a payload without %s', (field) => {
    const { [field as keyof typeof signed]: _omitted, ...rest } = signed;
    expect(() => validateContractPayload('CONTRACT_SIGNED', rest)).toThrow();
  });
});

describe('CONTRACT_CANCELLED', () => {
  it('accepts the payload as published, with the closed reason code', () => {
    expect(validateContractPayload('CONTRACT_CANCELLED', cancelled)).toEqual(cancelled);
  });

  it.each(['note', 'reason', 'cancelNote', 'amountMinor', 'cancelledBy'])(
    'refuses a payload with %s: client free text and amounts stay off the topic',
    (field) => {
      expect(() =>
        validateContractPayload('CONTRACT_CANCELLED', { ...cancelled, [field]: 'x' }),
      ).toThrow(/does not match its published contract/);
    },
  );

  it.each(['terms not agreed', 'x', '', 'LOWER_case'])('refuses the reason %p', (reasonCode) => {
    expect(() =>
      validateContractPayload('CONTRACT_CANCELLED', { ...cancelled, reasonCode }),
    ).toThrow();
  });

  it.each(Object.keys(cancelled))('refuses a payload without %s', (field) => {
    const { [field as keyof typeof cancelled]: _omitted, ...rest } = cancelled;
    expect(() => validateContractPayload('CONTRACT_CANCELLED', rest)).toThrow();
  });
});

describe('CONTRACT_DRAFTED', () => {
  it('accepts the payload as published', () => {
    expect(validateContractPayload('CONTRACT_DRAFTED', drafted)).toEqual(drafted);
  });

  it.each(['amountMinor', 'amount', 'price', 'parties', 'awardedBy', 'matrixDigest'])(
    'refuses a payload with %s: the topic is shared and carries identifiers and instants only',
    (field) => {
      expect(() =>
        validateContractPayload('CONTRACT_DRAFTED', { ...drafted, [field]: '1' }),
      ).toThrow(/does not match its published contract/);
    },
  );

  it.each(Object.keys(drafted))('refuses a payload without %s', (field) => {
    const { [field as keyof typeof drafted]: _omitted, ...rest } = drafted;
    expect(() => validateContractPayload('CONTRACT_DRAFTED', rest)).toThrow();
  });

  it('refuses an instant with an offset: UTC only', () => {
    expect(() =>
      validateContractPayload('CONTRACT_DRAFTED', {
        ...drafted,
        draftedAt: '2026-10-05T13:30:00+03:30',
      }),
    ).toThrow();
  });
});

describe('routing', () => {
  it('keys an event by the contract it is about', () => {
    expect(resolvePartitionKey('CONTRACT_DRAFTED', drafted).key).toBe('CTR_1');
    expect(AGGREGATE_OF.CONTRACT_DRAFTED).toBe(AGGREGATE_TYPE);
  });

  it('refuses an event that names no contract to key it by', () => {
    expect(() => resolvePartitionKey('CONTRACT_DRAFTED', {})).toThrow(/no contractId/);
  });
});

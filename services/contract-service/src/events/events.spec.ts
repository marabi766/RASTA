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

describe('CONTRACT_DRAFTED', () => {
  it('is the one event this change publishes, and has a schema', () => {
    expect(Object.keys(CONTRACT_EVENTS)).toEqual(['CONTRACT_DRAFTED']);
    expect(Object.keys(CONTRACT_EVENT_SCHEMAS)).toEqual(['CONTRACT_DRAFTED']);
  });

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

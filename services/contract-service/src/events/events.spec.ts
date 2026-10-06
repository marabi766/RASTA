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
  it('are the lifecycle’s four, the approval policy’s six and the authority review’s two, each with a schema and an aggregate', () => {
    const names = [
      'CONTRACT_DRAFTED',
      'CONTRACT_SIGNATURE_RECORDED',
      'CONTRACT_SIGNED',
      'CONTRACT_CANCELLED',
      'APPROVAL_POLICY_CREATED',
      'APPROVAL_POLICY_SUBMITTED',
      'APPROVAL_POLICY_REJECTED',
      'APPROVAL_POLICY_ACTIVATED',
      'APPROVAL_POLICY_RETIRED',
      'APPROVAL_POLICY_SUSPENDED',
      'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED',
      'CONTRACT_SIGNATURE_REFUSED',
    ];
    expect(Object.keys(CONTRACT_EVENTS)).toEqual(names);
    expect(Object.keys(CONTRACT_EVENT_SCHEMAS)).toEqual(names);
    expect(Object.keys(AGGREGATE_OF)).toEqual(names);
    for (const name of names) {
      expect(AGGREGATE_OF[name as keyof typeof AGGREGATE_OF]).toBe(
        name.startsWith('APPROVAL_POLICY_') ? 'ApprovalPolicy' : AGGREGATE_TYPE,
      );
    }
  });
});

describe('the approval policy events', () => {
  const base = {
    policyId: 'APL_1',
    organizationId: 'ORG_OWNER',
    workflowKey: 'contract.signature',
    policyVersion: 2,
  };
  const payloads = {
    APPROVAL_POLICY_CREATED: {
      ...base,
      authorOrganizationId: 'ORG_UNION',
      authorRole: 'UNION_ADMIN',
      stepCount: 1,
      isSample: false,
      createdBy: 'USR_1',
      createdAt: '2026-10-05T10:00:00.000Z',
    },
    APPROVAL_POLICY_SUBMITTED: {
      ...base,
      submittedBy: 'USR_1',
      submittedAt: '2026-10-05T10:00:00.000Z',
    },
    APPROVAL_POLICY_REJECTED: {
      ...base,
      rejectedBy: 'USR_2',
      rejectedAt: '2026-10-05T10:00:00.000Z',
    },
    APPROVAL_POLICY_ACTIVATED: {
      ...base,
      retiredPolicyId: null,
      activatedBy: 'USR_2',
      activatedAt: '2026-10-05T10:00:00.000Z',
    },
    APPROVAL_POLICY_RETIRED: { ...base, retiredBy: 'USR_2', retiredAt: '2026-10-05T10:00:00.000Z' },
    APPROVAL_POLICY_SUSPENDED: {
      ...base,
      authorOrganizationId: 'ORG_UNION',
      fromStatus: 'ACTIVE',
      reason: 'ORGANIZATION_MOVED',
      causeEventId: 'EVT_1',
      movedOrganizationId: 'ORG_OWNER',
      suspendedBy: 'system:contract-service',
      suspendedAt: '2026-10-05T10:00:00.000Z',
    },
  } as const;

  it.each(Object.entries(payloads))('%s accepts the payload as published', (name, payload) => {
    expect(validateContractPayload(name as keyof typeof payloads, payload)).toEqual(payload);
  });

  it.each(Object.keys(payloads))(
    '%s refuses a field it does not publish: no rationale, no rejection reason, no amount',
    (name) => {
      for (const field of ['rationale', 'rejectionReason', 'reason', 'amountMinor', 'label']) {
        expect(() =>
          validateContractPayload(name as keyof typeof payloads, {
            ...payloads[name as keyof typeof payloads],
            [field]: 'x',
          }),
        ).toThrow(/does not match its published contract/);
      }
    },
  );

  it('refuses a workflow that has no policy', () => {
    expect(() =>
      validateContractPayload('APPROVAL_POLICY_SUBMITTED', {
        ...payloads.APPROVAL_POLICY_SUBMITTED,
        workflowKey: 'contract.amendment',
      }),
    ).toThrow();
  });

  it('is keyed by (organization, workflow key), so every version of one line shares a stream', () => {
    for (const name of Object.keys(payloads)) {
      const decision = resolvePartitionKey(
        name as keyof typeof payloads,
        payloads[name as keyof typeof payloads],
      );
      expect(decision.key).toBe('ORG_OWNER/contract.signature');
    }
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
    policyId: null,
    policyVersion: null,
    signedAt: '2026-10-05T10:00:00.000Z',
  };

  it('accepts the payload as published, naming the signer by user id', () => {
    expect(validateContractPayload('CONTRACT_SIGNATURE_RECORDED', recorded)).toEqual(recorded);
  });

  it('names the policy that authorised the employer’s side, by id and version', () => {
    const employer = {
      ...recorded,
      side: 'EMPLOYER',
      signerOrganizationId: 'ORG_EMPLOYER',
      authorityRole: 'ORGANIZATION_ADMIN',
      policyId: 'APL_1',
      policyVersion: 3,
    };
    expect(validateContractPayload('CONTRACT_SIGNATURE_RECORDED', employer)).toEqual(employer);
    expect(() =>
      validateContractPayload('CONTRACT_SIGNATURE_RECORDED', { ...employer, policyVersion: 0 }),
    ).toThrow();
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

describe('the authority events (D-050, review round 3)', () => {
  const flagged = {
    contractId: 'CTR_1',
    organizationId: 'ORG_E',
    side: 'EMPLOYER',
    policyId: 'APL_1',
    policyVersion: 2,
    reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
    causeEventId: 'EVT_1',
    movedAt: '2026-10-06T10:00:00.000Z',
    flaggedAt: '2026-10-06T10:00:05.000Z',
  };
  const refused = {
    contractId: 'CTR_1',
    organizationId: 'ORG_E',
    side: 'EMPLOYER',
    reason: 'POLICY_AUTHOR_NOT_GOVERNING',
    policyId: 'APL_1',
    refusedBy: 'USR_1',
    refusedAt: '2026-10-06T10:00:05.000Z',
  };

  it('accept the payloads as published, keyed by the contract they concern', () => {
    expect(validateContractPayload('CONTRACT_SIGNATURE_AUTHORITY_FLAGGED', flagged)).toEqual(
      flagged,
    );
    expect(validateContractPayload('CONTRACT_SIGNATURE_REFUSED', refused)).toEqual(refused);
    expect(
      validateContractPayload('CONTRACT_SIGNATURE_REFUSED', { ...refused, policyId: null })
        .policyId,
    ).toBeNull();
    expect(resolvePartitionKey('CONTRACT_SIGNATURE_REFUSED', refused).key).toBe('CTR_1');
    expect(AGGREGATE_OF.CONTRACT_SIGNATURE_AUTHORITY_FLAGGED).toBe(AGGREGATE_TYPE);
  });

  it.each(['note', 'message', 'amountMinor', 'role'])(
    'refuse %s: no free text, no amount',
    (field) => {
      for (const [name, payload] of [
        ['CONTRACT_SIGNATURE_AUTHORITY_FLAGGED', flagged],
        ['CONTRACT_SIGNATURE_REFUSED', refused],
      ] as const) {
        expect(() => validateContractPayload(name, { ...payload, [field]: 'x' })).toThrow(
          /does not match its published contract/,
        );
      }
    },
  );

  it('name only closed reasons', () => {
    expect(() =>
      validateContractPayload('CONTRACT_SIGNATURE_AUTHORITY_FLAGGED', { ...flagged, reason: 'X' }),
    ).toThrow();
    expect(() =>
      validateContractPayload('CONTRACT_SIGNATURE_REFUSED', {
        ...refused,
        reason: 'CONTRACT_NOT_DRAFT',
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

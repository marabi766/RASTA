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
  it('are the lifecycle’s four, the approval policy’s seven, the authority review’s two, amendments’ and milestones’ seven, statements’ six and the settlement’s two, each with a schema and an aggregate', () => {
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
      'APPROVAL_POLICY_APPROVAL_REFUSED',
      'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED',
      'CONTRACT_SIGNATURE_REFUSED',
      'CONTRACT_AMENDMENT_PROPOSED',
      'CONTRACT_AMENDMENT_SIGNATURE_RECORDED',
      'CONTRACT_AMENDED',
      'CONTRACT_AMENDMENT_SIGNATURE_AUTHORITY_FLAGGED',
      'CONTRACT_MILESTONE_PLANNED',
      'CONTRACT_MILESTONE_CHANGED',
      'CONTRACT_AUTHORITY_REFUSED',
      'STATEMENT_DRAFTED',
      'STATEMENT_SUBMITTED',
      'STATEMENT_DECISION_RECORDED',
      'STATEMENT_TECHNICALLY_APPROVED',
      'STATEMENT_APPROVED',
      'STATEMENT_REJECTED',
      'STATEMENT_SETTLED',
      'CONTRACT_SETTLED',
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
    APPROVAL_POLICY_APPROVAL_REFUSED: {
      ...base,
      reason: 'SELF_APPROVAL',
      refusedBy: 'USR_1',
      refusedAt: '2026-10-05T10:00:00.000Z',
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
    detectedBy: 'ORGANIZATION_MOVED',
    movedAt: '2026-10-06T10:00:00.000Z',
    movedVersion: 7,
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
    expect(
      validateContractPayload('CONTRACT_SIGNATURE_AUTHORITY_FLAGGED', {
        ...flagged,
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
      }),
    ).toMatchObject({ detectedBy: 'MOVE_RECHECK', causeEventId: null, movedAt: null });
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

  it('FLAGGED is exactly one of two shapes: the cause event AND instant, or neither', () => {
    const recheck = { ...flagged, detectedBy: 'MOVE_RECHECK', causeEventId: null, movedAt: null };
    for (const bad of [
      { ...flagged, causeEventId: null },
      { ...flagged, movedAt: null },
      { ...flagged, causeEventId: null, movedAt: null },
      { ...recheck, causeEventId: 'EVT_1' },
      { ...recheck, movedAt: '2026-10-06T10:00:00.000Z' },
      { ...recheck, causeEventId: 'EVT_1', movedAt: '2026-10-06T10:00:00.000Z' },
      { ...flagged, detectedBy: 'SOMETHING_ELSE' },
      { ...flagged, flaggedAt: undefined },
      { ...recheck, flaggedAt: undefined },
    ]) {
      expect(() => validateContractPayload('CONTRACT_SIGNATURE_AUTHORITY_FLAGGED', bad)).toThrow();
    }
  });

  it('SUSPENDED is exactly one of two shapes: the cause event AND organization, or neither', () => {
    const moved = {
      policyId: 'APL_1',
      organizationId: 'ORG_OWNER',
      workflowKey: 'contract.signature',
      policyVersion: 2,
      authorOrganizationId: 'ORG_UNION',
      fromStatus: 'ACTIVE',
      reason: 'ORGANIZATION_MOVED',
      causeEventId: 'EVT_1',
      movedOrganizationId: 'ORG_OWNER',
      suspendedBy: 'system:contract-service',
      suspendedAt: '2026-10-05T10:00:00.000Z',
    };
    const none = { ...moved, causeEventId: null, movedOrganizationId: null };
    for (const reason of ['MOVE_RECHECK', 'SIGNING_RECHECK']) {
      expect(
        validateContractPayload('APPROVAL_POLICY_SUSPENDED', { ...none, reason }),
      ).toBeTruthy();
    }
    for (const bad of [
      { ...moved, causeEventId: null },
      { ...moved, movedOrganizationId: null },
      { ...none, reason: 'ORGANIZATION_MOVED' },
      { ...none, reason: 'MOVE_RECHECK', causeEventId: 'EVT_1' },
      { ...none, reason: 'SIGNING_RECHECK', movedOrganizationId: 'ORG_OWNER' },
      { ...moved, reason: 'MOVE_RECHECK' },
      { ...moved, reason: 'OTHER' },
    ]) {
      expect(() => validateContractPayload('APPROVAL_POLICY_SUSPENDED', bad)).toThrow();
    }
  });

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

describe('the amendment and milestone events (CON-003 PR 3)', () => {
  const at = '2026-10-07T10:00:00.000Z';
  const payloads = {
    CONTRACT_AMENDMENT_PROPOSED: {
      contractId: 'CTR_1',
      amendmentId: 'AMD_1',
      amendmentNumber: 1,
      organizationId: 'ORG_E',
      contractorOrganizationId: 'ORG_C',
      reasonCode: 'SCOPE_CHANGE',
      proposedBy: 'USR_1',
      proposedAt: at,
    },
    CONTRACT_AMENDMENT_SIGNATURE_RECORDED: {
      contractId: 'CTR_1',
      amendmentId: 'AMD_1',
      organizationId: 'ORG_E',
      side: 'EMPLOYER',
      signerOrganizationId: 'ORG_E',
      signedBy: 'USR_1',
      authorityRole: 'ORGANIZATION_ADMIN',
      policyId: 'APL_1',
      policyVersion: 2,
      signedAt: at,
    },
    CONTRACT_AMENDED: {
      contractId: 'CTR_1',
      amendmentId: 'AMD_1',
      amendmentNumber: 1,
      organizationId: 'ORG_E',
      contractorOrganizationId: 'ORG_C',
      reasonCode: 'SCOPE_CHANGE',
      employerSignedAt: at,
      contractorSignedAt: at,
      effectiveAt: at,
    },
    CONTRACT_AMENDMENT_SIGNATURE_AUTHORITY_FLAGGED: {
      contractId: 'CTR_1',
      amendmentId: 'AMD_1',
      organizationId: 'ORG_E',
      side: 'EMPLOYER',
      policyId: 'APL_1',
      policyVersion: 2,
      reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
      detectedBy: 'ORGANIZATION_MOVED',
      causeEventId: 'EVT_1',
      movedAt: at,
      movedVersion: 7,
      flaggedAt: at,
    },
    CONTRACT_MILESTONE_PLANNED: {
      contractId: 'CTR_1',
      milestoneId: 'MLS_1',
      organizationId: 'ORG_E',
      contractorOrganizationId: 'ORG_C',
      plannedBy: 'USR_1',
      plannedAt: at,
    },
    CONTRACT_MILESTONE_CHANGED: {
      contractId: 'CTR_1',
      milestoneId: 'MLS_1',
      organizationId: 'ORG_E',
      contractorOrganizationId: 'ORG_C',
      version: 2,
      changedBy: 'USR_1',
      changedAt: at,
    },
    CONTRACT_AUTHORITY_REFUSED: {
      contractId: 'CTR_1',
      organizationId: 'ORG_E',
      action: 'SIGN_AMENDMENT',
      side: 'EMPLOYER',
      subjectId: 'AMD_1',
      reason: 'SIGNATURE_POLICY_REQUIRED',
      policyId: null,
      refusedBy: 'USR_1',
      refusedAt: at,
    },
  } as const;
  type Name = keyof typeof payloads;

  it.each(Object.entries(payloads))('%s accepts the payload as published', (name, payload) => {
    expect(validateContractPayload(name as Name, payload)).toEqual(payload);
  });

  it.each(Object.keys(payloads))(
    '%s is keyed by the contract it concerns, on the contract aggregate',
    (name) => {
      expect(resolvePartitionKey(name as Name, payloads[name as Name]).key).toBe('CTR_1');
      expect(AGGREGATE_OF[name as Name]).toBe(AGGREGATE_TYPE);
    },
  );

  it.each(Object.keys(payloads))(
    '%s refuses an amount, a reason text, a title, a date or a share: identifiers and instants only',
    (name) => {
      for (const field of [
        'amountMinor',
        'deltaMinor',
        'delta',
        'amount',
        'reasonText',
        'title',
        'plannedDate',
        'plannedShareBp',
        'note',
      ]) {
        expect(() =>
          validateContractPayload(name as Name, { ...payloads[name as Name], [field]: '1' }),
        ).toThrow(/does not match its published contract/);
      }
    },
  );

  it.each(Object.entries(payloads))('%s refuses a payload missing any field', (name, payload) => {
    for (const field of Object.keys(payload)) {
      const { [field as keyof typeof payload]: _omitted, ...rest } = payload as Record<
        string,
        unknown
      >;
      expect(() => validateContractPayload(name as Name, rest)).toThrow();
    }
  });

  it('an amendment review event names its cause in exactly two shapes: event AND instant, or neither (#235 round 2)', () => {
    const proven = payloads.CONTRACT_AMENDMENT_SIGNATURE_AUTHORITY_FLAGGED;
    const recheck = { ...proven, detectedBy: 'MOVE_RECHECK', causeEventId: null, movedAt: null };
    const name = 'CONTRACT_AMENDMENT_SIGNATURE_AUTHORITY_FLAGGED';

    expect(validateContractPayload(name, proven)).toEqual(proven);
    expect(validateContractPayload(name, recheck)).toEqual(recheck);

    const refused: [string, Record<string, unknown>][] = [
      ['MOVE_RECHECK naming an event only', { ...recheck, causeEventId: 'EVT_1' }],
      ['MOVE_RECHECK naming an instant only', { ...recheck, movedAt: at }],
      ['MOVE_RECHECK naming both', { ...recheck, causeEventId: 'EVT_1', movedAt: at }],
      ['ORGANIZATION_MOVED without its event', { ...proven, causeEventId: null }],
      ['ORGANIZATION_MOVED without its instant', { ...proven, movedAt: null }],
      ['ORGANIZATION_MOVED naming neither', { ...proven, causeEventId: null, movedAt: null }],
      ['a detectedBy outside the closed pair', { ...proven, detectedBy: 'GUESS' }],
    ];
    for (const [what, payload] of refused) {
      const outcome = (() => {
        try {
          validateContractPayload(name, payload);
          return 'accepted';
        } catch (error) {
          return /does not match its published contract/.test((error as Error).message)
            ? 'refused'
            : 'other';
        }
      })();
      expect({ what, outcome }).toEqual({ what, outcome: 'refused' });
    }
  });

  it('names a refusal’s action and reason from closed lists, and nothing else', () => {
    const refused = payloads.CONTRACT_AUTHORITY_REFUSED;
    for (const action of [
      'SIGN_CONTRACT',
      'PROPOSE_AMENDMENT',
      'SIGN_AMENDMENT',
      'PLAN_MILESTONE',
      'CHANGE_MILESTONE',
      'DRAFT_STATEMENT',
      'SUBMIT_STATEMENT',
      'APPROVE_STATEMENT',
      'REJECT_STATEMENT',
    ]) {
      expect(
        validateContractPayload('CONTRACT_AUTHORITY_REFUSED', { ...refused, action }),
      ).toBeTruthy();
    }
    for (const reason of [
      'ROLE_NOT_PERMITTED',
      'NOT_EMPLOYER',
      'NOT_CONTRACTOR',
      'SIGNATURE_POLICY_REQUIRED',
      'POLICY_AUTHOR_NOT_GOVERNING',
      'MEMBER_OF_BOTH_PARTIES',
      'SAME_PERSON_BOTH_SIDES',
      'NOT_STEP_AUTHORITY',
      'MEMBER_OF_CONTRACTOR',
      'SUBMITTER_MAY_NOT_DECIDE',
      'ALREADY_DECIDED_STATEMENT',
      'ACTOR_IDENTITY_UNKNOWN',
    ]) {
      expect(
        validateContractPayload('CONTRACT_AUTHORITY_REFUSED', { ...refused, reason }),
      ).toBeTruthy();
    }
    // A decision's refused caller may be an approver that is neither party (CON-003 PR 6).
    for (const side of ['EMPLOYER', 'CONTRACTOR', 'APPROVER']) {
      expect(
        validateContractPayload('CONTRACT_AUTHORITY_REFUSED', { ...refused, side }),
      ).toBeTruthy();
    }
    expect(() =>
      validateContractPayload('CONTRACT_AUTHORITY_REFUSED', { ...refused, side: 'BYSTANDER' }),
    ).toThrow();
    expect(() =>
      validateContractPayload('CONTRACT_AUTHORITY_REFUSED', { ...refused, action: 'CANCEL' }),
    ).toThrow();
    expect(() =>
      validateContractPayload('CONTRACT_AUTHORITY_REFUSED', {
        ...refused,
        reason: 'CONTRACT_NOT_SIGNED',
      }),
    ).toThrow();
  });

  it('refuses an amendment number below 1 and an instant with an offset', () => {
    expect(() =>
      validateContractPayload('CONTRACT_AMENDED', {
        ...payloads.CONTRACT_AMENDED,
        amendmentNumber: 0,
      }),
    ).toThrow();
    expect(() =>
      validateContractPayload('CONTRACT_AMENDED', {
        ...payloads.CONTRACT_AMENDED,
        effectiveAt: '2026-10-07T13:30:00+03:30',
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

describe('the statement decision events (CON-003 PR 6)', () => {
  const facts = {
    contractId: 'CTR_1',
    statementId: 'STM_1',
    statementNumber: 3,
    organizationId: 'ORG_OWNER',
    contractorOrganizationId: 'ORG_WINNER',
  };
  const decisions = {
    STATEMENT_DECISION_RECORDED: {
      ...facts,
      chain: 'TECHNICAL',
      stepOrder: 2,
      outcome: 'APPROVED',
      deciderOrganizationId: 'ORG_CONSULTANT',
      deciderRole: 'SITE_SUPERVISOR',
      decidedBy: 'USR_2',
      decidedAt: '2026-10-16T10:00:00.000Z',
    },
    STATEMENT_TECHNICALLY_APPROVED: {
      ...facts,
      technicallyApprovedAt: '2026-10-16T10:00:00.000Z',
    },
    STATEMENT_APPROVED: { ...facts, approvedAt: '2026-10-16T11:00:00.000Z' },
    STATEMENT_REJECTED: {
      ...facts,
      chain: 'FINANCIAL',
      stepOrder: 1,
      rejectedAt: '2026-10-16T11:00:00.000Z',
    },
  } as const;
  const names = Object.keys(decisions) as (keyof typeof decisions)[];

  it('accept the decisions as published, keyed by the contract the statement belongs to', () => {
    for (const name of names) {
      expect(validateContractPayload(name, decisions[name])).toEqual(decisions[name]);
      expect(resolvePartitionKey(name, decisions[name]).key).toBe('CTR_1');
    }
  });

  it.each([
    'grossMinor',
    'netMinor',
    'netAmount',
    'deductions',
    'technicalApprover',
    'financialApprover',
    'reason',
    'decidedByIssuer',
    'decidedBySubject',
  ])(
    'refuse %s: identifiers and instants only — no amount (Q-97 (2)), no reason text, no identity pair',
    (field) => {
      for (const name of names) {
        expect(() => validateContractPayload(name, { ...decisions[name], [field]: '1' })).toThrow(
          /does not match its published contract/,
        );
      }
    },
  );

  it('name the chain and outcome from closed lists, a step from 1, a role as a code, UTC instants', () => {
    const recorded = decisions.STATEMENT_DECISION_RECORDED;
    for (const broken of [
      { chain: 'LEGAL' },
      { outcome: 'APPROVE' },
      { stepOrder: 0 },
      { deciderRole: 'site supervisor' },
      { decidedAt: '2026-10-16T13:30:00+03:30' },
    ]) {
      expect(() =>
        validateContractPayload('STATEMENT_DECISION_RECORDED', { ...recorded, ...broken }),
      ).toThrow();
    }
    expect(() =>
      validateContractPayload('STATEMENT_REJECTED', {
        ...decisions.STATEMENT_REJECTED,
        chain: 'X',
      }),
    ).toThrow();
  });
});

describe('the settlement events (CON-003 PR 6c)', () => {
  const settled = {
    STATEMENT_SETTLED: {
      contractId: 'CTR_1',
      statementId: 'STM_1',
      statementNumber: 3,
      organizationId: 'ORG_OWNER',
      contractorOrganizationId: 'ORG_WINNER',
      obligationId: 'TXN_1',
      settlementId: 'STL_1',
      settledAt: '2026-10-17T10:00:00.000Z',
    },
    CONTRACT_SETTLED: {
      contractId: 'CTR_1',
      projectId: 'PRJ_1',
      organizationId: 'ORG_OWNER',
      contractorOrganizationId: 'ORG_WINNER',
      settledAt: '2026-10-17T10:00:00.000Z',
    },
  } as const;
  const names = Object.keys(settled) as (keyof typeof settled)[];

  it('accept the settlements as published, keyed by the contract', () => {
    for (const name of names) {
      expect(validateContractPayload(name, settled[name])).toEqual(settled[name]);
      expect(resolvePartitionKey(name, settled[name]).key).toBe('CTR_1');
    }
  });

  it.each(['netMinor', 'amountMinor', 'settledAmountMinor', 'grossAmountMinor', 'currency'])(
    'refuse %s: identifiers and instants only — no amount (Q-97 (2))',
    (field) => {
      for (const name of names) {
        expect(() => validateContractPayload(name, { ...settled[name], [field]: '1' })).toThrow(
          /does not match its published contract/,
        );
      }
    },
  );

  it('carry UTC instants and every identifier', () => {
    for (const name of names) {
      expect(() =>
        validateContractPayload(name, { ...settled[name], settledAt: '2026-10-17T13:30:00+03:30' }),
      ).toThrow();
      for (const field of Object.keys(settled[name]).filter((key) => key !== 'statementNumber')) {
        const { [field as keyof (typeof settled)[typeof name]]: _dropped, ...rest } = settled[name];
        expect(() => validateContractPayload(name, rest)).toThrow();
      }
    }
  });
});

describe('the statement events (CON-003 PR 4 and 5)', () => {
  const statementDrafted = {
    contractId: 'CTR_1',
    statementId: 'STM_1',
    statementNumber: 1,
    organizationId: 'ORG_OWNER',
    contractorOrganizationId: 'ORG_WINNER',
    draftedBy: 'USR_1',
    draftedAt: '2026-10-15T10:00:00.000Z',
  };
  const { draftedBy: _by, draftedAt: _at, ...common } = statementDrafted;
  const statementSubmitted = {
    ...common,
    technicalPolicyId: 'APL_T',
    technicalPolicyVersion: 2,
    financialPolicyId: 'APL_F',
    financialPolicyVersion: 1,
    milestoneIds: ['MLS_1'],
    submittedBy: 'USR_1',
    submittedAt: '2026-10-15T11:00:00.000Z',
  };

  it('accept the payloads as published, keyed by the contract the statement belongs to', () => {
    expect(validateContractPayload('STATEMENT_DRAFTED', statementDrafted)).toEqual(
      statementDrafted,
    );
    expect(resolvePartitionKey('STATEMENT_DRAFTED', statementDrafted).key).toBe('CTR_1');
    expect(validateContractPayload('STATEMENT_SUBMITTED', statementSubmitted)).toEqual(
      statementSubmitted,
    );
    expect(
      validateContractPayload('STATEMENT_SUBMITTED', { ...statementSubmitted, milestoneIds: [] }),
    ).toEqual({ ...statementSubmitted, milestoneIds: [] });
    expect(resolvePartitionKey('STATEMENT_SUBMITTED', statementSubmitted).key).toBe('CTR_1');
  });

  it.each([
    'grossAmount',
    'grossMinor',
    'netMinor',
    'deductionsMinor',
    'deductions',
    'lines',
    'description',
    'steps',
    'authorityRole',
    'submittedByIssuer',
  ])(
    'refuse %s: identifiers and instants only, no amount (Q-97 (2)), no text, no identity pair',
    (field) => {
      for (const [name, payload] of [
        ['STATEMENT_DRAFTED', statementDrafted],
        ['STATEMENT_SUBMITTED', statementSubmitted],
      ] as const) {
        expect(() => validateContractPayload(name, { ...payload, [field]: '1' })).toThrow(
          /does not match its published contract/,
        );
      }
    },
  );

  it('refuses a submission without both chains’ policy and version', () => {
    for (const field of [
      'technicalPolicyId',
      'technicalPolicyVersion',
      'financialPolicyId',
      'financialPolicyVersion',
      'milestoneIds',
    ]) {
      const { [field as keyof typeof statementSubmitted]: _gone, ...rest } = statementSubmitted;
      expect(() => validateContractPayload('STATEMENT_SUBMITTED', rest)).toThrow();
    }
    expect(() =>
      validateContractPayload('STATEMENT_SUBMITTED', {
        ...statementSubmitted,
        technicalPolicyVersion: 0,
      }),
    ).toThrow();
  });

  it('refuses a statement number below 1 and an instant with an offset', () => {
    expect(() =>
      validateContractPayload('STATEMENT_DRAFTED', { ...statementDrafted, statementNumber: 0 }),
    ).toThrow();
    expect(() =>
      validateContractPayload('STATEMENT_DRAFTED', {
        ...statementDrafted,
        draftedAt: '2026-10-15T14:30:00+03:30',
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

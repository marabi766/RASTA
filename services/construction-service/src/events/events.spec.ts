import {
  CONSTRUCTION_EVENTS,
  CONSTRUCTION_EVENT_SCHEMAS,
  validateConstructionPayload,
  type ConstructionEventName,
} from './events';
import { AGGREGATE_OF, resolvePartitionKey } from './routing';

/**
 * The published contract of every construction event.
 *
 * For each event: a valid payload passes, an unknown field fails (`.strict()`,
 * so nothing a later change adds by accident reaches the log), and the fields
 * that must never be published — geometry, prose, document ids — are refused.
 */

const AT = '2026-09-26T08:00:00.000Z';
const BASE = { projectId: 'PRJ_01', organizationId: 'ORG_A' };

const VALID: Partial<Record<ConstructionEventName, Record<string, unknown>>> = {
  PROJECT_CREATED: {
    ...BASE,
    estimatedCostMinor: '1500000000',
    hasArea: true,
    createdBy: 'USR_1',
    createdAt: AT,
  },
  PROJECT_UPDATED: { ...BASE, changedFields: ['title'], updatedBy: 'USR_1', updatedAt: AT },
  PROJECT_STATUS_CHANGED: {
    ...BASE,
    from: 'DRAFT',
    to: 'CANCELLED',
    changedBy: 'USR_1',
    changedAt: AT,
  },
  PROJECT_NEED_ADDED: { ...BASE, needId: 'PND_1', addedBy: 'USR_1', addedAt: AT },
  PROJECT_NEED_UPDATED: {
    ...BASE,
    needId: 'PND_1',
    changedFields: ['quantity', 'unit'],
    updatedBy: 'USR_1',
    updatedAt: AT,
  },
  PROJECT_NEED_SUBMITTED: { ...BASE, needId: 'PND_1', submittedBy: 'USR_1', submittedAt: AT },
  PROJECT_NEED_WITHDRAWN: {
    ...BASE,
    needId: 'PND_1',
    withdrawnBy: 'USR_1',
    withdrawnAt: AT,
  },
};

const STEP = {
  approvalId: 'APR_1',
  projectId: 'PRJ_01',
  organizationId: 'ORG_A',
  workflowKey: 'project.execution',
  round: 1,
  stepOrder: 1,
};
const POLICY = { policyId: 'APL_1', organizationId: 'ORG_A', workflowKey: 'project.execution' };
const TENDER = { tenderId: 'TND_1', projectId: 'PRJ_01', organizationId: 'ORG_A' };

Object.assign(VALID, {
  APPROVAL_REQUESTED: {
    ...STEP,
    authorityOrganizationId: 'ORG_COUNCIL',
    authorityRole: 'ORGANIZATION_ADMIN',
    policyId: 'APL_1',
    policyVersion: 1,
    requestedAt: AT,
  },
  APPROVAL_GRANTED: {
    ...STEP,
    decidedBy: 'USR_2',
    decidedAt: AT,
    hasConditions: false,
  },
  APPROVAL_REJECTED: {
    ...STEP,
    decidedBy: 'USR_2',
    decidedAt: AT,
  },
  PROJECT_STARTED: { ...BASE, contractId: null, startedBy: 'USR_1', startedAt: AT },
  PROJECT_PROGRESS_UPDATED: {
    ...BASE,
    reportId: 'PRG_1',
    progressBasisPoints: 2500,
    submittedBy: 'USR_1',
    submittedAt: AT,
  },
  PROJECT_COMPLETED: { ...BASE, completedBy: 'USR_1', completedAt: AT },
  APPROVAL_POLICY_CREATED: {
    ...POLICY,
    authorOrganizationId: 'ORG_UNION',
    authorRole: 'UNION_ADMIN',
    policyVersion: 1,
    stepCount: 2,
    isSample: true,
    createdBy: 'USR_1',
    createdAt: AT,
  },
  APPROVAL_POLICY_ACTIVATED: {
    ...POLICY,
    policyVersion: 2,
    retiredPolicyId: 'APL_0',
    activatedBy: 'USR_1',
    activatedAt: AT,
  },
  APPROVAL_POLICY_RETIRED: { ...POLICY, policyVersion: 2, retiredBy: 'USR_1', retiredAt: AT },
  APPROVAL_POLICY_SUSPENDED: {
    ...POLICY,
    policyVersion: 2,
    authorOrganizationId: 'ORG_U',
    fromStatus: 'ACTIVE',
    reason: 'ORGANIZATION_MOVED',
    causeEventId: 'EVT_1',
    movedOrganizationId: 'ORG_M',
    suspendedBy: 'system:construction-service',
    suspendedAt: AT,
  },
  APPROVAL_POLICY_SUBMITTED: { ...POLICY, policyVersion: 2, submittedBy: 'USR_1', submittedAt: AT },
  APPROVAL_POLICY_REJECTED: { ...POLICY, policyVersion: 2, rejectedBy: 'USR_9', rejectedAt: AT },
  PROJECT_PROGRESS_REPORT_DRAFTED: {
    ...BASE,
    reportId: 'PRG_1',
    draftedBy: 'USR_1',
    draftedAt: AT,
  },
  PROJECT_PROGRESS_REPORT_DISCARDED: {
    ...BASE,
    reportId: 'PRG_1',
    discardedBy: 'USR_1',
    discardedAt: AT,
  },
  TENDER_CREATED: {
    ...TENDER,
    procurementNature: null,
    createdBy: 'USR_1',
    createdAt: AT,
  },
  TENDER_UPDATED: {
    ...TENDER,
    changedFields: ['bidClosingAt', 'bidOpeningAt'],
    updatedBy: 'USR_1',
    updatedAt: AT,
  },
  TENDER_CANCELLED: {
    ...TENDER,
    from: 'DRAFT',
    reasonCode: 'OWNER_REQUEST',
    cancelledBy: 'USR_1',
    cancelledAt: AT,
  },
  TENDER_CLOSED: {
    ...TENDER,
    bidCount: 3,
    closedAt: AT,
    closedBy: 'system:construction-service',
  },
  TENDER_CRITERIA_SET: {
    ...TENDER,
    criteriaCount: 3,
    totalWeightBp: 10_000,
    templateId: null,
    setBy: 'USR_1',
    setAt: AT,
  },
  TENDER_PUBLISHED: {
    ...TENDER,
    visibility: 'RESTRICTED',
    bidOpeningAt: '2026-11-01T08:00:00.000Z',
    bidClosingAt: '2026-11-30T20:30:00.000Z',
    criteriaCount: 3,
    keyId: 'TKY_1',
    publishedBy: 'USR_1',
    publishedAt: AT,
  },
  TENDER_BIDDER_INVITED: {
    ...TENDER,
    invitedOrganizationId: 'ORG_BIDDER',
    invitedBy: 'USR_1',
    invitedAt: AT,
  },
  BID_SUBMITTED: {
    bidId: 'BID_1',
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    bidderOrganizationId: 'ORG_B',
    revision: 1,
    receivedAt: AT,
    contentCommitment: 'a'.repeat(64),
    ciphertextSha256: 'b'.repeat(64),
    previousReceipt: 'c'.repeat(64),
    receipt: 'd'.repeat(64),
    submittedBy: 'USR_9',
  },
  BID_REVISED: {
    bidId: 'BID_1',
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    bidderOrganizationId: 'ORG_B',
    revision: 2,
    receivedAt: AT,
    contentCommitment: 'a'.repeat(64),
    ciphertextSha256: 'b'.repeat(64),
    previousReceipt: 'c'.repeat(64),
    receipt: 'd'.repeat(64),
    submittedBy: 'USR_9',
  },
  BID_WITHDRAWN: {
    bidId: 'BID_1',
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    bidderOrganizationId: 'ORG_B',
    revision: 2,
    withdrawnAt: AT,
    withdrawnBy: 'USR_9',
  },
  BID_ACCESSED: {
    bidId: 'BID_1',
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    accessorOrganizationId: 'ORG_B',
    accessedBy: 'USR_9',
    purpose: 'OWN_BID_RECEIPT',
    outcome: 'GRANTED',
    refusalCode: null,
    accessedAt: AT,
  },
  BID_QUALIFIED: {
    bidId: 'BID_1',
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    decidedBy: 'USR_1',
    decidedAt: AT,
  },
  BID_DISQUALIFIED: {
    bidId: 'BID_1',
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    reasonCode: 'NON_RESPONSIVE',
    decidedBy: 'USR_1',
    decidedAt: AT,
  },
  BID_SCORED: {
    bidId: 'BID_1',
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    evaluationId: 'BEV_1',
    evaluatorId: 'USR_1',
    recordedCount: 2,
    scoresDigest: 'a'.repeat(64),
    scoredAt: AT,
  },
  BID_EVALUATOR_RECUSED: {
    bidId: 'BID_1',
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    evaluatorId: 'USR_1',
    reasonCode: 'CONFLICT_OF_INTEREST',
    recusedAt: AT,
  },
  BIDS_EVALUATED: {
    ...TENDER,
    evaluatedBidCount: 2,
    matrixDigest: 'c'.repeat(64),
    evaluatedBy: 'USR_1',
    evaluatedAt: AT,
  },
  TENDER_AWARDED: {
    ...TENDER,
    winningBidId: 'BID_1',
    winnerOrganizationId: 'ORG_B',
    hasJustification: false,
    matrixDigest: 'c'.repeat(64),
    awardedBy: 'USR_1',
    awardedAt: AT,
  },
  TENDER_AWARD_STANDING_CONFLICT_DETECTED: {
    ...TENDER,
    winningBidId: 'BID_1',
    winnerOrganizationId: 'ORG_B',
    awardedBy: 'USR_1',
    awardedAt: AT,
    windowStart: AT,
    checkedAt: AT,
    suspensionIds: ['SUS_1'],
    suspensionCount: 1,
    qualificationRemoved: false,
  },
  BID_NOT_AWARDED: {
    bidId: 'BID_2',
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    bidderOrganizationId: 'ORG_C',
    decidedAt: AT,
  },
  BIDS_OPENED: {
    ...TENDER,
    bidCount: 2,
    bidIdsDigest: 'b'.repeat(64),
    receiptHead: 'a'.repeat(64),
    openedAt: AT,
    openedBy: 'USR_1',
    proposedBy: 'USR_2',
  },
  BID_OPENING_PROPOSAL_WITHDRAWN: {
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    proposedBy: 'USR_2',
    withdrawnBy: 'USR_1',
    reason: 'PROPOSER_CONFLICTED',
    withdrawnAt: AT,
  },
  BID_OPENING_CONFLICT_DETECTED: {
    tenderId: 'TND_1',
    organizationId: 'ORG_A',
    openedAt: AT,
    openedBy: 'USR_1',
    proposedBy: 'USR_2',
    windowStart: AT,
    checkedAt: AT,
    conflicts: [
      { userId: 'USR_2', role: 'PROPOSER', organizationIds: ['ORG_B'], organizationCount: 1 },
    ],
  },
  CRITERIA_TEMPLATE_CREATED: {
    templateId: 'CTP_1',
    organizationId: 'ORG_A',
    version: 2,
    criteriaCount: 3,
    totalWeightBp: 9_000,
    createdBy: 'USR_1',
    createdAt: AT,
  },
});

const NAMES = Object.values(CONSTRUCTION_EVENTS);
const TENDER_EVENTS = [
  'TENDER_CREATED',
  'TENDER_UPDATED',
  'TENDER_CANCELLED',
  'TENDER_CLOSED',
  'TENDER_CRITERIA_SET',
  'TENDER_PUBLISHED',
  'TENDER_BIDDER_INVITED',
  'BID_SUBMITTED',
  'BID_REVISED',
  'BID_WITHDRAWN',
  'BID_ACCESSED',
  'BIDS_OPENED',
  'BID_OPENING_PROPOSAL_WITHDRAWN',
  'BID_OPENING_CONFLICT_DETECTED',
  'BID_QUALIFIED',
  'BID_DISQUALIFIED',
  'BID_SCORED',
  'BID_EVALUATOR_RECUSED',
  'BIDS_EVALUATED',
  'TENDER_AWARDED',
  'BID_NOT_AWARDED',
  'TENDER_AWARD_STANDING_CONFLICT_DETECTED',
];
const TEMPLATE_EVENTS = ['CRITERIA_TEMPLATE_CREATED'];
const POLICY_EVENTS = [
  'APPROVAL_POLICY_CREATED',
  'APPROVAL_POLICY_ACTIVATED',
  'APPROVAL_POLICY_RETIRED',
  'APPROVAL_POLICY_SUSPENDED',
  'APPROVAL_POLICY_SUBMITTED',
  'APPROVAL_POLICY_REJECTED',
];
const PROJECT_EVENTS = NAMES.filter(
  (name) =>
    !POLICY_EVENTS.includes(name) &&
    !TENDER_EVENTS.includes(name) &&
    !TEMPLATE_EVENTS.includes(name),
);

describe('the construction event catalogue', () => {
  it('publishes the CON-001 events (seven of PR 1, thirteen of PR 2, the Q-83 suspension) and the CON-002 tender events so far', () => {
    expect([...NAMES].sort()).toEqual([
      'APPROVAL_GRANTED',
      'APPROVAL_POLICY_ACTIVATED',
      'APPROVAL_POLICY_CREATED',
      'APPROVAL_POLICY_REJECTED',
      'APPROVAL_POLICY_RETIRED',
      'APPROVAL_POLICY_SUBMITTED',
      'APPROVAL_POLICY_SUSPENDED',
      'APPROVAL_REJECTED',
      'APPROVAL_REQUESTED',
      'BIDS_EVALUATED',
      'BIDS_OPENED',
      'BID_ACCESSED',
      'BID_DISQUALIFIED',
      'BID_EVALUATOR_RECUSED',
      'BID_NOT_AWARDED',
      'BID_OPENING_CONFLICT_DETECTED',
      'BID_OPENING_PROPOSAL_WITHDRAWN',
      'BID_QUALIFIED',
      'BID_REVISED',
      'BID_SCORED',
      'BID_SUBMITTED',
      'BID_WITHDRAWN',
      'CRITERIA_TEMPLATE_CREATED',
      'PROJECT_COMPLETED',
      'PROJECT_CREATED',
      'PROJECT_NEED_ADDED',
      'PROJECT_NEED_SUBMITTED',
      'PROJECT_NEED_UPDATED',
      'PROJECT_NEED_WITHDRAWN',
      'PROJECT_PROGRESS_REPORT_DISCARDED',
      'PROJECT_PROGRESS_REPORT_DRAFTED',
      'PROJECT_PROGRESS_UPDATED',
      'PROJECT_STARTED',
      'PROJECT_STATUS_CHANGED',
      'PROJECT_UPDATED',
      'TENDER_AWARDED',
      'TENDER_AWARD_STANDING_CONFLICT_DETECTED',
      'TENDER_BIDDER_INVITED',
      'TENDER_CANCELLED',
      'TENDER_CLOSED',
      'TENDER_CREATED',
      'TENDER_CRITERIA_SET',
      'TENDER_PUBLISHED',
      'TENDER_UPDATED',
    ]);
    expect(Object.keys(CONSTRUCTION_EVENT_SCHEMAS).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('%s accepts its documented payload', (name) => {
    expect(() => validateConstructionPayload(name, VALID[name])).not.toThrow();
  });

  it.each(NAMES)('%s refuses an unknown field', (name) => {
    expect(() => validateConstructionPayload(name, { ...VALID[name]!, extra: 1 })).toThrow(
      /does not match its published contract/,
    );
  });

  it.each(PROJECT_EVENTS)('%s requires the project and organization it concerns', (name) => {
    const { projectId: _p, ...withoutProject } = VALID[name]!;
    const { organizationId: _o, ...withoutOrganization } = VALID[name]!;
    expect(() => validateConstructionPayload(name, withoutProject)).toThrow();
    expect(() => validateConstructionPayload(name, withoutOrganization)).toThrow();
  });

  it.each(TENDER_EVENTS.filter((name) => !name.startsWith('BID_')) as typeof NAMES)(
    '%s requires the tender, project and organization',
    (name) => {
      for (const field of ['tenderId', 'projectId', 'organizationId']) {
        const { [field]: _omitted, ...without } = VALID[name]!;
        expect(() => validateConstructionPayload(name, without)).toThrow();
      }
    },
  );

  // A bid event is keyed by its tender and names the owner and the bidder: no project.
  it.each(TENDER_EVENTS.filter((name) => name.startsWith('BID_')) as typeof NAMES)(
    '%s requires the tender and the owner, and carries no project',
    (name) => {
      for (const field of ['tenderId', 'organizationId']) {
        const { [field]: _omitted, ...without } = VALID[name]!;
        expect(() => validateConstructionPayload(name, without)).toThrow();
      }
      expect(Object.keys(VALID[name]!)).not.toContain('projectId');
    },
  );

  it.each([
    'BID_SUBMITTED',
    'BID_REVISED',
    'BID_WITHDRAWN',
    'BID_ACCESSED',
    'BIDS_OPENED',
    'BID_OPENING_PROPOSAL_WITHDRAWN',
    'BID_OPENING_CONFLICT_DETECTED',
  ] as typeof NAMES)(
    '%s carries no content, price or ciphertext, however it is dressed',
    (name) => {
      for (const extra of [
        { priceMinor: '1250000000' },
        { content: { note: 'x' } },
        { ciphertext: 'AAAA' },
        { answers: [] },
      ]) {
        expect(() => validateConstructionPayload(name, { ...VALID[name]!, ...extra })).toThrow(
          /does not match its published contract/,
        );
      }
    },
  );

  describe('the award events (ADR-067 § 3, Q-89)', () => {
    it('TENDER_AWARDED carries the winner, and no amount, rank, score nor words', () => {
      for (const extra of [
        { amountMinor: '1250000000' },
        { priceMinor: '1250000000' },
        { amount: 1250000000 },
        { rank: 1 },
        { totalScaled: '10' },
        { justification: 'The lowest bid was not responsive' },
        { reason: 'x' },
        { rankOfWinner: 1 },
      ]) {
        expect(() =>
          validateConstructionPayload('TENDER_AWARDED', { ...VALID.TENDER_AWARDED!, ...extra }),
        ).toThrow(/does not match its published contract/);
      }
    });

    it('the shared topic never carries the winner’s price, whatever it is called', () => {
      const text = JSON.stringify(VALID.TENDER_AWARDED);
      expect(text).not.toMatch(/amount|price/i);
    });

    it('TENDER_AWARD_STANDING_CONFLICT_DETECTED is ids, counts and times only', () => {
      for (const extra of [
        { reason: 'suspended for fraud' },
        { amountMinor: '1' },
        { name: 'x' },
      ]) {
        expect(() =>
          validateConstructionPayload('TENDER_AWARD_STANDING_CONFLICT_DETECTED', {
            ...VALID.TENDER_AWARD_STANDING_CONFLICT_DETECTED!,
            ...extra,
          }),
        ).toThrow(/does not match its published contract/);
      }
      expect(() =>
        validateConstructionPayload('TENDER_AWARD_STANDING_CONFLICT_DETECTED', {
          ...VALID.TENDER_AWARD_STANDING_CONFLICT_DETECTED!,
          suspensionIds: Array.from({ length: 21 }, (_, i) => `SUS_${i}`),
        }),
      ).toThrow();
    });

    it('TENDER_AWARDED says only whether the choice was justified, and pins a SHA-256 matrix digest', () => {
      expect(() =>
        validateConstructionPayload('TENDER_AWARDED', {
          ...VALID.TENDER_AWARDED!,
          hasJustification: 'yes',
        }),
      ).toThrow();
      expect(() =>
        validateConstructionPayload('TENDER_AWARDED', {
          ...VALID.TENDER_AWARDED!,
          matrixDigest: 'not-a-digest',
        }),
      ).toThrow();
    });

    it('BID_NOT_AWARDED names neither the winner, the amount, a rank nor a score: a loser is told its own, only', () => {
      for (const extra of [
        { winningBidId: 'BID_1' },
        { winnerOrganizationId: 'ORG_B' },
        { amountMinor: '1250000000' },
        { rank: 2 },
        { totalScaled: '10' },
        { justification: 'x' },
      ]) {
        expect(() =>
          validateConstructionPayload('BID_NOT_AWARDED', { ...VALID.BID_NOT_AWARDED!, ...extra }),
        ).toThrow(/does not match its published contract/);
      }
    });

    it('both are keyed by the tender', () => {
      for (const name of [
        'TENDER_AWARDED',
        'BID_NOT_AWARDED',
        'TENDER_AWARD_STANDING_CONFLICT_DETECTED',
      ] as const) {
        expect(resolvePartitionKey(name, VALID[name]!).key).toBe('TND_1');
      }
    });
  });

  it.each(POLICY_EVENTS as typeof NAMES)(
    '%s requires the organization and workflow key',
    (name) => {
      const { workflowKey: _w, ...withoutKey } = VALID[name]!;
      expect(() => validateConstructionPayload(name, withoutKey)).toThrow();
    },
  );
});

describe('what never reaches the log', () => {
  it('refuses the operating area on PROJECT_CREATED: hasArea, never the polygon', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED!,
        area: { type: 'Polygon', coordinates: [] },
      }),
    ).toThrow();
  });

  it('refuses the scope-of-work prose on PROJECT_CREATED', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED!,
        scopeOfWork: 'Private text',
      }),
    ).toThrow();
  });

  it('refuses field values on the *_UPDATED events: names only', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_UPDATED', {
        ...VALID.PROJECT_UPDATED!,
        title: 'New title',
      }),
    ).toThrow();
  });

  it('refuses money as a number', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED!,
        estimatedCostMinor: 1500000000,
      }),
    ).toThrow();
  });
});

describe('payload rules', () => {
  it('allows a null estimate', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED!,
        estimatedCostMinor: null,
      }),
    ).not.toThrow();
  });

  it('refuses a status change that changes nothing', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_STATUS_CHANGED', {
        ...VALID.PROJECT_STATUS_CHANGED!,
        to: 'DRAFT',
      }),
    ).toThrow();
  });

  it('refuses duplicate or empty changedFields', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_UPDATED', {
        ...VALID.PROJECT_UPDATED!,
        changedFields: ['title', 'title'],
      }),
    ).toThrow();
    expect(() =>
      validateConstructionPayload('PROJECT_UPDATED', {
        ...VALID.PROJECT_UPDATED!,
        changedFields: [],
      }),
    ).toThrow();
  });

  it('refuses a timestamp that is not ISO-8601', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_NEED_ADDED', {
        ...VALID.PROJECT_NEED_ADDED!,
        addedAt: 'yesterday',
      }),
    ).toThrow();
  });

  // Codex review of #119, finding 4: prose stays in the database.
  it.each<[ConstructionEventName, Record<string, unknown>]>([
    ['PROJECT_CREATED', { title: 'Road repair' }],
    ['PROJECT_CREATED', { operationType: 'road' }],
    ['PROJECT_STATUS_CHANGED', { reason: 'Funding withdrawn' }],
    ['PROJECT_NEED_WITHDRAWN', { reason: 'Covered by another line' }],
    // Codex review of #122, finding 4: unverified asset claims stay in the database.
    ['PROJECT_PROGRESS_UPDATED', { assetsUsed: ['AST_01JBQ4Y8ZK3M5N7P9R1S3T5V7W'] }],
    ['PROJECT_PROGRESS_UPDATED', { assetsUsed: ['the grader and two trucks'] }],
    ['PROJECT_PROGRESS_UPDATED', { obstacles: 'Rain on two days' }],
    // ADR-065: a tender's prose, its stated reason and its window's text stay in the database.
    ['TENDER_CREATED', { title: 'Road resurfacing tender' }],
    ['TENDER_CREATED', { scopeOfWork: 'Private specification' }],
    ['TENDER_UPDATED', { title: 'New title' }],
    ['TENDER_CANCELLED', { reason: 'Funding withdrawn' }],
    // A closure counts bids and says nothing about them.
    ['TENDER_CLOSED', { bids: [{ bidderOrganizationId: 'ORG_B' }] }],
    ['TENDER_CLOSED', { priceMinor: '1250000000' }],
    // An opening names the bids and counts them; what they say is read, audited, from the API.
    ['BIDS_OPENED', { bids: [{ priceMinor: '1250000000' }] }],
    ['BIDS_OPENED', { receiptHead: 'the head, in words' }],
    // Bounded by design: no list of ids that grows with the bids, only its digest.
    ['BIDS_OPENED', { bidIds: ['BID_1', 'BID_2'] }],
    ['BIDS_OPENED', { bidIdsDigest: 'BID_1,BID_2' }],
  ])('refuses free text on %s (%j)', (name, prose) => {
    expect(() => validateConstructionPayload(name, { ...VALID[name]!, ...prose })).toThrow();
  });
});

describe('routing (docs/07 § 7.7)', () => {
  it.each(PROJECT_EVENTS)('%s is about a Project and keyed by its projectId', (name) => {
    expect(AGGREGATE_OF[name]).toBe('Project');
    const payload = validateConstructionPayload(name, VALID[name]);
    expect(resolvePartitionKey(name, payload).key).toBe('PRJ_01');
  });

  it.each(POLICY_EVENTS as typeof NAMES)(
    '%s is about an ApprovalPolicy and keyed by its (organization, workflow key) line',
    (name) => {
      expect(AGGREGATE_OF[name]).toBe('ApprovalPolicy');
      const payload = validateConstructionPayload(name, VALID[name]);
      expect(resolvePartitionKey(name, payload).key).toBe('ORG_A/project.execution');
    },
  );

  it.each(TENDER_EVENTS as typeof NAMES)(
    '%s is about a Tender and keyed by its tenderId, not its project',
    (name) => {
      expect(AGGREGATE_OF[name]).toBe('Tender');
      const payload = validateConstructionPayload(name, VALID[name]);
      const decision = resolvePartitionKey(name, payload);
      expect(decision.key).toBe('TND_1');
      expect(decision.key).not.toBe('PRJ_01');
    },
  );

  it('keys a template event by (organization, template) and refuses to route it without a template', () => {
    const payload = validateConstructionPayload(
      'CRITERIA_TEMPLATE_CREATED',
      VALID.CRITERIA_TEMPLATE_CREATED,
    );
    expect(AGGREGATE_OF.CRITERIA_TEMPLATE_CREATED).toBe('CriteriaTemplate');
    expect(resolvePartitionKey('CRITERIA_TEMPLATE_CREATED', payload).key).toBe('ORG_A/CTP_1');
    expect(() =>
      resolvePartitionKey('CRITERIA_TEMPLATE_CREATED', { organizationId: 'ORG_A' }),
    ).toThrow(/no templateId/);
  });

  it.each([
    ['CRITERIA_TEMPLATE_CREATED', { label: 'Roads' }],
    ['CRITERIA_TEMPLATE_CREATED', { criteria: [{ code: 'PRICE' }] }],
    ['TENDER_CRITERIA_SET', { criteria: [{ code: 'PRICE' }] }],
    ['TENDER_CRITERIA_SET', { codes: ['PRICE'] }],
  ] as [ConstructionEventName, Record<string, unknown>][])(
    'never carries a criterion’s text or code: %s (%j)',
    (name, extra) => {
      expect(() => validateConstructionPayload(name, { ...VALID[name]!, ...extra })).toThrow();
    },
  );

  it.each([
    ['TENDER_PUBLISHED', { title: 'Road resurfacing tender' }],
    ['TENDER_PUBLISHED', { publicKeyPem: '-----BEGIN PUBLIC KEY-----' }],
    ['TENDER_PUBLISHED', { criteria: [{ code: 'PRICE', weightBp: 4000 }] }],
    ['TENDER_PUBLISHED', { wrappedPrivateKey: 'AAAA' }],
    ['TENDER_BIDDER_INVITED', { organizationName: 'Bidder Co' }],
  ] as [ConstructionEventName, Record<string, unknown>][])(
    'never carries text, criteria or key material: %s (%j)',
    (name, extra) => {
      expect(() => validateConstructionPayload(name, { ...VALID[name]!, ...extra })).toThrow();
    },
  );

  it('publishes only a RESTRICTED or PUBLIC visibility, and only UTC instants', () => {
    for (const bad of [{ visibility: 'SECRET' }, { bidClosingAt: 'next Monday' }]) {
      expect(() =>
        validateConstructionPayload('TENDER_PUBLISHED', { ...VALID.TENDER_PUBLISHED!, ...bad }),
      ).toThrow();
    }
  });

  it('refuses a criteria total above the whole, and none at all', () => {
    for (const totalWeightBp of [10_001, 0]) {
      expect(() =>
        validateConstructionPayload('TENDER_CRITERIA_SET', {
          ...VALID.TENDER_CRITERIA_SET!,
          totalWeightBp,
        }),
      ).toThrow();
    }
  });

  it('refuses to route a tender event with no tenderId', () => {
    expect(() =>
      resolvePartitionKey('TENDER_CREATED', { projectId: 'PRJ_01', organizationId: 'ORG_A' }),
    ).toThrow(/no tenderId/);
  });

  it('closes the reason code of a cancellation: nothing outside the set reaches the log', () => {
    expect(() =>
      validateConstructionPayload('TENDER_CANCELLED', {
        ...VALID.TENDER_CANCELLED!,
        reasonCode: 'Funding was withdrawn',
      }),
    ).toThrow();
  });

  it('refuses to route a project event with no projectId', () => {
    expect(() => resolvePartitionKey('PROJECT_CREATED', { organizationId: 'ORG_A' })).toThrow(
      /no projectId/,
    );
  });

  it('keys a need event by the project, not the need', () => {
    const payload = validateConstructionPayload('PROJECT_NEED_ADDED', VALID.PROJECT_NEED_ADDED);
    const decision = resolvePartitionKey('PROJECT_NEED_ADDED', payload);
    expect(decision.key).not.toBe('PND_1');
    expect(decision.reason).toMatch(/project aggregate/);
  });
});

describe('the PR 2 contracts', () => {
  it('never claims a contract on PROJECT_STARTED before CON-003', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_STARTED', {
        ...VALID.PROJECT_STARTED!,
        contractId: 'CTR_1',
      }),
    ).toThrow();
  });

  it('carries progress in basis points, never a float or beyond 100%', () => {
    for (const progressBasisPoints of [25.5, 10_001, -1]) {
      expect(() =>
        validateConstructionPayload('PROJECT_PROGRESS_UPDATED', {
          ...VALID.PROJECT_PROGRESS_UPDATED!,
          progressBasisPoints,
        }),
      ).toThrow();
    }
  });

  it.each<[ConstructionEventName, Record<string, unknown>]>([
    ['APPROVAL_REQUESTED', { approvalType: 'Council approval' }],
    ['APPROVAL_GRANTED', { conditions: 'Finish the drainage first' }],
    ['APPROVAL_GRANTED', { decisionNumber: '1405/12' }],
    ['APPROVAL_REJECTED', { reason: 'Estimate lacks detail' }],
    ['APPROVAL_POLICY_REJECTED', { reason: 'Authorities unclear' }],
    ['APPROVAL_POLICY_CREATED', { label: 'Council approvals' }],
    ['APPROVAL_POLICY_SUSPENDED', { reason: 'The union moved out of the hierarchy' }],
  ])('refuses the prose of a decision on %s (%j)', (name, prose) => {
    expect(() => validateConstructionPayload(name, { ...VALID[name]!, ...prose })).toThrow();
  });

  it('refuses an unknown workflow key', () => {
    expect(() =>
      validateConstructionPayload('APPROVAL_REQUESTED', {
        ...VALID.APPROVAL_REQUESTED!,
        workflowKey: 'project.anything',
      }),
    ).toThrow();
  });
});

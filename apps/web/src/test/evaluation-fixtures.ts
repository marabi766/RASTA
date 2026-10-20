import type { AwardApproval, EvaluationMatrix } from '@/server/tender-evaluation';
import type { ApprovalRequest, TenderAward } from '@/server/tender-owner';
import type { TenderDetail } from '@/server/tenders';

import { CLOSED_TENDER, OWNER, PENDING_REQUEST, TENDER_ID } from './owner-fixtures';

/**
 * A tender past its opening, as the owner's evaluators and awarder see it —
 * one fixture for the server, action and screen specs. Two bids: BID_A of
 * ORG-CON-A, qualified and scored in full by USR-EVALUATOR; BID_B of ORG-CON-B,
 * opened and undecided. The criteria are `tender-cast.ts`'s: a manual score out
 * of 10 at 70 %, a pass/fail out of 1 at 30 %.
 */

export const EVALUATOR = 'USR-EVALUATOR';
export const AWARDER = 'USR-AWARDER';
export const AWARD_APPROVER = 'USR-APPROVER';
export const AWARD_STEP_ID = 'APR_01JAWARDSTEPAAAAAAAAAAAA';

export const EVALUATING_TENDER: TenderDetail = {
  ...CLOSED_TENDER,
  status: 'EVALUATING',
  version: 7,
};
export const EVALUATED_TENDER: TenderDetail = { ...CLOSED_TENDER, status: 'EVALUATED', version: 8 };
export const AWARDED_TENDER: TenderDetail = { ...CLOSED_TENDER, status: 'AWARDED', version: 9 };

const CRITERIA: EvaluationMatrix['criteria'] = [
  {
    code: 'technical',
    label: 'روش اجرا',
    weightBp: 7000,
    scoringMethod: 'MANUAL_SCORE',
    maxScore: 10,
  },
  {
    code: 'compliance',
    label: 'کامل‌بودن مدارک',
    weightBp: 3000,
    scoringMethod: 'PASS_FAIL',
    maxScore: 1,
  },
];

/** BID_A scored 8.5 and pass: 7000 × 850 + 3000 × 100 = 6 250 000, i.e. 6.25 points. */
const SCORED_A: EvaluationMatrix['bids'][number] = {
  bidId: 'BID_A',
  bidderOrganizationId: 'ORG-CON-A',
  bidStatus: 'QUALIFIED',
  qualification: {
    decision: 'QUALIFIED',
    reasonCode: null,
    reasonText: null,
    decidedBy: EVALUATOR,
    decidedAt: '2026-10-21T08:00:00.000Z',
  },
  evaluations: [
    {
      evaluatorId: EVALUATOR,
      complete: true,
      totalScaled: '6250000',
      cells: [
        {
          criterionCode: 'compliance',
          scoreScaled: 100,
          revision: 1,
          scoredAt: '2026-10-21T08:10:00.000Z',
        },
        {
          criterionCode: 'technical',
          scoreScaled: 850,
          revision: 2,
          scoredAt: '2026-10-21T08:20:00.000Z',
        },
      ],
    },
  ],
  recusals: [],
  evaluatorCount: 1,
  totalScaled: '6250000',
  rank: 1,
  tied: false,
};

const UNDECIDED_B: EvaluationMatrix['bids'][number] = {
  bidId: 'BID_B',
  bidderOrganizationId: 'ORG-CON-B',
  bidStatus: 'OPENED',
  qualification: null,
  evaluations: [],
  recusals: [],
  evaluatorCount: 0,
  totalScaled: null,
  rank: null,
  tied: false,
};

export const EVALUATING_MATRIX: EvaluationMatrix = {
  tenderId: TENDER_ID,
  status: 'EVALUATING',
  frozen: false,
  criteria: CRITERIA,
  maxTotalScaled: '10000000',
  minEvaluators: 1,
  maxEvaluators: 1,
  ready: false,
  readinessBlockedBy: null,
  undecidedBidCount: 1,
  blockers: [],
  bids: [SCORED_A, UNDECIDED_B],
};

/** BID_B disqualified: nothing undecided, BID_A complete — `ready`. */
export const READY_MATRIX: EvaluationMatrix = {
  ...EVALUATING_MATRIX,
  ready: true,
  undecidedBidCount: 0,
  bids: [
    SCORED_A,
    {
      ...UNDECIDED_B,
      bidStatus: 'DISQUALIFIED',
      qualification: {
        decision: 'DISQUALIFIED',
        reasonCode: 'NON_RESPONSIVE',
        reasonText: 'مدارک فنی پیوست نشده بود',
        decidedBy: EVALUATOR,
        decidedAt: '2026-10-21T08:30:00.000Z',
      },
    },
  ],
};

/** Both qualified and scored: BID_A first, BID_C second. */
export const EVALUATED_MATRIX: EvaluationMatrix = {
  ...READY_MATRIX,
  status: 'EVALUATED',
  frozen: true,
  bids: [
    SCORED_A,
    {
      ...SCORED_A,
      bidId: 'BID_C',
      bidderOrganizationId: 'ORG-CON-C',
      evaluations: [{ ...SCORED_A.evaluations[0]!, totalScaled: '5200000' }],
      totalScaled: '5200000',
      rank: 2,
    },
    READY_MATRIX.bids[1]!,
  ],
};

export const AWARD_PENDING_REQUEST: ApprovalRequest = {
  ...PENDING_REQUEST,
  id: 'TAR_AWARD_1',
  workflowKey: 'tender.award',
  tenderVersion: 8,
  requestedBy: AWARDER,
  steps: [
    {
      ...PENDING_REQUEST.steps[0]!,
      approvalId: AWARD_STEP_ID,
      approvalType: 'Award approval (sample)',
    },
  ],
};

export const AWARD_APPROVED_REQUEST: ApprovalRequest = {
  ...AWARD_PENDING_REQUEST,
  status: 'APPROVED',
  steps: [
    {
      ...AWARD_PENDING_REQUEST.steps[0]!,
      status: 'GRANTED',
      decidedAt: '2026-10-22T08:00:00.000Z',
    },
  ],
};

/** The award step, as its authority reads it: it names BID_C, second, with a reason. */
export const AWARD_STEP: AwardApproval = {
  id: AWARD_STEP_ID,
  tenderId: TENDER_ID,
  workflowKey: 'tender.award',
  status: 'PENDING',
  authorityOrganizationId: OWNER,
  authorityRole: 'ORGANIZATION_ADMIN',
  version: 3,
  request: {
    requestId: 'TAR_AWARD_1',
    tenderVersion: 8,
    status: 'PENDING',
    requestedBy: AWARDER,
    bid: {
      bidId: 'BID_C',
      bidderOrganizationId: 'ORG-CON-C',
      rank: 2,
      tied: false,
      justification: 'زمان اجرای کوتاه‌تر',
      standingVerdict: 'ELIGIBLE',
      standingAsOf: '2026-10-22T07:00:00.000Z',
    },
  },
};

export const AWARD_RECORD: TenderAward = {
  tenderId: TENDER_ID,
  status: 'AWARDED',
  bidId: 'BID_A',
  bidderOrganizationId: 'ORG-CON-A',
  amountMinor: '4200000000',
  rank: 1,
  tied: false,
  justification: null,
  standingAsOf: '2026-10-22T09:00:00.000Z',
  awardedAt: '2026-10-22T09:01:00.000Z',
  awardedBy: AWARDER,
};

/**
 * @jest-environment node
 */
import {
  AWARD_REFUSAL_TEXT,
  EVALUATION_REFUSAL_TEXT,
  scoreField,
} from '@/lib/tender-evaluation-fields';
import { OPENING_REFUSAL_TEXT } from '@/lib/tender-owner-fields';
import {
  AWARD_APPROVED_REQUEST,
  AWARD_APPROVER,
  AWARD_PENDING_REQUEST,
  AWARD_RECORD,
  AWARD_STEP,
  AWARD_STEP_ID,
  AWARDER,
  EVALUATED_MATRIX,
  EVALUATED_TENDER,
  EVALUATING_MATRIX,
  EVALUATOR,
  READY_MATRIX,
} from '@/test/evaluation-fixtures';
import { OWNER, TENDER_ID, jwt } from '@/test/owner-fixtures';

import type { ReadResult } from './assets';
import type { WebSession } from './session';
import {
  awardOffers,
  awardStepToRead,
  canAward,
  canEvaluate,
  evaluationOffers,
  fetchAward,
  fetchAwardApproval,
  fetchEvaluation,
  isBidSideOnly,
  mayDecideAward,
  readsEvaluation,
  type AwardState,
  type EvaluationMatrix,
} from './tender-evaluation';
import {
  fetchAwardRequest,
  issueOwnerCommand,
  outcomeOf,
  ownerCallerOf,
  ownerRequest,
  type OwnerBinding,
} from './tender-owner';

/**
 * The evaluation and award module: what it reads, who it offers each form to —
 * the copy of construction-service's checks pinned by
 * `tender-evaluation.contract.spec.ts` — what each command sends, and what
 * every answer becomes.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = { accessToken: 'access-token-value' } as WebSession;
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const SETTINGS = {
  WEB_PROJECT_ROLES: ['ORGANIZATION_ADMIN'],
  WEB_PROJECT_READER_ROLES: [] as string[],
  WEB_TENDER_OPEN_ROLES: [] as string[],
  WEB_TENDER_EVALUATE_ROLES: [] as string[],
  WEB_TENDER_AWARD_ROLES: [] as string[],
  WEB_TENDER_COI_RULES: ['AWARDER_NOT_EVALUATOR'] as (
    'AWARDER_NOT_EVALUATOR' | 'EVALUATOR_NOT_TENDER_AUTHOR'
  )[],
};

function person(roles: string[], uid: string | null = 'USR-OTHER', org = OWNER) {
  return ownerCallerOf(
    jwt({
      sub: 'kc-subject',
      org_id: org,
      org_ids: [org],
      org_roles: roles.map((role) => `${org}:${role}`),
      ...(uid ? { rasta_uid: uid } : {}),
    }),
  );
}

const ADMIN = ['ORGANIZATION_ADMIN'];
const ok = <T>(data: T): ReadResult<T> => ({ kind: 'OK', data });

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1' },
  });
}

function problem(status: number, code: string, reasons: { path: string; code: string }[] = []) {
  return jsonResponse(status, {
    code,
    message: 'An English sentence the page must never show',
    correlationId: 'corr-1',
    ...(reasons.length ? { details: reasons.map((d) => ({ ...d, message: 'English' })) } : {}),
  });
}

function answering(status: number, body: unknown) {
  const urls: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return jsonResponse(status, body);
  }) as typeof fetch);
  return urls;
}

afterEach(() => jest.restoreAllMocks());

describe('reading', () => {
  it('the matrix, from the evaluation route, only of this tender', async () => {
    const urls = answering(200, EVALUATING_MATRIX);
    const read = await fetchEvaluation(SESSION, TENDER_ID);
    expect(urls[0]).toBe(`http://gateway.test:3000/v1/tenders/${TENDER_ID}/evaluation`);
    expect(read).toEqual({ kind: 'OK', data: EVALUATING_MATRIX });
    jest.restoreAllMocks();
    answering(200, { ...EVALUATING_MATRIX, tenderId: 'TND_OTHER' });
    expect((await fetchEvaluation(SESSION, TENDER_ID)).kind).toBe('MALFORMED');
  });

  it('a refused matrix, a stranger’s, and one before the opening are each their own outcome', async () => {
    answering(403, { code: 'FORBIDDEN', message: 'x' });
    expect(await fetchEvaluation(SESSION, TENDER_ID)).toEqual({ kind: 'FORBIDDEN' });
    jest.restoreAllMocks();
    answering(404, { code: 'NOT_FOUND', message: 'x' });
    expect(await fetchEvaluation(SESSION, TENDER_ID)).toEqual({ kind: 'NOT_FOUND' });
    jest.restoreAllMocks();
    answering(422, { code: 'BUSINESS_RULE_VIOLATION', message: 'x' });
    expect(await fetchEvaluation(SESSION, TENDER_ID)).toMatchObject({
      kind: 'UNAVAILABLE',
      status: 422,
    });
  });

  it('a total that is not a whole decimal string is not a matrix', async () => {
    answering(200, {
      ...EVALUATING_MATRIX,
      bids: [{ ...EVALUATING_MATRIX.bids[0]!, totalScaled: 6.25 }],
    });
    expect((await fetchEvaluation(SESSION, TENDER_ID)).kind).toBe('MALFORMED');
  });

  it('the newest award request, by its workflow, one at a time', async () => {
    const urls = answering(200, {
      items: [AWARD_PENDING_REQUEST],
      nextCursor: null,
      hasMore: false,
    });
    expect(await fetchAwardRequest(SESSION, TENDER_ID)).toEqual(ok(AWARD_PENDING_REQUEST));
    expect(urls[0]).toBe(
      `http://gateway.test:3000/v1/tenders/${TENDER_ID}/approvals?workflowKey=tender.award&limit=1`,
    );
  });

  it('an award step is read at its own route, and only an award step is one', async () => {
    const urls = answering(200, AWARD_STEP);
    expect(await fetchAwardApproval(SESSION, AWARD_STEP_ID)).toEqual(ok(AWARD_STEP));
    expect(urls[0]).toBe(`http://gateway.test:3000/v1/approvals/${AWARD_STEP_ID}`);
    jest.restoreAllMocks();
    answering(200, { ...AWARD_STEP, workflowKey: 'tender.publication' });
    expect((await fetchAwardApproval(SESSION, AWARD_STEP_ID)).kind).toBe('MALFORMED');
  });

  it('the award keeps the winner’s price as a decimal string', async () => {
    const urls = answering(200, {
      ...AWARD_RECORD,
      projectId: 'PRJ_1',
      matrixDigest: 'x',
      alreadyAwarded: true,
    });
    const read = await fetchAward(SESSION, TENDER_ID);
    expect(urls[0]).toBe(`http://gateway.test:3000/v1/tenders/${TENDER_ID}/award`);
    expect(read.kind === 'OK' && read.data.amountMinor).toBe('4200000000');
    jest.restoreAllMocks();
    answering(200, { ...AWARD_RECORD, amountMinor: 4200000000 });
    expect((await fetchAward(SESSION, TENDER_ID)).kind).toBe('MALFORMED');
  });
});

describe('who may evaluate and award — construction-service’s `assertOwnerBidSide`', () => {
  it('the owner’s role set by default, a platform user id required', () => {
    expect(canEvaluate(person(ADMIN), SETTINGS)).toBe(true);
    expect(canAward(person(ADMIN), SETTINGS)).toBe(true);
    expect(canEvaluate(person(ADMIN, null), SETTINGS)).toBe(false);
    expect(canAward(person(['FLEET_MANAGER']), SETTINGS)).toBe(false);
  });

  it('SYSTEM_ADMIN, AUDITOR and CONTRACTOR refuse it whenever present', () => {
    for (const refused of ['SYSTEM_ADMIN', 'AUDITOR', 'CONTRACTOR']) {
      expect(canEvaluate(person([...ADMIN, refused]), SETTINGS)).toBe(false);
      expect(canAward(person([...ADMIN, refused]), SETTINGS)).toBe(false);
      expect(mayDecideAward(person([...ADMIN, refused]))).toBe(false);
    }
    expect(mayDecideAward(person(['FLEET_MANAGER']))).toBe(true);
  });

  it('the configured roles take the place of the owner’s, each for its own command', () => {
    const configured = {
      ...SETTINGS,
      WEB_TENDER_EVALUATE_ROLES: ['FLEET_MANAGER'],
      WEB_TENDER_AWARD_ROLES: ['UNION_ADMIN'],
    };
    expect(canEvaluate(person(['FLEET_MANAGER']), configured)).toBe(true);
    expect(canEvaluate(person(ADMIN), configured)).toBe(false);
    expect(canAward(person(['UNION_ADMIN']), configured)).toBe(true);
    expect(canAward(person(['FLEET_MANAGER']), configured)).toBe(false);
    // An evaluator refused the tender read is given the bid side without it.
    expect(isBidSideOnly(person(['FLEET_MANAGER']), configured)).toBe(true);
    expect(isBidSideOnly(person(ADMIN), configured)).toBe(false);
  });

  it('the matrix is read only past the opening, by an evaluator', () => {
    for (const status of ['EVALUATING', 'EVALUATED', 'AWARDED']) {
      expect(readsEvaluation(person(ADMIN), status, SETTINGS)).toBe(true);
    }
    for (const status of ['DRAFT', 'PUBLISHED', 'CLOSED', 'CANCELLED']) {
      expect(readsEvaluation(person(ADMIN), status, SETTINGS)).toBe(false);
    }
    expect(readsEvaluation(person(['AUDITOR']), 'EVALUATING', SETTINGS)).toBe(false);
  });
});

describe('the evaluators’ offers', () => {
  const offered = (
    caller = person(ADMIN, EVALUATOR),
    matrix: EvaluationMatrix = EVALUATING_MATRIX,
  ) => evaluationOffers(caller, ok(matrix), SETTINGS);

  it('an undecided bid is decided, a qualified one scored at the revisions read; not ready, not completed', () => {
    const { offers, notes } = offered();
    expect(offers).toEqual([
      {
        command: 'SCORE',
        bidId: 'BID_A',
        scoring: [
          { criterionCode: 'technical', maxScore: 10, passFail: false, expectedRevision: 2 },
          { criterionCode: 'compliance', maxScore: 1, passFail: true, expectedRevision: 1 },
        ],
      },
      { command: 'QUALIFY', bidId: 'BID_B' },
      { command: 'DISQUALIFY', bidId: 'BID_B' },
    ]);
    expect(notes).toEqual(['EVALUATION_INCOMPLETE']);
  });

  it('a bid at its evaluator limit takes no new evaluator; one who stood down leaves a place', () => {
    const other = person(ADMIN, 'USR-SECOND');
    expect(offered(other).offers.map(({ command }) => command)).toEqual(['QUALIFY', 'DISQUALIFY']);
    const roomier = { ...EVALUATING_MATRIX, maxEvaluators: 2 };
    expect(offered(other, roomier).offers[0]).toMatchObject({
      command: 'SCORE',
      bidId: 'BID_A',
      scoring: [{ expectedRevision: 0 }, { expectedRevision: 0 }],
    });
    const stoodDown: EvaluationMatrix = {
      ...EVALUATING_MATRIX,
      bids: [
        {
          ...EVALUATING_MATRIX.bids[0]!,
          recusals: [
            { evaluatorId: EVALUATOR, reasonCode: 'OTHER', recusedAt: '2026-10-21T09:00:00.000Z' },
          ],
        },
        EVALUATING_MATRIX.bids[1]!,
      ],
    };
    expect(offered(other, stoodDown).offers[0]).toMatchObject({ command: 'SCORE', bidId: 'BID_A' });
    // And the one who stood down does not score or decide it again (`RECUSED`).
    expect(
      offered(person(ADMIN, EVALUATOR), stoodDown).offers.map(({ command }) => command),
    ).toEqual(['QUALIFY', 'DISQUALIFY']);
  });

  it('ready is completed; what keeps it from completing is said', () => {
    expect(offered(person(ADMIN, EVALUATOR), READY_MATRIX).offers.at(-1)).toEqual({
      command: 'EVALUATE',
    });
    expect(
      offered(person(ADMIN, EVALUATOR), {
        ...READY_MATRIX,
        ready: false,
        readinessBlockedBy: 'SAME_PERSON_AS_EVALUATOR',
      }),
    ).toMatchObject({ notes: ['READINESS_BLOCKED'] });
    const noneQualified: EvaluationMatrix = {
      ...READY_MATRIX,
      ready: false,
      bids: [READY_MATRIX.bids[1]!],
    };
    expect(offered(person(ADMIN, EVALUATOR), noneQualified)).toEqual({
      offers: [],
      notes: ['NO_QUALIFIED_BID'],
    });
  });

  it('nothing once evaluated, nothing without a platform user id or the evaluators’ role', () => {
    const none = { offers: [], notes: [] };
    expect(offered(person(ADMIN, EVALUATOR), { ...READY_MATRIX, status: 'EVALUATED' })).toEqual(
      none,
    );
    expect(offered(person(ADMIN, null))).toEqual(none);
    expect(offered(person(['AUDITOR'], EVALUATOR))).toEqual(none);
    expect(evaluationOffers(person(ADMIN), { kind: 'FORBIDDEN' }, SETTINGS)).toEqual(none);
  });
});

describe('the award’s offers', () => {
  const state = (overrides: Partial<AwardState> = {}): AwardState => ({
    tender: EVALUATED_TENDER,
    completedByCaller: false,
    matrix: ok(EVALUATED_MATRIX),
    request: ok(null),
    step: null,
    ...overrides,
  });
  const awarder = person(ADMIN, AWARDER);

  it('one form per ranked qualified bid; anything but the single first rank needs a justification', () => {
    expect(awardOffers(awarder, state(), SETTINGS)).toEqual({
      offers: [
        {
          command: 'AWARD',
          bidId: 'BID_A',
          award: { justificationRequired: false, execution: null },
        },
        {
          command: 'AWARD',
          bidId: 'BID_C',
          award: { justificationRequired: true, execution: null },
        },
      ],
      notes: [],
    });
    const tied: EvaluationMatrix = {
      ...EVALUATED_MATRIX,
      bids: EVALUATED_MATRIX.bids.map((bid) =>
        bid.rank === null ? bid : { ...bid, rank: 1, tied: true },
      ),
    };
    for (const offer of awardOffers(awarder, state({ matrix: ok(tied) }), SETTINGS).offers) {
      expect(offer).toMatchObject({ award: { justificationRequired: true } });
    }
  });

  it('whoever took part in the evaluation does not award it — unless the rule is off', () => {
    const evaluator = person(ADMIN, EVALUATOR);
    expect(awardOffers(evaluator, state(), SETTINGS)).toEqual({
      offers: [],
      notes: ['AWARDER_IS_EVALUATOR'],
    });
    expect(awardOffers(awarder, state({ completedByCaller: true }), SETTINGS)).toMatchObject({
      offers: [],
      notes: ['AWARDER_IS_EVALUATOR'],
    });
    expect(
      awardOffers(evaluator, state(), { ...SETTINGS, WEB_TENDER_COI_RULES: [] }).offers,
    ).toHaveLength(2);
  });

  it('a pending request does not hold the forms back: another choice ends it and asks anew', () => {
    // The policy's authority is the owner's own role, so these people decide its step too.
    const pending = state({ request: ok(AWARD_PENDING_REQUEST), step: ok(AWARD_STEP) });
    const own = awardOffers(awarder, pending, SETTINGS);
    expect(own.notes).toEqual(['OWN_AWARD_REQUEST']);
    expect(own.offers.filter(({ command }) => command === 'AWARD')).toMatchObject([
      { bidId: 'BID_A' },
      { bidId: 'BID_C' },
    ]);
    expect(awardOffers(person(ADMIN, 'USR-THIRD'), pending, SETTINGS).notes).toEqual([
      'AWARD_PENDING',
    ]);
  });

  it('approved on this version: only executing it, with the bid and the justification approved', () => {
    const approvedStep = { ...AWARD_STEP, status: 'GRANTED' };
    expect(awardStepToRead(awarder, EVALUATED_TENDER, AWARD_APPROVED_REQUEST, SETTINGS)).toBe(
      AWARD_STEP_ID,
    );
    expect(
      awardOffers(
        awarder,
        state({ request: ok(AWARD_APPROVED_REQUEST), step: ok(approvedStep) }),
        SETTINGS,
      ),
    ).toEqual({
      offers: [
        {
          command: 'AWARD',
          bidId: 'BID_C',
          award: {
            justificationRequired: false,
            execution: { justification: 'زمان اجرای کوتاه‌تر' },
          },
        },
      ],
      notes: ['AWARD_APPROVED'],
    });
    expect(
      awardOffers(
        awarder,
        state({
          request: ok(AWARD_APPROVED_REQUEST),
          step: { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' },
        }),
        SETTINGS,
      ),
    ).toEqual({ offers: [], notes: ['AWARD_APPROVED', 'AWARD_STEP_UNREAD'] });
    // Approved on an earlier version: that approval is stale; a new choice is a new request.
    const behind = { ...AWARD_APPROVED_REQUEST, tenderVersion: 7 };
    expect(awardStepToRead(awarder, EVALUATED_TENDER, behind, SETTINGS)).toBeNull();
    expect(awardOffers(awarder, state({ request: ok(behind) }), SETTINGS).offers).toHaveLength(2);
  });

  it('the authority decides the pending step read for its version: rejects always, grants another’s', () => {
    const approver = person(ADMIN, AWARD_APPROVER);
    const pending = { request: ok(AWARD_PENDING_REQUEST), step: ok(AWARD_STEP) };
    expect(awardStepToRead(approver, EVALUATED_TENDER, AWARD_PENDING_REQUEST, SETTINGS)).toBe(
      AWARD_STEP_ID,
    );
    expect(awardOffers(approver, state(pending), SETTINGS).offers.slice(0, 2)).toEqual([
      { command: 'GRANT_AWARD', approvalId: AWARD_STEP_ID, expectedVersion: 3 },
      { command: 'REJECT_AWARD', approvalId: AWARD_STEP_ID, expectedVersion: 3 },
    ]);
    // The requester is the step's authority too: the rejection only (`assertDistinctActors`).
    expect(
      awardOffers(awarder, state(pending), SETTINGS).offers.filter(({ command }) =>
        command.endsWith('_AWARD'),
      ),
    ).toEqual([{ command: 'REJECT_AWARD', approvalId: AWARD_STEP_ID, expectedVersion: 3 }]);
    // The service refused the step: it would refuse the decision too.
    expect(
      awardOffers(approver, state({ ...pending, step: { kind: 'FORBIDDEN' } }), SETTINGS).notes,
    ).toContain('AWARD_STEP_REFUSED');
    // A role the bid side excludes is never the approver of an award (`assertMayDecideAward`).
    expect(
      awardStepToRead(
        person([...ADMIN, 'CONTRACTOR'], AWARD_APPROVER),
        EVALUATED_TENDER,
        AWARD_PENDING_REQUEST,
        SETTINGS,
      ),
    ).toBeNull();
  });

  it('what cannot be read is said, and nothing is offered on it', () => {
    expect(
      awardOffers(
        awarder,
        state({ request: { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' } }),
        SETTINGS,
      ),
    ).toEqual({ offers: [], notes: ['AWARD_REQUESTS_UNREAD'] });
    expect(awardOffers(awarder, state({ matrix: { kind: 'FORBIDDEN' } }), SETTINGS)).toEqual({
      offers: [],
      notes: ['AWARD_MATRIX_UNREAD'],
    });
    expect(
      awardOffers(awarder, state({ tender: { status: 'AWARDED', version: 9 } }), SETTINGS),
    ).toEqual({
      offers: [],
      notes: [],
    });
  });
});

describe('what each command sends', () => {
  const bidBinding = (
    command: OwnerBinding['command'],
    extra: Partial<OwnerBinding> = {},
  ): OwnerBinding => ({
    command,
    approvalId: null,
    expectedVersion: null,
    bidId: 'BID_A',
    ...extra,
  });
  const scoring = [
    { criterionCode: 'technical', maxScore: 10, passFail: false, expectedRevision: 2 },
    { criterionCode: 'compliance', maxScore: 1, passFail: true, expectedRevision: 0 },
  ];
  const base = `/v1/tenders/${TENDER_ID}`;

  it('a decision on a bid names the bid in the path, a disqualification its reasons', () => {
    expect(ownerRequest(TENDER_ID, bidBinding('QUALIFY'), {})).toMatchObject({
      path: `${base}/bids/BID_A/qualification`,
      body: { decision: 'QUALIFIED' },
    });
    expect(
      ownerRequest(TENDER_ID, bidBinding('DISQUALIFY'), {
        disqualification: { reasonCode: 'NON_RESPONSIVE', reasonText: 'مدارک ناقص' },
      }),
    ).toMatchObject({
      path: `${base}/bids/BID_A/qualification`,
      body: { decision: 'DISQUALIFIED', reasonCode: 'NON_RESPONSIVE', reasonText: 'مدارک ناقص' },
    });
    expect(ownerRequest(TENDER_ID, bidBinding('DISQUALIFY'), {})).toBeNull();
  });

  it('a score sends only the criteria read, each at the revision read; its paths land on its fields', () => {
    const request = ownerRequest(TENDER_ID, bidBinding('SCORE', { scoring }), {
      scores: [
        { criterionCode: 'compliance', scoreScaled: 100, expectedRevision: 0 },
        { criterionCode: 'technical', scoreScaled: 850, expectedRevision: 2 },
      ],
    });
    expect(request).toMatchObject({
      path: `${base}/bids/BID_A/scores`,
      body: {
        scores: [
          { criterionCode: 'compliance', scoreScaled: 100, expectedRevision: 0 },
          { criterionCode: 'technical', scoreScaled: 850, expectedRevision: 2 },
        ],
      },
    });
    expect(request?.mapping.paths).toEqual({
      'scores.0.scoreScaled': scoreField('compliance'),
      'scores.1.scoreScaled': scoreField('technical'),
    });
    for (const scores of [
      [{ criterionCode: 'technical', scoreScaled: 850, expectedRevision: 1 }],
      [{ criterionCode: 'other', scoreScaled: 0, expectedRevision: 0 }],
      [],
    ]) {
      expect(ownerRequest(TENDER_ID, bidBinding('SCORE', { scoring }), { scores })).toBeNull();
    }
  });

  it('completing names nothing; an award names the bid, and executing repeats the approved justification', () => {
    expect(
      ownerRequest(TENDER_ID, { command: 'EVALUATE', approvalId: null, expectedVersion: null }, {}),
    ).toMatchObject({ path: `${base}/evaluate`, body: {} });
    const asked = bidBinding('AWARD', { award: { justificationRequired: true, execution: null } });
    expect(ownerRequest(TENDER_ID, asked, { justification: 'زمان کوتاه‌تر' })).toMatchObject({
      path: `${base}/award`,
      body: { bidId: 'BID_A', justification: 'زمان کوتاه‌تر' },
    });
    expect(ownerRequest(TENDER_ID, asked, { justification: null })?.body).toEqual({
      bidId: 'BID_A',
    });
    const executes = bidBinding('AWARD', {
      award: { justificationRequired: false, execution: { justification: 'آنچه موافقت شد' } },
    });
    expect(ownerRequest(TENDER_ID, executes, { justification: 'چیز دیگری' })?.body).toEqual({
      bidId: 'BID_A',
      justification: 'آنچه موافقت شد',
    });
  });

  it('an award decision is a decision on its step', () => {
    const step = { approvalId: AWARD_STEP_ID, expectedVersion: 3 };
    expect(ownerRequest(TENDER_ID, { command: 'GRANT_AWARD', ...step }, {})).toMatchObject({
      path: `/v1/approvals/${AWARD_STEP_ID}/decision`,
      body: { expectedVersion: 3, decision: 'GRANT' },
    });
    expect(
      ownerRequest(
        TENDER_ID,
        { command: 'REJECT_AWARD', ...step },
        { reason: 'رتبهٔ نخست بهتر است' },
      ),
    ).toMatchObject({
      body: { expectedVersion: 3, decision: 'REJECT', reason: 'رتبهٔ نخست بهتر است' },
    });
    expect(ownerRequest(TENDER_ID, { command: 'REJECT_AWARD', ...step }, {})).toBeNull();
  });

  it('a binding that does not fit its command carries nothing', () => {
    expect(ownerRequest(TENDER_ID, bidBinding('QUALIFY', { scoring }), {})).toBeNull();
    expect(ownerRequest(TENDER_ID, bidBinding('AWARD'), {})).toBeNull();
    expect(ownerRequest(TENDER_ID, bidBinding('EVALUATE'), {})).toBeNull();
    expect(ownerRequest(TENDER_ID, bidBinding('SCORE'), { scores: [] })).toBeNull();
    expect(
      ownerRequest(TENDER_ID, { command: 'QUALIFY', approvalId: null, expectedVersion: null }, {}),
    ).toBeNull();
    expect(
      ownerRequest(
        TENDER_ID,
        { command: 'GRANT_AWARD', approvalId: AWARD_STEP_ID, expectedVersion: 3, bidId: 'BID_A' },
        {},
      ),
    ).toBeNull();
  });
});

describe('what every answer becomes', () => {
  const send = (binding: OwnerBinding, response: Response, input = {}) => {
    const fetchImpl = jest.fn(async () => response);
    return issueOwnerCommand(
      SESSION,
      TENDER_ID,
      binding,
      ownerRequest(TENDER_ID, binding, input)!,
      SUBMISSION,
      fetchImpl as unknown as typeof fetch,
    );
  };
  const award: OwnerBinding = {
    command: 'AWARD',
    approvalId: null,
    expectedVersion: null,
    bidId: 'BID_A',
    award: { justificationRequired: false, execution: null },
  };

  it('an award answers its request (202) or the award (200) — both confirmed, told apart', async () => {
    const asked = await send(award, jsonResponse(202, AWARD_PENDING_REQUEST));
    expect(asked.kind === 'CREATED' && outcomeOf('AWARD', asked.data)).toBe('AWARD_REQUESTED');
    const done = await send(award, jsonResponse(200, { ...AWARD_RECORD, alreadyAwarded: false }));
    expect(done.kind === 'CREATED' && outcomeOf('AWARD', done.data)).toBe('AWARDED');
    for (const other of [
      jsonResponse(202, { ...AWARD_PENDING_REQUEST, workflowKey: 'tender.publication' }),
      jsonResponse(200, { ...AWARD_RECORD, bidId: 'BID_C' }),
      jsonResponse(200, { ...AWARD_RECORD, tenderId: 'TND_OTHER' }),
    ]) {
      expect(await send(award, other)).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    }
  });

  it('an award refused says its reason in fixed words, a stale approval too', async () => {
    const refused = await send(
      award,
      problem(422, 'BUSINESS_RULE_VIOLATION', [{ path: 'award', code: 'JUSTIFICATION_REQUIRED' }]),
    );
    expect(refused).toMatchObject({
      kind: 'INVALID',
      message: AWARD_REFUSAL_TEXT.JUSTIFICATION_REQUIRED,
    });
    const stale = await send(
      award,
      problem(409, 'CONFLICT', [{ path: 'approval', code: 'APPROVAL_STALE' }]),
    );
    expect(stale.kind === 'INVALID' && stale.message).toMatch(/دیگر معتبر نیست/);
    expect(JSON.stringify([refused, stale])).not.toContain('English');
  });

  it('a decision on a bid is confirmed only by that decision on that bid', async () => {
    const qualify: OwnerBinding = {
      command: 'QUALIFY',
      approvalId: null,
      expectedVersion: null,
      bidId: 'BID_A',
    };
    const answer = {
      bidId: 'BID_A',
      tenderId: TENDER_ID,
      decision: 'QUALIFIED',
      alreadyDecided: true,
    };
    expect(await send(qualify, jsonResponse(200, answer))).toMatchObject({ kind: 'CREATED' });
    for (const other of [{ decision: 'DISQUALIFIED' }, { bidId: 'BID_B' }]) {
      expect(await send(qualify, jsonResponse(200, { ...answer, ...other }))).toMatchObject({
        kind: 'UNKNOWN_OUTCOME',
      });
    }
  });

  it('an evaluation’s refusals are the evaluation’s words, not the opening’s', async () => {
    const qualify: OwnerBinding = {
      command: 'QUALIFY',
      approvalId: null,
      expectedVersion: null,
      bidId: 'BID_A',
    };
    const refused = await send(
      qualify,
      problem(403, 'FORBIDDEN', [{ path: 'evaluation', code: 'CONFLICT_OF_INTEREST' }]),
    );
    expect(refused).toMatchObject({ kind: 'FORBIDDEN', reasons: ['CONFLICT_OF_INTEREST'] });
    const ineligible = await send(
      qualify,
      problem(422, 'BUSINESS_RULE_VIOLATION', [
        { path: 'evaluation', code: 'BIDDER_NOT_ELIGIBLE' },
      ]),
    );
    expect(ineligible).toMatchObject({ message: EVALUATION_REFUSAL_TEXT.BIDDER_NOT_ELIGIBLE });
    expect(EVALUATION_REFUSAL_TEXT.CONFLICT_OF_INTEREST).not.toBe(
      OPENING_REFUSAL_TEXT.CONFLICT_OF_INTEREST,
    );
  });

  it('a score out of range lands on its criterion’s field', async () => {
    const score: OwnerBinding = {
      command: 'SCORE',
      approvalId: null,
      expectedVersion: null,
      bidId: 'BID_A',
      scoring: [{ criterionCode: 'technical', maxScore: 10, passFail: false, expectedRevision: 0 }],
    };
    const refused = await send(
      score,
      problem(400, 'VALIDATION_FAILED', [{ path: 'scores.0.scoreScaled', code: 'too_big' }]),
      { scores: [{ criterionCode: 'technical', scoreScaled: 900, expectedRevision: 0 }] },
    );
    expect(refused).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { [scoreField('technical')]: expect.any(String) },
    });
    const recorded = await send(
      score,
      jsonResponse(200, {
        bidId: 'BID_A',
        tenderId: TENDER_ID,
        evaluationId: 'E',
        evaluatorId: 'U',
        recorded: [],
        unchanged: ['technical'],
        complete: false,
      }),
      { scores: [{ criterionCode: 'technical', scoreScaled: 900, expectedRevision: 0 }] },
    );
    expect(recorded).toMatchObject({ kind: 'CREATED' });
  });

  it('an award decision is confirmed by an award step only; a publication decision by a publication step', async () => {
    const step = {
      id: AWARD_STEP_ID,
      tenderId: TENDER_ID,
      workflowKey: 'tender.award',
      authorityOrganizationId: OWNER,
      authorityRole: 'ORGANIZATION_ADMIN',
      version: 4,
      status: 'GRANTED',
    };
    const grantAward: OwnerBinding = {
      command: 'GRANT_AWARD',
      approvalId: AWARD_STEP_ID,
      expectedVersion: 3,
    };
    expect(await send(grantAward, jsonResponse(200, step))).toMatchObject({ kind: 'CREATED' });
    const grantPublication: OwnerBinding = { ...grantAward, command: 'GRANT' };
    expect(await send(grantPublication, jsonResponse(200, step))).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
  });
});

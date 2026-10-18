/**
 * @jest-environment node
 */

/**
 * `/tenders/[id]` past the opening, run as the server component it is with the
 * reads stubbed: which reads each person's page makes — the matrix only for an
 * evaluator, the award's requests and step only once evaluated, the award only
 * once made — and which forms it is given. An evaluator configured outside the
 * reader roles (`WEB_TENDER_EVALUATE_ROLES`) gets the matrix without the
 * tender, as construction-service gives it.
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  WEB_TENDER_EVALUATE_ROLES: 'ORGANIZATION_ADMIN,FLEET_MANAGER',
});

const ORG = 'ORG-DEH-0001';
const mockSession = { current: null as unknown };
const mockFetched: string[] = [];
const mockAnswers: Record<string, unknown> = {};
/** What each stubbed read was last asked with. */
const mockArgs: Record<string, unknown[]> = {};

/** The module as it is, with every `fetch*` read answered from `mockAnswers` and recorded. */
function mockStubFetchers(path: string): Record<string, unknown> {
  const actual = jest.requireActual(path) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.startsWith('fetch') && typeof value === 'function'
        ? async (...args: unknown[]) => {
            mockFetched.push(name);
            mockArgs[name] = args;
            return mockAnswers[name] ?? { kind: 'NOT_FOUND' };
          }
        : value,
    ]),
  );
}

jest.mock('@/server/current-session', () => ({
  currentSession: async () => mockSession.current,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('@/server/tenders', () => mockStubFetchers('@/server/tenders'));
jest.mock('@/server/tender-owner', () => mockStubFetchers('@/server/tender-owner'));
jest.mock('@/server/tender-bids', () => mockStubFetchers('@/server/tender-bids'));
jest.mock('@/server/tender-authority', () => mockStubFetchers('@/server/tender-authority'));
jest.mock('@/server/tender-evaluation', () => mockStubFetchers('@/server/tender-evaluation'));

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const TenderPage = (require('./[id]/page') as { default: Page }).default;
const { OwnerCommands } = require('./[id]/OwnerCommands') as typeof import('./[id]/OwnerCommands');
const { OpeningOnlyScreen, OwnerFlash } =
  require('./[id]/OwnerSections') as typeof import('./[id]/OwnerSections');
const { AwardSection, EvaluationSection } =
  require('./[id]/EvaluationSections') as typeof import('./[id]/EvaluationSections');
const { OwnTenderDetailScreen } =
  require('./[id]/TenderDetailScreen') as typeof import('./[id]/TenderDetailScreen');
const fixtures =
  require('@/test/evaluation-fixtures') as typeof import('@/test/evaluation-fixtures');
const { AuthorityInboxSection, AuthorityScreen } =
  require('./[id]/AuthoritySections') as typeof import('./[id]/AuthoritySections');
const { mintFlash } = require('@/server/flash') as typeof import('@/server/flash');
/* eslint-enable @typescript-eslint/no-require-imports */

const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function signedInWith(roles: string[], uid = 'USR-1') {
  return {
    subject: 'user-1',
    username: 'u',
    organizationId: ORG,
    accessToken: jwt({
      org_id: ORG,
      org_ids: [ORG],
      org_roles: roles.map((role) => `${ORG}:${role}`),
      rasta_uid: uid,
    }),
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf-token-for-this-session',
    issuedAt: Math.floor(Date.now() / 1000) - 60,
  };
}

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const item of node) elements(item, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values(node.props as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

const ofType = (tree: ReactNode, type: unknown) => elements(tree).filter((e) => e.type === type);

/** The session's recovery beside an absence: no form of its own, a restored record drawn here. */
const recoveries = (tree: ReactNode) =>
  ofType(tree, OwnerCommands).filter((e) => {
    const props = e.props as { offered: unknown[]; showsRestored?: boolean; tenderId: string };
    return props.offered.length === 0 && props.showsRestored === true && props.tenderId === 'TND_1';
  });

const offered = (tree: ReactNode): string[] =>
  ofType(tree, OwnerCommands).flatMap((element) =>
    (element.props as { offered: { command: string }[] }).offered.map(({ command }) => command),
  );

function run(
  view?: string,
  flash?: string,
  more: Record<string, string> = {},
): Promise<ReactElement> {
  return TenderPage({
    params: Promise.resolve({ id: 'TND_1' }),
    searchParams: Promise.resolve({
      ...(view ? { view } : {}),
      ...(flash ? { flash } : {}),
      ...more,
    }),
  });
}

beforeEach(() => {
  mockFetched.length = 0;
  for (const key of Object.keys(mockArgs)) delete mockArgs[key];
  for (const key of Object.keys(mockAnswers)) delete mockAnswers[key];
});

it('evaluating, to an evaluator: the tender, the matrix and the bids; the evaluators’ forms', async () => {
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN'], fixtures.EVALUATOR);
  mockAnswers.fetchTender = { kind: 'OK', data: fixtures.EVALUATING_TENDER };
  mockAnswers.fetchEvaluation = { kind: 'OK', data: fixtures.EVALUATING_MATRIX };
  const tree = await run('own');
  expect(mockFetched.sort()).toEqual(
    ['fetchEvaluation', 'fetchOwnerBids', 'fetchTender', 'fetchTenderCriteria'].sort(),
  );
  expect(ofType(tree, EvaluationSection)).toHaveLength(1);
  expect(ofType(tree, AwardSection)).toHaveLength(0);
  expect(offered(tree)).toEqual(['SCORE', 'QUALIFY', 'DISQUALIFY']);
});

it('evaluated, to an awarder who took no part: the award’s request read, a form per ranked bid', async () => {
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN'], fixtures.AWARDER);
  mockAnswers.fetchTender = { kind: 'OK', data: fixtures.EVALUATED_TENDER };
  mockAnswers.fetchEvaluation = { kind: 'OK', data: fixtures.EVALUATED_MATRIX };
  mockAnswers.fetchAwardRequest = { kind: 'OK', data: null };
  const tree = await run('own');
  expect(mockFetched).toContain('fetchAwardRequest');
  expect(mockFetched).not.toContain('fetchAward');
  expect(mockFetched).not.toContain('fetchAwardApproval');
  expect(offered(tree)).toEqual(['AWARD', 'AWARD']);
});

it('evaluated, to the evaluator: the award is someone else’s', async () => {
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN'], fixtures.EVALUATOR);
  mockAnswers.fetchTender = { kind: 'OK', data: fixtures.EVALUATED_TENDER };
  mockAnswers.fetchEvaluation = { kind: 'OK', data: fixtures.EVALUATED_MATRIX };
  mockAnswers.fetchAwardRequest = { kind: 'OK', data: null };
  const tree = await run('own');
  expect(offered(tree)).toEqual([]);
  const [award] = ofType(tree, AwardSection);
  expect((award?.props as { notes: string[] }).notes).toEqual(['AWARDER_IS_EVALUATOR']);
});

it('pending, to its authority: the step read for its version, and the decision', async () => {
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN'], fixtures.AWARD_APPROVER);
  mockAnswers.fetchTender = { kind: 'OK', data: fixtures.EVALUATED_TENDER };
  mockAnswers.fetchEvaluation = { kind: 'OK', data: fixtures.EVALUATED_MATRIX };
  mockAnswers.fetchAwardRequest = { kind: 'OK', data: fixtures.AWARD_PENDING_REQUEST };
  mockAnswers.fetchAwardApproval = { kind: 'OK', data: fixtures.AWARD_STEP };
  const tree = await run('own');
  expect(mockFetched).toContain('fetchAwardApproval');
  expect(offered(tree)).toEqual(['GRANT_AWARD', 'REJECT_AWARD', 'AWARD', 'AWARD']);
});

it('awarded, to an awarder: the award is read, and nothing is offered', async () => {
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN'], fixtures.AWARDER);
  mockAnswers.fetchTender = { kind: 'OK', data: fixtures.AWARDED_TENDER };
  mockAnswers.fetchEvaluation = {
    kind: 'OK',
    data: { ...fixtures.EVALUATED_MATRIX, status: 'AWARDED' },
  };
  mockAnswers.fetchAwardRequest = {
    kind: 'OK',
    data: { ...fixtures.AWARD_APPROVED_REQUEST, status: 'CONSUMED' },
  };
  mockAnswers.fetchAward = { kind: 'OK', data: fixtures.AWARD_RECORD };
  const tree = await run('own');
  expect(mockFetched).toContain('fetchAward');
  expect(offered(tree)).toEqual([]);
});

it('an evaluator outside the reader roles reads the matrix alone, never the tender', async () => {
  mockSession.current = signedInWith(['FLEET_MANAGER'], fixtures.EVALUATOR);
  mockAnswers.fetchEvaluation = { kind: 'OK', data: fixtures.EVALUATING_MATRIX };
  const tree = await run('own');
  expect(mockFetched).toEqual(['fetchEvaluation', 'fetchAuthoritySteps']);
  expect(ofType(tree, OpeningOnlyScreen)).toHaveLength(1);
  expect(ofType(tree, EvaluationSection)).toHaveLength(1);
  expect(offered(tree)).toEqual(['SCORE', 'QUALIFY', 'DISQUALIFY']);
  // Another organization's tender, or a missing one, is the absence the tender read would show.
  mockFetched.length = 0;
  delete mockAnswers.fetchEvaluation;
  const absent = await run('own');
  expect(mockFetched).toEqual(['fetchEvaluation', 'fetchAuthoritySteps']);
  const [screen] = ofType(absent, OwnTenderDetailScreen);
  expect((screen?.props as { result: unknown }).result).toEqual({ kind: 'NOT_FOUND' });
  // An approval authority of another organization whose role also evaluates: refused the
  // matrix, it reaches its step from its inbox (PR 346 review 2, finding 2).
  mockFetched.length = 0;
  const step = {
    ...fixtures.AWARD_STEP,
    stepOrder: 1,
    authorityOrganizationId: ORG,
    authorityRole: 'FLEET_MANAGER',
    authorityLabel: 'بازبین (نمونه)',
    requestedAt: '2026-10-22T07:00:00.000Z',
    project: { title: 'بهسازی راه روستایی' },
  };
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: {
      items: [{ summary: step, detail: { kind: 'OK', data: step } }],
      truncated: false,
      resumeFrom: null,
      failure: null,
    },
  };
  const authority = await run('own');
  expect(mockFetched).toEqual(['fetchEvaluation', 'fetchAuthoritySteps']);
  const [found] = ofType(authority, AuthorityScreen);
  expect((found?.props as { steps: unknown[] }).steps).toHaveLength(1);
  expect(ofType(authority, OwnTenderDetailScreen)).toHaveLength(0);
});

it('an evaluator whose matrix read succeeds is still offered its award-approval decision from the inbox (PR 346 review 3, finding 1)', async () => {
  mockSession.current = signedInWith(['FLEET_MANAGER'], fixtures.EVALUATOR);
  mockAnswers.fetchEvaluation = { kind: 'OK', data: fixtures.EVALUATING_MATRIX };
  const step = {
    ...fixtures.AWARD_STEP,
    stepOrder: 1,
    authorityOrganizationId: ORG,
    authorityRole: 'FLEET_MANAGER',
    authorityLabel: 'بازبین (نمونه)',
    requestedAt: '2026-10-22T07:00:00.000Z',
    project: { title: 'بهسازی راه روستایی' },
  };
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: {
      items: [{ summary: step, detail: { kind: 'OK', data: step } }],
      truncated: false,
      resumeFrom: null,
      failure: null,
    },
  };
  const tree = await run('own');
  expect(mockFetched).toEqual(['fetchEvaluation', 'fetchAuthoritySteps']);
  expect(ofType(tree, OpeningOnlyScreen)).toHaveLength(1);
  expect(ofType(tree, EvaluationSection)).toHaveLength(1);
  const [inbox] = ofType(tree, AuthorityInboxSection);
  const steps = (inbox?.props as { steps: { commands: ReactNode }[] }).steps;
  // Reading the matrix makes nobody a participant: the decision is offered beside the scoring.
  expect(offered(steps.map(({ commands }) => commands))).toEqual(['GRANT_AWARD', 'REJECT_AWARD']);
  expect(offered(tree)).toEqual(['SCORE', 'QUALIFY', 'DISQUALIFY']);
  // One record restored after a reload is drawn once: in the evaluation's group, not again here.
  const restoring = elements(tree)
    .concat(elements(steps.map(({ commands }) => commands)))
    .filter(
      (e) => e.type === OwnerCommands && (e.props as { showsRestored?: boolean }).showsRestored,
    );
  expect(restoring).toHaveLength(1);
  // Every form on the page is the page's own, the decisions included.
  const ids = (restoring[0]?.props as { pageSubmissionIds: string[] }).pageSubmissionIds;
  expect(ids).toHaveLength(5);
});

it('an inbox page that fails is never an absence: what was found, the correlation id, and a retry from that page (PR 346 review 3, finding 2)', async () => {
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN'], fixtures.AWARD_APPROVER);
  const step = {
    ...fixtures.AWARD_STEP,
    stepOrder: 1,
    authorityOrganizationId: ORG,
    authorityLabel: 'بازبین (نمونه)',
    requestedAt: '2026-10-22T07:00:00.000Z',
    project: { title: 'بهسازی راه روستایی' },
  };
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: {
      items: [{ summary: step, detail: { kind: 'OK', data: step } }],
      truncated: false,
      resumeFrom: null,
      failure: { correlationId: 'corr-9', at: 'APR_NEXT' },
    },
  };
  const found = await run('own', undefined, { inbox: 'APR_FROM' });
  expect(ofType(found, OwnTenderDetailScreen)).toHaveLength(0);
  const [screen] = ofType(found, AuthorityScreen);
  expect(screen?.props).toMatchObject({
    failure: { correlationId: 'corr-9', retryHref: '/tenders/TND_1?view=own&inbox=APR_NEXT' },
    restartHref: '/tenders/TND_1?view=own',
  });
  expect((screen?.props as { steps: unknown[] }).steps).toHaveLength(1);
  // Nothing found before the very first page failed: still the failure, retried from the top.
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: {
      items: [],
      truncated: false,
      resumeFrom: null,
      failure: { correlationId: 'corr-9', at: null },
    },
  };
  const none = await run('own');
  expect(ofType(none, OwnTenderDetailScreen)).toHaveLength(0);
  const [failed] = ofType(none, AuthorityScreen);
  expect(failed?.props).toMatchObject({
    steps: [],
    failure: { correlationId: 'corr-9', retryHref: '/tenders/TND_1?view=own' },
    restartHref: null,
  });
});

it('an inbox longer than the walk is never an absence: the warning, and a way to go on and back (PR 346 review 2, finding 3)', async () => {
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN'], fixtures.AWARD_APPROVER);
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: { items: [], truncated: true, resumeFrom: 'APR_NEXT', failure: null },
  };
  const first = await run('own');
  expect(mockArgs.fetchAuthoritySteps?.[2]).toBeNull();
  expect(ofType(first, OwnTenderDetailScreen)).toHaveLength(0);
  const [screen] = ofType(first, AuthorityScreen);
  expect(screen?.props).toMatchObject({
    steps: [],
    truncated: true,
    continueHref: '/tenders/TND_1?view=own&inbox=APR_NEXT',
    restartHref: null,
  });
  // Going on: the walk resumes from the service's cursor; at its end the page still offers the
  // way back to the start rather than turning into the absence.
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: { items: [], truncated: false, resumeFrom: null, failure: null },
  };
  const next = await run('own', undefined, { inbox: 'APR_NEXT' });
  expect(mockArgs.fetchAuthoritySteps?.[2]).toBe('APR_NEXT');
  const [resumed] = ofType(next, AuthorityScreen);
  expect(resumed?.props).toMatchObject({
    truncated: false,
    continueHref: null,
    restartHref: '/tenders/TND_1?view=own',
  });
  // A cursor that is not the service's kind starts from the top.
  await run('own', undefined, { inbox: 'not a cursor' });
  expect(mockArgs.fetchAuthoritySteps?.[2]).toBeNull();
});

it('an approval authority of another organization decides its step of the tender without the tender read', async () => {
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN'], fixtures.AWARD_APPROVER);
  const step = {
    ...fixtures.AWARD_STEP,
    stepOrder: 1,
    authorityOrganizationId: ORG,
    authorityLabel: 'بازبین (نمونه)',
    requestedAt: '2026-10-22T07:00:00.000Z',
    project: { title: 'بهسازی راه روستایی' },
  };
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: {
      items: [{ summary: step, detail: { kind: 'OK', data: step } }],
      truncated: false,
      resumeFrom: null,
      failure: null,
    },
  };
  const tree = await run('own');
  expect(mockFetched).toEqual(['fetchTender', 'fetchAuthoritySteps']);
  expect(ofType(tree, AuthorityScreen)).toHaveLength(1);
  expect(ofType(tree, OwnTenderDetailScreen)).toHaveLength(0);
  const [authority] = ofType(tree, AuthorityScreen);
  const steps = (authority?.props as { steps: { commands: ReactNode }[] }).steps;
  expect(offered(steps.map(({ commands }) => commands))).toEqual(['GRANT_AWARD', 'REJECT_AWARD']);
  // Nobody's step of this tender in the inbox: the absence the tender read showed.
  mockFetched.length = 0;
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: { items: [], truncated: false, resumeFrom: null, failure: null },
  };
  const absent = await run('own');
  expect(ofType(absent, AuthorityScreen)).toHaveLength(0);
  const [screen] = ofType(absent, OwnTenderDetailScreen);
  expect((screen?.props as { result: unknown }).result).toEqual({ kind: 'NOT_FOUND' });
  // A decision on its last step whose answer was lost leaves the inbox empty: the session's record
  // and its set-aside are still drawn beside the absence (PR 346 review 4).
  expect(recoveries(absent)).toHaveLength(1);
});

it('the authority’s decision just made, its step gone from the inbox: the confirmation, only as minted for this session and tender', async () => {
  const session = signedInWith(['ORGANIZATION_ADMIN'], fixtures.AWARD_APPROVER);
  mockSession.current = session;
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: { items: [], truncated: false, resumeFrom: null, failure: null },
  };
  const done = await run('own', mintFlash(session as never, 'TND_1', 'GRANT_AWARD'));
  const [authority] = ofType(done, AuthorityScreen);
  expect((authority?.props as { steps: unknown[] }).steps).toEqual([]);
  expect(ofType(done, OwnerFlash).map((e) => (e.props as { done: unknown }).done)).toEqual([
    'GRANT_AWARD',
  ]);
  // Another tender's confirmation, or another session's, shows the absence the tender read showed.
  for (const flash of [
    mintFlash(session as never, 'TND_OTHER', 'GRANT_AWARD'),
    mintFlash({ ...session, csrfToken: 'another-session' } as never, 'TND_1', 'GRANT_AWARD'),
  ]) {
    const absent = await run('own', flash);
    expect(ofType(absent, AuthorityScreen)).toHaveLength(0);
    expect(ofType(absent, OwnTenderDetailScreen)).toHaveLength(1);
  }
});

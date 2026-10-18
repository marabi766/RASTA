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

/** The module as it is, with every `fetch*` read answered from `mockAnswers` and recorded. */
function mockStubFetchers(path: string): Record<string, unknown> {
  const actual = jest.requireActual(path) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.startsWith('fetch') && typeof value === 'function'
        ? async () => {
            mockFetched.push(name);
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
jest.mock('@/server/tender-evaluation', () => mockStubFetchers('@/server/tender-evaluation'));

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const TenderPage = (require('./[id]/page') as { default: Page }).default;
const { OwnerCommands } = require('./[id]/OwnerCommands') as typeof import('./[id]/OwnerCommands');
const { OpeningOnlyScreen } =
  require('./[id]/OwnerSections') as typeof import('./[id]/OwnerSections');
const { AwardSection, EvaluationSection } =
  require('./[id]/EvaluationSections') as typeof import('./[id]/EvaluationSections');
const { OwnTenderDetailScreen } =
  require('./[id]/TenderDetailScreen') as typeof import('./[id]/TenderDetailScreen');
const fixtures =
  require('@/test/evaluation-fixtures') as typeof import('@/test/evaluation-fixtures');
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

const offered = (tree: ReactNode): string[] =>
  ofType(tree, OwnerCommands).flatMap((element) =>
    (element.props as { offered: { command: string }[] }).offered.map(({ command }) => command),
  );

function run(view?: string): Promise<ReactElement> {
  return TenderPage({
    params: Promise.resolve({ id: 'TND_1' }),
    searchParams: Promise.resolve(view ? { view } : {}),
  });
}

beforeEach(() => {
  mockFetched.length = 0;
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
  expect(mockFetched).toEqual(['fetchEvaluation']);
  expect(ofType(tree, OpeningOnlyScreen)).toHaveLength(1);
  expect(ofType(tree, EvaluationSection)).toHaveLength(1);
  expect(offered(tree)).toEqual(['SCORE', 'QUALIFY', 'DISQUALIFY']);
  // Another organization's tender, or a missing one, is the absence the tender read would show.
  mockFetched.length = 0;
  delete mockAnswers.fetchEvaluation;
  const absent = await run('own');
  const [screen] = ofType(absent, OwnTenderDetailScreen);
  expect((screen?.props as { result: unknown }).result).toEqual({ kind: 'NOT_FOUND' });
});

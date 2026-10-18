/**
 * @jest-environment node
 */

/**
 * `/tenders/[id]` for an opener who may not read the tender (PR 345 review 1,
 * finding 4). construction-service gates `GET /v1/tenders/:id` by
 * `assertCanRead` and the opening and `GET …/bids` by `assertCanOpenBids`
 * alone, so a configured opening role — here `FLEET_MANAGER` in
 * `WEB_TENDER_OPEN_ROLES`, mirroring `CONSTRUCTION_TENDER_OPEN_ROLES` — opens
 * bids on a tender whose details it is refused. The page is run as the server
 * component it is, with the reads stubbed; what it offers is read off the
 * element tree it returns.
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  WEB_TENDER_OPEN_ROLES: 'FLEET_MANAGER',
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

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const TenderPage = (require('./[id]/page') as { default: Page }).default;
const { OwnerCommands } = require('./[id]/OwnerCommands') as typeof import('./[id]/OwnerCommands');
const { AuthorityInboxSection, AuthorityScreen } =
  require('./[id]/AuthoritySections') as typeof import('./[id]/AuthoritySections');
const { OpeningOnlyScreen, OwnerBidsSection } =
  require('./[id]/OwnerSections') as typeof import('./[id]/OwnerSections');
const { OwnTenderDetailScreen } =
  require('./[id]/TenderDetailScreen') as typeof import('./[id]/TenderDetailScreen');
const { OPENED_BIDS, UNOPENED_BIDS } =
  require('@/test/owner-fixtures') as typeof import('@/test/owner-fixtures');
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

it('an opening-only role reads only the bids — never the tender it is refused — and is offered the opening', async () => {
  mockSession.current = signedInWith(['FLEET_MANAGER']);
  mockAnswers.fetchOwnerBids = { kind: 'OK', data: UNOPENED_BIDS };
  for (const view of ['own', undefined]) {
    mockFetched.length = 0;
    const tree = await run(view);
    // Its approval inbox too, whatever the bids read (PR 346 review 3, finding 1).
    expect(mockFetched).toEqual(['fetchOwnerBids', 'fetchAuthoritySteps']);
    expect(ofType(tree, OpeningOnlyScreen)).toHaveLength(1);
    expect(ofType(tree, OwnTenderDetailScreen)).toHaveLength(0);
    expect(offered(tree)).toEqual(['PROPOSE_OPENING', 'OPEN_BIDS', 'WITHDRAW_PROPOSAL']);
    expect(ofType(tree, OwnerBidsSection)).toHaveLength(1);
  }
});

it('once the bids are opened it is shown them, and offered nothing', async () => {
  mockSession.current = signedInWith(['FLEET_MANAGER']);
  mockAnswers.fetchOwnerBids = { kind: 'OK', data: OPENED_BIDS };
  const tree = await run('own');
  expect(offered(tree)).toEqual([]);
  expect(ofType(tree, OwnerBidsSection)).toHaveLength(1);
});

it('another organization’s tender or a missing one is the absence the tender read would show', async () => {
  mockSession.current = signedInWith(['FLEET_MANAGER']);
  const tree = await run('own');
  // Refused the bids, it is looked for in the caller's approval inbox, which holds nothing of it.
  expect(mockFetched).toEqual(['fetchOwnerBids', 'fetchAuthoritySteps']);
  const [screen] = ofType(tree, OwnTenderDetailScreen);
  expect((screen?.props as { result: unknown }).result).toEqual({ kind: 'NOT_FOUND' });
  expect(offered(tree)).toEqual([]);
  // Beside the absence, the session's own lost command, if this browser holds one (PR 346 review 4).
  expect(recoveries(tree)).toHaveLength(1);
});

it('an approval authority of another organization whose role also opens bids reaches its step after the bids are refused (PR 346 review 2, finding 2)', async () => {
  mockSession.current = signedInWith(['FLEET_MANAGER'], 'USR-REVIEWER');
  const step = {
    id: 'APR_PUB_1',
    tenderId: 'TND_1',
    workflowKey: 'tender.publication',
    stepOrder: 1,
    status: 'PENDING',
    authorityOrganizationId: ORG,
    authorityRole: 'FLEET_MANAGER',
    authorityLabel: 'بازبین (نمونه)',
    requestedAt: '2026-10-22T07:00:00.000Z',
    version: 2,
    project: { title: 'بهسازی راه روستایی' },
    request: {
      requestId: 'TAR_PUB_1',
      tenderVersion: 4,
      status: 'PENDING',
      requestedBy: 'USR-AUTHOR',
      bid: null,
    },
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
  expect(mockFetched).toEqual(['fetchOwnerBids', 'fetchAuthoritySteps']);
  expect(ofType(tree, OwnTenderDetailScreen)).toHaveLength(0);
  const [authority] = ofType(tree, AuthorityScreen);
  const steps = (authority?.props as { steps: { commands: ReactNode }[] }).steps;
  expect(offered(steps.map(({ commands }) => commands))).toEqual(['GRANT', 'REJECT']);
  // A failure that is not a refusal stays the failure it was: no inbox is walked on it.
  mockFetched.length = 0;
  mockAnswers.fetchOwnerBids = { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' };
  const failed = await run('own');
  expect(mockFetched).toEqual(['fetchOwnerBids']);
  expect(ofType(failed, AuthorityScreen)).toHaveLength(0);
});

it('an opener whose bids read succeeds is given its publication decision from the inbox beside the opening, and an inbox failure beside it too (PR 346 review 3, findings 1 and 2)', async () => {
  mockSession.current = signedInWith(['FLEET_MANAGER'], 'USR-REVIEWER');
  mockAnswers.fetchOwnerBids = { kind: 'OK', data: UNOPENED_BIDS };
  const step = {
    id: 'APR_PUB_1',
    tenderId: 'TND_1',
    workflowKey: 'tender.publication',
    stepOrder: 1,
    status: 'PENDING',
    authorityOrganizationId: ORG,
    authorityRole: 'FLEET_MANAGER',
    authorityLabel: 'بازبین (نمونه)',
    requestedAt: '2026-10-22T07:00:00.000Z',
    version: 2,
    project: { title: 'بهسازی راه روستایی' },
    request: {
      requestId: 'TAR_PUB_1',
      tenderVersion: 4,
      status: 'PENDING',
      requestedBy: 'USR-AUTHOR',
      bid: null,
    },
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
  expect(mockFetched).toEqual(['fetchOwnerBids', 'fetchAuthoritySteps']);
  expect(ofType(tree, OpeningOnlyScreen)).toHaveLength(1);
  expect(offered(tree)).toEqual(['PROPOSE_OPENING', 'OPEN_BIDS', 'WITHDRAW_PROPOSAL']);
  const [inbox] = ofType(tree, AuthorityInboxSection);
  const steps = (inbox?.props as { steps: { commands: ReactNode }[] }).steps;
  expect(offered(steps.map(({ commands }) => commands))).toEqual(['GRANT', 'REJECT']);
  // The inbox failing beside a page that read: the bid side as it was, the failure with its retry.
  mockAnswers.fetchAuthoritySteps = {
    kind: 'OK',
    data: {
      items: [],
      truncated: false,
      resumeFrom: null,
      failure: { correlationId: 'corr-9', at: null },
    },
  };
  const failed = await run('own');
  expect(offered(failed)).toEqual(['PROPOSE_OPENING', 'OPEN_BIDS', 'WITHDRAW_PROPOSAL']);
  const [failure] = ofType(failed, AuthorityInboxSection);
  expect(failure?.props).toMatchObject({
    steps: [],
    failure: { correlationId: 'corr-9', retryHref: '/tenders/TND_1?view=own' },
  });
});

it('an owner who reads the tender keeps the owner’s page; a reader who does not open is not given the opening', async () => {
  // A tender refused to them is looked for in their approval inbox, never read another way.
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN']);
  await run('own');
  expect(mockFetched).toEqual(['fetchTender', 'fetchAuthoritySteps']);
  mockFetched.length = 0;
  mockSession.current = signedInWith(['FLEET_MANAGER', 'AUDITOR']);
  await run('own');
  expect(mockFetched).toEqual(['fetchTender', 'fetchAuthoritySteps']);
});

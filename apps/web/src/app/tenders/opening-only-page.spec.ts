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

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const TenderPage = (require('./[id]/page') as { default: Page }).default;
const { OwnerCommands } = require('./[id]/OwnerCommands') as typeof import('./[id]/OwnerCommands');
const { OpeningOnlyScreen, OwnerBidsSection } =
  require('./[id]/OwnerSections') as typeof import('./[id]/OwnerSections');
const { OwnTenderDetailScreen } =
  require('./[id]/TenderDetailScreen') as typeof import('./[id]/TenderDetailScreen');
const { OPENED_BIDS, UNOPENED_BIDS } =
  require('@/test/owner-fixtures') as typeof import('@/test/owner-fixtures');
/* eslint-enable @typescript-eslint/no-require-imports */

const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function signedInWith(roles: string[]) {
  return {
    subject: 'user-1',
    username: 'u',
    organizationId: ORG,
    accessToken: jwt({
      org_id: ORG,
      org_ids: [ORG],
      org_roles: roles.map((role) => `${ORG}:${role}`),
      rasta_uid: 'USR-1',
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

it('an opening-only role reads only the bids — never the tender it is refused — and is offered the opening', async () => {
  mockSession.current = signedInWith(['FLEET_MANAGER']);
  mockAnswers.fetchOwnerBids = { kind: 'OK', data: UNOPENED_BIDS };
  for (const view of ['own', undefined]) {
    mockFetched.length = 0;
    const tree = await run(view);
    expect(mockFetched).toEqual(['fetchOwnerBids']);
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
  expect(mockFetched).toEqual(['fetchOwnerBids']);
  const [screen] = ofType(tree, OwnTenderDetailScreen);
  expect((screen?.props as { result: unknown }).result).toEqual({ kind: 'NOT_FOUND' });
  expect(offered(tree)).toEqual([]);
});

it('an owner who reads the tender keeps the owner’s page; a reader who does not open is not given the opening', async () => {
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN']);
  await run('own');
  expect(mockFetched).toEqual(['fetchTender']);
  mockFetched.length = 0;
  mockSession.current = signedInWith(['FLEET_MANAGER', 'AUDITOR']);
  await run('own');
  expect(mockFetched).toEqual(['fetchTender']);
});

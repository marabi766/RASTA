/**
 * @jest-environment node
 */

/**
 * One organization per request, across a switch (PR 405 review 1, F1).
 *
 * The person signs in acting for A, switches to B elsewhere, and the next
 * request's refresh brings a token for B — run here through the real
 * `renewSession`, the real cookie seal and the real pages against a fake
 * gateway. What the pages are handed afterwards is what middleware hands the
 * render: the renewed cookie, opened.
 *
 * Before task 100 the refresh kept the login's `organizationId`, so the label
 * said A, the marketplace hid A's offers as "our own", and the organizations
 * page read A's profile beside B's members — while every request acted for B.
 */

import { isValidElement, type ReactElement } from 'react';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const mockSession = { current: null as unknown };

jest.mock('@/server/current-session', () => ({
  currentSession: async () => mockSession.current,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
jest.mock('@/app/marketplace/[productId]/place-order-actions', () => ({
  submitPlaceOrder: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const page = (path: string): Page => (require(path) as { default: Page }).default;
const { TopBar } = require('@/ui') as typeof import('@/ui');
const { OffersScreen } =
  require('./marketplace/[productId]/OffersScreen') as typeof import('./marketplace/[productId]/OffersScreen');
const { forgetSharedRefreshes, renewSession } =
  require('@/server/session-refresh') as typeof import('@/server/session-refresh');
const { openSession, sealSession } =
  require('@/server/session') as typeof import('@/server/session');
const { isBoundSubmissionId, mintSubmissionId, submissionBinding } =
  require('@/server/submission') as typeof import('@/server/submission');
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
/* eslint-enable @typescript-eslint/no-require-imports */

type WebSession = import('@/server/session').WebSession;

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
const A = 'ORG-DEH-0001';
const B = 'ORG-DEH-0002';
const ROLES = ['ORGANIZATION_ADMIN'];

/** Every request a page made: path and bearer. */
let asked: { path: string; authorization: string | null }[] = [];
let answer: (path: string) => { status: number; body?: unknown } = () => ({ status: 404 });
const originalFetch = globalThis.fetch;

beforeEach(() => {
  asked = [];
  answer = () => ({ status: 404, body: { code: 'NOT_FOUND' } });
  forgetSharedRefreshes();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const { status, body } = answer(url.pathname);
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const now = () => Math.floor(Date.now() / 1000);

/** Signed in acting for A, the access token about to run out. */
function signedInForA(): WebSession {
  return {
    subject: 'USR_1',
    username: 'admin',
    organizationId: A,
    accessToken: actingAccessToken(A, ROLES),
    accessTokenExpiresAt: now() + 30,
    refreshToken: 'refresh-a',
    csrfToken: 'csrf-of-this-login',
    issuedAt: now() - 600,
  };
}

/** The session the render reads after middleware refreshed A's into B's. */
async function refreshedIntoB(inA: WebSession): Promise<WebSession> {
  const renewal = await renewSession(sealSession(inA, SECRET), {
    env: {
      OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
      OIDC_CLIENT_ID: 'rasta-web',
      WEB_SESSION_SECRET: SECRET,
      WEB_SESSION_MAX_AGE_SECONDS: 43_200,
    },
    refresh: async () => ({
      access_token: actingAccessToken(B, ROLES),
      refresh_token: 'refresh-b',
      id_token: 'id-b',
      expires_in: 900,
      token_type: 'Bearer',
    }),
  });
  if (renewal.kind !== 'RENEWED') throw new Error(`expected a refresh, got ${renewal.kind}`);
  return openSession(renewal.sealed, SECRET)!;
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

const propsOf = (tree: ReactElement, type: unknown): Record<string, unknown> => {
  const found = elements(tree).filter((element) => element.type === type);
  expect(found).toHaveLength(1);
  return found[0]!.props as Record<string, unknown>;
};

const run = (path: string, params: Record<string, string> = {}) =>
  page(path)({ params: Promise.resolve(params), searchParams: Promise.resolve({}) });

const offer = (id: string, supplier: string) => ({
  id,
  productId: 'PRD_1',
  supplierOrganizationId: supplier,
  unitPriceMinor: '300000',
  currency: 'IRR',
  availableQuantity: 15,
  leadTimeDays: 5,
  minimumQuantity: 1,
  supplierQualification: 'UNAVAILABLE',
});
const PRODUCT = {
  id: 'PRD_1',
  sku: 'SKU-1',
  name: 'شیلنگ',
  description: null,
  category: 'PARTS',
  kind: 'GOOD',
  unit: 'عدد',
  offers: [],
};

let inA: WebSession;
let inB: WebSession;

beforeEach(async () => {
  inA = signedInForA();
  inB = await refreshedIntoB(inA);
  mockSession.current = inB;
});

it('the refreshed session acts for B, in its token and in its stored copy', () => {
  expect(inB.organizationId).toBe(B);
  expect(inB.accessToken).toBe(actingAccessToken(B, ROLES));
});

it.each([
  ['/drivers', './drivers/page', {}],
  ['/marketplace/[productId]', './marketplace/[productId]/page', { productId: 'PRD_1' }],
  ['/organizations', './organizations/page', {}],
  ['/wallet', './wallet/page', {}],
  ['/', './page', {}],
])('%s is labelled B, and keyed to B', async (_route, path, params) => {
  const tree = await run(path, params);
  expect(propsOf(tree, TopBar).organizationName).toBe(B);
  expect(tree.key).toBe(`organization:${B}`);
});

it('the marketplace’s self-order filter is B’s: A’s offer is orderable, B’s own is not', async () => {
  answer = (path) =>
    path === '/v1/products/PRD_1/offers'
      ? { status: 200, body: { items: [offer('OFR_A', A), offer('OFR_B', B)] } }
      : path === '/v1/products/PRD_1'
        ? { status: 200, body: PRODUCT }
        : path === '/v1/wallets/provider/disclosure'
          ? { status: 200, body: { simulated: false } }
          : { status: 404, body: { code: 'NOT_FOUND' } };

  const tree = await run('./marketplace/[productId]/page', { productId: 'PRD_1' });
  const ordering = propsOf(tree, OffersScreen).ordering as {
    organizationId: string;
    binding: { owner: string };
  };
  expect(ordering.organizationId).toBe(B);
  expect(ordering.binding.owner).toBe(submissionBinding(inB).owner);
  expect(ordering.binding.owner).not.toBe(submissionBinding(inA).owner);

  // What the screen offers to order, as drawn.
  const { renderToStaticMarkup } = jest.requireActual(
    'react-dom/server',
  ) as typeof import('react-dom/server');
  const html = renderToStaticMarkup(tree);
  expect(html).toMatch(/value="OFR_A"/);
  expect(html).not.toMatch(/value="OFR_B"/);
});

it('the organizations page reads B’s profile and B’s members, both with B’s token, and never A’s', async () => {
  answer = () => ({ status: 503 });
  await run('./organizations/page');
  const bearer = `Bearer ${inB.accessToken}`;
  expect(asked).toContainEqual({ path: `/v1/organizations/${B}`, authorization: bearer });
  expect(asked).toContainEqual({ path: '/v1/users', authorization: bearer });
  expect(asked.map(({ path }) => path)).not.toContain(`/v1/organizations/${A}`);
  expect(asked.every(({ authorization }) => authorization === bearer)).toBe(true);
});

it('a form drawn for A is refused in B; one drawn for B is accepted', () => {
  const drawnInA = mintSubmissionId(inA);
  expect(isBoundSubmissionId(drawnInA, inA)).toBe(true);
  expect(isBoundSubmissionId(drawnInA, inB)).toBe(false);
  expect(isBoundSubmissionId(mintSubmissionId(inB), inB)).toBe(true);
});

it('remembered submissions are tagged per organization: the same person, another owner and login tag', () => {
  const a = submissionBinding(inA);
  const b = submissionBinding(inB);
  expect(b.person).toBe(a.person);
  expect(b.owner).not.toBe(a.owner);
  expect(b.session).not.toBe(a.session);
});

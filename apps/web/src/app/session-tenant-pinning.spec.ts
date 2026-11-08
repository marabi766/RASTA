/**
 * @jest-environment node
 */

/**
 * Audit F2 (task 118): the portal's acting organization after a session refresh.
 *
 * The person signs in acting for A. The same account's active organization is
 * then switched to B elsewhere — another session, identity's API — and this
 * session's next refresh brings a token whose `org_id` is B. Run here through
 * the real `renewSession`, the real cookie seal, the real `readSession` /
 * `currentSession` (over a mocked `next/headers`), the real wallet page and the
 * real top-up action, against a fake gateway that resolves the organization
 * the way the platform's guard does (`resolveOrganization`,
 * `assertHoldsRoles`): the `X-Organization-Id` header if one is sent — refused
 * unless the token grants it a role — else the token's own `org_id`.
 *
 * Before this task the refreshed session sent no header, so every request
 * acted for B while the page said A (and, after task 100, the page said B
 * without anybody choosing it). Now the session stays A: every call names A,
 * a form drawn for A is sent for A, and when the token stops granting A the
 * session stops acting — it is never moved to B.
 */

import { isValidElement, type ReactElement } from 'react';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

/** The cookie the request carries, and the session state middleware forwarded. */
const jar = { cookie: undefined as string | undefined, state: null as string | null };

jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'rasta_session' && jar.cookie !== undefined ? { value: jar.cookie } : undefined,
  }),
  headers: async () =>
    new Headers(jar.state === null ? {} : { 'x-rasta-session-state': jar.state }),
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { TopBar } = require('@/ui') as typeof import('@/ui');
const { WalletScreen } = require('./wallet/WalletScreen') as typeof import('./wallet/WalletScreen');
const WalletPage = (require('./wallet/page') as { default: WalletPageFn }).default;
const HomePage = (require('./page') as { default: () => Promise<ReactElement> }).default;
const RecoveryPage = (
  require('./account/recovery/page') as { default: () => Promise<ReactElement> }
).default;
const NoOrganizationPage = (
  require('./account/no-organization/page') as { default: () => Promise<ReactElement> }
).default;
const { ORGANIZATION_LOST_TITLE, RECOVERY_TITLE } =
  require('./account/recovery/RecoveryScreen') as typeof import('./account/recovery/RecoveryScreen');
const { NO_ORGANIZATION_TITLE } =
  require('./account/no-organization/NoOrganizationScreen') as typeof import('./account/no-organization/NoOrganizationScreen');
const { submitTopUp } = require('./wallet/actions') as typeof import('./wallet/actions');
const { forgetSharedRefreshes, renewSession } =
  require('@/server/session-refresh') as typeof import('@/server/session-refresh');
const { openSession, sealSession } =
  require('@/server/session') as typeof import('@/server/session');
const { NoActingOrganization } =
  require('@/server/session-organization') as typeof import('@/server/session-organization');
const { fetchWallet } = require('@/server/wallet') as typeof import('@/server/wallet');
const { pageContext } = require('@/server/page-context') as typeof import('@/server/page-context');
const { CONTEXT_PARAM } = require('@/lib/page-context') as typeof import('@/lib/page-context');
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
/* eslint-enable @typescript-eslint/no-require-imports */

type WebSession = import('@/server/session').WebSession;
type WalletPageFn = (props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
const A = 'ORG-DEH-0001';
const B = 'ORG-DEH-0002';
const ADMIN = 'ORGANIZATION_ADMIN';
const now = () => Math.floor(Date.now() / 1000);

/** A token active in `active`, granting `grants` (organization → roles). */
function token(active: string | null, grants: Record<string, string[]>, jti = 'next'): string {
  return actingAccessToken(active, [ADMIN], {
    ...(active === null ? {} : { org_id: active }),
    org_ids: Object.keys(grants),
    org_roles: Object.entries(grants).flatMap(([org, roles]) => roles.map((r) => `${org}:${r}`)),
    jti,
  });
}

function claimsOf(accessToken: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8'));
}

// ---------------------------------------------------------------------------
// A gateway that decides the organization as the platform's guard does, and
// keeps the books the oracle reads: which wallets were opened, which were
// credited, under which key.
// ---------------------------------------------------------------------------

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly header: string | null;
  /** The organization the guard acted for; null: refused. */
  readonly actedFor: string | null;
  readonly key: string | null;
}

let sent: Sent[] = [];
/** Wallets opened, by organization (`GET /v1/wallets/me` opens one, economic wallet.controller). */
let opened: Set<string>;
/** Credits, by wallet, with the key they were sent under (a replay is not a second credit). */
let credits: Map<string, Set<string>>;
const originalFetch = globalThis.fetch;

function actedFor(accessToken: string, header: string | null): string | null {
  const claims = claimsOf(accessToken);
  const target = header ?? (typeof claims.org_id === 'string' ? claims.org_id : null);
  if (target === null) return null;
  const memberships = Array.isArray(claims.org_ids) ? claims.org_ids : [];
  const roles = Array.isArray(claims.org_roles) ? (claims.org_roles as string[]) : [];
  if (!memberships.includes(target)) return null;
  if (!roles.some((pair) => pair.startsWith(`${target}:`))) return null;
  return target;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  sent = [];
  opened = new Set();
  credits = new Map();
  jar.cookie = undefined;
  jar.state = null;
  forgetSharedRefreshes();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const bearer = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const header = headers.get('x-organization-id');
    const organization = actedFor(bearer, header);
    const method = init?.method ?? 'GET';
    sent.push({
      method,
      path: url.pathname,
      search: url.search,
      header,
      actedFor: organization,
      key: headers.get('idempotency-key'),
    });
    if (organization === null) return json(403, { code: 'TENANT_MISMATCH', message: 'refused' });
    const walletOf = (org: string) => `WAL_${org}`;
    if (method === 'GET' && url.pathname === '/v1/wallets/me') {
      opened.add(organization);
      return json(200, {
        id: walletOf(organization),
        organizationId: organization,
        currency: 'IRR',
        status: 'ACTIVE',
        ledgerBalanceMinor: '0',
        pendingBalanceMinor: '0',
        availableBalanceMinor: '0',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      });
    }
    if (method === 'GET' && /^\/v1\/wallets\/[^/]+\/holds$/.test(url.pathname)) {
      return json(200, { items: [] });
    }
    if (method === 'GET' && url.pathname === '/v1/transactions') {
      return json(200, { items: [], nextCursor: null, hasMore: false });
    }
    if (method === 'GET' && url.pathname === '/v1/wallets/provider') {
      return json(200, { provider: 'MOCK', simulated: true });
    }
    const topUp = /^\/v1\/wallets\/([^/]+)\/top-up$/.exec(url.pathname);
    if (method === 'POST' && topUp) {
      // economic-service's ownWallet: a wallet of another organization is a 404.
      if (topUp[1] !== walletOf(organization))
        return json(404, { code: 'NOT_FOUND', message: 'x' });
      const keys = credits.get(topUp[1]!) ?? new Set<string>();
      keys.add(headers.get('idempotency-key') ?? '');
      credits.set(topUp[1]!, keys);
      return json(201, {
        paymentIntentId: 'PIN_1',
        transactionId: 'TXN_1',
        status: 'CAPTURED',
        amountMinor: '50000',
        currency: 'IRR',
        provider: 'MOCK',
        simulated: true,
        failureReason: null,
      });
    }
    if (method === 'GET' && url.pathname === '/v1/users/me') {
      return json(200, {
        id: 'USR_1',
        username: 'admin',
        status: 'ACTIVE',
        activeOrganizationId: B,
        memberships: [],
      });
    }
    return json(404, { code: 'NOT_FOUND', message: 'x' });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Signed in acting for A, the access token about to run out. */
function signedInForA(overrides: Partial<WebSession> = {}): WebSession {
  return {
    subject: 'USR_1',
    username: 'admin',
    organizationId: A,
    accessToken: token(A, { [A]: [ADMIN] }, 'login'),
    accessTokenExpiresAt: now() + 30,
    refreshToken: 'refresh-a',
    csrfToken: 'csrf-of-this-login',
    issuedAt: now() - 600,
    ...overrides,
  };
}

/** What middleware does before the route: the real renewal, the cookie it writes. */
async function refreshWith(session: WebSession, next: string) {
  const renewal = await renewSession(sealSession(session, SECRET), {
    env: {
      OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
      OIDC_CLIENT_ID: 'rasta-web',
      WEB_SESSION_SECRET: SECRET,
      WEB_SESSION_MAX_AGE_SECONDS: 43_200,
    },
    refresh: async () => ({
      access_token: next,
      refresh_token: 'refresh-next',
      id_token: 'id-next',
      expires_in: 900,
      token_type: 'Bearer',
    }),
  });
  if (renewal.kind === 'RENEWED' || renewal.kind === 'ORGANIZATION_LOST') {
    jar.cookie = renewal.sealed;
  }
  return renewal;
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

const wallet = (query: Record<string, string> = {}) =>
  WalletPage({ searchParams: Promise.resolve(query) });

function topUpForm(csrf: string, submissionId: string): FormData {
  const form = new FormData();
  form.set('csrf', csrf);
  form.set('submission', submissionId);
  form.set('amountMinor', '50000');
  return form;
}

async function submit(walletId: string, form: FormData): Promise<unknown> {
  try {
    return await submitTopUp(walletId, { kind: 'IDLE' }, form);
  } catch (error) {
    return { thrown: String(error) };
  }
}

// ---------------------------------------------------------------------------

describe('a refresh after the account was switched to B elsewhere', () => {
  const switched = token(B, { [A]: [ADMIN], [B]: [ADMIN] });

  it('really holds a refreshed token active in B — and still acts for A', async () => {
    const before = signedInForA();
    const renewal = await refreshWith(before, switched);
    expect(renewal.kind).toBe('RENEWED');
    const session = openSession(jar.cookie!, SECRET)!;
    // The trigger: a token the provider minted after the switch, not the login's.
    expect(session.accessToken).not.toBe(before.accessToken);
    expect(claimsOf(session.accessToken).org_id).toBe(B);
    expect(session.refreshToken).toBe('refresh-next');
    // The session: still A.
    expect(session.organizationId).toBe(A);
  });

  it('the wallet page is A’s: labelled A, keyed A, and every read names A and is answered for A', async () => {
    await refreshWith(signedInForA(), switched);
    const tree = await wallet();
    expect(propsOf(tree, TopBar).organizationName).toBe(A);
    expect(tree.key).toBe(`organization:${A}`);
    const screen = propsOf(tree, WalletScreen) as {
      wallet: { kind: string; data?: { id: string } };
    };
    expect(screen.wallet).toMatchObject({ kind: 'OK', data: { id: `WAL_${A}` } });

    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.every(({ header, actedFor }) => header === A && actedFor === A)).toBe(true);
    // Oracle (addendum H): reading A's wallet opened no wallet in B.
    expect([...opened]).toEqual([A]);
  });

  it('a form drawn for A is sent for A, and its replay too — B’s wallet is never credited, never opened', async () => {
    await refreshWith(signedInForA(), switched);
    const tree = await wallet();
    const screen = propsOf(tree, WalletScreen) as { submissionId: string; csrfToken: string };
    const form = topUpForm(screen.csrfToken, screen.submissionId);

    expect(await submit(`WAL_${A}`, form)).toEqual({ thrown: 'Error: NEXT_REDIRECT:/wallet' });
    // The same submission again — a retry of the same form: the same key, for A.
    expect(await submit(`WAL_${A}`, form)).toEqual({ thrown: 'Error: NEXT_REDIRECT:/wallet' });

    const writes = sent.filter(({ method }) => method === 'POST');
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write).toMatchObject({
        path: `/v1/wallets/WAL_${A}/top-up`,
        header: A,
        actedFor: A,
        key: screen.submissionId,
      });
    }
    expect(sent.every(({ actedFor }) => actedFor === A)).toBe(true);
    expect([...credits.keys()]).toEqual([`WAL_${A}`]);
    expect(credits.get(`WAL_${A}`)).toEqual(new Set([screen.submissionId]));
    expect(credits.has(`WAL_${B}`)).toBe(false);
    expect(opened.has(B)).toBe(false);
  });

  it('home draws A and A’s roles — not B’s — and asks for the person’s own record naming A', async () => {
    await refreshWith(signedInForA(), token(B, { [A]: ['FLEET_MANAGER'], [B]: [ADMIN] }));
    const { renderToStaticMarkup } = jest.requireActual(
      'react-dom/server',
    ) as typeof import('react-dom/server');
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain('مدیر ناوگان');
    expect(html).not.toContain('مدیر سازمان');
    expect(sent).toEqual([expect.objectContaining({ path: '/v1/users/me', header: A })]);
  });
});

describe('a refresh whose token no longer grants A', () => {
  it.each([
    ['the membership in A was removed', token(B, { [B]: [ADMIN] })],
    ['every role in A was removed', token(B, { [A]: [], [B]: [ADMIN] })],
  ])(
    '%s: the session is recovered, never moved to B — no page, no write, nothing sent',
    async (_name, next) => {
      const before = signedInForA();
      // A form drawn for A before the refresh.
      jar.cookie = sealSession({ ...before, accessTokenExpiresAt: now() + 900 }, SECRET);
      const screen = propsOf(await wallet(), WalletScreen) as {
        submissionId: string;
        csrfToken: string;
      };
      sent = [];
      opened = new Set();

      expect((await refreshWith(before, next)).kind).toBe('ORGANIZATION_LOST');
      const session = openSession(jar.cookie!, SECRET)!;
      expect(session.organizationId).toBe(A);
      expect(claimsOf(session.accessToken).org_id).toBe(B);

      await expect(wallet()).rejects.toThrow('NEXT_REDIRECT:/login?returnTo=/wallet');
      expect(await submit(`WAL_${A}`, topUpForm(screen.csrfToken, screen.submissionId))).toEqual({
        kind: 'REFUSED',
        reason: 'NO_SESSION',
      });
      expect(sent).toEqual([]);
      expect(opened.size).toBe(0);

      // Where `/login` sends it: the explicit "your organization changed" page.
      const { renderToStaticMarkup } = jest.requireActual(
        'react-dom/server',
      ) as typeof import('react-dom/server');
      const html = renderToStaticMarkup(await RecoveryPage());
      expect(html).toContain(ORGANIZATION_LOST_TITLE);
      expect(html).not.toContain(RECOVERY_TITLE);
      expect(html).not.toContain(B);
      expect(sent).toEqual([]);
    },
  );
});

describe('a transient refresh failure keeps today’s behaviour and never falls back to B', () => {
  it('the cookie is left alone; the page still acts for A with the token it has', async () => {
    const before = signedInForA();
    jar.cookie = sealSession(before, SECRET);
    const renewal = await renewSession(jar.cookie, {
      env: {
        OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
        OIDC_CLIENT_ID: 'rasta-web',
        WEB_SESSION_SECRET: SECRET,
        WEB_SESSION_MAX_AGE_SECONDS: 43_200,
      },
      refresh: async () => {
        throw new (jest.requireActual('@/server/oidc') as typeof import('@/server/oidc')).OidcError(
          'TOKEN_REQUEST_FAILED',
          'the identity provider answered 503',
        );
      },
    });
    expect(renewal).toEqual({ kind: 'REFUSED', usable: true });
    await wallet();
    expect(sent.every(({ header, actedFor }) => header === A && actedFor === A)).toBe(true);
  });
});

describe('a form drawn for A, after the session acts for another organization (addendum D)', () => {
  it('is refused on the server before anything is sent', async () => {
    const inA = signedInForA({ accessTokenExpiresAt: now() + 900 });
    jar.cookie = sealSession(inA, SECRET);
    const screen = propsOf(await wallet(), WalletScreen) as {
      submissionId: string;
      csrfToken: string;
    };
    sent = [];
    // The same person, the same CSRF token, now pinned to B: only the organization differs.
    jar.cookie = sealSession(
      { ...inA, organizationId: B, accessToken: token(B, { [A]: [ADMIN], [B]: [ADMIN] }) },
      SECRET,
    );
    expect(await submit(`WAL_${A}`, topUpForm(screen.csrfToken, screen.submissionId))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(sent).toEqual([]);
  });

  it('a URL drawn for A — its cursor — is not read for B (addendum G)', async () => {
    const inA = signedInForA({ accessTokenExpiresAt: now() + 900 });
    const query = { cursor: 'CURSOR_OF_A', [CONTEXT_PARAM]: pageContext(inA) };
    jar.cookie = sealSession(inA, SECRET);
    await wallet(query);
    expect(sent.find(({ path }) => path === '/v1/transactions')?.search).toContain('CURSOR_OF_A');
    sent = [];
    jar.cookie = sealSession(
      { ...inA, organizationId: B, accessToken: token(B, { [B]: [ADMIN] }) },
      SECRET,
    );
    await wallet(query);
    const read = sent.find(({ path }) => path === '/v1/transactions');
    expect(read?.search ?? '').not.toContain('CURSOR_OF_A');
    expect(read?.header).toBe(B);
  });
});

describe('a session that acts for no organization (addendum B)', () => {
  /** Pinned to none at sign-in; the account was made active in B since. */
  const none = (): WebSession =>
    signedInForA({
      organizationId: null,
      accessToken: token(B, { [B]: [ADMIN] }),
      accessTokenExpiresAt: now() + 900,
    });

  it('sends no tenant read at all — never a header-less one the guard would answer for B', async () => {
    await expect(fetchWallet(none())).rejects.toThrow(NoActingOrganization);
    expect(sent).toEqual([]);
  });

  it('an action hidden from it by middleware answers NO_ORGANIZATION, nothing sent', async () => {
    // What `tenant-gate.ts` hands the action: no session, marked.
    jar.cookie = undefined;
    jar.state = 'no-organization';
    expect(await submit(`WAL_${B}`, topUpForm('csrf-of-this-login', 'sub_x'))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_ORGANIZATION',
    });
    expect(sent).toEqual([]);
  });

  it('its own pages still work: home reads the person’s record with no header, and says no organization', async () => {
    jar.cookie = sealSession(none(), SECRET);
    const { renderToStaticMarkup } = jest.requireActual(
      'react-dom/server',
    ) as typeof import('react-dom/server');
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain('انتخاب نشده');
    expect(sent).toEqual([expect.objectContaining({ path: '/v1/users/me', header: null })]);
    expect(renderToStaticMarkup(await NoOrganizationPage())).toContain(NO_ORGANIZATION_TITLE);
  });
});

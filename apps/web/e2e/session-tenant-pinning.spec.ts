import { randomUUID } from 'node:crypto';

import { decodeJwt } from 'jose';

import { expect, test, type APIRequestContext } from './expect';
import { installProvisionedSession, liveAccessToken } from './live-session';
import { provisionPerson, provisionedAccessToken } from './provisioned-people';
import { SESSION_COOKIE, openSession, type WebSession } from '../src/server/session';

/**
 * Audit F2 (task 118), through the live stack: one account, two sessions.
 *
 * A person is an organization administrator of A and of B, active in A.
 * Session 1 is the portal, signed in while A was active — so pinned to A. Session
 * 2 is the same account signed in again (a second password grant), which
 * switches the account's active organization to B through identity's own API.
 * Session 1's next request refreshes its tokens through the real realm; the
 * token it gets back is active in B. The scenario proves that trigger first —
 * it opens session 1's own cookie and reads the refreshed token — and only
 * then that session 1 still shows A and writes to A: its wallet read and its
 * top-up (and the top-up's replay) land in A's wallet, and B's wallet and
 * ledger are untouched.
 *
 * Before task 118 the portal sent no `X-Organization-Id`, so that same page
 * read — and opened — B's wallet and the top-up credited B.
 *
 * The two organizations are this run's own (`ORG-E2E-PIN-…`): no other spec
 * moves money in them, so "B unchanged" is exact. The person is provisioned
 * the way the platform provisions anyone (`provisioned-people.ts`).
 */

const RUN = randomUUID().slice(0, 8).toUpperCase();
const A = `ORG-E2E-PIN-A-${RUN}`;
const B = `ORG-E2E-PIN-B-${RUN}`;
const AMOUNT_MINOR = '73000';
const PROJECTION_WAIT_MS = 30_000;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`The live portal browser test requires ${name}`);
  return value;
}

const gatewayUrl = (path: string) => `${requiredEnv('API_GATEWAY_URL').replace(/\/+$/, '')}${path}`;

async function call<T>(
  request: APIRequestContext,
  token: string,
  method: 'get' | 'post',
  path: string,
  options: { organization?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await request[method](gatewayUrl(path), {
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.organization ? { 'x-organization-id': options.organization } : {}),
      ...(method === 'post' ? { 'idempotency-key': `e2e-pinning-${randomUUID()}` } : {}),
    },
    ...(options.body === undefined ? {} : { data: options.body }),
  });
  const text = await response.text();
  return { status: response.status(), body: (text ? JSON.parse(text) : undefined) as T };
}

interface WalletView {
  readonly id: string;
  readonly organizationId: string;
  readonly ledgerBalanceMinor: string;
  readonly pendingBalanceMinor: string;
  readonly availableBalanceMinor: string;
}

/** Until a fresh password grant for the person satisfies `ready` (Keycloak projection). */
async function untilToken(
  token: () => Promise<string>,
  ready: (claims: Record<string, unknown>) => boolean,
  what: string,
): Promise<string> {
  const deadline = Date.now() + PROJECTION_WAIT_MS;
  while (Date.now() < deadline) {
    const value = await token();
    if (ready(decodeJwt(value) as Record<string, unknown>)) return value;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`No token ${what} within ${PROJECTION_WAIT_MS} ms`);
}

/** Session 1's own cookie, opened with the portal's secret — what its next request will act with. */
async function sessionOf(context: import('./expect').BrowserContext): Promise<WebSession | null> {
  const cookie = (await context.cookies()).find((entry) => entry.name === SESSION_COOKIE);
  return cookie ? openSession(cookie.value, requiredEnv('WEB_SESSION_SECRET')) : null;
}

test.describe('a portal session pinned to A, the account switched to B elsewhere (audit F2)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'needs the live stack: identity, Keycloak, the gateway and economic-service',
  );

  test('session 1 refreshes into a token active in B — and still reads and writes A only', async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);

    // --- One account, administrator of A and of B, active in A. ----------------
    const systemAdmin = await liveAccessToken('systemAdmin');
    const person = await provisionPerson(systemAdmin, `e2e.pin.${RUN.toLowerCase()}.admin`, A, [
      'ORGANIZATION_ADMIN',
    ]);
    const added = await call(
      request,
      systemAdmin,
      'post',
      `/v1/users/${person.userId}/memberships`,
      {
        body: { organizationId: B, roles: ['ORGANIZATION_ADMIN'] },
      },
    );
    expect(added.status).toBe(201);
    await untilToken(
      () => provisionedAccessToken(person),
      (claims) =>
        claims.org_id === A &&
        Array.isArray(claims.org_ids) &&
        claims.org_ids.includes(B) &&
        Array.isArray(claims.org_roles) &&
        claims.org_roles.includes(`${B}:ORGANIZATION_ADMIN`),
      'listing the membership in B',
    );

    // --- Session 1: the portal, signed in while A is active. ------------------
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const signedIn = await installProvisionedSession(context, person, {
        refreshOnFirstRequest: true,
      });
      expect(signedIn.organizationId).toBe(A);
      expect((await sessionOf(context))?.organizationId).toBe(A);

      // --- Session 2: the same account, switching its active organization to B. ---
      const second = await provisionedAccessToken(person);
      const switched = await call<{ activeOrganizationId: string }>(
        request,
        second,
        'post',
        '/v1/users/me/active-organization',
        { body: { organizationId: B } },
      );
      expect(switched.status).toBe(200);
      expect(switched.body.activeOrganizationId).toBe(B);
      const activeInB = await untilToken(
        () => provisionedAccessToken(person),
        (claims) => claims.org_id === B,
        'active in B',
      );

      // --- The oracle's "before": both wallets, as their own organization sees them. ---
      const walletA = await call<WalletView>(request, activeInB, 'get', '/v1/wallets/me', {
        organization: A,
      });
      const walletB = await call<WalletView>(request, activeInB, 'get', '/v1/wallets/me', {
        organization: B,
      });
      expect(walletA.status).toBe(200);
      expect(walletB.status).toBe(200);
      expect(walletA.body.organizationId).toBe(A);
      expect(walletB.body.organizationId).toBe(B);
      expect(walletA.body.id).not.toBe(walletB.body.id);
      const ledgerOfB = async () => ({
        wallet: await call<WalletView>(
          request,
          activeInB,
          'get',
          `/v1/wallets/${walletB.body.id}`,
          {
            organization: B,
          },
        ),
        owed: await call<{ items: unknown[] }>(request, activeInB, 'get', '/v1/transactions', {
          organization: B,
        }),
        owedTo: await call<{ items: unknown[] }>(
          request,
          activeInB,
          'get',
          '/v1/transactions?includeIncoming=true',
          { organization: B },
        ),
      });
      const before = await ledgerOfB();
      expect(before.wallet.status).toBe(200);
      expect(before.owed.status).toBe(200);
      expect(before.owedTo.status).toBe(200);

      // --- Session 1's next request refreshes. Prove the trigger first (addendum I). ---
      await page.goto('/wallet');
      const refreshed = await sessionOf(context);
      expect(refreshed).not.toBeNull();
      expect(refreshed!.accessToken).not.toBe(signedIn.accessToken);
      expect(decodeJwt(refreshed!.accessToken).org_id).toBe(B);
      // ...and the session it refreshed is still pinned to A.
      expect(refreshed!.organizationId).toBe(A);

      // --- What session 1 shows and does: A's. ----------------------------------
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('کیف پول و تراکنش');
      // The top bar (the page has a second <header>, the page title's): its label is A.
      const topBar = page.locator('header').filter({ hasText: 'رستا' });
      await expect(topBar).toHaveCount(1);
      await expect(topBar).toContainText(A);
      await expect(topBar).not.toContainText(B);

      const form = page.locator('form').filter({ has: page.getByLabel('مبلغ (ریال)') });
      await form.getByLabel('مبلغ (ریال)').fill(AMOUNT_MINOR);
      const sent = page.waitForRequest(
        (entry) => entry.method() === 'POST' && entry.headers()['next-action'] !== undefined,
      );
      await form.getByRole('button', { name: 'افزایش موجودی نمایشی' }).click();
      const topUp = await sent;
      await expect
        .poll(
          async () =>
            (
              await call<WalletView>(request, activeInB, 'get', `/v1/wallets/${walletA.body.id}`, {
                organization: A,
              })
            ).body.ledgerBalanceMinor,
        )
        .toBe(String(BigInt(walletA.body.ledgerBalanceMinor) + BigInt(AMOUNT_MINOR)));

      // The same submission again — the form's own request, resent byte for byte with
      // session 1's cookie: a replay of the same key, which the portal sends for A again.
      // Its answer is the action's redirect or its page; the ledgers below are the oracle.
      const replayed = await request
        .post(topUp.url(), {
          headers: await topUp.allHeaders(),
          data: topUp.postDataBuffer() ?? '',
        })
        .then(
          (response) => response.status(),
          (error: unknown) => String(error),
        );
      expect(typeof replayed === 'number' ? replayed < 500 : /redirect/i.test(replayed)).toBe(true);

      const afterA = await call<WalletView>(
        request,
        activeInB,
        'get',
        `/v1/wallets/${walletA.body.id}`,
        { organization: A },
      );
      // Credited once, in A.
      expect(afterA.body.ledgerBalanceMinor).toBe(
        String(BigInt(walletA.body.ledgerBalanceMinor) + BigInt(AMOUNT_MINOR)),
      );

      // --- B: wallet and ledger exactly as before, replay included (addendum H). ---
      const after = await ledgerOfB();
      expect(after.wallet.body).toEqual(before.wallet.body);
      expect(after.owed.body).toEqual(before.owed.body);
      expect(after.owedTo.body).toEqual(before.owedTo.body);

      // And session 1 is still A after all of it.
      expect((await sessionOf(context))?.organizationId).toBe(A);
    } finally {
      await context.close();
    }
  });
});

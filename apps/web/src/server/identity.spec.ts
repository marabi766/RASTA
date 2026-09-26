/**
 * @jest-environment node
 */
import { activeMembership, displayName, fetchCurrentUser } from './identity';
import type { WebSession } from './session';

/**
 * What the portal keeps from identity-service, and what it drops.
 *
 * The dropping is the part worth testing. identity's view carries an email and
 * a phone number; neither is declared in this module's schema, so neither
 * survives parsing — and what does not survive parsing cannot reach a React
 * tree, which is serialized into the page (`docs/07 § 7.3`).
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'dehyar',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

const ENV = {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};

const IDENTITY_ANSWER = {
  id: 'USR_1',
  username: 'dehyar',
  email: 'dehyar@example.invalid',
  firstName: 'زهرا',
  lastName: 'محمدی',
  phone: '+989000000000',
  status: 'ACTIVE',
  activeOrganizationId: 'ORG_1',
  memberships: [{ organizationId: 'ORG_1', roles: ['FLEET_MANAGER'], status: 'ACTIVE' }],
  effectiveRoles: ['FLEET_MANAGER'],
};

function withFetch(handler: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

beforeEach(() => {
  Object.assign(process.env, ENV);
});

describe('reading the caller’s own record', () => {
  it('keeps the identifiers and the roles, and drops the contact details', async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify(IDENTITY_ANSWER), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
      async () => {
        const result = await fetchCurrentUser(SESSION);
        expect(result.kind).toBe('USER');
        if (result.kind !== 'USER') return;

        expect(result.user.effectiveRoles).toEqual(['FLEET_MANAGER']);
        const serialised = JSON.stringify(result.user);
        expect(serialised).not.toContain('dehyar@example.invalid');
        expect(serialised).not.toContain('+989000000000');
      },
    );
  });

  it('renders a refusal instead of throwing one', async () => {
    // A screen that threw on a 503 would replace a working shell with a
    // framework error page, and the person would lose the navigation they were
    // about to use.
    await withFetch((async () => new Response('{}', { status: 503 })) as typeof fetch, async () => {
      const result = await fetchCurrentUser(SESSION);
      expect(result.kind).toBe('UNAVAILABLE');
      if (result.kind === 'UNAVAILABLE') expect(result.status).toBe(503);
    });
  });

  it('refuses an answer that does not match the contract', async () => {
    await withFetch(
      (async () => new Response(JSON.stringify({ id: 'USR_1' }), { status: 200 })) as typeof fetch,
      async () => {
        expect((await fetchCurrentUser(SESSION)).kind).toBe('MALFORMED');
      },
    );
  });
});

describe('small presentation decisions', () => {
  it('prefers a full name and falls back to the username', () => {
    expect(displayName({ ...IDENTITY_ANSWER } as never)).toBe('زهرا محمدی');
    expect(displayName({ ...IDENTITY_ANSWER, firstName: '', lastName: '' } as never)).toBe(
      'dehyar',
    );
  });

  it('finds the membership for the organization being acted in', () => {
    expect(activeMembership({ ...IDENTITY_ANSWER } as never)?.organizationId).toBe('ORG_1');
    expect(
      activeMembership({ ...IDENTITY_ANSWER, activeOrganizationId: 'ORG_OTHER' } as never),
    ).toBeUndefined();
  });
});

describe('the membership organization name', () => {
  /**
   * `MembershipView.organizationName` is `string | null` on the service, and
   * `toMembershipView` sends `?? null` whenever the organization's name has
   * not replicated into identity yet. `.optional()` accepts `undefined` and
   * rejects `null`, so this legitimate, documented response came back
   * `MALFORMED` — the dashboard and `/organizations` both blank, with nothing
   * on screen able to explain why.
   */
  const answering = (membership: Record<string, unknown>) =>
    (async () =>
      new Response(JSON.stringify({ ...IDENTITY_ANSWER, memberships: [membership] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

  const base = { organizationId: 'ORG_1', roles: ['FLEET_MANAGER'], status: 'ACTIVE' };

  it('accepts an explicit null, which is what the service sends', async () => {
    await withFetch(answering({ ...base, organizationName: null }), async () => {
      const result = await fetchCurrentUser(SESSION);
      expect(result.kind).toBe('USER');
    });
  });

  it('keeps the name when there is one', async () => {
    await withFetch(answering({ ...base, organizationName: 'دهیاری نمونه' }), async () => {
      const result = await fetchCurrentUser(SESSION);
      expect(result.kind === 'USER' && result.user.memberships[0]?.organizationName).toBe(
        'دهیاری نمونه',
      );
    });
  });

  it('accepts the key being absent as well', async () => {
    await withFetch(answering(base), async () => {
      const result = await fetchCurrentUser(SESSION);
      expect(result.kind).toBe('USER');
    });
  });
});

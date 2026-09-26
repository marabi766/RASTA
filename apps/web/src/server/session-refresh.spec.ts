/**
 * @jest-environment node
 */
import { OidcError, type TokenResponse } from './oidc';
import {
  forgetSharedRefreshes,
  REJECTION_GRACE_MS,
  renewSession,
  type RenewalDependencies,
} from './session-refresh';
import type { RefreshCoordinator, RefreshOutcome } from './refresh-coordinator';
import { openSession, seal, sealSession, type WebSession } from './session';

/**
 * Keeping a session alive, and ending it on time (ADR-059 § 4).
 *
 * The two findings these tests hold shut: a refresh whose rotated token was
 * never written back, which signed a reader out every access-token lifetime
 * against a realm that refuses reuse; and a configured session lifetime that
 * nothing on the server enforced.
 */

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
const MAX_AGE = 12 * 60 * 60;
const T0 = 1_900_000_000; // seconds
const at = (seconds: number) => seconds * 1000;

const ENV: RenewalDependencies['env'] = {
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_SESSION_SECRET: SECRET,
  WEB_SESSION_MAX_AGE_SECONDS: MAX_AGE,
};

function session(overrides: Partial<WebSession> = {}): WebSession {
  return {
    subject: 'USR_01J8',
    username: 'dehyar',
    organizationId: 'ORG_01J8',
    accessToken: 'access-0',
    accessTokenExpiresAt: T0 + 900,
    refreshToken: 'refresh-0',
    csrfToken: 'csrf-token-value',
    issuedAt: T0,
    ...overrides,
  };
}

const sealed = (overrides: Partial<WebSession> = {}) => sealSession(session(overrides), SECRET);

/**
 * A token endpoint that behaves like the realm: every refresh token works
 * once (`revokeRefreshToken: true`, `refreshTokenMaxReuse: 0`), and a spent
 * one is refused.
 */
function rotatingProvider() {
  const spent = new Set<string>();
  let issued = 0;
  const calls: string[] = [];
  const refresh = async (refreshToken: string): Promise<TokenResponse> => {
    calls.push(refreshToken);
    if (spent.has(refreshToken)) {
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider answered 400');
    }
    spent.add(refreshToken);
    issued += 1;
    return {
      access_token: `access-${issued}`,
      refresh_token: `refresh-${issued}`,
      id_token: `id-${issued}`,
      expires_in: 900,
      token_type: 'Bearer',
    };
  };
  return { refresh, calls };
}

beforeEach(() => forgetSharedRefreshes());

describe('a session that needs nothing', () => {
  it('leaves a request with no cookie alone', async () => {
    expect(await renewSession(undefined, { env: ENV })).toEqual({ kind: 'NONE' });
  });

  it('leaves a fresh access token alone, and does not call the provider', async () => {
    const { refresh, calls } = rotatingProvider();
    expect(await renewSession(sealed(), { env: ENV, refresh, now: at(T0 + 60) })).toEqual({
      kind: 'VALID',
    });
    expect(calls).toEqual([]);
  });
});

describe('refreshing', () => {
  it('rotates the tokens and keeps everything else, the start of the session included', async () => {
    const { refresh, calls } = rotatingProvider();
    const now = at(T0 + 880); // inside the skew before the 900 s expiry
    const renewal = await renewSession(sealed(), { env: ENV, refresh, now });

    expect(calls).toEqual(['refresh-0']);
    expect(renewal.kind).toBe('RENEWED');
    if (renewal.kind !== 'RENEWED') return;

    const opened = openSession(renewal.sealed, SECRET)!;
    expect(opened).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: T0 + 880 + 900,
      csrfToken: 'csrf-token-value',
      subject: 'USR_01J8',
      issuedAt: T0,
    });
    // The cookie lives exactly as long as the session has left.
    expect(renewal.maxAgeSeconds).toBe(MAX_AGE - 880);
  });

  it('keeps a reader signed in across many access-token lifetimes against a realm that refuses reuse', async () => {
    // The regression: each "navigation" presents whatever cookie the last
    // one left behind. When the rotated token was not written back, the
    // second refresh presented a spent token and the session ended.
    const { refresh } = rotatingProvider();
    let cookie = sealed();
    for (let minute = 1; minute <= 8 * 60; minute += 5) {
      const renewal = await renewSession(cookie, { env: ENV, refresh, now: at(T0 + minute * 60) });
      expect(renewal.kind).not.toBe('ENDED');
      if (renewal.kind === 'RENEWED') cookie = renewal.sealed;
    }
    expect(openSession(cookie, SECRET)!.refreshToken).not.toBe('refresh-0');
  });

  it('shares one refresh among requests that present the same token at once', async () => {
    // A navigation and its prefetches arrive together with the same cookie.
    // Two refreshes of one token would spend it twice, and the second would
    // end a good session.
    const { refresh, calls } = rotatingProvider();
    const cookie = sealed();
    const now = at(T0 + 880);
    const [first, second] = await Promise.all([
      renewSession(cookie, { env: ENV, refresh, now }),
      renewSession(cookie, { env: ENV, refresh, now }),
    ]);

    expect(calls).toEqual(['refresh-0']);
    expect(first.kind).toBe('RENEWED');
    expect(second.kind).toBe('RENEWED');
    if (first.kind === 'RENEWED' && second.kind === 'RENEWED') {
      expect(openSession(second.sealed, SECRET)!.refreshToken).toBe(
        openSession(first.sealed, SECRET)!.refreshToken,
      );
    }
  });

  it('reports a refusal without ending the session — another replica may have rotated it', async () => {
    // Codex #113 R1-1: ending here raced the replica that won the refresh,
    // and response order decided whether the person stayed signed in.
    const refresh = async (): Promise<TokenResponse> => {
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider did not answer');
    };
    expect(await renewSession(sealed(), { env: ENV, refresh, now: at(T0 + 880) })).toEqual({
      kind: 'REFUSED',
      // 20 s of access token left: this request may still use it.
      usable: true,
    });
  });

  it('marks a refused session unusable once its access token has run out', async () => {
    const refresh = async (): Promise<TokenResponse> => {
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider answered 400');
    };
    expect(await renewSession(sealed(), { env: ENV, refresh, now: at(T0 + 900) })).toEqual({
      kind: 'REFUSED',
      usable: false,
    });
  });

  it('never ends a session for presenting a spent refresh token', async () => {
    const { refresh } = rotatingProvider();
    const cookie = sealed();
    await renewSession(cookie, { env: ENV, refresh, now: at(T0 + 880) });
    forgetSharedRefreshes(); // as if the second request reached another process

    const late = await renewSession(cookie, { env: ENV, refresh, now: at(T0 + 890) });
    expect(late.kind).toBe('REFUSED');
  });

  it('lets a failure that is not the provider’s propagate, rather than hiding a bug', async () => {
    const refresh = async (): Promise<TokenResponse> => {
      throw new TypeError('a bug');
    };
    await expect(renewSession(sealed(), { env: ENV, refresh, now: at(T0 + 880) })).rejects.toThrow(
      'a bug',
    );
  });
});

describe('a refused grant ends the session — after a grace (Codex #113 R2-2)', () => {
  const answering = (outcome: RefreshOutcome): RefreshCoordinator => ({
    refresh: async () => outcome,
  });
  const NOW = at(T0 + 880);

  it('keeps the cookie within the grace: a concurrent rotation may still land', async () => {
    const coordinator = answering({ kind: 'REJECTED', firstRejectedAt: NOW - 10_000 });
    expect(await renewSession(sealed(), { env: ENV, coordinator, now: NOW })).toEqual({
      kind: 'REFUSED',
      usable: true,
    });
  });

  it('ends the session once the grace has passed with no rotation of the token', async () => {
    const coordinator = answering({
      kind: 'REJECTED',
      firstRejectedAt: NOW - REJECTION_GRACE_MS,
    });
    expect(await renewSession(sealed(), { env: ENV, coordinator, now: NOW })).toEqual({
      kind: 'ENDED',
    });
  });

  it('never ends it for a transient failure, however long it lasts', async () => {
    // A timeout, a 5xx, a malformed body: nothing about the grant.
    const coordinator = answering({ kind: 'REFUSED' });
    const late = at(T0 + 6 * 60 * 60);
    expect(await renewSession(sealed(), { env: ENV, coordinator, now: late })).toEqual({
      kind: 'REFUSED',
      usable: false,
    });
  });

  it('ends a revoked session end to end, through the process coordinator', async () => {
    // The provider says invalid_grant every time; the rejection is remembered,
    // so a request past the grace ends the session instead of re-asking.
    const calls: string[] = [];
    const refresh = async (token: string): Promise<TokenResponse> => {
      calls.push(token);
      throw new OidcError('INVALID_GRANT', 'the identity provider refused the grant');
    };
    const cookie = sealed({ accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 30 });
    const first = await renewSession(cookie, { env: ENV, refresh, now: Date.now() });
    expect(first).toEqual({ kind: 'REFUSED', usable: true });

    const later = await renewSession(cookie, {
      env: ENV,
      refresh,
      now: Date.now() + REJECTION_GRACE_MS,
    });
    expect(later).toEqual({ kind: 'ENDED' });
    // The second answer came from the memory, not from asking again.
    expect(calls).toHaveLength(1);
  });
});

describe('the absolute lifetime, enforced on the server', () => {
  it('ends a session past WEB_SESSION_MAX_AGE_SECONDS, even with a working refresh token', async () => {
    const { refresh, calls } = rotatingProvider();
    const renewal = await renewSession(sealed(), {
      env: ENV,
      refresh,
      now: at(T0 + MAX_AGE),
    });
    expect(renewal).toEqual({ kind: 'ENDED' });
    // Not even asked: a session past its lifetime does not get new tokens.
    expect(calls).toEqual([]);
  });

  it('ends one past its lifetime even while its access token is still fresh', async () => {
    const cookie = sealed({ accessTokenExpiresAt: T0 + MAX_AGE + 900 });
    expect(await renewSession(cookie, { env: ENV, now: at(T0 + MAX_AGE + 1) })).toEqual({
      kind: 'ENDED',
    });
  });

  it('is not extended by refreshing', async () => {
    const { refresh } = rotatingProvider();
    let cookie = sealed();
    let minute = 0;
    let renewal: Awaited<ReturnType<typeof renewSession>> = { kind: 'VALID' };
    while (renewal.kind !== 'ENDED') {
      minute += 14;
      renewal = await renewSession(cookie, { env: ENV, refresh, now: at(T0 + minute * 60) });
      if (renewal.kind === 'RENEWED') cookie = renewal.sealed;
    }
    // Ends at the ceiling, measured from the login, however often it refreshed.
    expect(minute * 60).toBeGreaterThanOrEqual(MAX_AGE);
    expect(minute * 60).toBeLessThan(MAX_AGE + 14 * 60);
  });

  it('ends a cookie sealed before sessions carried their start', async () => {
    // Sealed with the generic `seal`, which does not validate, exactly as an
    // older build of this portal would have written it.
    const withoutStart: Partial<WebSession> = session();
    delete withoutStart.issuedAt;
    expect(await renewSession(seal(withoutStart, SECRET), { env: ENV, now: at(T0) })).toEqual({
      kind: 'ENDED',
    });
  });

  it('ends a cookie that does not open', async () => {
    expect(await renewSession('not-a-sealed-value', { env: ENV })).toEqual({ kind: 'ENDED' });
  });
});

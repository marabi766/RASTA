/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { middleware } from './middleware';
import { renewSession } from '@/server/session-refresh';
import { SESSION_COOKIE, sealSession } from '@/server/session';
import { REFRESH_UNAVAILABLE, SESSION_STATE_HEADER } from '@/server/session-state';

// Only the session wiring below reaches these: a request without a session
// cookie returns before the environment or the renewal is consulted, so the
// header tests run against the real code path.
jest.mock('@/server/session-refresh', () => ({ renewSession: jest.fn() }));
jest.mock('@/server/env', () => ({
  webServerEnv: () => ({
    WEB_COOKIE_SECURE: true,
    WEB_SESSION_SECRET: 'a-session-secret-that-is-long-enough-to-be-one',
    WEB_SESSION_MAX_AGE_SECONDS: 3600,
  }),
}));

const renew = renewSession as jest.MockedFunction<typeof renewSession>;

/** A request header as middleware hands it to the route (`NextResponse.next({ request })`). */
function forwardedHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

/**
 * The security headers this portal sends on every response (docs/09 §
 * 302-306, docs/16 § 356-368) — asserted directly on `middleware`'s output
 * rather than through a running server, the same way `gateway.spec.ts` asserts
 * on `callGateway` rather than through a browser.
 */

const ENV_KEYS = ['NODE_ENV', 'WEB_COOKIE_SECURE'] as const;

/**
 * `NODE_ENV` is typed read-only when indexed by its own literal name — Next's
 * own environment types — even though it is an ordinary writable env var at
 * runtime. Going through a plain `string` index rather than the literal union
 * sidesteps the readonly check without touching `process.env`'s real
 * `get`/`set` behaviour the way `Object.defineProperty` would (that defines a
 * plain shadow property instead, which is silently never read back by
 * `process.env.NODE_ENV`).
 */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

async function run(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  // Only the keys the caller actually overrides are touched — every other
  // test keeps whatever Jest's own environment already set for it.
  const touched = ENV_KEYS.filter((key) => key in overrides);
  const previous: Partial<Record<string, string | undefined>> = {};
  for (const key of touched) {
    previous[key] = process.env[key];
    setEnv(key, overrides[key]);
  }
  try {
    // Awaited inside the `try`: the middleware is async, and restoring the
    // environment before it has read it would test the wrong configuration.
    return await middleware(new NextRequest('http://localhost:3200/drivers'));
  } finally {
    for (const key of touched) setEnv(key, previous[key]);
  }
}

describe('the CSP', () => {
  it('is strict: no wildcard, no unsafe-inline, framing refused', async () => {
    const csp = (await run({ NODE_ENV: 'production' })).headers.get('Content-Security-Policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('*');
  });

  it('carries a nonce and strict-dynamic for scripts, so Next.js can still inject its own', async () => {
    const csp = (await run({ NODE_ENV: 'production' })).headers.get('Content-Security-Policy');
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  });

  it('allows unsafe-eval only in development, where Fast Refresh needs it', async () => {
    expect(
      (await run({ NODE_ENV: 'development' })).headers.get('Content-Security-Policy'),
    ).toContain('unsafe-eval');
    expect(
      (await run({ NODE_ENV: 'production' })).headers.get('Content-Security-Policy'),
    ).not.toContain('unsafe-eval');
  });

  it('mints a different nonce on every request', async () => {
    const first = (await run()).headers.get('Content-Security-Policy');
    const second = (await run()).headers.get('Content-Security-Policy');
    expect(first).not.toBe(second);
  });
});

describe('the other headers', () => {
  it('sets a referrer policy and refuses MIME sniffing', async () => {
    const response = await run();
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('upgrades insecure requests only for a deployment that terminates TLS', async () => {
    const csp = async (value: string) =>
      (await run({ WEB_COOKIE_SECURE: value })).headers.get('Content-Security-Policy') ?? '';
    expect(await csp('false')).not.toContain('upgrade-insecure-requests');
    expect(await csp('true')).toContain('upgrade-insecure-requests');
  });

  it('sends HSTS only for a deployment that terminates TLS', async () => {
    expect(
      (await run({ WEB_COOKIE_SECURE: 'false' })).headers.get('Strict-Transport-Security'),
    ).toBeNull();
    expect(
      (await run({ WEB_COOKIE_SECURE: 'true' })).headers.get('Strict-Transport-Security'),
    ).toContain('max-age=');
  });
});

describe('the session cookie, renewed before the route runs', () => {
  const withSession = (value: string) =>
    new NextRequest('http://localhost:3200/drivers', {
      headers: { cookie: `${SESSION_COOKIE}=${value}` },
    });

  beforeEach(() => renew.mockReset());

  it('does nothing, and asks nothing, for a request without a session', async () => {
    const response = await middleware(new NextRequest('http://localhost:3200/login'));
    expect(renew).not.toHaveBeenCalled();
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('writes a renewed session back to the browser, living no longer than the session', async () => {
    renew.mockResolvedValue({ kind: 'RENEWED', sealed: 'rotated-cookie', maxAgeSeconds: 1234 });

    const response = await middleware(withSession('spent-cookie'));

    expect(renew).toHaveBeenCalledWith('spent-cookie', expect.anything());
    const written = response.cookies.get(SESSION_COOKIE);
    expect(written?.value).toBe('rotated-cookie');
    expect(written?.maxAge).toBe(1234);
    expect(written?.httpOnly).toBe(true);
  });

  it('hands the render the rotated session in this same request, not the spent one', async () => {
    // The render reads the cookie it was sent; without this it would present
    // the spent refresh token, which the realm refuses.
    renew.mockResolvedValue({ kind: 'RENEWED', sealed: 'rotated-cookie', maxAgeSeconds: 60 });

    const response = await middleware(withSession('spent-cookie'));

    const forwarded = response.headers.get('x-middleware-request-cookie') ?? '';
    expect(forwarded).toContain(`${SESSION_COOKIE}=rotated-cookie`);
    expect(forwarded).not.toContain('spent-cookie');
  });

  it('clears an ended session from the browser and from the render', async () => {
    renew.mockResolvedValue({ kind: 'ENDED' });

    const response = await middleware(withSession('expired-cookie'));

    const cleared = response.cookies.get(SESSION_COOKIE);
    expect(cleared?.value).toBe('');
    expect(response.headers.get('x-middleware-request-cookie') ?? '').not.toContain(
      'expired-cookie',
    );
  });

  it('never touches the browser’s cookie on a refused refresh — another replica may be rotating it', async () => {
    // Codex #113 R1-1. Clearing here raced the replica that won the refresh:
    // whichever response arrived last decided whether the person stayed in.
    for (const usable of [true, false]) {
      renew.mockResolvedValue({ kind: 'REFUSED', usable });

      const response = await middleware(withSession('raced-cookie'));

      expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
      expect(response.headers.get('set-cookie') ?? '').not.toContain(SESSION_COOKIE);
    }
  });

  it('hides a refused session from the render once its access token has run out', async () => {
    // Otherwise `/login` (openable session → `/`) and `/` (expired → `/login`)
    // would bounce the person between them.
    renew.mockResolvedValue({ kind: 'REFUSED', usable: false });

    const response = await middleware(withSession('raced-cookie'));

    expect(response.headers.get('x-middleware-request-cookie') ?? '').not.toContain('raced-cookie');
  });

  it.each([false, true])(
    'marks every refused refresh as unavailable, not ended — usable: %s (PR 319 r2 f3, r3 f2)',
    async (usable) => {
      // usable: true too — the token can run out between that judgement and the
      // route's own check, and the route must then say "unavailable", not "ended".
      renew.mockResolvedValue({ kind: 'REFUSED', usable });

      const response = await middleware(withSession('raced-cookie'));

      expect(forwardedHeader(response, SESSION_STATE_HEADER)).toBe(REFRESH_UNAVAILABLE);
    },
  );

  it.each([
    { kind: 'ENDED' as const },
    { kind: 'VALID' as const },
    { kind: 'RENEWED' as const, sealed: 'rotated-cookie', maxAgeSeconds: 60 },
  ])('marks nothing for $kind', async (renewal) => {
    renew.mockResolvedValue(renewal);

    const response = await middleware(withSession('a-cookie'));

    expect(forwardedHeader(response, SESSION_STATE_HEADER)).toBeNull();
  });

  it('never forwards a session state the browser sent itself', async () => {
    renew.mockResolvedValue({ kind: 'ENDED' });
    const forged = new NextRequest('http://localhost:3200/auth/session', {
      headers: {
        cookie: `${SESSION_COOKIE}=expired-cookie`,
        [SESSION_STATE_HEADER]: REFRESH_UNAVAILABLE,
      },
    });

    const response = await middleware(forged);

    expect(forwardedHeader(response, SESSION_STATE_HEADER)).toBeNull();
    // Overridden, not merely left out: Next drops a request header missing
    // from the override list.
    expect(response.headers.get('x-middleware-override-headers') ?? '').not.toContain(
      SESSION_STATE_HEADER,
    );
  });

  it('lets the render keep a refused session whose access token is still good', async () => {
    renew.mockResolvedValue({ kind: 'REFUSED', usable: true });

    const response = await middleware(withSession('raced-cookie'));

    // The render reads the cookie exactly as the browser sent it.
    expect(response.headers.get('x-middleware-request-cookie')).toBe(
      `${SESSION_COOKIE}=raced-cookie`,
    );
  });

  it('leaves a valid session untouched', async () => {
    renew.mockResolvedValue({ kind: 'VALID' });

    const response = await middleware(withSession('good-cookie'));

    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
});

describe('what is refused before the body is read (ADR-069)', () => {
  const post = (path: string, headers: Record<string, string>) =>
    new NextRequest(`http://localhost:3200${path}`, { method: 'POST', headers });

  beforeEach(() => renew.mockReset());

  it('refuses a Server Action POST without a session: 401, and no refresh is attempted', async () => {
    const response = await middleware(
      post('/drivers', { 'next-action': 'abc', 'content-length': '300' }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'NO_SESSION' });
    expect(renew).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses a cookie it cannot open, however well-formed it looks', async () => {
    const response = await middleware(
      post('/drivers', {
        'next-action': 'abc',
        'content-length': '300',
        cookie: `${SESSION_COOKIE}=forged`,
      }),
    );
    expect(response.status).toBe(401);
    expect(renew).not.toHaveBeenCalled();
  });

  it('refuses the place-order action of a session that has expired: 401 JSON, never the action', async () => {
    // The path a retry of an unresolved order takes after the session ends
    // (`place-order-recovery.spec.tsx` shows what the form does with it).
    const expired = sealSession(
      {
        subject: 'USR_1',
        username: 'buyer',
        organizationId: 'ORG_1',
        accessToken: 'access-token-value',
        accessTokenExpiresAt: 2_000_000_000,
        refreshToken: 'refresh-token-value',
        csrfToken: 'csrf-token-value',
        issuedAt: 1_000,
      },
      'a-session-secret-that-is-long-enough-to-be-one',
    );
    const response = await middleware(
      post('/marketplace/PRD_1', {
        'next-action': 'abc',
        'content-length': '300',
        cookie: `${SESSION_COOKIE}=${expired}`,
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(await response.json()).toEqual({ code: 'NO_SESSION' });
    expect(renew).not.toHaveBeenCalled();
  });

  it('refuses an oversize body anywhere but the asset page: 413', async () => {
    const response = await middleware(
      post('/drivers', { 'next-action': 'abc', 'content-length': String(26 * 1024 * 1024) }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: 'BODY_TOO_LARGE' });
  });

  it('does not refuse a large body on the asset page on size grounds (it still needs a session)', async () => {
    const response = await middleware(
      post('/assets/9f1c', { 'next-action': 'abc', 'content-length': String(26 * 1024 * 1024) }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'NO_SESSION' });
  });

  it('leaves a signed-out page view alone', async () => {
    const response = await middleware(new NextRequest('http://localhost:3200/login'));
    expect(response.status).toBe(200);
  });
});

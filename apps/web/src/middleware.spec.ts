/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { middleware } from './middleware';
import { renewSession } from '@/server/session-refresh';
import { SESSION_COOKIE } from '@/server/session';

// Only the session wiring below reaches these: a request without a session
// cookie returns before the environment or the renewal is consulted, so the
// header tests run against the real code path.
jest.mock('@/server/session-refresh', () => ({ renewSession: jest.fn() }));
jest.mock('@/server/env', () => ({
  webServerEnv: () => ({ WEB_COOKIE_SECURE: true }),
}));

const renew = renewSession as jest.MockedFunction<typeof renewSession>;

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

  it('leaves a valid session untouched', async () => {
    renew.mockResolvedValue({ kind: 'VALID' });

    const response = await middleware(withSession('good-cookie'));

    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
});

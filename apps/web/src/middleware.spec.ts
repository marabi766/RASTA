/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { middleware } from './middleware';

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

function run(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  // Only the keys the caller actually overrides are touched — every other
  // test keeps whatever Jest's own environment already set for it.
  const touched = ENV_KEYS.filter((key) => key in overrides);
  const previous: Partial<Record<string, string | undefined>> = {};
  for (const key of touched) {
    previous[key] = process.env[key];
    setEnv(key, overrides[key]);
  }
  try {
    return middleware(new NextRequest('http://localhost:3200/drivers'));
  } finally {
    for (const key of touched) setEnv(key, previous[key]);
  }
}

describe('the CSP', () => {
  it('is strict: no wildcard, no unsafe-inline, framing refused', () => {
    const csp = run({ NODE_ENV: 'production' }).headers.get('Content-Security-Policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('*');
  });

  it('carries a nonce and strict-dynamic for scripts, so Next.js can still inject its own', () => {
    const csp = run({ NODE_ENV: 'production' }).headers.get('Content-Security-Policy');
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  });

  it('allows unsafe-eval only in development, where Fast Refresh needs it', () => {
    expect(run({ NODE_ENV: 'development' }).headers.get('Content-Security-Policy')).toContain(
      'unsafe-eval',
    );
    expect(run({ NODE_ENV: 'production' }).headers.get('Content-Security-Policy')).not.toContain(
      'unsafe-eval',
    );
  });

  it('mints a different nonce on every request', () => {
    const first = run().headers.get('Content-Security-Policy');
    const second = run().headers.get('Content-Security-Policy');
    expect(first).not.toBe(second);
  });
});

describe('the other headers', () => {
  it('sets a referrer policy and refuses MIME sniffing', () => {
    const response = run();
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('sends HSTS only for a deployment that terminates TLS', () => {
    expect(run({ WEB_COOKIE_SECURE: 'false' }).headers.get('Strict-Transport-Security')).toBeNull();
    expect(run({ WEB_COOKIE_SECURE: 'true' }).headers.get('Strict-Transport-Security')).toContain(
      'max-age=',
    );
  });
});

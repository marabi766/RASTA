import {
  DEFAULT_REQUEST_MAX_BYTES,
  refuseBeforeBody,
  requestMaxBytes,
  takesDocuments,
  type GateInput,
} from './request-gate';
import { sealSession, type WebSession } from './session';

const SECRET = 'a-session-secret-that-is-long-enough-to-be-one';
const MAX_AGE = 3600;
const NOW = 1_800_000_000_000;

const session: WebSession = {
  subject: 'user-1',
  username: 'manager',
  organizationId: 'org-1',
  accessToken: 'access',
  accessTokenExpiresAt: Math.floor(NOW / 1000) + 600,
  refreshToken: 'refresh',
  csrfToken: 'csrf',
  issuedAt: Math.floor(NOW / 1000) - 60,
};

function gate(overrides: {
  method?: string;
  pathname?: string;
  headers?: Record<string, string>;
  sessionCookie?: string;
  maxBytesRaw?: string;
}): ReturnType<typeof refuseBeforeBody> {
  const headers = new Headers(overrides.headers);
  const input: GateInput = {
    method: overrides.method ?? 'POST',
    pathname: overrides.pathname ?? '/drivers',
    headers,
    sessionCookie: overrides.sessionCookie,
    maxBytesRaw: overrides.maxBytesRaw,
    sessionConfig: () => ({ secret: SECRET, maxAgeSeconds: MAX_AGE }),
    now: NOW,
  };
  return refuseBeforeBody(input);
}

describe('an action without a session is refused before its body is read', () => {
  const action = { 'next-action': 'abc123', 'content-length': '500' };

  it('refuses a Next-Action POST with no cookie: 401', () => {
    expect(gate({ headers: action })).toEqual({ status: 401, code: 'NO_SESSION' });
  });

  it('refuses a cookie the server cannot open (forged, or sealed with another key)', () => {
    expect(gate({ headers: action, sessionCookie: 'not-a-sealed-session' })).toEqual({
      status: 401,
      code: 'NO_SESSION',
    });
    const other = sealSession(session, 'another-secret-that-is-also-long-enough-xx');
    expect(gate({ headers: action, sessionCookie: other })?.status).toBe(401);
  });

  it('refuses a session past its absolute lifetime', () => {
    const old = sealSession({ ...session, issuedAt: Math.floor(NOW / 1000) - MAX_AGE - 1 }, SECRET);
    expect(gate({ headers: action, sessionCookie: old })?.status).toBe(401);
  });

  it('lets an action through with a session this server can open', () => {
    expect(gate({ headers: action, sessionCookie: sealSession(session, SECRET) })).toBeNull();
  });

  it('asks nothing of the environment for a request that is not an action', () => {
    const input: GateInput = {
      method: 'GET',
      pathname: '/login',
      headers: new Headers(),
      sessionCookie: undefined,
      maxBytesRaw: undefined,
      sessionConfig: () => {
        throw new Error('the environment must not be read');
      },
    };
    expect(refuseBeforeBody(input)).toBeNull();
  });

  it('does not treat a plain form POST (no Next-Action) as an action', () => {
    expect(gate({ headers: { 'content-length': '10' } })).toBeNull();
  });
});

describe('the body ceiling, for every path but the document page', () => {
  it('refuses a declared Content-Length above the ceiling: 413', () => {
    expect(gate({ headers: { 'content-length': String(DEFAULT_REQUEST_MAX_BYTES + 1) } })).toEqual({
      status: 413,
      code: 'BODY_TOO_LARGE',
    });
  });

  it('admits a body exactly at the ceiling', () => {
    expect(gate({ headers: { 'content-length': String(DEFAULT_REQUEST_MAX_BYTES) } })).toBeNull();
  });

  it('refuses a Content-Length that is not a number', () => {
    expect(gate({ headers: { 'content-length': '12abc' } })?.status).toBe(413);
  });

  it('refuses a body with no declared length: 411 — the ceiling is not a header to leave out', () => {
    expect(gate({ headers: { 'transfer-encoding': 'chunked' } })).toEqual({
      status: 411,
      code: 'LENGTH_REQUIRED',
    });
  });

  it('applies to an action POST as well, ahead of the session check', () => {
    expect(
      gate({
        headers: { 'next-action': 'x', 'content-length': String(27 * 1024 * 1024) },
      })?.status,
    ).toBe(413);
  });

  it('never looks at a GET', () => {
    expect(gate({ method: 'GET', headers: { 'content-length': '99999999' } })).toBeNull();
  });

  it('exempts the asset page — and only it — from the ceiling', () => {
    const big = { 'content-length': String(26 * 1024 * 1024), 'transfer-encoding': 'chunked' };
    expect(gate({ pathname: '/assets/9f1c', headers: big })).toBeNull();
    expect(gate({ pathname: '/assets/9f1c/', headers: big })).toBeNull();
    for (const pathname of [
      '/assets',
      '/assets/9f1c/edit',
      '/assets/9f1c/documents',
      '/drivers/9f1c',
    ]) {
      expect(gate({ pathname, headers: { 'content-length': big['content-length'] } })?.status).toBe(
        413,
      );
    }
  });

  it('still wants a session on the asset page for an action', () => {
    expect(
      gate({
        pathname: '/assets/9f1c',
        headers: { 'next-action': 'x', 'content-length': String(26 * 1024 * 1024) },
      })?.status,
    ).toBe(401);
  });

  it('honours a configured ceiling', () => {
    const headers = { 'content-length': String(200 * 1024) };
    expect(gate({ headers })).toBeNull();
    expect(gate({ headers, maxBytesRaw: String(100 * 1024) })?.status).toBe(413);
  });
});

describe('requestMaxBytes', () => {
  it('defaults to 1 MiB and falls back on anything that is not a sane whole number', () => {
    expect(requestMaxBytes(undefined)).toBe(1024 * 1024);
    for (const raw of ['', '  ', 'abc', '-5', '1.5', '10', String(26 * 1024 * 1024), '1e6']) {
      expect(requestMaxBytes(raw)).toBe(1024 * 1024);
    }
  });

  it('accepts a number in range', () => {
    expect(requestMaxBytes('262144')).toBe(262144);
  });
});

describe('takesDocuments', () => {
  it('is exactly /assets/<id>', () => {
    expect(takesDocuments('/assets/abc')).toBe(true);
    expect(takesDocuments('/assets')).toBe(false);
    expect(takesDocuments('/assets/abc/x')).toBe(false);
    expect(takesDocuments('/xassets/abc')).toBe(false);
  });
});

/**
 * @jest-environment node
 */

/**
 * PR 405 review 2, F2: a URL's query is one organization's state. The class,
 * closed at one boundary (`server/page-context.ts`) and kept closed by the
 * guards below: no page reads its query but through `pageParams`, which hands
 * over nothing unless the URL was drawn for the organization the session acts
 * for; and every URL the portal draws with a query is bound to it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { pageContext, pageHref, pageParams } =
  require('./page-context') as typeof import('./page-context');
const { CONTEXT_PARAM, contextHref, withContext } =
  require('@/lib/page-context') as typeof import('@/lib/page-context');
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
/* eslint-enable @typescript-eslint/no-require-imports */

type WebSession = import('./session').WebSession;

const A = 'ORG-DEH-0001';
const B = 'ORG-DEH-0002';

function sessionFor(organizationId: string | null, subject = 'USR_1'): WebSession {
  return {
    subject,
    username: 'u',
    organizationId,
    accessToken: actingAccessToken(organizationId),
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'r',
    csrfToken: 'one-login',
    issuedAt: 1_900_000_000,
  };
}

const inA = sessionFor(A);
const inB = sessionFor(B);

describe('the boundary', () => {
  const drawnInA = { cursor: 'DRV_ZZZZ', warehouse: 'WHS_1', flash: 'token', [CONTEXT_PARAM]: '' };

  it('hands a page its query when the URL was drawn for the organization it acts for', async () => {
    const query = { ...drawnInA, [CONTEXT_PARAM]: pageContext(inA) };
    expect(await pageParams(inA, Promise.resolve(query))).toEqual({
      cursor: 'DRV_ZZZZ',
      warehouse: 'WHS_1',
      flash: 'token',
    });
  });

  it.each([
    ['drawn for another organization', () => pageContext(inA)],
    ['with no tag', () => undefined],
    ['with a tag that is not one', () => 'x'.repeat(16)],
    ['with the tag twice', () => [pageContext(inB), pageContext(inB)]],
  ])(
    'hands it nothing for a URL %s: every cursor, filter and confirmation reset before any read',
    async (_label, tag) => {
      const query = { ...drawnInA, [CONTEXT_PARAM]: tag() };
      expect(await pageParams(inB, Promise.resolve(query))).toEqual({});
    },
  );

  it('is the organization’s tag, not the person’s: a link shared within it keeps its filters', () => {
    expect(pageContext(sessionFor(A, 'USR_2'))).toBe(pageContext(inA));
    expect(pageContext(inB)).not.toBe(pageContext(inA));
    expect(pageContext(sessionFor(null))).not.toBe(pageContext(inA));
    // A keyed digest: it does not name the organization.
    expect(pageContext(inA)).not.toContain(A);
  });

  it('refuses a session whose organization cannot be told — before anything is read', async () => {
    const untold = { ...inA, accessToken: actingAccessToken(A, []) };
    expect(() => pageContext(untold)).toThrow();
    await expect(pageParams(untold, Promise.resolve({}))).rejects.toThrow();
  });

  it('binds every URL it draws, and leaves a bare path bare', () => {
    expect(pageHref(inA, '/drivers')).toBe('/drivers');
    expect(pageHref(inA, '/drivers', { cursor: undefined, q: '' })).toBe('/drivers');
    expect(pageHref(inA, '/drivers', { cursor: 'C1' })).toBe(
      `/drivers?cursor=C1&${CONTEXT_PARAM}=${pageContext(inA)}`,
    );
    expect(contextHref('T', '/maintenance#report', { assetId: 'AST_1' })).toBe(
      `/maintenance?assetId=AST_1&${CONTEXT_PARAM}=T#report`,
    );
    expect(withContext('T', '/tenders/TND_1?view=open')).toBe(
      `/tenders/TND_1?view=open&${CONTEXT_PARAM}=T`,
    );
    // A tag already there is replaced, never doubled; a query of the tag alone is no query.
    expect(withContext('T', `/x?a=1&${CONTEXT_PARAM}=OLD`)).toBe(`/x?a=1&${CONTEXT_PARAM}=T`);
    expect(withContext('T', `/x?${CONTEXT_PARAM}=OLD`)).toBe('/x');
    expect(withContext('T', '/x')).toBe('/x');
  });
});

/** Every source file of the app, by path relative to `src/`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
  });
}
const SRC = join(__dirname, '..');
const files = sources(SRC).map((path) => ({
  file: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

describe('no page reads its query but through the boundary', () => {
  /** Pages with no tenant state in their query: no session to bind it to. */
  const UNBOUND = new Set(['app/login/page.tsx', 'app/account/recovery/page.tsx']);
  const pages = files.filter(({ file }) => file.endsWith('page.tsx') && !UNBOUND.has(file));

  it('every page with a query reads it with `pageParams(session, searchParams)` and nothing else', () => {
    const readers = pages.filter(({ text }) => /\bsearchParams\b/.test(text));
    expect(readers.length).toBeGreaterThanOrEqual(27);
    for (const { file, text } of readers) {
      const uses = text.match(/\bsearchParams\b/g)?.length ?? 0;
      // The prop itself (destructured, typed) and the one hand-over.
      const handed = text.match(/pageParams\(session, searchParams\)/g)?.length ?? 0;
      expect({ file, handed }).toEqual({ file, handed: 1 });
      expect({
        file,
        direct: /await searchParams\b|searchParams\.then|use\(searchParams\)/.test(text),
      }).toEqual({
        file,
        direct: false,
      });
      expect({ file, uses }).toEqual({ file, uses: 3 });
    }
  });

  it('the guard itself sees a direct read', () => {
    expect(/await searchParams\b/.test('const params = await searchParams;')).toBe(true);
  });
});

describe('every URL the portal draws with a query is bound', () => {
  /**
   * URLs with no tenant state of a page: the sign-in flow, the provider's
   * endpoints, and the gateway's API (`/v1/…`), which the service scopes itself.
   */
  const UNBOUND_URL = /\/login\?|\/auth\/login\?|returnTo=|error=|https?:\/\/|[`'"]\/v1\//;
  /** A path with a query, written as a string or a template: `/x?a=`, `/x/${id}?a=`, `${base}?a=`. */
  const QUERY_URL = /[`'"](?:\/[^`'"\s?]*|\$\{\w+\})\?[\w${}[\]]+=/;
  const COMMENT = /^\s*(\*|\/\/)/;
  const BOUND = /withContext\(|pageHref\(|contextHref\(|flashHref\(/;

  const app = files.filter(({ file }) => file.startsWith('app/') || file.startsWith('server/'));

  it('builds no query URL outside the context helpers', () => {
    const unbound: string[] = [];
    for (const { file, text } of app) {
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (COMMENT.test(line) || !QUERY_URL.test(line) || UNBOUND_URL.test(line)) return;
        // The helper may open the call a few lines up (a long argument list).
        const around = lines.slice(Math.max(0, index - 4), index + 1).join('\n');
        if (!BOUND.test(around)) unbound.push(`${file}:${index + 1}`);
      });
    }
    expect(unbound).toEqual([]);
  });

  it('every link builder of a page that assembles a query binds what it returns', () => {
    // `server/` builds the gateway's URLs, which the service scopes itself; pages and screens are in `app/`.
    const unbound = files
      .filter(({ file }) => file.startsWith('app/'))
      .filter(({ text }) => /new URLSearchParams\(/.test(text) && !BOUND.test(text))
      .map(({ file }) => file);
    expect(unbound).toEqual([]);
  });

  it('every GET form carries the tag', () => {
    const unbound = app
      .filter(
        ({ text }) =>
          (text.match(/method="get"/g)?.length ?? 0) >
          (text.match(/<ContextField\b/g)?.length ?? 0),
      )
      .map(({ file }) => file);
    expect(unbound).toEqual([]);
  });

  it('the guards themselves see an unbound URL', () => {
    expect(QUERY_URL.test("redirect('/organizations?saved=profile');")).toBe(true);
    expect(QUERY_URL.test('`/tenders/${id}?view=open`')).toBe(true);
    expect(QUERY_URL.test('`${back}?${RELEASE_PARAM}=${outcome}`')).toBe(true);
    expect(QUERY_URL.test('`/drivers/${encodeURIComponent(id)}?created=1`')).toBe(true);
    expect(QUERY_URL.test('`/x/${id}?${FLASH_PARAM}=${flash}`')).toBe(true);
    expect(UNBOUND_URL.test("read(session, '/v1/drivers?limit=100')")).toBe(true);
    expect(QUERY_URL.test("href={'/drivers'}")).toBe(false);
  });
});

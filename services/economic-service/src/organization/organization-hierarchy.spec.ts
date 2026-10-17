import { InternalTokenService, runWithContext, type RequestContext } from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OrganizationHierarchy } from './organization-hierarchy';

/**
 * The consumer side of the hierarchy contract (docs/24 Q-136): the real
 * `OrganizationHierarchy` HTTP client against a server that answers as
 * organization-service's provider test proves it does
 * (`services/organization-service/test/construction-hierarchy-contract.int-spec.ts`,
 * which covers economic-service as a caller):
 *
 *   X-Internal-Token from economic-service, for organization-service,
 *   signed for the union; GET /v1/organizations/{id}
 *     id is the union, or beneath it → 200 { id, hierarchyVersion }
 *     otherwise                      → 404 { code: 'NOT_FOUND', message: 'Organization not found' }
 *
 * The server verifies the token with the real verifier, so a client that sent
 * the wrong audience, caller, purpose or organization would fail here. Then
 * every way the answer can go wrong is shown to refuse — fail closed: only
 * that 200 is "within", only that 404 is "not within", and everything else is
 * 503/504, never either.
 */

const SECRET = randomBytes(24).toString('hex');
const tokens = new InternalTokenService(SECRET, 'rasta-internal', 300);

/** union → county → dehyari; stranger stands alone. */
const PARENT: Record<string, string> = {
  'ORG-COUNTY': 'ORG-UNION',
  'ORG-DEHYARI': 'ORG-COUNTY',
};

function within(scope: string, id: string): boolean {
  for (let current: string | undefined = id; current; current = PARENT[current]) {
    if (current === scope) return true;
  }
  return false;
}

const VERSION: Record<string, number> = { 'ORG-DEHYARI': 7, 'ORG-COUNTY': 3 };

type Behaviour =
  | 'contract'
  | 'error'
  | 'wrong-body'
  | 'slow'
  | 'stalled-body'
  | 'oversized'
  | 'no-version'
  | 'bad-version'
  | 'html-404'
  | 'empty-404'
  | 'route-404';

const organizationNotFound = (path: string) => ({
  code: 'NOT_FOUND',
  message: 'Organization not found',
  correlationId: 'corr-hierarchy',
  timestamp: new Date().toISOString(),
  path,
});

describe('OrganizationHierarchy against the organization-service contract', () => {
  let server: Server;
  let behaviour: Behaviour = 'contract';
  let baseUrl: string;
  const seen: { path: string; token: string | undefined; correlationId: string | undefined }[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const token = req.headers['x-internal-token'] as string | undefined;
        seen.push({
          path: req.url ?? '',
          token,
          correlationId: req.headers['x-correlation-id'] as string | undefined,
        });
        if (behaviour === 'slow') return; // never answers
        if (behaviour === 'stalled-body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"id":');
          return;
        }
        if (behaviour === 'oversized') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ id: 'ORG-DEHYARI', hierarchyVersion: 7, pad: 'x'.repeat(4096) }),
          );
          return;
        }
        if (behaviour === 'error') {
          res.writeHead(503).end();
          return;
        }
        if (behaviour === 'html-404') {
          res.writeHead(404, { 'content-type': 'text/html' });
          res.end('<html><body><h1>404 Not Found</h1>nginx</body></html>');
          return;
        }
        if (behaviour === 'empty-404') {
          res.writeHead(404).end();
          return;
        }
        if (behaviour === 'route-404') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ...organizationNotFound(req.url ?? ''),
              message: `Cannot GET ${req.url ?? ''}`,
            }),
          );
          return;
        }
        const id = decodeURIComponent((req.url ?? '').replace('/v1/organizations/', ''));
        if (behaviour === 'wrong-body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'ORG-SOMETHING-ELSE', hierarchyVersion: 1 }));
          return;
        }
        const claims = await tokens.verify(token ?? '', 'organization-service').catch(() => null);
        if (
          !claims ||
          claims.callerService !== 'economic-service' ||
          claims.purpose !== 'SERVICE' ||
          !claims.organizationId
        ) {
          res.writeHead(403).end();
          return;
        }
        if (!within(claims.organizationId, id)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify(organizationNotFound(req.url ?? '')));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        const version =
          behaviour === 'no-version'
            ? undefined
            : behaviour === 'bad-version'
              ? '7'
              : (VERSION[id] ?? 1);
        res.end(JSON.stringify({ id, hierarchyVersion: version }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    behaviour = 'contract';
    seen.length = 0;
  });

  const hierarchy = (url = baseUrl, timeoutMs = 500) =>
    new OrganizationHierarchy({ baseUrl: url, timeoutMs, tokens });

  const asked = <T>(fn: () => Promise<T>) =>
    runWithContext(
      {
        requestId: 'r',
        correlationId: 'corr-hierarchy',
        authType: 'USER',
        organizationId: 'ORG-UNION',
        roles: ['UNION_ADMIN'],
        organizationIds: [],
        startedAt: Date.now(),
      } as RequestContext,
      fn,
    );

  it('answers within, with the version of the organization asked, two levels down, one, and the union itself', async () => {
    await expect(
      asked(() => hierarchy().withinVersion('ORG-UNION', 'ORG-DEHYARI')),
    ).resolves.toEqual({ hierarchyVersion: 7 });
    await expect(
      asked(() => hierarchy().withinVersion('ORG-UNION', 'ORG-COUNTY')),
    ).resolves.toEqual({ hierarchyVersion: 3 });
    await expect(asked(() => hierarchy().withinVersion('ORG-UNION', 'ORG-UNION'))).resolves.toEqual(
      { hierarchyVersion: 1 },
    );
  });

  it('answers "not within" for an organization outside the union, and upward', async () => {
    await expect(
      asked(() => hierarchy().withinVersion('ORG-UNION', 'ORG-STRANGER')),
    ).resolves.toBeNull();
    await expect(
      asked(() => hierarchy().withinVersion('ORG-DEHYARI', 'ORG-UNION')),
    ).resolves.toBeNull();
  });

  it('sends a token for organization-service, from economic-service, signed for the union', async () => {
    await asked(() => hierarchy().withinVersion('ORG-UNION', 'ORG-DEHYARI'));
    const [call] = seen;
    expect(call?.path).toBe('/v1/organizations/ORG-DEHYARI');
    expect(call?.correlationId).toBe('corr-hierarchy');
    await expect(tokens.verify(call!.token!, 'organization-service')).resolves.toMatchObject({
      callerService: 'economic-service',
      purpose: 'SERVICE',
      organizationId: 'ORG-UNION',
    });
  });

  it.each([
    ['another status', 'error'],
    ['a 200 that does not name the organization asked', 'wrong-body'],
    ['a 200 without a hierarchy version', 'no-version'],
    ['a 200 whose version is not a number', 'bad-version'],
    ['a body larger than the answer allows, even one naming the organization', 'oversized'],
    ['an HTML 404 from a proxy', 'html-404'],
    ['an empty 404', 'empty-404'],
    ['a route-level 404 (Nest’s `Cannot GET`)', 'route-404'],
  ] as const)('fails closed on %s: 503, never "within" or "not within"', async (_label, mode) => {
    behaviour = mode;
    await expect(
      asked(() => hierarchy().withinVersion('ORG-UNION', 'ORG-DEHYARI')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('fails closed on a timeout, and on a body that stalls — the deadline covers the read (504)', async () => {
    for (const mode of ['slow', 'stalled-body'] as const) {
      behaviour = mode;
      await expect(
        asked(() => hierarchy(baseUrl, 150).withinVersion('ORG-UNION', 'ORG-DEHYARI')),
      ).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    }
  });

  it('fails closed when organization-service cannot be reached (503)', async () => {
    await expect(
      asked(() => hierarchy('http://127.0.0.1:9').withinVersion('ORG-UNION', 'ORG-DEHYARI')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

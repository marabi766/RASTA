import { InternalTokenService, runWithContext, type RequestContext } from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OrganizationDirectory } from '../src/organization/organization-directory';
import { testEnv } from './helpers';

/**
 * The consumer side of the Q-70 (7) hierarchy contract: the real `OrganizationDirectory` HTTP
 * client against a server that answers exactly as organization-service's provider test proves it
 * does (`services/organization-service/test/construction-hierarchy-contract.int-spec.ts`, which
 * covers contract-service as a caller too):
 *
 *   X-Internal-Token from contract-service, for organization-service,
 *   signed for the scope organization; GET /v1/organizations/{id}
 *     id is the scope, or beneath it → 200 { id, hierarchyVersion }
 *     otherwise                      → 404 { code: 'NOT_FOUND', message: 'Organization not found' }
 *
 * Only that 404 is "not within". A 404 without that body — a proxy's HTML page, an empty body, a
 * route that is not mounted — proves nothing about the hierarchy and is refused as unavailable:
 * read as "outside", it would make the sweeper suspend a valid policy (contract audit F2).
 *
 * The server verifies the token with the real verifier, so a client that sent the wrong audience,
 * caller, purpose or organization would fail here. Then every way the answer can go wrong is shown
 * to refuse — fail closed.
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

/** The hierarchy version each organization is at (organization-service stamps it on a move). */
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
  | 'route-404'
  | 'oversized-404';

/** What organization-service's exception filter renders for `RastaError.notFound('Organization', id)`. */
const organizationNotFound = (path: string) => ({
  code: 'NOT_FOUND',
  message: 'Organization not found',
  correlationId: 'corr-directory',
  timestamp: new Date().toISOString(),
  path,
});

describe('OrganizationDirectory against the organization-service contract', () => {
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
          // Headers and half a body, then nothing: the deadline must cover the read.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"id":');
          return;
        }
        if (behaviour === 'oversized') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'ORG-DEHYARI', padding: 'x'.repeat(4096) }));
          return;
        }
        if (behaviour === 'error') {
          res.writeHead(500).end();
          return;
        }
        // 404s that are not organization-service's answer about an organization.
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
          // Nest's own 404 for a route that is not mounted: the same filter and code, another message.
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ...organizationNotFound(req.url ?? ''),
              message: `Cannot GET ${req.url ?? ''}`,
            }),
          );
          return;
        }
        if (behaviour === 'oversized-404') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ ...organizationNotFound(req.url ?? ''), padding: 'x'.repeat(4096) }),
          );
          return;
        }
        const id = decodeURIComponent((req.url ?? '').replace('/v1/organizations/', ''));
        if (behaviour === 'wrong-body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'ORG-SOMETHING-ELSE' }));
          return;
        }
        if (behaviour === 'bad-version') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id, hierarchyVersion: '7' }));
          return;
        }
        const claims = await tokens.verify(token ?? '', 'organization-service').catch(() => null);
        if (!claims || claims.callerService !== 'contract-service' || !claims.organizationId) {
          res.writeHead(403).end();
          return;
        }
        if (!within(claims.organizationId, id)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify(organizationNotFound(req.url ?? '')));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        // `no-version`: an organization-service from before hierarchy versions (D-050).
        res.end(
          JSON.stringify(
            behaviour === 'no-version' ? { id } : { id, hierarchyVersion: VERSION[id] ?? 1 },
          ),
        );
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

  const directory = (url = baseUrl, timeoutMs = '500') =>
    new OrganizationDirectory(
      testEnv({
        ORGANIZATION_SERVICE_URL: url,
        CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS: timeoutMs,
        INTERNAL_TOKEN_SECRET: SECRET,
      }),
      tokens,
    );

  const asked = <T>(fn: () => Promise<T>) =>
    runWithContext(
      {
        requestId: 'r',
        correlationId: 'corr-directory',
        authType: 'USER',
        roles: ['UNION_ADMIN'],
        startedAt: Date.now(),
      } as unknown as RequestContext,
      fn,
    );

  it('confirms a descendant two levels down, a child, and the scope itself', async () => {
    for (const id of ['ORG-DEHYARI', 'ORG-COUNTY', 'ORG-UNION']) {
      await expect(asked(() => directory().isWithin('ORG-UNION', id))).resolves.toBe(true);
    }
  });

  it('answers the hierarchy version of the organization asked, with "within" (D-050)', async () => {
    await expect(
      asked(() => directory().withinVersion('ORG-UNION', 'ORG-DEHYARI')),
    ).resolves.toEqual({ hierarchyVersion: 7 });
    await expect(
      asked(() => directory().withinVersion('ORG-UNION', 'ORG-COUNTY')),
    ).resolves.toEqual({ hierarchyVersion: 3 });
    // Outside the scope there is no version: not within.
    await expect(
      asked(() => directory().withinVersion('ORG-UNION', 'ORG-STRANGER')),
    ).resolves.toBeNull();
  });

  it('refuses "within" that arrives without a valid version when a version is needed (503), and still answers the plain question', async () => {
    for (const mode of ['no-version', 'bad-version'] as const) {
      behaviour = mode;
      await expect(
        asked(() => directory().withinVersion('ORG-UNION', 'ORG-DEHYARI')),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      // The policy commands ask only "within": a version is not needed for them.
      await expect(asked(() => directory().isWithin('ORG-UNION', 'ORG-DEHYARI'))).resolves.toBe(
        true,
      );
    }
  });

  it('answers false for an organization outside the scope, and upward', async () => {
    await expect(asked(() => directory().isWithin('ORG-UNION', 'ORG-STRANGER'))).resolves.toBe(
      false,
    );
    await expect(asked(() => directory().isWithin('ORG-DEHYARI', 'ORG-UNION'))).resolves.toBe(
      false,
    );
  });

  it('sends a token for organization-service, from contract-service, signed for the scope', async () => {
    await asked(() => directory().isWithin('ORG-UNION', 'ORG-DEHYARI'));
    const [call] = seen;
    expect(call?.path).toBe('/v1/organizations/ORG-DEHYARI');
    expect(call?.correlationId).toBe('corr-directory');
    const claims = await tokens.verify(call!.token!, 'organization-service');
    expect(claims).toMatchObject({
      callerService: 'contract-service',
      purpose: 'SERVICE',
      organizationId: 'ORG-UNION',
    });
  });

  it('reads "not within" only from organization-service’s own 404 body (F2)', async () => {
    // The genuine answer: the resource-level body, for every question that rests on it.
    await expect(asked(() => directory().isWithin('ORG-UNION', 'ORG-STRANGER'))).resolves.toBe(
      false,
    );
    await expect(
      asked(() => directory().withinAnswer('ORG-UNION', 'ORG-STRANGER')),
    ).resolves.toBeNull();
  });

  it.each([
    ['an HTML 404 from a proxy', 'html-404'],
    ['an empty 404', 'empty-404'],
    ['a route-level 404 (Nest’s `Cannot GET`)', 'route-404'],
    ['a 404 body larger than the answer allows', 'oversized-404'],
  ] as const)(
    'fails closed on %s: unavailable (503), never "outside" (F2)',
    async (_label, mode) => {
      behaviour = mode;
      // Each question a caller asks: the policy write's, the signature's and the sweeper's. None of
      // them may read this as "not within" — the sweeper would suspend a valid policy.
      const questions: (() => Promise<unknown>)[] = [
        () => directory().isWithin('ORG-UNION', 'ORG-STRANGER'),
        () => directory().withinVersion('ORG-UNION', 'ORG-STRANGER'),
        () => directory().withinAnswer('ORG-UNION', 'ORG-STRANGER'),
      ];
      for (const question of questions) {
        await expect(asked(question)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      }
    },
  );

  it('fails closed on any other status (503)', async () => {
    behaviour = 'error';
    await expect(
      asked(() => directory().isWithin('ORG-UNION', 'ORG-DEHYARI')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('fails closed on a 200 that does not name the organization asked', async () => {
    behaviour = 'wrong-body';
    await expect(
      asked(() => directory().isWithin('ORG-UNION', 'ORG-DEHYARI')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('fails closed on a timeout (504)', async () => {
    behaviour = 'slow';
    await expect(
      asked(() => directory(baseUrl, '150').isWithin('ORG-UNION', 'ORG-DEHYARI')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });

  it('fails closed on a 200 whose body stalls — the deadline covers the body read (504)', async () => {
    behaviour = 'stalled-body';
    await expect(
      asked(() => directory(baseUrl, '150').isWithin('ORG-UNION', 'ORG-DEHYARI')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });

  it('fails closed on a body larger than { id } allows, even one naming the organization (503)', async () => {
    behaviour = 'oversized';
    await expect(
      asked(() => directory().isWithin('ORG-UNION', 'ORG-DEHYARI')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('fails closed when organization-service cannot be reached (503)', async () => {
    await expect(
      asked(() => directory('http://127.0.0.1:9').isWithin('ORG-UNION', 'ORG-DEHYARI')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

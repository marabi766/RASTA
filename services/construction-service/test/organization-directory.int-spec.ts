import { InternalTokenService, runWithContext, type RequestContext } from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OrganizationDirectory } from '../src/organization/organization-directory';
import { testEnv } from './helpers';

/**
 * The consumer side of the Q-70 (7) hierarchy contract: the real
 * `OrganizationDirectory` HTTP client against a server that answers exactly
 * as organization-service's provider test proves it does
 * (`services/organization-service/test/construction-hierarchy-contract.int-spec.ts`):
 *
 *   X-Internal-Token from construction-service, for organization-service,
 *   signed for the scope organization; GET /v1/organizations/{id}
 *     id is the scope, or beneath it → 200 { id }
 *     otherwise                      → 404
 *
 * The server verifies the token with the real verifier, so a client that sent
 * the wrong audience, caller, purpose or organization would fail here. Then
 * every way the answer can go wrong is shown to refuse — fail closed.
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

type Behaviour = 'contract' | 'error' | 'wrong-body' | 'slow';

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
        if (behaviour === 'error') {
          res.writeHead(500).end();
          return;
        }
        const id = decodeURIComponent((req.url ?? '').replace('/v1/organizations/', ''));
        if (behaviour === 'wrong-body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'ORG-SOMETHING-ELSE' }));
          return;
        }
        const claims = await tokens.verify(token ?? '', 'organization-service').catch(() => null);
        if (!claims || claims.callerService !== 'construction-service' || !claims.organizationId) {
          res.writeHead(403).end();
          return;
        }
        if (!within(claims.organizationId, id)) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id }));
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
        ORGANIZATION_REQUEST_TIMEOUT_MS: timeoutMs,
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

  it('answers false for an organization outside the scope, and upward', async () => {
    await expect(asked(() => directory().isWithin('ORG-UNION', 'ORG-STRANGER'))).resolves.toBe(
      false,
    );
    await expect(asked(() => directory().isWithin('ORG-DEHYARI', 'ORG-UNION'))).resolves.toBe(
      false,
    );
  });

  it('sends a token for organization-service, from construction-service, signed for the scope', async () => {
    await asked(() => directory().isWithin('ORG-UNION', 'ORG-DEHYARI'));
    const [call] = seen;
    expect(call?.path).toBe('/v1/organizations/ORG-DEHYARI');
    expect(call?.correlationId).toBe('corr-directory');
    const claims = await tokens.verify(call!.token!, 'organization-service');
    expect(claims).toMatchObject({
      callerService: 'construction-service',
      purpose: 'SERVICE',
      organizationId: 'ORG-UNION',
    });
  });

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

  it('fails closed when organization-service cannot be reached (503)', async () => {
    await expect(
      asked(() => directory('http://127.0.0.1:9').isWithin('ORG-UNION', 'ORG-DEHYARI')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

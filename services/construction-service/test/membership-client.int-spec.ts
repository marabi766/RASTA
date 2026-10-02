import { InternalTokenService } from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MembershipClient } from '../src/tender/membership.client';
import { testEnv } from './helpers';

/**
 * The consumer side of identity-service's `GET /v1/users/{id}/organizations`: the real
 * `MembershipClient` against a server that answers as identity-service does (a
 * `construction-service` token for identity-service, signed for no tenant; 200
 * `{ userId, organizationIds, asOf }`). Every way the answer can go wrong refuses:
 * "could not confirm" is never "no conflict".
 */

const SECRET = randomBytes(24).toString('hex');
const tokens = new InternalTokenService(SECRET, 'rasta-internal', 300);

type Behaviour = 'contract' | 'error' | 'extra-field' | 'other-user' | 'slow' | 'text';

describe('MembershipClient against the identity-service contract', () => {
  let server: Server;
  let behaviour: Behaviour = 'contract';
  let baseUrl: string;
  const seen: {
    url: string;
    claims: { callerService?: string; organizationId?: string } | null;
  }[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const claims = await tokens
          .verify(String(req.headers['x-internal-token'] ?? ''), 'identity-service')
          .catch(() => null);
        seen.push({ url: req.url ?? '', claims });
        const userId = decodeURIComponent((req.url ?? '').split('?')[0]!.split('/')[3] ?? '');
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        if (!claims || claims.callerService !== 'construction-service' || claims.organizationId) {
          return send(403, { error: 'forbidden' });
        }
        const ok = { userId, organizationIds: ['ORG_A', 'ORG_B'], asOf: new Date().toISOString() };
        switch (behaviour) {
          case 'error':
            return send(500, { error: 'boom' });
          case 'extra-field':
            return send(200, { ...ok, email: 'someone@example.test' });
          case 'other-user':
            return send(200, { ...ok, userId: 'USR_SOMEONE_ELSE' });
          case 'text':
            return send(200, 'not json');
          case 'slow':
            return void setTimeout(() => send(200, ok), 1500);
          default:
            return send(200, ok);
        }
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    behaviour = 'contract';
    seen.length = 0;
  });

  const client = (timeoutMs = 5000) =>
    new MembershipClient(
      testEnv({
        IDENTITY_SERVICE_URL: baseUrl,
        CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS: String(timeoutMs),
      }),
      tokens,
    );

  it('reads a user’s organizations with a tenant-less construction-service token', async () => {
    expect(await client().fetchOrganizationIds('USR_ONE')).toEqual(['ORG_A', 'ORG_B']);
    expect(seen).toEqual([
      {
        url: '/v1/users/USR_ONE/organizations',
        claims: expect.objectContaining({ callerService: 'construction-service' }),
      },
    ]);
    expect(seen[0]!.claims!.organizationId).toBeUndefined();
  });

  it('asks for the memberships held at an instant with `at`', async () => {
    const at = new Date('2026-10-01T12:00:00.000Z');
    expect(await client().fetchOrganizationIdsAt('USR_ONE', at)).toEqual(['ORG_A', 'ORG_B']);
    expect(seen[0]!.url).toBe('/v1/users/USR_ONE/organizations?at=2026-10-01T12%3A00%3A00.000Z');
  });

  it.each<[Behaviour, string]>([
    ['error', 'a non-200'],
    ['extra-field', 'a body with a field outside the contract'],
    ['other-user', 'memberships of another user'],
    ['text', 'a body that is not JSON'],
  ])('refuses %s (%s): UPSTREAM_UNAVAILABLE', async (kind) => {
    behaviour = kind;
    await expect(client().fetchOrganizationIds('USR_ONE')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('refuses an answer that is too slow: UPSTREAM_TIMEOUT', async () => {
    behaviour = 'slow';
    await expect(client(200).fetchOrganizationIds('USR_ONE')).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });
});

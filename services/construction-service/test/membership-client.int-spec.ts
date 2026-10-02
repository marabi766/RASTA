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
 * `{ userId, memberships: [{ organizationId, roles }], asOf }`; with `?from=`, `{ userId,
 * organizationIds, asOf }`). Every way the answer can go wrong refuses:
 * "could not confirm" is never "no conflict".
 */

const SECRET = randomBytes(24).toString('hex');
const tokens = new InternalTokenService(SECRET, 'rasta-internal', 300);

type Behaviour = 'contract' | 'error' | 'extra-field' | 'ids-only' | 'other-user' | 'slow' | 'text';

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
        const asOf = '2026-10-02T10:00:00.000Z';
        const ok = (req.url ?? '').includes('?from=')
          ? { userId, organizationIds: ['ORG_A', 'ORG_B'], asOf }
          : {
              userId,
              memberships: [
                { organizationId: 'ORG_A', roles: ['ORGANIZATION_ADMIN'] },
                { organizationId: 'ORG_B', roles: ['OPERATOR', 'ORGANIZATION_ADMIN'] },
              ],
              asOf,
            };
        switch (behaviour) {
          case 'error':
            return send(500, { error: 'boom' });
          case 'extra-field':
            return send(200, { ...ok, email: 'someone@example.test' });
          case 'ids-only':
            return send(200, { userId, organizationIds: ['ORG_A'], asOf });
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

  it('reads a user’s live memberships and roles with a tenant-less construction-service token', async () => {
    expect(await client().fetchMemberships('USR_ONE')).toEqual({
      memberships: [
        { organizationId: 'ORG_A', roles: ['ORGANIZATION_ADMIN'] },
        { organizationId: 'ORG_B', roles: ['OPERATOR', 'ORGANIZATION_ADMIN'] },
      ],
      // identity-service's own clock as it answered: the start of the conflict window.
      asOf: new Date('2026-10-02T10:00:00.000Z'),
    });
    expect(seen).toEqual([
      {
        url: '/v1/users/USR_ONE/organizations',
        claims: expect.objectContaining({ callerService: 'construction-service' }),
      },
    ]);
    expect(seen[0]!.claims!.organizationId).toBeUndefined();
  });

  it('asks for the organizations held from an instant to identity-service’s own, with `from`', async () => {
    const from = new Date('2026-10-01T12:00:00.000Z');
    expect(await client().fetchOrganizationIdsSince('USR_ONE', from)).toEqual({
      organizationIds: ['ORG_A', 'ORG_B'],
      asOf: new Date('2026-10-02T10:00:00.000Z'),
    });
    expect(seen[0]!.url).toBe('/v1/users/USR_ONE/organizations?from=2026-10-01T12%3A00%3A00.000Z');
  });

  it.each<[Behaviour, string]>([
    ['error', 'a non-200'],
    ['extra-field', 'a body with a field outside the contract'],
    ['other-user', 'memberships of another user'],
    ['text', 'a body that is not JSON'],
  ])('refuses %s (%s): UPSTREAM_UNAVAILABLE', async (kind) => {
    behaviour = kind;
    await expect(client().fetchMemberships('USR_ONE')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    await expect(client().fetchOrganizationIdsSince('USR_ONE', new Date())).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('refuses the old shape of the live answer (ids only, no roles): the owner’s role cannot be confirmed', async () => {
    behaviour = 'ids-only';
    await expect(client().fetchMemberships('USR_ONE')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('refuses an answer that is too slow: UPSTREAM_TIMEOUT', async () => {
    behaviour = 'slow';
    await expect(client(200).fetchMemberships('USR_ONE')).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });
});

import { InternalTokenService } from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SupplierSnapshotClient } from '../src/tender/supplier-snapshot.client';
import { testEnv } from './helpers';

/**
 * The consumer side of the standing-snapshot contract (ADR-061 § 4): the real
 * `SupplierSnapshotClient` against a server that answers as supplier-service's own
 * test proves it does (`services/supplier-service/test/standing-snapshot.int-spec.ts`):
 *
 *   X-Internal-Token from construction-service, for supplier-service, signed for
 *   **no tenant**; GET /v1/suppliers/standing-snapshot?limit&cursor
 *     a token for a tenant, another caller, or none → 403 / 401
 *     otherwise → 200 { items, nextCursor, hasMore, snapshotAt }
 *
 * The server verifies the token with the real verifier. Then every way the answer
 * can go wrong is shown to refuse — fail closed.
 */

const SECRET = randomBytes(24).toString('hex');
const tokens = new InternalTokenService(SECRET, 'rasta-internal', 300);

type Behaviour =
  'contract' | 'error' | 'extra-field' | 'bad-instant' | 'slow' | 'oversized' | 'text';

const PAGE = {
  items: [
    {
      organizationId: 'ORG-A',
      contractingApprovedAt: '2026-03-01T08:00:00.000Z',
      suspensions: [
        {
          suspensionId: 'SUS-1',
          suspendedAt: '2026-04-01T08:00:00.000Z',
          reinstatedAt: null,
        },
      ],
    },
  ],
  nextCursor: 'SUP-9',
  hasMore: true,
  snapshotAt: '2026-10-01T09:00:00.000Z',
};

describe('SupplierSnapshotClient against the supplier-service contract', () => {
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
          .verify((req.headers['x-internal-token'] as string | undefined) ?? '', 'supplier-service')
          .catch(() => null);
        seen.push({ url: req.url ?? '', claims });
        if (behaviour === 'slow') return;
        if (behaviour === 'error') {
          res.writeHead(500).end();
          return;
        }
        if (!claims || claims.callerService !== 'construction-service' || claims.organizationId) {
          res.writeHead(403).end();
          return;
        }
        if (behaviour === 'oversized') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...PAGE, padding: 'x'.repeat(3 * 1024 * 1024) }));
          return;
        }
        if (behaviour === 'text') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('not json');
          return;
        }
        const body =
          behaviour === 'extra-field'
            ? { ...PAGE, items: [{ ...PAGE.items[0], reason: 'Suspended for a failed audit' }] }
            : behaviour === 'bad-instant'
              ? { ...PAGE, snapshotAt: 'yesterday' }
              : PAGE;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
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

  const client = (timeoutMs = '500') =>
    new SupplierSnapshotClient(
      testEnv({
        SUPPLIER_SERVICE_URL: baseUrl,
        CONSTRUCTION_SUPPLIER_REQUEST_TIMEOUT_MS: timeoutMs,
        INTERNAL_TOKEN_SECRET: SECRET,
      }),
      tokens,
    );

  it('reads a page with a service token for supplier-service that is signed for no tenant', async () => {
    const page = await client().fetchPage('SUP-1', 200);

    expect(page).toEqual(PAGE);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/v1/suppliers/standing-snapshot?limit=200&cursor=SUP-1');
    // Platform-wide: the signed claim names the caller and no organization.
    expect(seen[0]!.claims).toMatchObject({ callerService: 'construction-service' });
    expect(seen[0]!.claims!.organizationId).toBeUndefined();
  });

  it('starts without a cursor on the first page', async () => {
    await client().fetchPage(null, 50);
    expect(seen[0]!.url).toBe('/v1/suppliers/standing-snapshot?limit=50');
  });

  it.each([
    ['an error status', 'error'],
    ['a body with a field the contract does not have (a reason, say)', 'extra-field'],
    ['an instant that is not one', 'bad-instant'],
    ['a body that is not JSON', 'text'],
    ['a page over the size bound', 'oversized'],
  ] as [string, Behaviour][])(
    'refuses %s as unavailable, never as an empty or partial snapshot',
    async (_label, mode) => {
      behaviour = mode;
      await expect(client().fetchPage(null, 200)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    },
  );

  it('times out on a server that never answers', async () => {
    behaviour = 'slow';
    await expect(client('300').fetchPage(null, 200)).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });
});

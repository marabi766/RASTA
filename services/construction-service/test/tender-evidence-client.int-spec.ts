import { InternalTokenService } from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TenderEvidenceClient } from '../src/tender/tender-evidence.client';
import { genesisReceipt } from '../src/tender/sealing/sealing';
import { testEnv } from './helpers';

/**
 * The consumer side of the tender-evidence contract (ADR-066 § 2): the real
 * `TenderEvidenceClient` against a server that answers as audit-service's own test
 * proves it does (`services/audit-service/test/tender-evidence.int-spec.ts`):
 *
 *   X-Internal-Token from construction-service, for audit-service, signed for **no
 *   tenant**; GET /v1/internal/tender-evidence/{tenderId}/chain
 *     any other caller, or a tenant-signed token → 403
 *     otherwise → 200 { tenderId, genesis, head, links }
 *
 * The server verifies the token with the real verifier. Then every way the answer can
 * go wrong is shown to refuse — fail closed: opening bids has no other head to use.
 */

const SECRET = randomBytes(24).toString('hex');
const tokens = new InternalTokenService(SECRET, 'rasta-internal', 300);
const h = (c: string) => c.repeat(64);

type Behaviour =
  'contract' | 'error' | 'extra-field' | 'bad-digest' | 'other-tender' | 'slow' | 'text';

const chainFor = (tenderId: string) => ({
  tenderId,
  genesis: genesisReceipt(tenderId),
  head: h('b'),
  links: [
    {
      seq: 1,
      bidId: 'BID_1',
      revision: 1,
      receivedAt: '2026-10-01T09:00:00.000Z',
      ciphertextSha256: h('c'),
      contentCommitment: h('d'),
      previousReceipt: genesisReceipt(tenderId),
      receipt: h('b'),
    },
  ],
});

describe('TenderEvidenceClient against the audit-service contract', () => {
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
          .verify((req.headers['x-internal-token'] as string | undefined) ?? '', 'audit-service')
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
        if (behaviour === 'text') {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('not json');
          return;
        }
        const asked = decodeURIComponent(
          /\/tender-evidence\/([^/]+)\/chain/.exec(req.url ?? '')?.[1] ?? '',
        );
        const body = chainFor(behaviour === 'other-tender' ? 'TND_SOMEONE_ELSE' : asked);
        const sent =
          behaviour === 'extra-field'
            ? { ...body, reason: 'x' }
            : behaviour === 'bad-digest'
              ? { ...body, head: 'not-a-digest' }
              : body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sent));
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
    new TenderEvidenceClient(
      testEnv({
        AUDIT_SERVICE_URL: baseUrl,
        CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS: timeoutMs,
        INTERNAL_TOKEN_SECRET: SECRET,
      }),
      tokens,
    );

  it('reads a tender’s chain with a service token for audit-service that is signed for no tenant', async () => {
    const chain = await client().fetchChain('TND_A/1');

    expect(chain).toEqual(chainFor('TND_A/1'));
    expect(seen[0]!.url).toBe('/v1/internal/tender-evidence/TND_A%2F1/chain');
    expect(seen[0]!.claims).toMatchObject({ callerService: 'construction-service' });
    expect(seen[0]!.claims!.organizationId).toBeUndefined();
  });

  it.each([
    ['an error status', 'error'],
    ['a body with a field the contract does not have', 'extra-field'],
    ['a head that is not a digest', 'bad-digest'],
    ['a chain for another tender', 'other-tender'],
    ['a body that is not JSON', 'text'],
  ] as [string, Behaviour][])(
    'refuses %s as unavailable, never as an empty chain',
    async (_label, mode) => {
      behaviour = mode;
      await expect(client().fetchChain('TND_A')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    },
  );

  it('times out on a server that never answers', async () => {
    behaviour = 'slow';
    await expect(client('300').fetchChain('TND_A')).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });

  it('refuses when nothing is listening at all', async () => {
    const dead = new TenderEvidenceClient(
      testEnv({
        AUDIT_SERVICE_URL: 'http://127.0.0.1:1',
        CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS: '500',
        INTERNAL_TOKEN_SECRET: SECRET,
      }),
      tokens,
    );
    await expect(dead.fetchChain('TND_A')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

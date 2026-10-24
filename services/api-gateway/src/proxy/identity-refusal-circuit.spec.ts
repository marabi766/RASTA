import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InternalTokenService, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { ServiceName, ServiceUrls } from '../config/routes';
import { ProxyService, isExpectedIdentityRefusal } from './proxy.service';

/**
 * PR #381 r3 F2: identity's expected refusals do not open its circuit.
 *
 * A narrowing change that identity refuses with its fixed `503
 * KEYCLOAK_WRITE_SETTLING` (an earlier Keycloak write of that one user may
 * still land, D-069) or `503 KEYCLOAK_UNAVAILABLE` (Keycloak could not be
 * written first, D-064) is identity working as designed. Counted as transport
 * failures, five of them for one user opened the shared identity circuit and
 * cut every tenant off from identity for 30 s. Timeouts, connection errors and
 * every other 5xx still count; the exemption fails closed on anything short of
 * identity's complete envelope for this request.
 *
 * Real `fetch` against a real HTTP upstream, the forwarder as `AppModule` builds it.
 */

const THRESHOLD = 5;

interface Answer {
  status: number;
  /** The body; `correlationId` is replaced by the forwarded `x-correlation-id` when `echo`. */
  body: (correlationId: string) => string;
}

interface Upstream {
  url: string;
  received: string[];
  answer: (req: IncomingMessage) => Answer;
  close: () => Promise<void>;
}

const OK: Answer = { status: 200, body: () => '{"id":"USR_OTHER"}' };

function envelope(code: string, extra: Record<string, unknown> = {}) {
  return (correlationId: string) =>
    JSON.stringify({
      code,
      message:
        code === 'KEYCLOAK_WRITE_SETTLING'
          ? 'An earlier identity-provider write of this user may still land; nothing was changed'
          : 'The identity provider could not be written before the change; nothing was changed',
      correlationId,
      timestamp: new Date().toISOString(),
      path: '/v1/memberships/MBR_1/roles',
      ...extra,
    });
}

async function startUpstream(): Promise<Upstream> {
  const upstream = { received: [] as string[], answer: () => OK } as unknown as Upstream;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    upstream.received.push(`${req.method} ${req.url}`);
    const answer = upstream.answer(req);
    const correlationId = String(req.headers['x-correlation-id'] ?? '');
    res.writeHead(answer.status, { 'content-type': 'application/json', 'retry-after': '120' });
    res.end(answer.body(correlationId));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  upstream.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  upstream.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return upstream;
}

function contextOf(organizationId: string, n: number): RequestContext {
  return {
    correlationId: `COR-${organizationId}-${n}`,
    requestId: `REQ-${organizationId}-${n}`,
    organizationId,
    userId: `USR-${organizationId}`,
    roles: ['ORGANIZATION_ADMIN'],
    organizationIds: [organizationId],
    authType: 'USER',
    startedAt: Date.now(),
  };
}

describe('identity expected refusals and the circuit (PR #381 r3 F2, D-069)', () => {
  let upstream: Upstream;
  let proxy: ProxyService;
  let n = 0;

  beforeAll(async () => {
    upstream = await startUpstream();
  });
  afterAll(async () => {
    await upstream.close();
  });
  beforeEach(() => {
    upstream.received.length = 0;
    upstream.answer = () => OK;
    const urls = {
      IDENTITY_SERVICE_URL: upstream.url,
      ORGANIZATION_SERVICE_URL: upstream.url,
    } as unknown as ServiceUrls;
    proxy = new ProxyService(
      urls,
      new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
      { timeoutMs: 2_000, failureThreshold: THRESHOLD, resetAfterMs: 30_000 },
    );
  });

  const demote = (organizationId: string, service: ServiceName = 'identity') =>
    runWithContext(contextOf(organizationId, (n += 1)), () =>
      proxy.forward({
        service,
        method: 'PUT',
        path: '/v1/memberships/MBR_1/roles',
        query: '',
        headers: {},
        body: { roles: ['OPERATOR'], reason: 'r' },
      }),
    ).catch((error: unknown) => error);

  const me = (organizationId: string) =>
    runWithContext(contextOf(organizationId, (n += 1)), () =>
      proxy.forward({
        service: 'identity',
        method: 'GET',
        path: '/v1/users/me',
        query: '',
        headers: {},
        body: undefined,
      }),
    ).catch((error: unknown) => error);

  it.each(['KEYCLOAK_WRITE_SETTLING', 'KEYCLOAK_UNAVAILABLE'])(
    'five %s refusals for one user, then another tenant’s GET /v1/users/me still reaches identity',
    async (code) => {
      upstream.answer = (req) =>
        req.method === 'PUT' ? { status: 503, body: envelope(code) } : OK;
      for (let i = 0; i < THRESHOLD + 2; i += 1) {
        // The caller still gets identity's refusal, sanitized as before.
        await expect(demote('ORG-A')).resolves.toMatchObject({
          status: 503,
          body: { code, correlationId: expect.stringMatching(/^COR-ORG-A-/) },
        });
      }
      // Never counted: the circuit has no entry, or one with no failures.
      expect(proxy.circuitStates().identity ?? { failures: 0, open: false }).toEqual({
        failures: 0,
        open: false,
      });

      await expect(me('ORG-B')).resolves.toMatchObject({ status: 200 });
      expect(upstream.received.filter((line) => line === 'GET /v1/users/me')).toHaveLength(1);
    },
  );

  it('neither resets nor adds to failures already counted', async () => {
    upstream.answer = () => ({ status: 500, body: () => '<html>crash</html>' });
    for (let i = 0; i < THRESHOLD - 1; i += 1) await demote('ORG-A');
    upstream.answer = () => ({ status: 503, body: envelope('KEYCLOAK_WRITE_SETTLING') });
    await demote('ORG-A');
    expect(proxy.circuitStates().identity).toEqual({ failures: THRESHOLD - 1, open: false });
  });

  describe('everything else still counts — the exemption fails closed', () => {
    const counted: Array<[string, Answer, ServiceName?]> = [
      ['another 503 code', { status: 503, body: envelope('UPSTREAM_UNAVAILABLE') }],
      [
        'the code with another 5xx status',
        { status: 500, body: envelope('KEYCLOAK_WRITE_SETTLING') },
      ],
      [
        'the envelope with details',
        {
          status: 503,
          body: envelope('KEYCLOAK_WRITE_SETTLING', { details: [{ path: 'x', message: 'y' }] }),
        },
      ],
      [
        'the envelope with a key the filter never writes',
        { status: 503, body: envelope('KEYCLOAK_UNAVAILABLE', { stack: 'at x' }) },
      ],
      [
        'another request’s correlation id',
        {
          status: 503,
          body: () => envelope('KEYCLOAK_WRITE_SETTLING')('COR-SOMEONE-ELSE'),
        },
      ],
      [
        'an incomplete envelope (no timestamp)',
        {
          status: 503,
          body: (correlationId) =>
            JSON.stringify({ code: 'KEYCLOAK_WRITE_SETTLING', message: 'm', correlationId }),
        },
      ],
      ['a page that is not JSON', { status: 503, body: () => 'Service Unavailable' }],
      [
        'the same envelope from another service',
        { status: 503, body: envelope('KEYCLOAK_WRITE_SETTLING') },
        'organization',
      ],
    ];

    it.each(counted)('%s', async (_name, answer, service = 'identity') => {
      upstream.answer = () => answer;
      for (let i = 0; i < THRESHOLD; i += 1) await demote('ORG-A', service);
      expect(proxy.circuitStates()[service]).toEqual({ failures: THRESHOLD, open: true });
      // With identity's circuit open, another tenant's read is refused at the edge.
      if (service === 'identity') {
        await expect(me('ORG-B')).resolves.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      }
    });

    it('a timeout still counts', async () => {
      const slow = new ProxyService(
        { IDENTITY_SERVICE_URL: 'http://10.255.255.1:9' } as unknown as ServiceUrls,
        new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
        { timeoutMs: 50, failureThreshold: 1, resetAfterMs: 30_000 },
      );
      await runWithContext(contextOf('ORG-A', (n += 1)), () =>
        slow.forward({
          service: 'identity',
          method: 'GET',
          path: '/v1/users/me',
          query: '',
          headers: {},
          body: undefined,
        }),
      ).catch(() => undefined);
      expect(slow.circuitStates().identity).toEqual({ failures: 1, open: true });
    });
  });

  it('the predicate on its own: only identity, only 503, only the complete envelope of this request', () => {
    const body = envelope('KEYCLOAK_WRITE_SETTLING')('COR-X');
    const within = (fn: () => boolean) =>
      runWithContext({ ...contextOf('ORG-A', 0), correlationId: 'COR-X' }, fn);
    expect(within(() => isExpectedIdentityRefusal('identity', 503, body))).toBe(true);
    expect(within(() => isExpectedIdentityRefusal('organization', 503, body))).toBe(false);
    expect(within(() => isExpectedIdentityRefusal('identity', 502, body))).toBe(false);
    expect(within(() => isExpectedIdentityRefusal('identity', 503, '[]'))).toBe(false);
    expect(within(() => isExpectedIdentityRefusal('identity', 503, 'null'))).toBe(false);
  });
});

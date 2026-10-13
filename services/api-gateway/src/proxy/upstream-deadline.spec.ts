import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ExpressAdapter } from '@nestjs/platform-express';
import {
  InternalTokenService,
  RastaError,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { loadGatewayEnv, type GatewayEnv } from '../config/env';
import { SERVICE_NAMES, type ServiceUrls } from '../config/routes';
import { GatewayController } from './gateway.controller';
import { ProxyService, proxyOptionsOf } from './proxy.service';
import type { RateLimiter, RateLimitRule } from './rate-limiter';

/**
 * Codex r2 on #250, G1: the gateway's upstream deadline for opening a tender's bids.
 *
 * construction-service may legitimately work for many seconds on `POST /tenders/{id}/open-bids`
 * and `GET /tenders/{id}/bids` (every standing bid decrypted under
 * `CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS`). Under the default 3 s deadline the gateway answered
 * `UPSTREAM_TIMEOUT` while the opening still ran — and might still commit — and counted it against
 * the circuit. Those two requests now have `GATEWAY_TENDER_OPEN_TIMEOUT_MS`; every other request
 * keeps `GATEWAY_UPSTREAM_TIMEOUT_MS`.
 *
 * Exercised as it happens: the configuration is loaded as the gateway loads it, the forwarder is
 * built from it as `AppModule` builds it (`proxyOptionsOf`), and a real Express app runs the real
 * `GatewayController`, which forwards with the real `fetch` to an upstream that answers late.
 */

/** Both deadlines short, so the test is quick: 300 ms for everything, 5 s for the tender routes. */
const DEFAULT_DEADLINE_MS = 300;
const TENDER_DEADLINE_MS = 5_000;
/** Late for every route but the two tender routes. */
const SLOW_UPSTREAM_MS = 1_200;

const BASE_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    SERVICE_NAMES.map((name) => [`${name.toUpperCase()}_SERVICE_URL`, 'http://unused:3000']),
  ),
  REDIS_URL: 'redis://localhost:6379',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
};

const userContext: RequestContext = {
  correlationId: 'req-sample-correlation',
  requestId: 'req-sample-request',
  organizationId: 'ORG-SAMPLE',
  userId: 'USR-SAMPLE',
  roles: ['ORGANIZATION_ADMIN'],
  organizationIds: [],
  authType: 'USER',
  startedAt: 0,
};

interface Upstream {
  url: string;
  delayMs: number;
  received: string[];
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const upstream = { delayMs: 0, received: [] as string[] } as Upstream;
  const server: Server = createServer((req, res) => {
    upstream.received.push(`${req.method} ${req.url}`);
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, upstream.delayMs);
    res.on('close', () => clearTimeout(timer));
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

const allowingLimiter = {
  consume: async (_scope: string, _identifier: string, rule: RateLimitRule) => ({
    allowed: true,
    limit: rule.limit,
    remaining: 1,
    resetAt: 0,
    retryAfterSeconds: 0,
  }),
} as unknown as RateLimiter;

/** The gateway as configured by `env`, every service URL pointing at `upstream`. */
async function startGateway(upstream: Upstream, env: GatewayEnv) {
  const urls = Object.fromEntries(
    SERVICE_NAMES.map((name) => [`${name.toUpperCase()}_SERVICE_URL`, upstream.url]),
  ) as unknown as ServiceUrls;
  const proxy = new ProxyService(
    urls,
    new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
    proxyOptionsOf(env),
  );
  const controller = new GatewayController(proxy, allowingLimiter, env);

  const app = new ExpressAdapter().getInstance();
  app.all(/^\/v1\/.*/, (req: never, res: never) => {
    runWithContext(userContext, () => controller.handle(req, res)).catch((error: unknown) => {
      const response = res as unknown as {
        status: (n: number) => { json: (b: unknown) => void };
      };
      if (error instanceof RastaError) {
        response.status(error.status).json({ code: error.code });
      } else {
        response.status(500).json({ code: 'UNEXPECTED' });
      }
    });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const send = (method: string, path: string) =>
    new Promise<{ status: number; body: string; elapsedMs: number }>((resolve, reject) => {
      const started = Date.now();
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          // `tenders` requires an Idempotency-Key on unsafe methods at the edge.
          headers: { 'content-type': 'application/json', 'idempotency-key': randomKey() },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body, elapsedMs: Date.now() - started }),
          );
        },
      );
      req.on('error', reject);
      req.end(method === 'GET' ? undefined : '{}');
    });

  return {
    send,
    proxy,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const randomKey = (): string => randomBytes(8).toString('hex');

describe('the tender opening routes wait for construction-service (Codex r2 on #250, G1)', () => {
  jest.setTimeout(30_000);

  const env = loadGatewayEnv({
    ...BASE_ENV,
    GATEWAY_UPSTREAM_TIMEOUT_MS: String(DEFAULT_DEADLINE_MS),
    GATEWAY_TENDER_OPEN_TIMEOUT_MS: String(TENDER_DEADLINE_MS),
  });
  let upstream: Upstream;
  let gateway: Awaited<ReturnType<typeof startGateway>>;

  beforeEach(async () => {
    upstream = await startUpstream();
    upstream.delayMs = SLOW_UPSTREAM_MS;
    gateway = await startGateway(upstream, env);
  });
  afterEach(async () => {
    await gateway.close();
    await upstream.close();
  });

  it.each([
    ['POST', '/v1/tenders/TND_1/open-bids'],
    ['GET', '/v1/tenders/TND_1/bids'],
    ['GET', '/v1/tenders/TND_1/bids?limit=50'],
    ['POST', '/v1/tenders/TND_1/open-bids/'],
  ])(
    '%s %s: answered after the default deadline, and no failure is counted',
    async (method, path) => {
      const response = await gateway.send(method, path);

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(response.elapsedMs).toBeGreaterThanOrEqual(SLOW_UPSTREAM_MS - 50);
      expect(upstream.received).toHaveLength(1);
      expect(gateway.proxy.circuitStates().construction).toBeUndefined();
    },
  );

  it.each([
    // The tender's other routes, the slow two's neighbours included.
    ['POST', '/v1/tenders/TND_1/open-bids/proposal'],
    ['POST', '/v1/tenders/TND_1/open-bids/proposal/withdraw'],
    ['GET', '/v1/tenders/TND_1/bids/BID_1'],
    ['GET', '/v1/tenders/TND_1/bids/mine'],
    ['POST', '/v1/tenders/TND_1/bids'],
    ['GET', '/v1/tenders/TND_1/open-bids'],
    ['GET', '/v1/tenders/TND_1'],
    ['GET', '/v1/tenders/TND_1/bid-access-log'],
    // The same shapes under another service's prefix.
    ['GET', '/v1/projects/TND_1/bids'],
    ['POST', '/v1/projects/TND_1/open-bids'],
  ])('%s %s: keeps the default deadline (504 UPSTREAM_TIMEOUT)', async (method, path) => {
    const response = await gateway.send(method, path);

    expect(response.status).toBe(504);
    expect(JSON.parse(response.body)).toEqual({ code: 'UPSTREAM_TIMEOUT' });
    expect(response.elapsedMs).toBeLessThan(SLOW_UPSTREAM_MS);
  });

  it('still bounds the tender routes: an opening past GATEWAY_TENDER_OPEN_TIMEOUT_MS is UPSTREAM_TIMEOUT', async () => {
    upstream.delayMs = TENDER_DEADLINE_MS + 1_000;

    const response = await gateway.send('POST', '/v1/tenders/TND_1/open-bids');

    expect(response.status).toBe(504);
    expect(JSON.parse(response.body)).toEqual({ code: 'UPSTREAM_TIMEOUT' });
    expect(response.elapsedMs).toBeGreaterThanOrEqual(TENDER_DEADLINE_MS - 50);
    expect(response.elapsedMs).toBeLessThan(TENDER_DEADLINE_MS + 1_000);
  });
});

describe('the deadlines AppModule configures (proxyOptionsOf)', () => {
  const proxyFor = (overrides: NodeJS.ProcessEnv = {}) =>
    new ProxyService(
      {} as ServiceUrls,
      new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
      proxyOptionsOf(loadGatewayEnv({ ...BASE_ENV, ...overrides })),
    );

  it('by default: 60 s for opening and listing the opened bids, 3 s for everything else', () => {
    const proxy = proxyFor();
    const at = (method: string, path: string, service = 'construction' as const) =>
      proxy.deadlineFor({ service, method, path });

    expect(at('POST', '/v1/tenders/TND_1/open-bids')).toBe(60_000);
    expect(at('post', '/v1/tenders/TND_1/open-bids')).toBe(60_000);
    expect(at('GET', '/v1/tenders/TND_1/bids')).toBe(60_000);
    expect(at('GET', '/v1/tenders/TND_1/bids/BID_1')).toBe(3_000);
    expect(at('POST', '/v1/tenders/TND_1/open-bids/proposal')).toBe(3_000);
    expect(at('POST', '/v1/tenders/TND_1/bids')).toBe(3_000);
    expect(at('GET', '/v1/tenders/TND_1/open-bids')).toBe(3_000);
    expect(at('GET', '/v1/tenders/a/b/bids')).toBe(3_000);
    expect(
      proxy.deadlineFor({ service: 'contract', method: 'GET', path: '/v1/tenders/TND_1/bids' }),
    ).toBe(3_000);
  });

  it('follows GATEWAY_TENDER_OPEN_TIMEOUT_MS for those two routes only', () => {
    const proxy = proxyFor({ GATEWAY_TENDER_OPEN_TIMEOUT_MS: '90000' });

    expect(
      proxy.deadlineFor({
        service: 'construction',
        method: 'POST',
        path: '/v1/tenders/T/open-bids',
      }),
    ).toBe(90_000);
    expect(
      proxy.deadlineFor({ service: 'construction', method: 'GET', path: '/v1/tenders/T' }),
    ).toBe(3_000);
  });
});

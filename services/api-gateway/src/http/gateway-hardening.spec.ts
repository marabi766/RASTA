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
import { GatewayController } from '../proxy/gateway.controller';
import { ProxyService } from '../proxy/proxy.service';
import type { RateLimiter, RateLimitRule } from '../proxy/rate-limiter';
import type { GatewayEnv } from '../config/env';
import type { ServiceUrls } from '../config/routes';
import { loadGatewayEnv } from '../config/env';
import { applyTrustProxy, trustProxySetting } from './trust-proxy';
import { assertCanonicalPath } from './canonical-path';

/**
 * L1-03, L1-04 and L1-06, over real HTTP.
 *
 * The defects all live at a seam between two components that are each
 * correct alone — Express and the gateway's key choice, the gateway's route
 * choice and `fetch`'s URL parser, an upstream's error page and the gateway's
 * reflection of it — so they are exercised the way they occur: a real Express
 * app runs the real `GatewayController` and `ProxyService`, which forward with
 * the real `fetch` to a real upstream server that records what reached it.
 * Only the rate limiter's store is replaced, by one that records the key.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PLATFORM_ENV = {
  GATEWAY_RATE_LIMIT_MAX: 300,
  GATEWAY_RATE_LIMIT_WINDOW_MS: 60_000,
  GATEWAY_TENANT_RATE_LIMIT_MAX: 3000,
  GATEWAY_ANON_RATE_LIMIT_MAX: 60,
} as unknown as GatewayEnv;

interface Upstream {
  url: string;
  received: string[];
  respond: (res: import('node:http').ServerResponse) => void;
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const upstream: Partial<Upstream> = {
    received: [],
    respond: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  };
  const server: Server = createServer((req, res) => {
    upstream.received!.push(req.url ?? '');
    upstream.respond!(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  upstream.url = `http://127.0.0.1:${port}`;
  upstream.close = () => new Promise((resolve) => server.close(() => resolve()));
  return upstream as Upstream;
}

function recordingLimiter() {
  const keys: Array<{ scope: string; identifier: string; rule: RateLimitRule }> = [];
  const limiter = {
    consume: async (scope: string, identifier: string, rule: RateLimitRule) => {
      keys.push({ scope, identifier, rule });
      return { allowed: true, limit: rule.limit, remaining: 1, resetAt: 0, retryAfterSeconds: 0 };
    },
  } as unknown as RateLimiter;
  return { limiter, keys };
}

function proxyTo(upstream: Upstream): ProxyService {
  const every = [
    'IDENTITY',
    'ORGANIZATION',
    'ASSET',
    'FLEET',
    'MAINTENANCE',
    'MARKETPLACE',
    'PROCUREMENT',
    'SUPPLIER',
    'INVENTORY',
    'CONSTRUCTION',
    'CONTRACT',
    'ECONOMIC',
    'NOTIFICATION',
    'DOCUMENT',
    'AUDIT',
    'ANALYTICS',
  ];
  const urls = Object.fromEntries(
    every.map((name) => [`${name}_SERVICE_URL`, upstream.url]),
  ) as unknown as ServiceUrls;
  return new ProxyService(
    urls,
    new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
    { timeoutMs: 2000, failureThreshold: 100, resetAfterMs: 1000 },
  );
}

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

const anonymousContext: RequestContext = {
  correlationId: 'req-sample-correlation',
  requestId: 'req-sample-request',
  roles: [],
  organizationIds: [],
  authType: 'ANONYMOUS',
  startedAt: 0,
};

/**
 * A real Express app running the real controller. Errors are written the way
 * the platform filter writes them — code and status — which is all these
 * tests assert on.
 */
async function startGateway(options: {
  upstream: Upstream;
  context: RequestContext;
  trustedProxies?: string[];
}) {
  const { limiter, keys } = recordingLimiter();
  const controller = new GatewayController(proxyTo(options.upstream), limiter, PLATFORM_ENV);

  const app = new ExpressAdapter().getInstance();
  applyTrustProxy(app, options.trustedProxies ?? []);
  app.all(/^\/v1\/.*/, (req: never, res: never) => {
    runWithContext(options.context, () => controller.handle(req, res)).catch((error: unknown) => {
      const response = res as unknown as {
        status: (n: number) => { json: (b: unknown) => void };
      };
      if (error instanceof RastaError) {
        response.status(error.status).json({ code: error.code, message: error.message });
      } else {
        response.status(500).json({ code: 'UNEXPECTED' });
      }
    });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  /** Sends the path exactly as written — no client-side normalisation. */
  const send = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
      },
    );

  return {
    send,
    keys,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// L1-04 — dot-segments
// ---------------------------------------------------------------------------

describe('L1-04: a dot-segment path is refused before the route is chosen', () => {
  let upstream: Upstream;
  beforeEach(async () => (upstream = await startUpstream()));
  afterEach(async () => upstream.close());

  it.each([
    '/v1/users/../audit-corrections',
    '/v1/users/%2e%2e/audit-corrections',
    '/v1/users/%2E%2e/audit-corrections',
    '/v1/users/.%2e/audit-corrections',
    '/v1/users/%2e./audit-corrections',
    '/v1/users/..%5caudit-corrections',
    '/v1/users/x/../../audit-corrections',
  ])('%s never reaches a service', async (path) => {
    const gateway = await startGateway({ upstream, context: userContext });
    try {
      const response = await gateway.send(path, {}, 'POST');

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({ code: 'VALIDATION_FAILED' });
      // Nothing forwarded and nothing charged to the `users` budget.
      expect(upstream.received).toEqual([]);
      expect(gateway.keys).toEqual([]);
    } finally {
      await gateway.close();
    }
  });

  it('the premise: without the check, fetch delivers it to a different route', async () => {
    // What the gateway used to do, reproduced with the same forwarder: the
    // route was `users`, the upstream saw `audit-corrections`.
    await runWithContext(userContext, () =>
      proxyTo(upstream).forward({
        service: 'identity',
        method: 'GET',
        path: '/v1/users/../audit-corrections',
        query: '',
        headers: {},
        body: undefined,
      }),
    );
    expect(upstream.received).toEqual(['/v1/audit-corrections']);
  });

  it('a canonical path is forwarded unchanged and charged to its own route', async () => {
    const gateway = await startGateway({ upstream, context: userContext });
    try {
      const response = await gateway.send('/v1/users/me?expand=roles');

      expect(response.status).toBe(200);
      expect(upstream.received).toEqual(['/v1/users/me?expand=roles']);
      expect(gateway.keys[0]?.scope).toBe('user:users');
    } finally {
      await gateway.close();
    }
  });

  it.each([
    '/v1/documents/report.v2.pdf',
    '/v1/documents/...',
    '/v1/organizations/ORG-DEH-0001',
    '/v1/products/a..b',
    '/v1/documents/%2e%2e%2e',
  ])('does not refuse %s, which no URL parser rewrites', (path) => {
    expect(() => assertCanonicalPath(path)).not.toThrow();
    expect(new URL(`http://up${path}`).pathname).toBe(path);
  });
});

// ---------------------------------------------------------------------------
// L1-03 — the anonymous rate-limit key
// ---------------------------------------------------------------------------

describe('L1-03: anonymous rate limits key on the client, not the ingress', () => {
  let upstream: Upstream;
  beforeEach(async () => (upstream = await startUpstream()));
  afterEach(async () => upstream.close());

  const anonymousKeyFor = async (trustedProxies: string[], forwardedFor?: string) => {
    const gateway = await startGateway({ upstream, context: anonymousContext, trustedProxies });
    try {
      await gateway.send(
        '/v1/registration-requests',
        forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
        'POST',
      );
      const key = gateway.keys.find((entry) => entry.scope === 'ip:registration-requests');
      if (!key) throw new Error('no anonymous budget was consumed');
      return key.identifier;
    } finally {
      await gateway.close();
    }
  };

  it('by default trusts no hop: a forwarded address from anyone is ignored', async () => {
    // Unchanged default — and the reason it stays the default: without a
    // named proxy, the header is just something the client wrote.
    expect(await anonymousKeyFor([], '203.0.113.9')).toBe('127.0.0.1');
  });

  it('behind a named ingress, keys on the client the ingress saw', async () => {
    // The socket peer here is 127.0.0.1 — the stand-in for the ingress.
    expect(await anonymousKeyFor(['127.0.0.1'], '203.0.113.9')).toBe('203.0.113.9');
    expect(await anonymousKeyFor(['loopback'], '203.0.113.9')).toBe('203.0.113.9');
  });

  it('ignores an address the client prepended to spoof another bucket', async () => {
    // The ingress appends the address it saw; whatever the client sent sits
    // to its left and is never reached.
    expect(await anonymousKeyFor(['127.0.0.1'], '198.51.100.7, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('keeps the socket peer when the trusted list does not cover it', async () => {
    // A request that reached the gateway around the ingress cannot choose
    // its own key by sending the header.
    expect(await anonymousKeyFor(['10.0.0.0/8'], '203.0.113.9')).toBe('127.0.0.1');
  });

  it('never configures Express to trust every hop', () => {
    expect(trustProxySetting([])).toBe(false);
    expect(trustProxySetting(['10.0.0.0/8', 'loopback'])).toEqual(['10.0.0.0/8', 'loopback']);
  });
});

describe('GATEWAY_TRUSTED_PROXIES', () => {
  const base: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      [
        'IDENTITY',
        'ORGANIZATION',
        'ASSET',
        'FLEET',
        'MAINTENANCE',
        'MARKETPLACE',
        'PROCUREMENT',
        'SUPPLIER',
        'INVENTORY',
        'CONSTRUCTION',
        'CONTRACT',
        'ECONOMIC',
        'NOTIFICATION',
        'DOCUMENT',
        'AUDIT',
        'ANALYTICS',
      ].map((name) => [`${name}_SERVICE_URL`, `http://${name.toLowerCase()}:3000`]),
    ),
    REDIS_URL: 'redis://localhost:6379',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'not-a-secret-placeholder-for-env-parsing-only',
  };
  const load = (value?: string) =>
    loadGatewayEnv({ ...base, ...(value === undefined ? {} : { GATEWAY_TRUSTED_PROXIES: value }) })
      .GATEWAY_TRUSTED_PROXIES;

  it('defaults to trusting nobody', () => {
    expect(load()).toEqual([]);
  });

  it('reads addresses, ranges and named ranges, trimming whitespace', () => {
    expect(load(' 10.0.0.0/8 , fd00::/8,192.168.1.5, loopback ')).toEqual([
      '10.0.0.0/8',
      'fd00::/8',
      '192.168.1.5',
      'loopback',
    ]);
  });

  it.each(['true', '*', '1', '2', '0.0.0.0/33', '10.0.0.0/8/1', 'ingress.local', 'fe80::/129'])(
    'refuses %p at start-up',
    (value) => {
      // `true` and a hop count are Express-valid and exactly the spoofable
      // settings; a hostname is not an address and would never match.
      expect(() => load(value)).toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// L1-06 — an upstream's raw 5xx body
// ---------------------------------------------------------------------------

describe('L1-06: a non-platform 5xx body is replaced, never reflected', () => {
  let upstream: Upstream;
  beforeEach(async () => (upstream = await startUpstream()));
  afterEach(async () => upstream.close());

  const LEAK = 'Error: connect ECONNREFUSED at /srv/app/node_modules/pg/lib/client.js:132';

  it.each([
    ['an HTML error page', 'text/html', `<html><body><pre>${LEAK}</pre></body></html>`],
    ['a plain-text stack trace', 'text/plain', LEAK],
    ['JSON that is not the platform envelope', 'application/json', JSON.stringify({ stack: LEAK })],
    ['an empty body', 'text/plain', ''],
  ])('%s becomes the platform error', async (_label, contentType, body) => {
    upstream.respond = (res) => {
      res.writeHead(500, { 'content-type': contentType });
      res.end(body);
    };
    const gateway = await startGateway({ upstream, context: userContext });
    try {
      const response = await gateway.send('/v1/users/me');

      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect(response.body).not.toContain('ECONNREFUSED');
      expect(response.body).not.toContain('node_modules');
      expect(String(response.headers['content-type'])).toMatch(/application\/json/);
    } finally {
      await gateway.close();
    }
  });

  it('passes a platform error envelope through unchanged', async () => {
    const envelope = {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      correlationId: 'req-sample-correlation',
      timestamp: new Date(0).toISOString(),
    };
    upstream.respond = (res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(envelope));
    };
    const gateway = await startGateway({ upstream, context: userContext });
    try {
      const response = await gateway.send('/v1/users/me');

      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toEqual(envelope);
    } finally {
      await gateway.close();
    }
  });

  it('never labels a reflected body with the upstream content type', async () => {
    // Below 500 a non-JSON body is still wrapped as `{ raw }` (unchanged), but
    // it goes out as JSON — a `text/html` label is how it would be rendered.
    upstream.respond = (res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<p>Cannot GET</p>');
    };
    const gateway = await startGateway({ upstream, context: userContext });
    try {
      const response = await gateway.send('/v1/users/nobody');

      expect(response.status).toBe(404);
      expect(String(response.headers['content-type'])).toMatch(/^application\/json/);
    } finally {
      await gateway.close();
    }
  });
});

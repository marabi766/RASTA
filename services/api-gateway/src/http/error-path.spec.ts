import { randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Module,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import {
  AllExceptionsFilter,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  RequestContextMiddleware,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import request from 'supertest';
import { GatewayController } from '../proxy/gateway.controller';
import { ProxyService } from '../proxy/proxy.service';
import { RateLimiter, type RateLimitRule } from '../proxy/rate-limiter';
import type { GatewayEnv } from '../config/env';
import type { ServiceUrls } from '../config/routes';
import { GATEWAY_ENV } from '../tokens';

/**
 * S-09 on the gateway's error path: an error body and its log line name the
 * request by its path alone. The query is the caller's data — a cursor, a
 * search term — and must not come back in `path`, in Nest's `Cannot GET …`,
 * or in an upstream's envelope the gateway relays.
 *
 * The real pipeline over real HTTP: `RequestContextMiddleware`, the
 * `GatewayController`, the platform `AllExceptionsFilter` with a recording
 * logger, and `ProxyService` forwarding with `fetch` to a stub upstream.
 */

// No generated value can hold it: lowercase letters past `f` are in no ULID, instant or hex
// digest, and the log carries a hex trace id where `abc` sat by chance (#452).
const SECRET = 'query-value-wxyz';
const QUERY = `?secret=${SECRET}`;

let upstreamRespond: (res: ServerResponse) => void;
let upstreamServer: Server;
let upstreamUrl: string;
const logged: unknown[] = [];

const at = () => (payload: unknown, message: string) => {
  logged.push({ payload, message });
};
const logger = {
  error: at(),
  warn: at(),
  info: at(),
  debug: at(),
} as unknown as Logger;

const limiter = {
  consume: async (_scope: string, _identifier: string, rule: RateLimitRule) => ({
    allowed: true,
    limit: rule.limit,
    remaining: 1,
    resetAt: 0,
    retryAfterSeconds: 0,
  }),
} as unknown as RateLimiter;

const env = {
  GATEWAY_RATE_LIMIT_MAX: 300,
  GATEWAY_RATE_LIMIT_WINDOW_MS: 60_000,
  GATEWAY_TENANT_RATE_LIMIT_MAX: 3000,
  GATEWAY_ANON_RATE_LIMIT_MAX: 60,
} as unknown as GatewayEnv;

function proxy(): ProxyService {
  // Every service at the stub; only identity is reached here.
  const urls = new Proxy({} as ServiceUrls, { get: () => upstreamUrl });
  return new ProxyService(
    urls,
    new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
    { timeoutMs: 2000, failureThreshold: 100, resetAfterMs: 1000 },
  );
}

@Module({
  controllers: [GatewayController],
  providers: [
    { provide: ProxyService, useFactory: proxy },
    { provide: RateLimiter, useValue: limiter },
    { provide: GATEWAY_ENV, useValue: env },
    { provide: EXCEPTION_FILTER_LOGGER, useValue: logger },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class ErrorPathModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

type Send = (url: string) => request.Test;

function respondJson(status: number, body: unknown): (res: ServerResponse) => void {
  return (res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

/** An upstream error envelope whose `path` still carries the query. */
function upstreamEnvelope(status: number, code: string): (res: ServerResponse) => void {
  return (res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        code,
        message: 'Refused',
        correlationId: 'corr-upstream',
        timestamp: '2026-10-13T00:00:00.000Z',
        path: `/v1/registration-requests${QUERY}#frag`,
      }),
    );
  };
}

describe('gateway error path carries no query (S-09)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    upstreamServer = createServer((_req, res) => upstreamRespond(res));
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`;

    app = await NestFactory.create(ErrorPathModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  beforeEach(() => {
    logged.length = 0;
  });

  /** Neither the body nor anything logged for the request holds the secret. */
  const expectNoSecret = (body: unknown) => {
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  };

  it('an unknown route: 404, `path` is the path, nothing of the query anywhere', async () => {
    const response = await request(app.getHttpServer()).get(`/v1/x${QUERY}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', path: '/v1/x' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ payload: { method: 'GET', path: '/v1/x' } });
    expectNoSecret(response.body);
  });

  it('a route that needs a token: 401, the same', async () => {
    const response = await request(app.getHttpServer()).get(`/v1/users${QUERY}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED', path: '/v1/users' });
    expect(logged[0]).toMatchObject({ payload: { path: '/v1/users' } });
    expectNoSecret(response.body);
  });

  it('outside /v1: Nest’s own 404 keeps `Cannot GET <path>` and loses the query', async () => {
    const response = await request(app.getHttpServer()).get(`/nowhere${QUERY}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Cannot GET /nowhere',
      path: '/nowhere',
    });
    expectNoSecret(response.body);
  });

  it('a method spelt with a hyphen (`M-SEARCH`): Nest’s 404 is written again, no query', async () => {
    // supertest's typings name only the common methods; Node's parser knows this one.
    const mSearch = (request(app.getHttpServer()) as unknown as Record<string, Send>)['m-search'];
    const response = await mSearch!('/nowhere?access_token=secret123');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Cannot M-SEARCH /nowhere',
      path: '/nowhere',
    });
    expect(logged[0]).toMatchObject({ payload: { method: 'M-SEARCH', path: '/nowhere' } });
    expect(JSON.stringify([response.body, logged])).not.toContain('secret123');
  });

  it.each([
    [400, 'VALIDATION_FAILED'],
    [404, 'NOT_FOUND'],
    [503, 'UPSTREAM_UNAVAILABLE'],
  ])('an upstream %s envelope is relayed with `path` reduced to the path', async (status, code) => {
    upstreamRespond = upstreamEnvelope(status, code);

    const response = await request(app.getHttpServer()).get(`/v1/registration-requests${QUERY}`);

    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code, path: '/v1/registration-requests' });
    expectNoSecret(response.body);
  });

  it.each([400, 404, 409, 503])(
    'an upstream %s envelope: only the envelope’s own fields travel — no `url`, no nested `error.path`',
    async (status) => {
      upstreamRespond = respondJson(status, {
        code: 'SOMETHING',
        message: 'Refused',
        details: [{ path: 'cursor', message: 'Invalid', echo: `/v1/x${QUERY}` }],
        correlationId: 'corr-upstream',
        traceId: 'trace-upstream',
        timestamp: '2026-10-13T00:00:00.000Z',
        path: `/v1/registration-requests${QUERY}`,
        url: `/v1/registration-requests${QUERY}`,
        error: { path: `/v1/registration-requests${QUERY}` },
        stack: `at handler (${SECRET})`,
      });

      const response = await request(app.getHttpServer()).get(`/v1/registration-requests${QUERY}`);

      expect(response.status).toBe(status);
      expect(response.body).toEqual({
        code: 'SOMETHING',
        message: 'Refused',
        details: [{ path: 'cursor', message: 'Invalid' }],
        correlationId: 'corr-upstream',
        traceId: 'trace-upstream',
        timestamp: '2026-10-13T00:00:00.000Z',
        path: '/v1/registration-requests',
      });
      expectNoSecret(response.body);
    },
  );

  it('an upstream’s route-not-found `message` that quotes the query is written again', async () => {
    upstreamRespond = respondJson(404, {
      code: 'NOT_FOUND',
      message: `Cannot GET /v1/registration-requests${QUERY}`,
      correlationId: 'corr-upstream',
      timestamp: '2026-10-13T00:00:00.000Z',
    });

    const response = await request(app.getHttpServer()).get(`/v1/registration-requests${QUERY}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Cannot GET /v1/registration-requests',
    });
    expectNoSecret(response.body);
  });

  it.each([
    ['HTML', 'text/html', `<p>Cannot GET /v1/registration-requests${QUERY}</p>`],
    ['plain text', 'text/plain', `not found: /v1/registration-requests${QUERY}`],
    ['truncated JSON', 'application/json', `{"code":"NOT_FOUND","path":"/v1/x${QUERY}`],
    [
      'JSON of another shape',
      'application/json',
      JSON.stringify({ error: { path: `/v1/x${QUERY}` }, url: `/v1/x${QUERY}` }),
    ],
    ['an empty body', 'application/json', ''],
  ])('an upstream 4xx with %s: a fixed envelope, nothing of the body', async (_, type, text) => {
    upstreamRespond = (res) => {
      res.writeHead(404, { 'content-type': type });
      res.end(text);
    };

    const response = await request(app.getHttpServer()).get(`/v1/registration-requests${QUERY}`);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({
      code: 'NOT_FOUND',
      message: 'The request was refused',
      correlationId: expect.any(String),
      timestamp: expect.any(String),
      path: '/v1/registration-requests',
    });
    expectNoSecret(response.body);
  });

  it('a 4xx status with no code of its own keeps its status and a generic code', async () => {
    upstreamRespond = (res) => {
      res.writeHead(405, { 'content-type': 'text/html' });
      res.end(`<p>${SECRET}</p>`);
    };

    const response = await request(app.getHttpServer()).get(`/v1/registration-requests${QUERY}`);

    expect(response.status).toBe(405);
    expect(response.body).toMatchObject({ code: 'MALFORMED_REQUEST' });
    expectNoSecret(response.body);
  });

  it('the query itself still reaches the upstream — only the report is reduced', async () => {
    const received: string[] = [];
    upstreamRespond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
    upstreamServer.once('request', (req) => received.push(req.url ?? ''));

    const response = await request(app.getHttpServer()).get(`/v1/registration-requests${QUERY}`);

    expect(response.status).toBe(200);
    expect(received).toEqual([`/v1/registration-requests${QUERY}`]);
  });
});

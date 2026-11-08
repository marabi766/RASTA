import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';
import {
  All,
  Body,
  Controller,
  Module,
  Req,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  AllExceptionsFilter,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  Public,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { SERVICE_NAMES, type ServiceUrls } from '../config/routes';
import { GATEWAY_ENV } from '../tokens';
import { RevocationGate } from '../revocation/revocation-gate';
import { GatewayController } from './gateway.controller';
import {
  FORWARDABLE_METHODS,
  MAX_FORWARDED_BODY_NESTING,
  ProxyService,
  type ProxyOptions,
} from './proxy.service';
import { RateLimiter } from './rate-limiter';

/**
 * The breaker is one per service and shared by every tenant, so nothing one
 * caller can provoke locally may count against the service: five such requests
 * would refuse everybody else for the whole cooldown.
 *
 * Over real HTTP, wired as `main.ts` wires it: a real Nest gateway with the
 * production body parser and exception filter, forwarding with the real `fetch`
 * to a real Nest service with the same parser and filter. Only authentication
 * (a header picks the caller) and the rate limiter's store are replaced.
 */

const THRESHOLD = 5;
const COOLDOWN_MS = 30_000;
const USERS = '/v1/users/me';

const quietLogger = { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() };

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

interface Received {
  method: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

const received: Received[] = [];
let behaviour: 'ok' | 'crash' | 'cut' = 'ok';

@Controller()
class ServiceController {
  @All('v1/*path')
  @Public('A stand-in for the routed service')
  handle(@Req() req: import('express').Request, @Body() body: unknown) {
    received.push({ method: req.method, headers: req.headers, body });
    if (behaviour === 'crash') throw new Error('the service crashed');
    if (behaviour === 'cut') req.socket.destroy();
    return { ok: true };
  }
}

@Module({
  controllers: [ServiceController],
  providers: [
    { provide: EXCEPTION_FILTER_LOGGER, useValue: quietLogger },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class ServiceModule {}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

function caller(user: string, organizationId: string, roles: string[]): RequestContext {
  return {
    correlationId: `req-local-${user}`,
    requestId: `req-local-${user}`,
    organizationId,
    userId: user,
    // One person per user: the breaker tells people apart by subject (#758 r1 R1).
    subject: `SUB_${user}`,
    roles,
    organizationIds: [],
    authType: 'USER',
    startedAt: 0,
  };
}

const CALLERS: Record<string, RequestContext> = {
  A: caller('USR_A', 'ORG_A', ['ORGANIZATION_ADMIN']),
  B: caller('USR_B', 'ORG_B', ['ORGANIZATION_ADMIN']),
  /** A context no header can carry: Fetch's own header check refuses it. */
  UNSENDABLE: caller('USR_C', 'ORG_C', ['ROLE\nINJECTED']),
};

function selectCaller(req: import('express').Request, _res: unknown, next: () => void): void {
  runWithContext({ ...CALLERS[String(req.headers['x-test-caller'] ?? 'A')]! }, next);
}

let proxy: ProxyService;

@Module({
  controllers: [GatewayController],
  providers: [
    { provide: ProxyService, useFactory: () => proxy },
    // The list is off, as in every build without the identity-topic reader (EXT-005 PR 2).
    { provide: RevocationGate, useValue: RevocationGate.off() },
    {
      provide: RateLimiter,
      useValue: {
        consume: async (_scope: string, _id: string, rule: { limit: number }) => ({
          allowed: true,
          limit: rule.limit,
          remaining: 1,
          resetAt: 0,
          retryAfterSeconds: 0,
        }),
      },
    },
    {
      provide: GATEWAY_ENV,
      useValue: {
        GATEWAY_RATE_LIMIT_MAX: 300,
        GATEWAY_RATE_LIMIT_WINDOW_MS: 60_000,
        GATEWAY_TENANT_RATE_LIMIT_MAX: 3000,
        GATEWAY_ANON_RATE_LIMIT_MAX: 60,
      },
    },
    { provide: EXCEPTION_FILTER_LOGGER, useValue: quietLogger },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class GatewayModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(selectCaller).forRoutes('*');
  }
}

/** As `main.ts`: the same limit, on the same parser. */
async function listening(module: unknown): Promise<{ app: INestApplication; port: number }> {
  const app = await NestFactory.create<NestExpressApplication>(module as never, { logger: false });
  app.useBodyParser('json', { limit: '256kb' });
  await app.listen(0, '127.0.0.1');
  return { app, port: (app.getHttpServer().address() as AddressInfo).port };
}

interface Answer {
  status: number;
  code?: string;
  allow?: string;
}

interface Attempt {
  method?: string;
  path?: string;
  caller?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

function send(port: number, attempt: Attempt = {}): Promise<Answer> {
  const { method = 'GET', path = USERS, caller: who = 'A', headers = {}, body } = attempt;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'x-test-caller': who,
          ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let code: string | undefined;
          try {
            code = (JSON.parse(text) as { code?: string }).code;
          } catch {
            code = undefined;
          }
          resolve({ status: res.statusCode ?? 0, code, allow: res.headers.allow });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JSON_TYPE = { 'content-type': 'application/json' };
const PLAIN = '{"a":"valid"}';
const encoded = (encoding: string, body: Buffer | string): Attempt => ({
  method: 'POST',
  headers: { ...JSON_TYPE, 'content-encoding': encoding },
  body,
});
const objects = (depth: number) => '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
const arrays = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);
const deep = (method: string, body: string): Attempt => ({
  method,
  headers: JSON_TYPE,
  body,
});

/** A valid body far past the 256 KiB limit once inflated, tiny as sent. */
const INFLATES_PAST_LIMIT = gzipSync(`{"a":"${'x'.repeat(1024 * 1024)}"}`);

let service: { app: INestApplication; port: number };
let gatewayApp: { app: INestApplication; port: number } | undefined;
let clock = 0;

function proxyFor(servicePort: number, options: Partial<ProxyOptions> = {}): ProxyService {
  const urls = Object.fromEntries(
    SERVICE_NAMES.map((name) => [
      `${name.toUpperCase()}_SERVICE_URL`,
      `http://127.0.0.1:${servicePort}`,
    ]),
  ) as unknown as ServiceUrls;
  return new ProxyService(
    urls,
    new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
    {
      timeoutMs: 2000,
      failureThreshold: THRESHOLD,
      // What counts at all, not who may open: circuit-organizations.spec.ts.
      organizationsToOpen: 1,
      resetAfterMs: COOLDOWN_MS,
      now: () => clock,
      ...options,
    },
  );
}

async function startGateway(servicePort = service.port): Promise<number> {
  proxy = proxyFor(servicePort);
  gatewayApp = await listening(GatewayModule);
  return gatewayApp.port;
}

beforeAll(async () => {
  service = await listening(ServiceModule);
});

afterAll(async () => {
  await service.app.close();
});

beforeEach(() => {
  received.length = 0;
  behaviour = 'ok';
  clock = 0;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await gatewayApp?.app.close();
  gatewayApp = undefined;
});

/** A threshold's worth of `attempt`; each answered `expected`. */
async function hammer(port: number, attempt: Attempt, expected: Partial<Answer>): Promise<void> {
  for (let i = 0; i < THRESHOLD; i += 1) {
    expect(await send(port, attempt)).toMatchObject(expected);
  }
}

/** The breaker saw nothing, and another tenant's request reaches the service. */
async function otherTenantStillServed(port: number): Promise<void> {
  expect(proxy.circuitStates().identity?.failures ?? 0).toBe(0);
  expect(proxy.circuitStates().identity?.state ?? 'CLOSED').toBe('CLOSED');
  received.length = 0;
  expect(await send(port, { caller: 'B' })).toMatchObject({ status: 200 });
  expect(received).toHaveLength(1);
  expect(received[0]!.headers['x-organization-id']).toBe('ORG_B');
}

// ---------------------------------------------------------------------------
// Family 1: compressed bodies
// ---------------------------------------------------------------------------

describe('a compressed body the gateway consumed', () => {
  it.each([
    ['gzip', encoded('gzip', gzipSync(PLAIN))],
    ['deflate', encoded('deflate', deflateSync(PLAIN))],
    ['br', encoded('br', brotliCompressSync(PLAIN))],
    ['zstd', encoded('zstd', zstdCompressSync(PLAIN))],
    ['GZIP in capitals', encoded('GZIP', gzipSync(PLAIN))],
  ])('%s: delivered as the plain JSON it is, nothing counted', async (_name, attempt) => {
    const port = await startGateway();

    await hammer(port, attempt, { status: 200 });

    expect(received).toHaveLength(THRESHOLD);
    for (const { headers, body } of received) {
      expect(headers['content-encoding']).toBeUndefined();
      expect(headers['content-type']).toBe('application/json');
      expect(body).toEqual({ a: 'valid' });
    }
    await otherTenantStillServed(port);
  });

  it.each([
    ['DELETE', { ...encoded('gzip', gzipSync(PLAIN)), method: 'DELETE' }],
    ['PUT', { ...encoded('br', brotliCompressSync(PLAIN)), method: 'PUT' }],
    ['PATCH', { ...encoded('deflate', deflateSync(PLAIN)), method: 'PATCH' }],
  ])('%s carries it the same way', async (_name, attempt) => {
    const port = await startGateway();

    await hammer(port, attempt, { status: 200 });

    expect(received[0]!.body).toEqual({ a: 'valid' });
    expect(received[0]!.headers['content-encoding']).toBeUndefined();
    await otherTenantStillServed(port);
  });

  it.each<[string, Attempt]>([
    [
      'a type the parser skipped',
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        body: PLAIN,
      },
    ],
    ['no body at all', { method: 'POST', headers: { 'content-encoding': 'gzip' } }],
    ['GET', { headers: { 'content-encoding': 'gzip' } }],
  ])('the header without a body it describes (%s) does not travel', async (_name, attempt) => {
    const port = await startGateway();

    await hammer(port, attempt, { status: 200 });

    expect(received[0]!.headers['content-encoding']).toBeUndefined();
    await otherTenantStillServed(port);
  });

  it('every other header about the caller’s bytes stays behind too', async () => {
    const port = await startGateway();

    await send(port, {
      method: 'POST',
      headers: {
        ...JSON_TYPE,
        'content-md5': 'AAAA',
        'content-language': 'fa',
        'content-digest': 'sha-256=:AAAA:',
        digest: 'sha-256=AAAA',
        'repr-digest': 'sha-256=:AAAA:',
        'x-kept': 'yes',
      },
      body: PLAIN,
    });

    const { headers } = received[0]!;
    for (const name of [
      'content-md5',
      'content-language',
      'content-digest',
      'digest',
      'repr-digest',
    ]) {
      expect(headers[name]).toBeUndefined();
    }
    expect(headers['x-kept']).toBe('yes');
  });

  it.each([
    ['not gzip', encoded('gzip', 'not gzip at all')],
    ['gzip cut short', encoded('gzip', gzipSync(PLAIN).subarray(0, 8))],
    ['not deflate', encoded('deflate', 'not deflate')],
    ['not Brotli', encoded('br', 'not brotli at all, really')],
    ['not Zstandard', encoded('zstd', 'not zstd at all')],
  ])('%s: the caller’s 400 at the gateway, nothing sent', async (_name, attempt) => {
    const port = await startGateway();

    await hammer(port, attempt, { status: 400, code: 'MALFORMED_REQUEST' });

    expect(received).toHaveLength(0);
    await otherTenantStillServed(port);
  });

  it.each<[string, Attempt, Partial<Answer>]>([
    [
      'inflating past the limit',
      encoded('gzip', INFLATES_PAST_LIMIT),
      { status: 413, code: 'PAYLOAD_TOO_LARGE' },
    ],
    ['an unknown encoding', encoded('nope', PLAIN), { status: 415 }],
    [
      'urlencoded nested too deeply',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `a${'[b]'.repeat(50)}=1`,
      },
      { status: 400, code: 'MALFORMED_REQUEST' },
    ],
    [
      'urlencoded with too many parameters',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: Array.from({ length: 1500 }, (_, i) => `a${i}=1`).join('&'),
      },
      { status: 413, code: 'PAYLOAD_TOO_LARGE' },
    ],
  ])('%s: refused as the caller’s, nothing sent', async (_name, attempt, expected) => {
    const port = await startGateway();

    await hammer(port, attempt, expected);

    expect(received).toHaveLength(0);
    await otherTenantStillServed(port);
  });
});

// ---------------------------------------------------------------------------
// Family 2: nesting
// ---------------------------------------------------------------------------

describe('a body nested too deeply to forward', () => {
  it.each([
    ['POST', objects(10_000)],
    ['PUT', objects(10_000)],
    ['PATCH', objects(10_000)],
    ['DELETE', objects(10_000)],
    ['POST', arrays(100_000)],
    // Deep enough to survive `JSON.stringify` here, and to overflow a recursive
    // schema in a service: the 500 would be counted, so it is never sent.
    ['POST', objects(3_000)],
    ['POST', objects(MAX_FORWARDED_BODY_NESTING + 1)],
    ['POST', arrays(MAX_FORWARDED_BODY_NESTING + 1)],
  ])('%s: the caller’s 400, nothing sent, nothing counted', async (method, body) => {
    const port = await startGateway();

    await hammer(port, deep(method, body), { status: 400, code: 'MALFORMED_REQUEST' });

    expect(received).toHaveLength(0);
    await otherTenantStillServed(port);
  });

  it.each([
    ['at the limit', objects(MAX_FORWARDED_BODY_NESTING)],
    ['arrays at the limit', arrays(MAX_FORWARDED_BODY_NESTING)],
    ['wide and shallow', JSON.stringify({ rows: Array.from({ length: 20_000 }, (_, i) => i) })],
  ])('%s: forwarded unchanged', async (_name, body) => {
    const port = await startGateway();

    expect(await send(port, deep('POST', body))).toMatchObject({ status: 200 });

    expect(received[0]!.body).toEqual(JSON.parse(body));
  });
});

// ---------------------------------------------------------------------------
// Text no service can store: its 500 would be counted
// ---------------------------------------------------------------------------

describe('text PostgreSQL or Prisma would refuse', () => {
  const posted = (body: string): Attempt => deep('POST', body);

  it.each<[string, Attempt]>([
    ['NUL in a value', posted('{"note":"a\\u0000b"}')],
    ['NUL in a nested value', posted('{"a":[{"b":["\\u0000"]}]}')],
    ['NUL in a key', posted('{"a\\u0000":1}')],
    ['a lone high surrogate', posted('{"note":"a\\ud800b"}')],
    ['a lone low surrogate', posted('{"note":"\\udc00"}')],
    ['a lone surrogate in a key', posted('{"\\ud800":1}')],
    ['NUL, DELETE', deep('DELETE', '{"reason":"\\u0000"}')],
    ['NUL in a query', { path: `${USERS}?q=%00` }],
    ['NUL in a path', { path: `${USERS}/a%00b` }],
    [
      'NUL in a query, POST',
      { method: 'POST', path: `${USERS}?q=%00`, headers: JSON_TYPE, body: '{}' },
    ],
  ])('%s: the caller’s 400, nothing sent, nothing counted', async (_name, attempt) => {
    const port = await startGateway();

    await hammer(port, attempt, { status: 400, code: 'MALFORMED_REQUEST' });

    expect(received).toHaveLength(0);
    await otherTenantStillServed(port);
  });

  it.each<[string, Attempt]>([
    ['a valid surrogate pair', posted('{"note":"a\\ud83d\\ude00b"}')],
    ['other control characters', posted('{"note":"a\\u0001\\u007f\\n"}')],
    ['the words of an escape', posted('{"note":"%00 and \\\\u0000"}')],
    ['a query with an encoded percent', { path: `${USERS}?q=%2500` }],
    ['Persian with a ZWNJ', posted('{"note":"می\u200cشود"}')],
  ])('%s: forwarded', async (_name, attempt) => {
    const port = await startGateway();

    expect(await send(port, attempt)).toMatchObject({ status: 200 });

    expect(received).toHaveLength(1);
  });

  it('a GET’s body is never sent, so it is never read', async () => {
    const port = await startGateway();

    expect(await send(port, deep('GET', '{"a":"\\u0000"}'))).toMatchObject({ status: 200 });
  });
});

// ---------------------------------------------------------------------------
// The header budget: the gateway's own headers can tip a request past the service's
// ---------------------------------------------------------------------------

describe('headers that fit the gateway but not the service', () => {
  it('the service’s 431 is an answer: relayed, and nothing counted', async () => {
    const port = await startGateway();
    // Under the 16 KiB both parsers allow, until the gateway's token is added.
    const attempt: Attempt = {
      method: 'POST',
      headers: { ...JSON_TYPE, 'x-pad': 'a'.repeat(16_000) },
      body: '{}',
    };

    await hammer(port, attempt, { status: 431 });

    expect(received).toHaveLength(0);
    await otherTenantStillServed(port);
  });
});

// ---------------------------------------------------------------------------
// Family 3: methods
// ---------------------------------------------------------------------------

describe('a method the gateway does not forward', () => {
  it.each(['TRACE', 'M-SEARCH', 'PROPFIND', 'PURGE', 'LOCK', 'REPORT'])(
    '%s: 405 with `Allow`, nothing sent, nothing counted',
    async (method) => {
      const port = await startGateway();

      await hammer(
        port,
        { method },
        { status: 405, code: 'MALFORMED_REQUEST', allow: FORWARDABLE_METHODS.join(', ') },
      );

      expect(received).toHaveLength(0);
      await otherTenantStillServed(port);
    },
  );

  it.each(FORWARDABLE_METHODS)('%s still reaches the service', async (method) => {
    const port = await startGateway();

    expect(await send(port, { method })).toMatchObject({ status: 200 });

    expect(received.map((r) => r.method)).toEqual([method]);
  });
});

// ---------------------------------------------------------------------------
// Family 4: transport headers
// ---------------------------------------------------------------------------

describe('a header the transport would refuse', () => {
  it('`Expect: 100-continue`: answered by the gateway’s server, never forwarded', async () => {
    const port = await startGateway();

    await hammer(
      port,
      { method: 'POST', headers: { ...JSON_TYPE, expect: '100-continue' }, body: PLAIN },
      { status: 200 },
    );

    expect(received).toHaveLength(THRESHOLD);
    expect(received[0]!.headers.expect).toBeUndefined();
    expect(received[0]!.body).toEqual({ a: 'valid' });
    await otherTenantStillServed(port);
  });

  it.each<[string, Record<string, string>]>([
    ['upgrade', { connection: 'upgrade', upgrade: 'websocket' }],
    ['keep-alive', { 'keep-alive': 'timeout=5' }],
    ['te', { te: 'trailers' }],
    ['transfer-encoding', { 'transfer-encoding': 'chunked' }],
    ['a non-ASCII value', { 'x-note': Buffer.from('é').toString('latin1') }],
  ])('%s: forwarded without a refusal, nothing counted', async (_name, headers) => {
    const port = await startGateway();

    await hammer(port, { headers }, { status: 200 });

    await otherTenantStillServed(port);
  });

  it('whatever Fetch would reject is the 400 of `prepare`, nothing sent or counted', async () => {
    const port = await startGateway();

    await hammer(port, { caller: 'UNSENDABLE' }, { status: 400, code: 'MALFORMED_REQUEST' });

    expect(received).toHaveLength(0);
    await otherTenantStillServed(port);
  });
});

// ---------------------------------------------------------------------------
// The boundary itself
// ---------------------------------------------------------------------------

/** A rejection of the shape fetch gives: `TypeError('fetch failed')`, code on the cause. */
function fetchFailed(code: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('from the transport'), { code }),
  });
}

async function openThenCool(port: number): Promise<void> {
  behaviour = 'crash';
  await hammer(port, {}, { status: 500 });
  expect(proxy.circuitStates().identity).toMatchObject({ state: 'OPEN' });
  behaviour = 'ok';
  received.length = 0;
  clock += COOLDOWN_MS + 1;
}

describe('a transport error after the request was marked sent', () => {
  it.each(['UND_ERR_NOT_SUPPORTED', 'UND_ERR_INVALID_ARG'])(
    '%s, Undici’s own refusal: the caller’s 400, a release',
    async (code) => {
      const port = await startGateway();
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      fetchSpy.mockRejectedValue(fetchFailed(code));

      await hammer(port, {}, { status: 400, code: 'MALFORMED_REQUEST' });

      fetchSpy.mockRestore();
      await otherTenantStillServed(port);
    },
  );

  it.each(['UND_ERR_SOMETHING_NEW', 'EMFILE', 'none'])(
    '%s proves nothing: no verdict against the service, and no claim it was not sent',
    async (code) => {
      const port = await startGateway();
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      fetchSpy.mockRejectedValue(code === 'none' ? new Error('odd') : fetchFailed(code));

      await hammer(port, {}, { status: 503, code: 'UPSTREAM_UNAVAILABLE' });

      fetchSpy.mockRestore();
      await otherTenantStillServed(port);
    },
  );

  it('an unproven error keeps the probe’s slot until its deadline: it may have been sent', async () => {
    const port = await startGateway();
    await openThenCool(port);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    fetchSpy.mockRejectedValueOnce(fetchFailed('UND_ERR_SOMETHING_NEW'));

    expect(await send(port)).toMatchObject({ status: 503, code: 'UPSTREAM_UNAVAILABLE' });
    fetchSpy.mockRestore();

    expect(await send(port)).toMatchObject({ status: 503 });
    expect(received).toHaveLength(0);

    clock += 2001;
    expect(await send(port, { caller: 'B' })).toMatchObject({ status: 200 });
    expect(proxy.circuitStates().identity).toMatchObject({ state: 'CLOSED' });
  });

  it('Undici’s refusal gives the probe’s slot straight back', async () => {
    const port = await startGateway();
    await openThenCool(port);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    fetchSpy.mockRejectedValueOnce(fetchFailed('UND_ERR_NOT_SUPPORTED'));

    expect(await send(port)).toMatchObject({ status: 400 });
    fetchSpy.mockRestore();

    expect(await send(port)).toMatchObject({ status: 200 });
    expect(proxy.circuitStates().identity).toMatchObject({ state: 'CLOSED' });
  });
});

describe('the probe slot', () => {
  it.each<[string, Attempt, number]>([
    ['TRACE', { method: 'TRACE' }, 405],
    ['a deep body', deep('POST', objects(10_000)), 400],
    ['a NUL in a body', deep('POST', '{"a":"\\u0000"}'), 400],
    ['a NUL in a query', { path: `${USERS}?q=%00` }, 400],
    ['a corrupt body', encoded('gzip', 'not gzip'), 400],
  ])('%s does not take it, and does not reopen the circuit', async (_name, attempt, status) => {
    const port = await startGateway();
    await openThenCool(port);

    expect((await send(port, attempt)).status).toBe(status);

    expect(received).toHaveLength(0);
    expect(await send(port)).toMatchObject({ status: 200 });
    expect(proxy.circuitStates().identity).toMatchObject({ state: 'CLOSED' });
  });
});

// ---------------------------------------------------------------------------
// Controls: what the breaker exists for still opens it
// ---------------------------------------------------------------------------

describe('while the circuit is open', () => {
  it.each<[string, Attempt, number]>([
    ['TRACE', { method: 'TRACE' }, 405],
    ['a deep body', deep('POST', objects(10_000)), 400],
  ])('%s is still the caller’s own 4xx, and moves nothing', async (_name, attempt, status) => {
    const port = await startGateway();
    behaviour = 'crash';
    await hammer(port, {}, { status: 500 });
    behaviour = 'ok';
    clock += COOLDOWN_MS + 1;

    expect((await send(port, attempt)).status).toBe(status);

    // Past the cooldown, and still OPEN: only a request that can be sent starts the probe.
    expect(proxy.circuitStates().identity).toMatchObject({ state: 'OPEN' });
  });
});

describe('genuine upstream failures still count', () => {
  async function opened(port: number): Promise<void> {
    expect(proxy.circuitStates().identity).toMatchObject({ state: 'OPEN', open: true });
    received.length = 0;
    expect(await send(port, { caller: 'B' })).toMatchObject({
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(received).toHaveLength(0);
  }

  it('a service answering 500', async () => {
    const port = await startGateway();
    behaviour = 'crash';

    await hammer(port, {}, { status: 500 });

    await opened(port);
  });

  it('a service that cuts the connection (UND_ERR_SOCKET)', async () => {
    const port = await startGateway();
    behaviour = 'cut';

    await hammer(port, {}, { status: 503 });

    await opened(port);
  });

  it('an answer cut off once it had begun, whatever the error says', async () => {
    const port = await startGateway();
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('no code at all'));
            },
          }),
        ),
    );

    await hammer(port, {}, { status: 503 });

    fetchSpy.mockRestore();
    await opened(port);
  });

  it('a service nobody answers for (ECONNREFUSED)', async () => {
    const closed = await listening(ServiceModule);
    await closed.app.close();
    const port = await startGateway(closed.port);

    await hammer(port, {}, { status: 503 });

    expect(proxy.circuitStates().identity).toMatchObject({ state: 'OPEN', open: true });
  });

  it.each([
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
    'HPE_INVALID_CONSTANT',
  ])('%s', async (code) => {
    const port = await startGateway();
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    fetchSpy.mockRejectedValue(fetchFailed(code));

    await hammer(port, {}, { status: 503 });

    fetchSpy.mockRestore();
    await opened(port);
  });
});

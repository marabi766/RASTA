import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { ExpressAdapter } from '@nestjs/platform-express';
import {
  AllExceptionsFilter,
  InternalTokenService,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import type { GatewayEnv } from '../config/env';
import { SERVICE_NAMES, type ServiceUrls } from '../config/routes';
import { GatewayController } from './gateway.controller';
import { ProxyService, type ProxyOptions } from './proxy.service';
import type { RateLimiter, RateLimitRule } from './rate-limiter';

/**
 * #381 r4 F2: the circuit breaker's recovery, over real HTTP.
 *
 * A real Express app runs the real `GatewayController` and `ProxyService`, with
 * the platform's real exception filter, and forwards with the real `fetch` to a
 * real upstream whose every exchange the test holds, answers, stalls or cuts.
 * Clients are real sockets, so a client that goes away really goes away. The
 * deadlines are real timers: a body that stalls is a body that stalls, not an
 * unreachable port that fetch refuses at once.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Exchange {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  res: ServerResponse;
  /** The gateway hung up before this exchange was answered. */
  abandoned: boolean;
}

type Behaviour = (exchange: Exchange) => void;

const ok: Behaviour = ({ res }) => answer(res, 200, { ok: true });
const crash: Behaviour = ({ res }) => {
  res.writeHead(500, { 'content-type': 'text/plain' });
  res.end('boom');
};
const hold: Behaviour = () => undefined;
/** 200 headers and part of the body, then nothing: the body never completes. */
const stallBody: Behaviour = ({ res }) => {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
  res.write('{"ok":');
};

function answer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

interface Upstream {
  url: string;
  exchanges: Exchange[];
  behaviour: Behaviour;
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const upstream = { exchanges: [] as Exchange[], behaviour: ok } as Upstream;
  const server: Server = createServer((req, res) => {
    const exchange: Exchange = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      res,
      abandoned: false,
    };
    res.on('close', () => {
      if (!res.writableFinished) exchange.abandoned = true;
    });
    upstream.exchanges.push(exchange);
    req.resume();
    req.on('end', () => upstream.behaviour(exchange));
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

function context(user: string, organizationId: string, roles: string[]): RequestContext {
  return {
    correlationId: `req-circuit-${user}`,
    requestId: `req-circuit-${user}`,
    organizationId,
    userId: user,
    roles,
    organizationIds: [],
    authType: 'USER',
    startedAt: 0,
  };
}

/** Who is calling, chosen by the client's `x-test-caller`. */
const CALLERS: Record<string, RequestContext> = {
  A: context('USR_A', 'ORG_A', ['ORGANIZATION_ADMIN']),
  B: context('USR_B', 'ORG_B', ['ORGANIZATION_ADMIN']),
  LIMITED: context('USR_LIMITED', 'ORG_A', ['ORGANIZATION_ADMIN']),
  anonymous: {
    correlationId: 'req-circuit-anonymous',
    requestId: 'req-circuit-anonymous',
    roles: [],
    organizationIds: [],
    authType: 'ANONYMOUS',
    startedAt: 0,
  },
};

const PLATFORM_ENV = {
  GATEWAY_RATE_LIMIT_MAX: 300,
  GATEWAY_RATE_LIMIT_WINDOW_MS: 60_000,
  GATEWAY_TENANT_RATE_LIMIT_MAX: 3000,
  GATEWAY_ANON_RATE_LIMIT_MAX: 60,
} as unknown as GatewayEnv;

/** Allows everyone but `USR_LIMITED`, who is over their limit. */
const limiter = {
  consume: async (_scope: string, identifier: string, rule: RateLimitRule) => ({
    allowed: identifier !== 'USR_LIMITED',
    limit: rule.limit,
    remaining: 1,
    resetAt: 0,
    retryAfterSeconds: 30,
  }),
} as unknown as RateLimiter;

const quietLogger = { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() };

interface Answer {
  status: number;
  code?: string;
  retryAfter?: string;
  elapsedMs: number;
}

interface Sent {
  answer: Promise<Answer>;
  /** Hangs up the client's socket. */
  abort: () => void;
}

interface Gateway {
  proxy: ProxyService;
  send: (
    path: string,
    options?: { caller?: string; method?: string; headers?: Record<string, string> },
  ) => Sent;
  close: () => Promise<void>;
}

async function startGateway(
  upstream: Upstream,
  options: Pick<ProxyOptions, 'timeoutMs' | 'failureThreshold' | 'resetAfterMs'>,
): Promise<Gateway> {
  const urls = Object.fromEntries(
    SERVICE_NAMES.map((name) => [`${name.toUpperCase()}_SERVICE_URL`, upstream.url]),
  ) as unknown as ServiceUrls;
  const proxy = new ProxyService(
    urls,
    new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
    options,
  );
  const controller = new GatewayController(proxy, limiter, PLATFORM_ENV);
  const filter = new AllExceptionsFilter(quietLogger as never);

  const app = new ExpressAdapter().getInstance();
  app.all(/^\/v1\/.*/, (req: import('express').Request, res: import('express').Response) => {
    const caller = CALLERS[String(req.headers['x-test-caller'] ?? 'A')]!;
    void runWithContext({ ...caller }, async () => {
      try {
        await controller.handle(req, res);
      } catch (error) {
        // As Nest would: the platform filter writes the envelope and `Retry-After`.
        filter.catch(error, {
          switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
        } as never);
      }
    });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const send: Gateway['send'] = (path, { caller = 'A', method = 'GET', headers = {} } = {}) => {
    const started = Date.now();
    let abort = () => undefined as void;
    const answered = new Promise<Answer>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: { 'content-type': 'application/json', 'x-test-caller': caller, ...headers },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            let code: string | undefined;
            try {
              code = (JSON.parse(body) as { code?: string }).code;
            } catch {
              code = undefined;
            }
            resolve({
              status: res.statusCode ?? 0,
              code,
              retryAfter: res.headers['retry-after'] as string | undefined,
              elapsedMs: Date.now() - started,
            });
          });
        },
      );
      req.on('error', reject);
      abort = () => req.destroy();
      req.end(method === 'GET' ? undefined : '{}');
    });
    return { answer: answered, abort: () => abort() };
  };

  return {
    proxy,
    send,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Long enough for anything already in flight to have reached the upstream. */
const QUIET_MS = 150;
const COOLDOWN_MS = 200;
const PAST_COOLDOWN_MS = COOLDOWN_MS + 60;

const USERS = '/v1/users/me';

/** Opens identity's circuit with one crash (threshold 1) and waits out the cooldown. */
async function openThenCool(upstream: Upstream, gateway: Gateway): Promise<void> {
  upstream.behaviour = crash;
  expect((await gateway.send(USERS).answer).status).toBe(503);
  expect(gateway.proxy.circuitStates().identity).toMatchObject({ state: 'OPEN', open: true });
  await sleep(PAST_COOLDOWN_MS);
}

let upstream: Upstream;
let gateway: Gateway | undefined;
beforeEach(async () => {
  upstream = await startUpstream();
  gateway = undefined;
});
afterEach(async () => {
  await gateway?.close();
  await upstream.close();
});

// ---------------------------------------------------------------------------
// Defect 1 — half-open admits exactly one probe
// ---------------------------------------------------------------------------

describe('HALF_OPEN admits exactly one probe', () => {
  it('of 20 concurrent requests after the cooldown, exactly one reaches the service', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openThenCool(upstream, gateway);
    upstream.behaviour = hold;

    const sent = Array.from({ length: 20 }, () => gateway!.send(USERS));
    const answers: Answer[] = [];
    for (const one of sent) void one.answer.then((a) => answers.push(a));

    await until(() => answers.length === 19, '19 refusals');
    await sleep(QUIET_MS);
    expect(upstream.exchanges).toHaveLength(2); // the opening crash + ONE probe
    for (const refused of answers) {
      expect(refused).toMatchObject({ status: 503, code: 'UPSTREAM_UNAVAILABLE', retryAfter: '1' });
    }
    expect(gateway.proxy.circuitStates().identity).toMatchObject({
      state: 'HALF_OPEN',
      open: false,
    });

    answer(upstream.exchanges[1]!.res, 200, { ok: true });
    await until(() => answers.length === 20, 'the probe');
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(gateway.proxy.circuitStates().identity).toEqual({
      failures: 0,
      open: false,
      state: 'CLOSED',
    });

    upstream.behaviour = ok;
    expect((await gateway.send(USERS).answer).status).toBe(200);
    expect(upstream.exchanges).toHaveLength(3);
  });

  it('a probe that fails opens the circuit again, for a fresh cooldown', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openThenCool(upstream, gateway);

    expect((await gateway.send(USERS).answer).status).toBe(503); // the probe, crashed
    expect(gateway.proxy.circuitStates().identity).toMatchObject({ state: 'OPEN', open: true });
    expect(upstream.exchanges).toHaveLength(2);

    upstream.behaviour = ok;
    expect(await gateway.send(USERS).answer).toMatchObject({ status: 503, retryAfter: '1' });
    expect(upstream.exchanges).toHaveLength(2); // refused inside the new cooldown

    await sleep(PAST_COOLDOWN_MS);
    expect((await gateway.send(USERS).answer).status).toBe(200);
    expect(gateway.proxy.circuitStates().identity?.state).toBe('CLOSED');
  });

  it('a probe that times out opens the circuit again', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 300,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openThenCool(upstream, gateway);
    upstream.behaviour = hold;

    const probe = await gateway.send(USERS).answer;
    expect(probe).toMatchObject({ status: 504, code: 'UPSTREAM_TIMEOUT' });
    expect(probe.elapsedMs).toBeGreaterThanOrEqual(280);
    expect(gateway.proxy.circuitStates().identity).toMatchObject({ state: 'OPEN', failures: 2 });
  });

  it('a probe answered 4xx closes the circuit: the service answered', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openThenCool(upstream, gateway);
    upstream.behaviour = ({ res }) => answer(res, 404, { code: 'NOT_FOUND' });

    expect((await gateway.send(USERS).answer).status).toBe(404);
    expect(gateway.proxy.circuitStates().identity).toEqual({
      failures: 0,
      open: false,
      state: 'CLOSED',
    });
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — a response affects only the generation it started in
// ---------------------------------------------------------------------------

describe('a response affects only the circuit generation that admitted it', () => {
  it('a late 200 admitted before the circuit opened does not close it', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 5,
      resetAfterMs: 60_000,
    });
    upstream.behaviour = hold;
    const early = gateway.send(USERS);
    await until(() => upstream.exchanges.length === 1, 'the early request');

    upstream.behaviour = crash;
    for (let i = 0; i < 5; i += 1) expect((await gateway.send(USERS).answer).status).toBe(503);
    expect(gateway.proxy.circuitStates().identity).toMatchObject({ state: 'OPEN', failures: 5 });

    answer(upstream.exchanges[0]!.res, 200, { ok: true });
    expect((await early.answer).status).toBe(200); // its own answer is still delivered
    expect(gateway.proxy.circuitStates().identity).toMatchObject({ state: 'OPEN', failures: 5 });

    upstream.behaviour = ok;
    expect(await gateway.send(USERS).answer).toMatchObject({ status: 503, retryAfter: '60' });
    expect(upstream.exchanges).toHaveLength(6); // still open: never reached the service
  });

  it('a late failure admitted before the probe neither re-opens the circuit nor decides the probe', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    upstream.behaviour = hold;
    const early = gateway.send(USERS);
    await until(() => upstream.exchanges.length === 1, 'the early request');
    await openThenCool(upstream, gateway);

    upstream.behaviour = hold;
    const probe = gateway.send(USERS);
    await until(() => upstream.exchanges.length === 3, 'the probe');

    crash(upstream.exchanges[0]!);
    expect((await early.answer).status).toBe(503);
    expect(gateway.proxy.circuitStates().identity).toMatchObject({
      state: 'HALF_OPEN',
      failures: 1,
    });
    expect(await gateway.send(USERS).answer).toMatchObject({ status: 503, retryAfter: '1' });
    expect(upstream.exchanges).toHaveLength(3);

    answer(upstream.exchanges[2]!.res, 200, { ok: true });
    expect((await probe.answer).status).toBe(200);
    expect(gateway.proxy.circuitStates().identity?.state).toBe('CLOSED');
  });

  it('a late client abort admitted before the probe does not free the probe slot', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    upstream.behaviour = hold;
    const early = gateway.send(USERS);
    void early.answer.catch(() => undefined);
    await until(() => upstream.exchanges.length === 1, 'the early request');
    await openThenCool(upstream, gateway);

    upstream.behaviour = hold;
    const probe = gateway.send(USERS);
    await until(() => upstream.exchanges.length === 3, 'the probe');

    early.abort();
    await until(() => upstream.exchanges[0]!.abandoned, 'the early upstream call to be aborted');
    expect(await gateway.send(USERS).answer).toMatchObject({ status: 503, retryAfter: '1' });
    expect(upstream.exchanges).toHaveLength(3); // the slot is still the probe's

    answer(upstream.exchanges[2]!.res, 200, { ok: true });
    expect((await probe.answer).status).toBe(200);
    expect(gateway.proxy.circuitStates().identity?.state).toBe('CLOSED');
  });

  it('an older success does not clear failures recorded after it was admitted', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 3,
      resetAfterMs: 60_000,
    });
    upstream.behaviour = hold;
    const early = gateway.send(USERS);
    await until(() => upstream.exchanges.length === 1, 'the early request');

    upstream.behaviour = crash;
    for (let i = 0; i < 2; i += 1) expect((await gateway.send(USERS).answer).status).toBe(503);
    answer(upstream.exchanges[0]!.res, 200, { ok: true });
    expect((await early.answer).status).toBe(200);
    expect(gateway.proxy.circuitStates().identity).toMatchObject({ state: 'CLOSED', failures: 2 });

    expect((await gateway.send(USERS).answer).status).toBe(503);
    expect(gateway.proxy.circuitStates().identity).toMatchObject({ state: 'OPEN', failures: 3 });
  });
});

// ---------------------------------------------------------------------------
// Defect 3 — success only once the body is complete
// ---------------------------------------------------------------------------

describe('a success counts only once its body is complete', () => {
  it('five body timeouts in a row open the circuit (a real stalled body)', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 300,
      failureThreshold: 5,
      resetAfterMs: 60_000,
    });
    upstream.behaviour = stallBody;

    for (let i = 0; i < 5; i += 1) {
      const timedOut = await gateway.send(USERS).answer;
      expect(timedOut).toMatchObject({ status: 504, code: 'UPSTREAM_TIMEOUT' });
      // A real deadline, not an immediate refusal.
      expect(timedOut.elapsedMs).toBeGreaterThanOrEqual(280);
    }
    expect(gateway.proxy.circuitStates().identity).toEqual({
      failures: 5,
      open: true,
      state: 'OPEN',
    });

    upstream.behaviour = ok;
    expect((await gateway.send(USERS).answer).status).toBe(503);
    expect(upstream.exchanges).toHaveLength(5);
  });

  it('a 200 whose connection is cut mid-body is one failure', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 5,
      resetAfterMs: 60_000,
    });
    upstream.behaviour = (exchange) => {
      stallBody(exchange);
      setTimeout(() => exchange.res.socket?.destroy(), 20);
    };

    expect(await gateway.send(USERS).answer).toMatchObject({
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(gateway.proxy.circuitStates().identity).toEqual({
      failures: 1,
      open: false,
      state: 'CLOSED',
    });
  });

  it('a probe whose body stalls past the deadline opens the circuit again', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 300,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openThenCool(upstream, gateway);
    upstream.behaviour = stallBody;

    expect(await gateway.send(USERS).answer).toMatchObject({ status: 504 });
    expect(gateway.proxy.circuitStates().identity?.state).toBe('OPEN');
  });
});

// ---------------------------------------------------------------------------
// Client cancellation
// ---------------------------------------------------------------------------

describe('a client that goes away frees the probe slot and changes nothing', () => {
  it.each([
    ['waiting for the response headers', hold],
    ['reading the response body', stallBody],
  ])('while the probe is %s', async (_label, probeBehaviour) => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openThenCool(upstream, gateway);
    upstream.behaviour = probeBehaviour;

    const probe = gateway.send(USERS);
    void probe.answer.catch(() => undefined);
    await until(() => upstream.exchanges.length === 2, 'the probe');
    await sleep(50); // the stalled body's headers have reached the gateway
    probe.abort();

    // The upstream call is cancelled with the client…
    await until(() => upstream.exchanges[1]!.abandoned, 'the probe upstream call to be aborted');
    // …and neither a success nor a failure was recorded.
    expect(gateway.proxy.circuitStates().identity).toEqual({
      failures: 1,
      open: false,
      state: 'HALF_OPEN',
    });

    upstream.behaviour = ok;
    expect((await gateway.send(USERS).answer).status).toBe(200); // the next probe
    expect(upstream.exchanges).toHaveLength(3);
    expect(gateway.proxy.circuitStates().identity?.state).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
// Isolation and tenant boundaries
// ---------------------------------------------------------------------------

describe('circuits are per service; tenants share a service’s circuit and keep their own context', () => {
  it('identity’s open circuit and its probe leave organization-service’s traffic alone', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openThenCool(upstream, gateway);
    upstream.behaviour = (exchange) =>
      exchange.url.startsWith('/v1/users') ? undefined : ok(exchange);

    const probe = gateway.send(USERS);
    await until(() => upstream.exchanges.length === 2, 'the identity probe');
    const others = await Promise.all(
      Array.from({ length: 5 }, () => gateway!.send('/v1/organizations/ORG_A').answer),
    );
    expect(others.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
    expect(gateway.proxy.circuitStates().organization).toBeUndefined();
    expect(gateway.proxy.circuitStates().identity?.state).toBe('HALF_OPEN');

    answer(upstream.exchanges[1]!.res, 200, { ok: true });
    expect((await probe.answer).status).toBe(200);
  });

  it('two tenants share identity’s breaker; refusals before forwarding never take the probe; each request keeps its own tenant', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openThenCool(upstream, gateway); // opened by tenant A's request

    // Authentication, rate limit and the route's role check all run before
    // admission: none of these reaches the breaker, so none takes the slot.
    expect((await gateway.send(USERS, { caller: 'anonymous' }).answer).status).toBe(401);
    expect((await gateway.send(USERS, { caller: 'LIMITED' }).answer).status).toBe(429);
    expect((await gateway.send('/v1/ledger/entries', { caller: 'B' }).answer).status).toBe(403);
    expect(upstream.exchanges).toHaveLength(1);

    // Tenant B's request is the probe; tenant A is refused meanwhile.
    upstream.behaviour = hold;
    const probe = gateway.send(USERS, { caller: 'B' });
    await until(() => upstream.exchanges.length === 2, 'tenant B’s probe');
    expect(await gateway.send(USERS, { caller: 'A' }).answer).toMatchObject({
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    });
    const forwarded = upstream.exchanges[1]!.headers;
    expect(forwarded['x-organization-id']).toBe('ORG_B');
    expect(forwarded['x-user-id']).toBe('USR_B');
    expect(forwarded['x-internal-token']).toEqual(expect.any(String));

    answer(upstream.exchanges[1]!.res, 200, { ok: true });
    expect((await probe.answer).status).toBe(200);

    upstream.behaviour = ok;
    expect((await gateway.send(USERS, { caller: 'A' }).answer).status).toBe(200);
    expect(upstream.exchanges[2]!.headers['x-organization-id']).toBe('ORG_A');
    expect(upstream.exchanges[2]!.headers['x-user-id']).toBe('USR_A');
  });
});

// ---------------------------------------------------------------------------
// Money: a probe is never resent and never re-keyed
// ---------------------------------------------------------------------------

describe('a financial probe', () => {
  const TRANSFER = '/v1/wallets/WAL_1/transfers';

  async function openEconomicThenCool(): Promise<void> {
    upstream.behaviour = crash;
    const opened = gateway!.send(TRANSFER, {
      method: 'POST',
      headers: { 'idempotency-key': 'KEY-OPEN' },
    });
    expect((await opened.answer).status).toBe(503);
    expect(gateway!.proxy.circuitStates().economic?.state).toBe('OPEN');
    await sleep(PAST_COOLDOWN_MS);
  }

  it('without its Idempotency-Key is refused before admission and does not take the slot', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 4000,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openEconomicThenCool();

    expect(await gateway.send(TRANSFER, { method: 'POST' }).answer).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    // Never reached the breaker: still OPEN, past its cooldown, the slot unused.
    expect(gateway.proxy.circuitStates().economic?.state).toBe('OPEN');
    expect(upstream.exchanges).toHaveLength(1);

    upstream.behaviour = ok;
    const keyed = gateway.send(TRANSFER, {
      method: 'POST',
      headers: { 'idempotency-key': 'KEY-1' },
    });
    expect((await keyed.answer).status).toBe(200);
    expect(upstream.exchanges).toHaveLength(2);
  });

  it('that times out is answered UPSTREAM_TIMEOUT, sent once with the client’s own key, never resent', async () => {
    gateway = await startGateway(upstream, {
      timeoutMs: 300,
      failureThreshold: 1,
      resetAfterMs: COOLDOWN_MS,
    });
    await openEconomicThenCool();
    upstream.behaviour = hold;

    const probe = gateway.send(TRANSFER, {
      method: 'POST',
      headers: { 'idempotency-key': 'KEY-1' },
    });
    // 504, not "nothing happened": the write may have committed upstream.
    expect(await probe.answer).toMatchObject({ status: 504, code: 'UPSTREAM_TIMEOUT' });
    await sleep(PAST_COOLDOWN_MS);

    const probes = upstream.exchanges.slice(1);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ method: 'POST', url: TRANSFER });
    expect(probes[0]!.headers['idempotency-key']).toBe('KEY-1');
    expect(gateway.proxy.circuitStates().economic?.state).toBe('OPEN');
  });
});

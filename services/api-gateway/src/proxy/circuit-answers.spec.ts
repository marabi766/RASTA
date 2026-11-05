import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { InternalTokenService, runWithContext } from '@rasta/nest-common';
import { SERVICE_NAMES, type ServiceName, type ServiceUrls } from '../config/routes';
import { ProxyService, READINESS_PATH, answerOutcome } from './proxy.service';

/**
 * What a complete answer proves, over real HTTP (#758 review R2 = FU-109,
 * R3 = FU-110), and colluding callers against a ready service (FU-113).
 */

const THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
});
afterAll(() => jest.restoreAllMocks());

function envelope(code: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    code,
    message: 'refused',
    correlationId: 'req-upstream',
    timestamp: '2026-11-05T00:00:00.000Z',
    ...extra,
  });
}

/** Every path the tests use, and what the one upstream answers on it. */
const ANSWERS: Record<string, [number, string]> = {
  '/v1/users/me': [200, '{}'],
  '/v1/users/poison': [500, '{}'],
  '/v1/users/invalid': [400, envelope('VALIDATION_FAILED')],
  '/v1/memberships/settling/revoke': [503, envelope('KEYCLOAK_WRITE_SETTLING')],
  '/v1/memberships/keycloak-down/revoke': [503, envelope('KEYCLOAK_UNAVAILABLE')],
  '/v1/memberships/not-an-envelope/revoke': [503, '{"code":"KEYCLOAK_UNAVAILABLE"}'],
  '/v1/memberships/upstream/revoke': [503, envelope('UPSTREAM_UNAVAILABLE')],
  '/v1/memberships/as-500/revoke': [500, envelope('KEYCLOAK_UNAVAILABLE')],
};

let server: Server;
let urls: ServiceUrls;
let ready: boolean;
let checks: number;
let forwarded: string[];
let clock: number;
let proxy: ProxyService;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === READINESS_PATH) {
      checks += 1;
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    forwarded.push(req.url ?? '');
    const [status, body] = ANSWERS[req.url ?? ''] ?? [404, envelope('NOT_FOUND')];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  urls = Object.fromEntries(
    SERVICE_NAMES.map((name) => [`${name.toUpperCase()}_SERVICE_URL`, `http://127.0.0.1:${port}`]),
  ) as unknown as ServiceUrls;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  ready = false;
  checks = 0;
  forwarded = [];
  clock = 1_000;
  // The production defaults: five failures, three organizations, a 30 s cooldown.
  proxy = new ProxyService(
    urls,
    new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
    { timeoutMs: 500, failureThreshold: THRESHOLD, resetAfterMs: COOLDOWN_MS, now: () => clock },
  );
});

/** One request of `org`'s own person; resolves with its status or refusal code. */
function call(org: string | undefined, path: string, service: ServiceName = 'identity') {
  return runWithContext(
    {
      correlationId: 'req-answers',
      requestId: 'req-answers',
      ...(org ? { organizationId: org, subject: `SUB_${org}`, userId: `USR_${org}` } : {}),
      roles: [],
      organizationIds: org ? [org] : [],
      authType: org ? ('USER' as const) : ('ANONYMOUS' as const),
      startedAt: 0,
    },
    () =>
      proxy.forward({ service, method: 'POST', path, query: '', headers: {}, body: {} }).then(
        ({ status }) => status,
        (error: { code?: string }) => error.code ?? 'error',
      ),
  );
}

const state = () => proxy.circuitStates().identity?.state ?? 'CLOSED';

async function outage() {
  for (const org of ['ORG_X', 'ORG_Y', 'ORG_Z', 'ORG_X', 'ORG_Y']) {
    expect(await call(org, '/v1/users/poison')).toBe('UPSTREAM_UNAVAILABLE');
  }
  expect(state()).toBe('OPEN');
}

describe('a 4xx is a refusal of one request, not recovery (#758 R2, FU-109)', () => {
  it('another tenant’s 400 does not erase the failures of others: the run still opens', async () => {
    for (const org of ['ORG_A', 'ORG_B', 'ORG_C', 'ORG_D']) await call(org, '/v1/users/poison');
    expect(await call('ORG_ATTACKER', '/v1/users/invalid')).toBe(400);
    await call('ORG_E', '/v1/users/poison');
    expect(state()).toBe('OPEN');
  });

  it('a 400 recovery probe neither closes the circuit nor clears its state', async () => {
    await outage();
    clock += COOLDOWN_MS;
    expect(await call('ORG_ATTACKER', '/v1/users/invalid')).toBe(400);
    expect(state()).toBe('HALF_OPEN');
    // The slot is free again for whoever asks next, and the circuit is as it was.
    expect(await call('ORG_VICTIM', '/v1/users/poison')).toBe('UPSTREAM_UNAVAILABLE');
    expect(state()).toBe('HALF_OPEN');
  });

  it('interleaved 400s do not keep one organization from shedding itself', async () => {
    for (let i = 0; i < THRESHOLD; i += 1) {
      expect(await call('ORG_ATTACKER', '/v1/users/poison')).toBe('UPSTREAM_UNAVAILABLE');
      if (i < THRESHOLD - 1) expect(await call('ORG_ATTACKER', '/v1/users/invalid')).toBe(400);
    }
    const sent = forwarded.length;
    expect(await call('ORG_ATTACKER', '/v1/users/me')).toBe('UPSTREAM_UNAVAILABLE');
    expect(forwarded).toHaveLength(sent);
  });
});

describe('identity’s exempt refusals are neutral, complete and from identity only (#758 R3, FU-110)', () => {
  it.each(['settling', 'keycloak-down'])(
    'five complete %s answers neither shed the organization nor open anything',
    async (which) => {
      for (const org of ['ORG_A', 'ORG_B', 'ORG_C']) {
        for (let i = 0; i < THRESHOLD; i += 1) {
          expect(await call(org, `/v1/memberships/${which}/revoke`)).toBe(503);
        }
      }
      expect(await call('ORG_A', '/v1/users/me')).toBe(200);
      expect(state()).toBe('CLOSED');
      expect(proxy.circuitStates().identity).toBeUndefined();
      expect(checks).toBe(0);
    },
  );

  it.each<[string, string, ServiceName]>([
    ['without a valid envelope', '/v1/memberships/not-an-envelope/revoke', 'identity'],
    ['with another 503 code', '/v1/memberships/upstream/revoke', 'identity'],
    ['as a 500', '/v1/memberships/as-500/revoke', 'identity'],
    ['from another service', '/v1/memberships/keycloak-down/revoke', 'organization'],
  ])('%s, it is still a failure that sheds the organization', async (_label, path, service) => {
    for (let i = 0; i < THRESHOLD; i += 1) await call('ORG_A', path, service);
    const sent = forwarded.length;
    expect(await call('ORG_A', '/v1/users/me', service)).toBe('UPSTREAM_UNAVAILABLE');
    expect(forwarded).toHaveLength(sent);
  });

  it('one place decides: only 2xx–3xx is recovery', () => {
    expect(answerOutcome('identity', 204, null)).toBe('success');
    expect(answerOutcome('identity', 304, null)).toBe('success');
    expect(answerOutcome('identity', 400, null)).toBe('release');
    expect(answerOutcome('identity', 499, null)).toBe('release');
    expect(answerOutcome('identity', 503, null)).toBe('failure');
  });
});

describe('colluding organizations against a ready service, over HTTP (FU-113)', () => {
  it.each([3, 5, 10])(
    '%i organizations plus anonymous hammering a route that crashes open nothing for anyone',
    async (n) => {
      ready = true;
      const callers = [...Array.from({ length: n }, (_, i) => `ORG_C${i}`), undefined];
      for (let round = 0; round < THRESHOLD + 2; round += 1) {
        for (const org of callers) await call(org, '/v1/users/poison');
      }
      expect(state()).toBe('CLOSED');
      expect(await call('ORG_VICTIM', '/v1/users/me')).toBe(200);
      expect(checks).toBeGreaterThan(0);
    },
  );

  it('a service the check finds not ready opens on the same failures', async () => {
    const callers = ['ORG_C0', 'ORG_C1', 'ORG_C2'];
    for (let round = 0; round < 2; round += 1) {
      for (const org of callers) await call(org, '/v1/users/poison');
    }
    expect(state()).toBe('OPEN');
    expect(await call('ORG_VICTIM', '/v1/users/me')).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('after an outage, a colluder’s failed probe hands recovery to the check, which closes it', async () => {
    await outage();
    ready = true;
    clock += COOLDOWN_MS;
    expect(await call('ORG_C0', '/v1/users/poison')).toBe('UPSTREAM_UNAVAILABLE');
    expect(state()).toBe('CLOSED');
    expect(await call('ORG_VICTIM', '/v1/users/me')).toBe(200);
  });
});

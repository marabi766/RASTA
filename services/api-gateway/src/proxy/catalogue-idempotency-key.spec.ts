import { randomBytes } from 'node:crypto';
import { GatewayController } from './gateway.controller';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { RateLimiter, RateLimitRule } from './rate-limiter';
import type { ProxyService } from './proxy.service';
import type { GatewayEnv } from '../config/env';
import { RevocationGate } from '../revocation/revocation-gate';

/**
 * The catalogue's writes require an `Idempotency-Key` at the gateway; its reads
 * do not (docs/06 § 6.8 lists publishing an offer — a double submit published
 * two). Driven through `GatewayController.handle`, so what is asserted is what
 * reaches the upstream, not only the routing table's flag.
 */

/** Generated, not written down: a literal Idempotency-Key reads as a secret to the scanner. */
const KEY = `catalogue-${randomBytes(8).toString('hex')}`;

const env = {
  GATEWAY_RATE_LIMIT_MAX: 300,
  GATEWAY_RATE_LIMIT_WINDOW_MS: 60_000,
  GATEWAY_TENANT_RATE_LIMIT_MAX: 3000,
  GATEWAY_ANON_RATE_LIMIT_MAX: 60,
} as unknown as GatewayEnv;

const context: RequestContext = {
  correlationId: 'COR-CAT',
  requestId: 'REQ-CAT',
  organizationId: 'ORG-CAT',
  userId: 'USR-CAT',
  roles: ['SUPPLIER'],
  organizationIds: [],
  authType: 'USER',
  startedAt: 0,
};

const limiter = {
  consume: async (_scope: string, _identifier: string, rule: RateLimitRule) => ({
    allowed: true,
    limit: rule.limit,
    remaining: 1,
    resetAt: 0,
    retryAfterSeconds: 0,
  }),
} as unknown as RateLimiter;

function requestFor(method: string, path: string, headers: Record<string, string> = {}) {
  return {
    method,
    path,
    originalUrl: path,
    headers,
    body: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as never;
}

const response = () =>
  ({
    setHeader: () => undefined,
    status: () => response(),
    json: () => undefined,
    end: () => undefined,
  }) as never;

/** Sends one request; resolves with whether the upstream was reached. */
async function send(
  method: string,
  path: string,
  headers?: Record<string, string>,
): Promise<boolean> {
  const forward = jest.fn(async () => ({ status: 200, headers: {}, body: {} }));
  const controller = new GatewayController(
    { forward } as unknown as ProxyService,
    limiter,
    env,
    RevocationGate.off(),
  );
  await runWithContext(context, () =>
    controller.handle(requestFor(method, path, headers), response()),
  );
  return forward.mock.calls.length === 1;
}

describe('the catalogue at the gateway: Idempotency-Key on writes, never on reads', () => {
  it.each([
    ['POST', '/v1/products'],
    ['POST', '/v1/offers'],
    ['PATCH', '/v1/offers/OFR_1'],
  ])('refuses %s %s without a key, before the upstream', async (method, path) => {
    await expect(send(method, path)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(send(method, path, { 'idempotency-key': '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it.each([
    ['POST', '/v1/products'],
    ['POST', '/v1/offers'],
    ['PATCH', '/v1/offers/OFR_1'],
  ])('forwards %s %s with a key', async (method, path) => {
    expect(await send(method, path, { 'idempotency-key': KEY })).toBe(true);
  });

  it.each([
    ['GET', '/v1/products'],
    ['GET', '/v1/products/PRD_1'],
    ['GET', '/v1/products/PRD_1/offers'],
    ['GET', '/v1/offers'],
  ])('forwards %s %s with no key at all', async (method, path) => {
    expect(await send(method, path)).toBe(true);
  });
});

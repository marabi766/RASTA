import { GatewayController } from './gateway.controller';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { RateLimiter, RateLimitRule } from './rate-limiter';
import type { ProxyService } from './proxy.service';
import type { GatewayEnv } from '../config/env';

/**
 * Which rate-limit rule a request is measured against.
 *
 * This is the one piece of the gateway where a routing-table entry and an HTTP
 * method combine into a decision, and it is easy to get subtly wrong in a way
 * no other test would notice: a route override that also caught reads would
 * still return 200 for the first twenty requests and only bite a real user on
 * their second screen of documents.
 *
 * The limiter and the upstream are stubbed because neither is under test here.
 * What is under test is the rule handed to `consume`.
 */

const PLATFORM_DEFAULT = { limit: 300, windowSeconds: 60 };

const env = {
  GATEWAY_RATE_LIMIT_MAX: PLATFORM_DEFAULT.limit,
  GATEWAY_RATE_LIMIT_WINDOW_MS: PLATFORM_DEFAULT.windowSeconds * 1000,
  GATEWAY_TENANT_RATE_LIMIT_MAX: 3000,
  GATEWAY_ANON_RATE_LIMIT_MAX: 60,
} as unknown as GatewayEnv;

const context: RequestContext = {
  correlationId: 'COR-RL',
  requestId: 'REQ-RL',
  organizationId: 'ORG-RL',
  userId: 'USR-RL',
  roles: ['ORGANIZATION_ADMIN'],
  authType: 'USER',
  startedAt: 0,
};

/** Records the rule each `consume` call was given. */
function recordingLimiter() {
  const calls: Array<{ scope: string; rule: RateLimitRule }> = [];
  const limiter = {
    consume: async (scope: string, _identifier: string, rule: RateLimitRule) => {
      calls.push({ scope, rule });
      return { allowed: true, limit: rule.limit, remaining: 1, resetAt: 0, retryAfterSeconds: 0 };
    },
  } as unknown as RateLimiter;
  return { limiter, calls };
}

const proxy = {
  forward: async () => ({ status: 200, headers: {}, body: {} }),
} as unknown as ProxyService;

function requestFor(method: string, path: string) {
  return {
    method,
    path,
    originalUrl: path,
    headers: {},
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

async function ruleUsedFor(method: string, path: string): Promise<RateLimitRule> {
  const { limiter, calls } = recordingLimiter();
  const controller = new GatewayController(proxy, limiter, env);

  await runWithContext(context, () => controller.handle(requestFor(method, path), response()));

  const routeCall = calls.find((call) => call.scope.startsWith('user:'));
  if (!routeCall) throw new Error('the controller consumed no per-route budget');
  return routeCall.rule;
}

describe('a route override marked unsafeMethodsOnly', () => {
  it('applies to a write', async () => {
    // `docs/06` § 6.9: twenty document uploads an hour.
    expect(await ruleUsedFor('POST', '/v1/documents/upload-url')).toEqual({
      limit: 20,
      windowSeconds: 3600,
      unsafeMethodsOnly: true,
    });
  });

  it('applies to a deletion', async () => {
    expect((await ruleUsedFor('DELETE', '/v1/documents/DOC_1')).limit).toBe(20);
  });

  it('does not apply to a read', async () => {
    // The point of the flag. Twenty an hour on GET would empty a user's
    // budget on one page of their own document list.
    expect(await ruleUsedFor('GET', '/v1/documents')).toEqual(PLATFORM_DEFAULT);
  });

  it('does not apply to a HEAD or an OPTIONS either', async () => {
    expect(await ruleUsedFor('HEAD', '/v1/documents')).toEqual(PLATFORM_DEFAULT);
    expect(await ruleUsedFor('OPTIONS', '/v1/documents')).toEqual(PLATFORM_DEFAULT);
  });
});

describe('a route override without the flag', () => {
  it('still applies to every method', async () => {
    // `products` carries the search limit, which is about read volume — so
    // narrowing it to writes would be the wrong change and this guards it.
    expect((await ruleUsedFor('GET', '/v1/products')).limit).toBe(60);
    expect((await ruleUsedFor('POST', '/v1/products')).limit).toBe(60);
  });
});

describe('a route with no override', () => {
  it('uses the platform default for reads and writes alike', async () => {
    expect(await ruleUsedFor('GET', '/v1/users/me')).toEqual(PLATFORM_DEFAULT);
    expect(await ruleUsedFor('POST', '/v1/users')).toEqual(PLATFORM_DEFAULT);
  });
});

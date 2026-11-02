import { EventEmitter } from 'node:events';
import { GatewayController } from './gateway.controller';
import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { RateLimiter, RateLimitRule } from './rate-limiter';
import type { ProxyService } from './proxy.service';
import type { GatewayEnv } from '../config/env';

/**
 * What a route override's quota does to the requests it is not about (task
 * 130, PR #483 r1 R6).
 *
 * `rate-limit-scope.spec.ts` checks the rule and bucket each request is handed;
 * this one runs sequences through a limiter that counts the way the Redis
 * script does (`rate-limiter.ts`: one sorted set per key, trimmed to the
 * consuming rule's window, then counted), so a shared bucket shows up as what
 * it did to a user:
 *
 * - a reviewer's sixth page load of the registration queue, or a decision
 *   after five, refused for an hour by the public submission's five an hour;
 * - on `documents`, one read trimming the set to its minute and so wiping the
 *   hour of uploads the twenty-an-hour cap had counted.
 */

const PLATFORM_DEFAULT = { limit: 300, windowSeconds: 60 };

const env = {
  GATEWAY_RATE_LIMIT_MAX: PLATFORM_DEFAULT.limit,
  GATEWAY_RATE_LIMIT_WINDOW_MS: PLATFORM_DEFAULT.windowSeconds * 1000,
  GATEWAY_TENANT_RATE_LIMIT_MAX: 3000,
  GATEWAY_ANON_RATE_LIMIT_MAX: 60,
} as unknown as GatewayEnv;

const reviewer: RequestContext = {
  correlationId: 'COR-RB',
  requestId: 'REQ-RB',
  organizationId: 'ORG-RB',
  userId: 'USR-RB',
  roles: ['UNION_ADMIN'],
  organizationIds: ['ORG-RB'],
  authType: 'USER',
  startedAt: 0,
};

const anonymous: RequestContext = {
  correlationId: 'COR-RB-A',
  requestId: 'REQ-RB-A',
  roles: [],
  organizationIds: [],
  authType: 'ANONYMOUS',
  startedAt: 0,
};

/** The Redis script's arithmetic, on a clock the test moves. */
function slidingWindowLimiter() {
  const sets = new Map<string, number[]>();
  const clock = { now: 1_000_000 };
  const limiter = {
    consume: async (scope: string, identifier: string, rule: RateLimitRule) => {
      const key = `${scope}:${identifier}`;
      const kept = (sets.get(key) ?? []).filter((at) => at > clock.now - rule.windowSeconds * 1000);
      const allowed = kept.length < rule.limit;
      if (allowed) kept.push(clock.now);
      sets.set(key, kept);
      return {
        allowed,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - kept.length),
        resetAt: 0,
        retryAfterSeconds: allowed ? 0 : rule.windowSeconds,
      };
    },
  } as unknown as RateLimiter;
  return { limiter, clock };
}

const proxy = {
  forward: async () => ({ status: 200, headers: {}, body: {} }),
} as unknown as ProxyService;

const response = () =>
  Object.assign(new EventEmitter(), {
    closed: false,
    writableFinished: false,
    setHeader: () => undefined,
    status: () => response(),
    json: () => undefined,
    end: () => undefined,
  }) as never;

function gateway() {
  const { limiter, clock } = slidingWindowLimiter();
  const controller = new GatewayController(proxy, limiter, env);
  /** 'ok', or 'limited' for the gateway's 429. */
  const send = async (context: RequestContext, method: string, url: string) => {
    const request = {
      method,
      path: url.split('?')[0],
      originalUrl: url,
      query: Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? '')),
      headers: {},
      body: {},
      ip: '198.51.100.7',
      socket: { remoteAddress: '198.51.100.7' },
    } as never;
    try {
      await runWithContext(context, () => controller.handle(request, response()));
      return 'ok';
    } catch (error) {
      if (error instanceof RastaError && error.code === 'RATE_LIMIT_EXCEEDED') return 'limited';
      throw error;
    }
  };
  return { send, clock };
}

describe('registration review is not throttled by the public submission quota (R6)', () => {
  it('a reviewer reads the queue a sixth time, and approves and rejects after it', async () => {
    const { send } = gateway();

    for (let load = 0; load < 5; load += 1) {
      expect(await send(reviewer, 'GET', '/v1/registration-requests')).toBe('ok');
    }

    expect(await send(reviewer, 'GET', '/v1/registration-requests?status=PENDING')).toBe('ok');
    expect(await send(reviewer, 'POST', '/v1/registration-requests/REG_1/approve')).toBe('ok');
    expect(await send(reviewer, 'POST', '/v1/registration-requests/REG_2/reject')).toBe('ok');
  });

  it('the submission keeps its five an hour, anonymous or signed in, and review traffic does not spend it', async () => {
    const { send, clock } = gateway();

    for (let read = 0; read < 20; read += 1) {
      expect(await send(reviewer, 'GET', '/v1/registration-requests')).toBe('ok');
    }
    for (let submission = 0; submission < 5; submission += 1) {
      expect(await send(anonymous, 'POST', '/v1/registration-requests')).toBe('ok');
      expect(await send(reviewer, 'POST', '/v1/registration-requests')).toBe('ok');
    }
    expect(await send(anonymous, 'POST', '/v1/registration-requests')).toBe('limited');
    expect(await send(reviewer, 'POST', '/v1/registration-requests')).toBe('limited');

    // Still refused after the platform window, still allowed after the hour.
    clock.now += 61_000;
    expect(await send(anonymous, 'POST', '/v1/registration-requests')).toBe('limited');
    clock.now += 3_600_000;
    expect(await send(anonymous, 'POST', '/v1/registration-requests')).toBe('ok');
  });
});

describe('a read does not reset the document upload cap (R6 sibling)', () => {
  it('twenty uploads an hour stay twenty after a listing in between', async () => {
    const { send, clock } = gateway();

    for (let upload = 0; upload < 20; upload += 1) {
      expect(await send(reviewer, 'POST', '/v1/documents/upload-url')).toBe('ok');
    }
    clock.now += 120_000;
    expect(await send(reviewer, 'GET', '/v1/documents')).toBe('ok');
    clock.now += 1_000;

    expect(await send(reviewer, 'POST', '/v1/documents/upload-url')).toBe('limited');
  });
});

import { loadGatewayEnv } from '../config/env';
import { Logger } from '@nestjs/common';
import { RateLimiter, redisFailure } from './rate-limiter';

/**
 * What `GATEWAY_RATE_LIMIT_FAIL_OPEN` actually decides, end to end.
 *
 * `env.spec.ts` proves the flag parses. This proves the parse changes the
 * decision: the value goes into `RateLimiter` exactly as `app.module.ts` wires
 * it, Redis is then unreachable, and the request is either admitted or
 * refused. That is the whole point of the flag, and it is the reason D-020 was
 * filed as a security defect rather than a tidiness one.
 *
 * Against the previous `z.coerce.boolean()`, the fail-closed case below
 * returns `allowed: true` — an operator who configured the gateway to refuse
 * traffic during a Redis outage got a gateway that admitted all of it,
 * unrate-limited, with nothing in the logs to say so.
 */

/**
 * Redis is mocked rather than merely pointed at a dead port: the failure has
 * to be the same failure every time, on every machine, with no socket, no
 * reconnect timer and no open handle left behind.
 */
const evalsha = jest.fn();
const scriptLoad = jest.fn();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class {
    on = jest.fn();
    quit = jest.fn().mockResolvedValue('OK');
    ping = jest.fn().mockRejectedValue(new Error('unreachable'));
    script = (...args: unknown[]) => scriptLoad(...args);
    evalsha = (...args: unknown[]) => evalsha(...args);
    eval = (...args: unknown[]) => evalsha(...args);
  },
}));

const SERVICE_URLS: NodeJS.ProcessEnv = Object.fromEntries(
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
);

const BASE: NodeJS.ProcessEnv = {
  ...SERVICE_URLS,
  REDIS_URL: 'redis://localhost:6379',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
};

const RULE = { limit: 100, windowSeconds: 60 };

/** Builds the limiter the way `app.module.ts` does, from parsed configuration. */
function limiterFrom(failOpenValue?: string): RateLimiter {
  const env = loadGatewayEnv({
    ...BASE,
    ...(failOpenValue === undefined ? {} : { GATEWAY_RATE_LIMIT_FAIL_OPEN: failOpenValue }),
  });

  return new RateLimiter(env.REDIS_URL, env.REDIS_KEY_PREFIX, env.GATEWAY_RATE_LIMIT_FAIL_OPEN);
}

describe('rate limiting when Redis is unreachable', () => {
  let limiter: RateLimiter | undefined;

  beforeEach(() => {
    scriptLoad.mockRejectedValue(new Error('Redis unreachable'));
    evalsha.mockRejectedValue(new Error('Redis unreachable'));
  });

  afterEach(async () => {
    await limiter?.onModuleDestroy();
    limiter = undefined;
  });

  it('admits the request when the deployment left the default alone', async () => {
    // The documented default: a cache outage degrades the platform rather than
    // closing it. Unchanged by this fix, and asserted so it stays that way.
    limiter = limiterFrom();

    const result = await limiter.consume('user', 'user-1', RULE);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RULE.limit);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it('refuses the request when GATEWAY_RATE_LIMIT_FAIL_OPEN=false', async () => {
    // The regression. Under `z.coerce.boolean()` the string "false" parsed as
    // `true`, so this returned `allowed: true`: a deployment that asked to
    // fail closed failed open, silently, for as long as Redis was down.
    limiter = limiterFrom('false');

    const result = await limiter.consume('user', 'user-1', RULE);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(RULE.windowSeconds);
  });

  it.each(['FALSE', '0', 'no', 'off'])(
    'refuses the request when the operator wrote %p',
    async (value) => {
      // The spellings a person actually types. Each one is a fail-closed
      // instruction, and each one has to arrive as a refusal.
      limiter = limiterFrom(value);

      expect((await limiter.consume('user', 'user-1', RULE)).allowed).toBe(false);
    },
  );

  it('still admits the request when fail-open is asked for explicitly', async () => {
    limiter = limiterFrom('true');

    expect((await limiter.consume('user', 'user-1', RULE)).allowed).toBe(true);
  });
});

describe('what is logged about Redis (#385 r6)', () => {
  // The sentinels of scripts/refusal-probes.mjs, as REDIS_URL's credentials
  // and in what the client reports.
  const SENTINEL = /sentinel|jz97|another[-_]secret/i;
  const URL_WITH_CREDENTIALS = [
    'redis://',
    'private-sentinel-79',
    ':',
    'JZ97-another-secret',
    '@cache.invalid:6379',
  ].join('');
  const leaky = (): Error =>
    Object.assign(new Error(`connect ECONNREFUSED ${URL_WITH_CREDENTIALS}`), {
      code: 'ECONNREFUSED',
    });
  let limiter: RateLimiter | undefined;

  afterEach(async () => {
    await limiter?.onModuleDestroy();
    limiter = undefined;
  });

  it('an error event and a failed check are logged by class and code only', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    evalsha.mockRejectedValue(leaky());
    scriptLoad.mockRejectedValue(leaky());
    limiter = new RateLimiter(URL_WITH_CREDENTIALS, 'rasta', true);
    const on = (limiter as unknown as { redis: { on: jest.Mock } }).redis.on;
    const onError = on.mock.calls.find(([event]) => event === 'error')?.[1] as (e: Error) => void;
    onError(leaky());
    await limiter.consume('user', 'user-1', RULE);

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'Redis unavailable for rate limiting (REDIS_URL): Error ECONNREFUSED',
      'Rate limit check failed (Error ECONNREFUSED); allowing the request',
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(SENTINEL);
    warn.mockRestore();
  });

  it('redisFailure keeps a class and a well-formed code, nothing else', () => {
    expect(redisFailure(Object.assign(new Error('x'), { code: URL_WITH_CREDENTIALS }))).toBe(
      'Error',
    );
    expect(redisFailure(Object.assign(new Error('x'), { name: URL_WITH_CREDENTIALS }))).toBe(
      'unknown',
    );
    expect(redisFailure(URL_WITH_CREDENTIALS)).toBe('unknown');
  });
});

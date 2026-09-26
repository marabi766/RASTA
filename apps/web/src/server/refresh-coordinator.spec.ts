/**
 * @jest-environment node
 */
import { OidcError, type TokenResponse } from './oidc';
import {
  LocalRefreshFlights,
  processRefreshCoordinator,
  redisRefreshCoordinator,
  refreshKeyOf,
  type RedisLike,
  type RefreshOutcome,
} from './refresh-coordinator';
import { openSession, seal, sealSession, type WebSession } from './session';
import type { RenewalDependencies, SessionRenewal } from './session-refresh';

/**
 * One refresh per refresh token across replicas (Codex #113 R1-1), and a
 * per-process cache that cannot grow or linger (R1-2).
 */

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
const T0 = 1_900_000_000;
const NOW = (T0 + 880) * 1000; // inside the refresh skew of a 900 s token

const ENV: RenewalDependencies['env'] = {
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_SESSION_SECRET: SECRET,
  WEB_SESSION_MAX_AGE_SECONDS: 12 * 60 * 60,
};

const session = (): WebSession => ({
  subject: 'USR_01J8',
  username: 'dehyar',
  organizationId: 'ORG_01J8',
  accessToken: 'access-0',
  accessTokenExpiresAt: T0 + 900,
  refreshToken: 'refresh-0',
  csrfToken: 'csrf-token-value',
  issuedAt: T0,
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * One Keycloak for every replica, behaving like the realm: each refresh token
 * works once, a spent one is refused. Answers after a few event-loop turns, so
 * concurrent callers genuinely overlap.
 */
function sharedKeycloak() {
  const spent = new Set<string>();
  const calls: string[] = [];
  let issued = 0;
  const refresh = async (refreshToken: string): Promise<TokenResponse> => {
    calls.push(refreshToken);
    await tick();
    await tick();
    if (spent.has(refreshToken)) {
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider answered 400');
    }
    spent.add(refreshToken);
    issued += 1;
    return {
      access_token: `access-${issued}`,
      refresh_token: `refresh-${issued}`,
      id_token: `id-${issued}`,
      expires_in: 900,
      token_type: 'Bearer',
    };
  };
  return { refresh, calls };
}

/** A Redis with just the commands the coordinator uses, and real expiry. */
class FakeRedis implements RedisLike {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  down = false;

  private live(key: string) {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private async hop() {
    if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    await tick();
  }

  async get(key: string) {
    await this.hop();
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, _px: 'PX', ttlMs: number, nx?: 'NX') {
    await this.hop();
    if (nx && this.live(key)) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return 'OK' as const;
  }

  async exists(key: string) {
    await this.hop();
    return this.live(key) ? 1 : 0;
  }

  async eval(_script: string, _keys: number, key: string, owner: string) {
    await this.hop();
    if (this.live(key)?.value !== owner) return 0;
    this.store.delete(key);
    return 1;
  }
}

/**
 * A replica: its own copy of the modules — so its own per-process state,
 * exactly as a second pod or worker would have — sharing Keycloak and Redis
 * with the others.
 */
function replica(options: { redis?: RedisLike; lockTtlMs?: number; pollMs?: number } = {}) {
  let mod!: {
    renewSession: typeof import('./session-refresh').renewSession;
    coordinator: ReturnType<typeof redisRefreshCoordinator>;
    OidcError: typeof OidcError;
  };
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports -- an isolated copy per replica */
    const refresh = require('./session-refresh') as typeof import('./session-refresh');
    const coordination = require('./refresh-coordinator') as typeof import('./refresh-coordinator');
    const oidc = require('./oidc') as typeof import('./oidc');
    /* eslint-enable @typescript-eslint/no-require-imports */
    mod = {
      OidcError: oidc.OidcError,
      renewSession: refresh.renewSession,
      coordinator: options.redis
        ? coordination.redisRefreshCoordinator({
            redis: options.redis,
            secret: SECRET,
            lockTtlMs: options.lockTtlMs ?? 15_000,
            pollMs: options.pollMs ?? 1,
          })
        : coordination.processRefreshCoordinator(),
    };
  });
  return {
    renew: (cookie: string, refresh: (token: string) => Promise<TokenResponse>) =>
      mod.renewSession(cookie, {
        env: ENV,
        // Keycloak's refusal arrives as *this* replica's OidcError, as its own
        // `oidc.ts` would throw it: each isolated copy has its own class.
        refresh: async (token) => {
          try {
            return await refresh(token);
          } catch (error) {
            if (error instanceof OidcError) throw new mod.OidcError(error.reason, error.message);
            throw error;
          }
        },
        now: NOW,
        coordinator: mod.coordinator,
      }),
    coordinator: mod.coordinator,
  };
}

/** What the browser holds after applying responses in the order they arrived. */
function browserAfter(start: string, responses: SessionRenewal[]): string | null {
  let cookie: string | null = start;
  for (const response of responses) {
    if (response.kind === 'RENEWED') cookie = response.sealed;
    if (response.kind === 'ENDED') cookie = null;
    // VALID, NONE and REFUSED write nothing.
  }
  return cookie;
}

const refreshTokenIn = (cookie: string | null) =>
  cookie ? openSession(cookie, SECRET)?.refreshToken : undefined;

// ---------------------------------------------------------------------------

describe('two replicas, one refresh token (Codex #113 R1-1)', () => {
  it('spends the token once and gives both replicas the same rotated session', async () => {
    const keycloak = sharedKeycloak();
    const redis = new FakeRedis();
    const a = replica({ redis });
    const b = replica({ redis });
    const cookie = sealSession(session(), SECRET);

    const [fromA, fromB] = await Promise.all([
      a.renew(cookie, keycloak.refresh),
      b.renew(cookie, keycloak.refresh),
    ]);

    expect(keycloak.calls).toEqual(['refresh-0']);
    expect(fromA.kind).toBe('RENEWED');
    expect(fromB.kind).toBe('RENEWED');
    // Whichever response the browser applies last, it holds the rotated token.
    expect(refreshTokenIn(browserAfter(cookie, [fromA, fromB]))).toBe('refresh-1');
    expect(refreshTokenIn(browserAfter(cookie, [fromB, fromA]))).toBe('refresh-1');
  });

  it('serves a latecomer the stored result instead of spending the token again', async () => {
    const keycloak = sharedKeycloak();
    const redis = new FakeRedis();
    const cookie = sealSession(session(), SECRET);

    const first = await replica({ redis }).renew(cookie, keycloak.refresh);
    // A second tab's request, landing on another replica moments later.
    const late = await replica({ redis }).renew(cookie, keycloak.refresh);

    expect(keycloak.calls).toEqual(['refresh-0']);
    expect(first.kind).toBe('RENEWED');
    expect(late.kind).toBe('RENEWED');
  });

  it('without Redis, the loser’s refusal still cannot sign the person out, in either order', async () => {
    // The failover path: no coordination, Keycloak refuses the second spend.
    const keycloak = sharedKeycloak();
    const a = replica();
    const b = replica();
    const cookie = sealSession(session(), SECRET);

    const [fromA, fromB] = await Promise.all([
      a.renew(cookie, keycloak.refresh),
      b.renew(cookie, keycloak.refresh),
    ]);

    expect(keycloak.calls).toEqual(['refresh-0', 'refresh-0']);
    expect([fromA.kind, fromB.kind].sort()).toEqual(['REFUSED', 'RENEWED']);
    expect(refreshTokenIn(browserAfter(cookie, [fromA, fromB]))).toBe('refresh-1');
    expect(refreshTokenIn(browserAfter(cookie, [fromB, fromA]))).toBe('refresh-1');
  });

  it('falls back to an uncoordinated refresh when Redis is down, rather than failing the request', async () => {
    const keycloak = sharedKeycloak();
    const redis = new FakeRedis();
    redis.down = true;
    const errors: unknown[] = [];
    const coordinator = redisRefreshCoordinator({
      redis,
      secret: SECRET,
      onRedisError: (error) => errors.push(error),
    });

    const outcome = await coordinator.refresh('refresh-0', keycloak.refresh);

    expect(outcome.kind).toBe('ROTATED');
    expect(errors).toHaveLength(1);
  });

  it('takes over from a winner that vanished holding the lock', async () => {
    // A replica died after taking the lock and before storing anything.
    const keycloak = sharedKeycloak();
    const redis = new FakeRedis();
    await redis.set(`rasta:web:refresh:lock:${refreshKeyOf('refresh-0')}`, 'dead', 'PX', 30);
    const coordinator = redisRefreshCoordinator({
      redis,
      secret: SECRET,
      lockTtlMs: 30,
      pollMs: 5,
    });

    const outcome = await coordinator.refresh('refresh-0', keycloak.refresh);

    expect(outcome.kind).toBe('ROTATED');
    expect(keycloak.calls).toEqual(['refresh-0']);
  });

  it('shares a refusal too, so a dead token is not hammered from every replica', async () => {
    const redis = new FakeRedis();
    const calls: string[] = [];
    const refuse = async (token: string): Promise<TokenResponse> => {
      calls.push(token);
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider answered 400');
    };

    const first = await redisRefreshCoordinator({ redis, secret: SECRET }).refresh('dead', refuse);
    const second = await redisRefreshCoordinator({ redis, secret: SECRET }).refresh('dead', refuse);

    expect([first.kind, second.kind]).toEqual(['REFUSED', 'REFUSED']);
    expect(calls).toEqual(['dead']);
  });
});

describe('what Redis holds', () => {
  it('holds no token in the clear, under a key that is a hash', async () => {
    const redis = new FakeRedis();
    await redisRefreshCoordinator({ redis, secret: SECRET }).refresh(
      'refresh-0',
      sharedKeycloak().refresh,
    );

    const everything = JSON.stringify([...redis.store.entries()]);
    for (const token of ['refresh-0', 'refresh-1', 'access-1', 'id-1']) {
      expect(everything).not.toContain(token);
    }
  });

  it('ignores a stored outcome sealed for another refresh token', async () => {
    // Anybody able to write to the shared Redis could copy one person's
    // result under another's key; the binding makes it open as nobody's.
    const keycloak = sharedKeycloak();
    const redis = new FakeRedis();
    const foreign: RefreshOutcome = {
      kind: 'ROTATED',
      tokens: {
        access_token: 'someone-else',
        refresh_token: 'someone-else',
        id_token: 'someone-else',
        expires_in: 900,
        token_type: 'Bearer',
      },
    };
    await redis.set(
      `rasta:web:refresh:result:${refreshKeyOf('refresh-0')}`,
      seal({ key: refreshKeyOf('another-token'), outcome: foreign }, SECRET),
      'PX',
      30_000,
    );

    const outcome = await redisRefreshCoordinator({ redis, secret: SECRET }).refresh(
      'refresh-0',
      keycloak.refresh,
    );

    expect(outcome).toMatchObject({ kind: 'ROTATED', tokens: { access_token: 'access-1' } });
  });
});

// ---------------------------------------------------------------------------

describe('the per-process cache (Codex #113 R1-2)', () => {
  const rotated = (n: number): Promise<RefreshOutcome> =>
    Promise.resolve({
      kind: 'ROTATED',
      tokens: {
        access_token: `access-${n}`,
        refresh_token: `refresh-${n}`,
        id_token: `id-${n}`,
        expires_in: 900,
        token_type: 'Bearer',
      },
    });

  it('shares one flight among concurrent callers', async () => {
    const flights = new LocalRefreshFlights();
    const start = jest.fn(() => rotated(1));

    await Promise.all([flights.share('k', start), flights.share('k', start)]);

    expect(start).toHaveBeenCalledTimes(1);
    flights.clear();
  });

  it('lets every entry go on its own timer, with no later refresh needed to sweep it', async () => {
    // The finding: entries were swept only inside the *next* refresh, so after
    // a burst and then silence they held raw tokens forever.
    const flights = new LocalRefreshFlights(20, 1_000);
    for (let n = 0; n < 50; n += 1) await flights.share(`k${n}`, () => rotated(n));
    expect(flights.size).toBe(50);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(flights.size).toBe(0);
  });

  it('never keeps a process alive for an expiry timer', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const flights = new LocalRefreshFlights(60_000, 10);

    await flights.share('k', () => rotated(1));
    await tick();

    const timer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    setTimeoutSpy.mockRestore();
    flights.clear();
  });

  it('holds at most its limit, dropping the oldest', async () => {
    const flights = new LocalRefreshFlights(60_000, 3);
    for (let n = 0; n < 5; n += 1) await flights.share(`k${n}`, () => rotated(n));

    expect(flights.size).toBe(3);
    // The oldest two are gone: asking again starts a new flight.
    const again = jest.fn(() => rotated(9));
    await flights.share('k0', again);
    expect(again).toHaveBeenCalledTimes(1);
    flights.clear();
  });

  it('keeps a refusal only briefly, so a provider that recovers is asked again soon', async () => {
    const flights = new LocalRefreshFlights(60_000, 10, 20);
    await flights.share('k', () => Promise.resolve({ kind: 'REFUSED' }));
    expect(flights.size).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(flights.size).toBe(0);
  });

  it('stores a refusal in Redis for no longer than the refusal window', async () => {
    const redis = new FakeRedis();
    const refuse = async (): Promise<TokenResponse> => {
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider did not answer');
    };
    await redisRefreshCoordinator({ redis, secret: SECRET }).refresh('slow', refuse);

    const [entry] = [...redis.store.entries()].filter(([key]) => key.includes(':result:'));
    expect(entry![1].expiresAt - Date.now()).toBeLessThanOrEqual(5_000);
  });

  it('drops a failed flight at once, so the next request tries again', async () => {
    const flights = new LocalRefreshFlights();
    await expect(flights.share('k', () => Promise.reject(new TypeError('a bug')))).rejects.toThrow(
      'a bug',
    );
    await tick();
    expect(flights.size).toBe(0);
  });

  it('does not let an expired flight’s timer remove its successor', async () => {
    const flights = new LocalRefreshFlights(20, 10);
    await flights.share('k', () => rotated(1));
    flights.clear();
    await flights.share('k', () => rotated(2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(flights.size).toBe(1);
    flights.clear();
  });

  it('is what a coordinator without Redis uses', async () => {
    const coordinator = processRefreshCoordinator(new LocalRefreshFlights(60_000, 2));
    const keycloak = sharedKeycloak();
    await coordinator.refresh('refresh-0', keycloak.refresh);
    await coordinator.refresh('refresh-0', keycloak.refresh);
    expect(keycloak.calls).toEqual(['refresh-0']);
    coordinator.flights.clear();
  });
});

/**
 * The same race against a real Redis, when one is given
 * (`WEB_TEST_REDIS_URL=redis://127.0.0.1:6379`). Skipped visibly otherwise;
 * the fake above carries the same assertions everywhere.
 */
const realRedisUrl = process.env.WEB_TEST_REDIS_URL;
(realRedisUrl ? describe : describe.skip)('two replicas against a real Redis', () => {
  it('spends the token once across two clients', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded only when a Redis is given
    const { default: Redis } = require('ioredis') as typeof import('ioredis');
    const clients = [new Redis(realRedisUrl as string), new Redis(realRedisUrl as string)];
    try {
      const keycloak = sharedKeycloak();
      const token = `refresh-real-${Date.now()}`;
      const [a, b] = clients.map((redis) =>
        redisRefreshCoordinator({ redis, secret: SECRET, pollMs: 5 }),
      );

      const outcomes = await Promise.all([
        a.refresh(token, keycloak.refresh),
        b.refresh(token, keycloak.refresh),
      ]);

      expect(keycloak.calls).toEqual([token]);
      expect(outcomes.map((outcome) => outcome.kind)).toEqual(['ROTATED', 'ROTATED']);
      a.flights.clear();
      b.flights.clear();
    } finally {
      await Promise.all(clients.map((client) => client.quit()));
    }
  });
});

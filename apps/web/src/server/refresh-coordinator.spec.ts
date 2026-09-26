/**
 * @jest-environment node
 */
import { OidcError, type TokenResponse } from './oidc';
import {
  PUBLISH_SCRIPT,
  RELEASE_SCRIPT,
  LocalRefreshFlights,
  processRefreshCoordinator,
  redisRefreshCoordinator,
  refreshKeyOf,
  REJECTION_MEMORY_MS,
  type RedisLike,
  type RefreshOutcome,
} from './refresh-coordinator';
import { openSession, seal, sealSession, type WebSession } from './session';
import {
  REJECTION_GRACE_MS,
  renewSession,
  type RenewalDependencies,
  type SessionRenewal,
} from './session-refresh';

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

  /** The two scripts the coordinator runs, emulated line for line. */
  async eval(script: string, _keys: number, ...args: string[]): Promise<unknown> {
    await this.hop();
    if (script === RELEASE_SCRIPT) {
      const [key, owner] = args as [string, string];
      if (this.live(key)?.value !== owner) return 0;
      this.store.delete(key);
      return 1;
    }
    if (script === PUBLISH_SCRIPT) {
      const [lockKey, resultKey, owner, kind, value, ttl] = args as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const current = this.live(resultKey)?.value ?? null;
      if (this.live(lockKey)?.value !== owner) return current;
      const currentKind = current?.slice(0, 1) ?? '';
      if (currentKind !== 'R' && !(kind === 'J' && currentKind === 'J')) {
        this.store.set(resultKey, { value, expiresAt: Date.now() + Number(ttl) });
      }
      this.store.delete(lockKey);
      return this.live(resultKey)?.value ?? null;
    }
    throw new Error('FakeRedis: an unknown script');
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

  describe('a revoked session still ends while Redis fails (Codex #113 R3-1)', () => {
    const revoked = () =>
      jest.fn(async (): Promise<TokenResponse> => {
        throw new OidcError('INVALID_GRANT', 'invalid_grant');
      });

    /** Two requests with one cookie, more than the grace apart. */
    async function twoRequestsAcrossTheGrace(redis: RedisLike) {
      let clock = NOW;
      const coordinator = redisRefreshCoordinator({
        redis,
        secret: SECRET,
        now: () => clock,
        onRedisError: () => undefined,
      });
      const refresh = revoked();
      const cookie = sealSession(session(), SECRET);

      const first = await renewSession(cookie, { env: ENV, refresh, coordinator, now: clock });
      // The refusal's own flight is long gone by then (REFUSAL_WINDOW_MS).
      coordinator.flights.clear();
      clock += REJECTION_GRACE_MS + 1;
      const second = await renewSession(cookie, { env: ENV, refresh, coordinator, now: clock });
      return { first, second, refresh };
    }

    it('with Redis down, the second request clears the cookie', async () => {
      // Before: each fallback call stamped a fresh rejection time, so the
      // grace never passed and the dead cookie stayed until absolute expiry.
      const redis = new FakeRedis();
      redis.down = true;

      const { first, second, refresh } = await twoRequestsAcrossTheGrace(redis);

      expect(first).toEqual({ kind: 'REFUSED', usable: true });
      expect(second).toEqual({ kind: 'ENDED' });
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('with every publish failing, the second request clears the cookie', async () => {
      class PublishFails extends FakeRedis {
        override async eval(script: string, keys: number, ...args: string[]) {
          if (script === PUBLISH_SCRIPT) throw new Error('Command timed out');
          return super.eval(script, keys, ...args);
        }
      }

      const { first, second } = await twoRequestsAcrossTheGrace(new PublishFails());

      expect(first).toEqual({ kind: 'REFUSED', usable: true });
      expect(second).toEqual({ kind: 'ENDED' });
    });
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
 * Lost leases, fencing and TTLs (Codex #113 R2-1, R2-3) — against the fake
 * above and, when `WEB_TEST_REDIS_URL` is given, against a real Redis, where
 * the Lua itself runs. CI sets `WEB_TEST_REDIS_REQUIRED=true` in a job with a
 * Redis service, so there the real run cannot be skipped by accident.
 */
const realRedisUrl = process.env.WEB_TEST_REDIS_URL;
if (process.env.WEB_TEST_REDIS_REQUIRED === 'true' && !realRedisUrl) {
  throw new Error('WEB_TEST_REDIS_REQUIRED is set but WEB_TEST_REDIS_URL is not');
}

interface Backend {
  readonly clients: RedisLike[];
  /** Milliseconds `key` has left, or -2 when it does not exist. */
  pttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  close(): Promise<void>;
}

function fakeBackend(): Backend {
  const redis = new FakeRedis();
  return {
    clients: [redis, redis, redis],
    pttl: async (key) => {
      const entry = redis.store.get(key);
      return entry ? entry.expiresAt - Date.now() : -2;
    },
    get: (key) => redis.get(key),
    close: async () => undefined,
  };
}

function realBackend(): Backend {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded only when a Redis is given
  const { default: Redis } = require('ioredis') as typeof import('ioredis');
  const clients = [0, 1, 2].map(() => new Redis(realRedisUrl as string));
  return {
    clients,
    pttl: (key) => clients[0]!.pttl(key),
    get: (key) => clients[0]!.get(key),
    close: async () => {
      await Promise.all(clients.map((client) => client.quit()));
    },
  };
}

const backends: Array<[string, () => Backend]> = [
  ['a fake Redis', fakeBackend],
  ...(realRedisUrl ? ([['a real Redis', realBackend]] as Array<[string, () => Backend]>) : []),
];

const rotation = (n: string): TokenResponse => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  id_token: `id-${n}`,
  expires_in: 900,
  token_type: 'Bearer',
});

/** A call that reaches the provider now and answers only when released. */
function heldCall(answer: () => TokenResponse) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const atProvider = new Promise<void>((resolve) => (reached = resolve));
  const call = async (): Promise<TokenResponse> => {
    reached();
    await gate;
    return answer();
  };
  return { call, release, atProvider };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lockKeyOf = (token: string) => `rasta:web:refresh:lock:${refreshKeyOf(token)}`;
const resultKeyOf = (token: string) => `rasta:web:refresh:result:${refreshKeyOf(token)}`;

describe.each(backends)('fencing and TTLs, against %s (Codex #113 R2-1)', (_name, make) => {
  let backend: Backend;
  beforeEach(() => {
    backend = make();
  });
  afterEach(async () => {
    await backend.close();
  });

  /** A replica with a lease short enough to lose on purpose. */
  const replicaOn = (index: number) =>
    redisRefreshCoordinator({
      redis: backend.clients[index]!,
      secret: SECRET,
      lockTtlMs: 60,
      waitMs: 30,
      pollMs: 5,
    });

  it('lets a holder that lost its lease publish nothing — but hand its own caller its rotation', async () => {
    // A reaches Keycloak, which spends the token, but A stalls past its lease.
    // B takes the lease and is refused (invalid_grant), and publishes that.
    // A is outside the lease now: it may not write (Codex #113 R3-2) — yet
    // the rotation it obtained is real, and its own caller gets it.
    const token = `refresh-fence-a-${Date.now()}`;
    const spent = new Set<string>();
    const a = heldCall(() => rotation('a'));
    const aOutcome = replicaOn(0).refresh(token, async (t) => {
      spent.add(t);
      return a.call();
    });
    await a.atProvider;
    await pause(90); // A's lease has expired

    const bCalls: string[] = [];
    const bOutcome = await replicaOn(1).refresh(token, async (t) => {
      bCalls.push(t);
      if (spent.has(t)) throw new OidcError('INVALID_GRANT', 'invalid_grant');
      return rotation('b');
    });
    expect(bOutcome.kind).toBe('REJECTED');
    const storedByB = await backend.get(resultKeyOf(token));
    expect(storedByB?.slice(0, 1)).toBe('J');

    a.release();
    expect(await aOutcome).toMatchObject({ kind: 'ROTATED', tokens: { access_token: 'access-a' } });

    // Neither key moved: B's rejection stands, and there is no lease to release.
    expect(await backend.get(resultKeyOf(token))).toBe(storedByB);
    expect(await backend.get(lockKeyOf(token))).toBeNull();
    expect(bCalls).toEqual([token]);
  });

  it('lets a stale non-owner change neither key, and nobody overwrite a stored rotation', async () => {
    // The script itself, on the real Redis when one is given (Codex #113 R3-2).
    const [redis] = backend.clients as [RedisLike];
    const lock = `rasta:web:refresh:lock:fence-lua-${Date.now()}`;
    const result = `rasta:web:refresh:result:fence-lua-${Date.now()}`;
    const publish = (owner: string, kind: string, value: string) =>
      redis.eval(PUBLISH_SCRIPT, 2, lock, result, owner, kind, value, '30000');

    // Somebody else holds the lease; nothing is stored yet.
    await redis.set(lock, 'current-owner', 'PX', 5_000);
    for (const kind of ['R', 'X', 'J']) {
      expect(await publish('stale-owner', kind, `${kind}:stale`)).toBeNull();
      expect(await backend.get(result)).toBeNull();
      expect(await backend.get(lock)).toBe('current-owner');
    }

    // A rotation is stored while the current owner still holds the lease.
    await redis.set(result, 'R:existing', 'PX', 5_000);
    for (const kind of ['R', 'X', 'J']) {
      expect(await publish('stale-owner', kind, `${kind}:stale`)).toBe('R:existing');
      expect(await backend.get(lock)).toBe('current-owner');
    }

    // Not even the owner overwrites it — it only releases its lease.
    expect(await publish('current-owner', 'R', 'R:another')).toBe('R:existing');
    expect(await backend.get(result)).toBe('R:existing');
    expect(await backend.get(lock)).toBeNull();
  });

  it('never lets a late refusal overwrite a rotation', async () => {
    // A stalls past its lease and then times out; B takes over and rotates.
    const token = `refresh-fence-b-${Date.now()}`;
    const a = heldCall(() => {
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider did not answer');
    });
    const aOutcome = replicaOn(0).refresh(token, a.call);
    await a.atProvider;
    await pause(90);

    expect(await replicaOn(1).refresh(token, async () => rotation('b'))).toMatchObject({
      kind: 'ROTATED',
    });

    a.release();
    // A hands its caller the authoritative outcome rather than its own refusal.
    expect(await aOutcome).toMatchObject({ kind: 'ROTATED', tokens: { access_token: 'access-b' } });
    expect((await backend.get(resultKeyOf(token)))?.slice(0, 1)).toBe('R');
  });

  it('never lets a stale holder release — or publish a refusal over — the current holder', async () => {
    const token = `refresh-fence-c-${Date.now()}`;
    const a = heldCall(() => {
      throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider did not answer');
    });
    const aOutcome = replicaOn(0).refresh(token, a.call);
    await a.atProvider;
    await pause(90);

    const b = heldCall(() => rotation('b'));
    const bOutcome = redisRefreshCoordinator({
      redis: backend.clients[1]!,
      secret: SECRET,
      lockTtlMs: 5_000, // B keeps its lease for the rest of the test
      pollMs: 5,
    }).refresh(token, b.call);
    await b.atProvider;
    const bLease = await backend.get(lockKeyOf(token));
    expect(bLease).not.toBeNull();

    a.release();
    expect((await aOutcome).kind).toBe('REFUSED');
    // B's lease is untouched, and A's refusal was not stored.
    expect(await backend.get(lockKeyOf(token))).toBe(bLease);
    expect(await backend.get(resultKeyOf(token))).toBeNull();

    b.release();
    expect((await bOutcome).kind).toBe('ROTATED');
    expect(await backend.get(lockKeyOf(token))).toBeNull();
  });

  it('keeps the first rejection time, and each kind for its own TTL', async () => {
    const rejected = `refresh-ttl-j-${Date.now()}`;
    let clock = 1_000_000;
    const refuseGrant = async (): Promise<TokenResponse> => {
      throw new OidcError('INVALID_GRANT', 'invalid_grant');
    };
    const first = await redisRefreshCoordinator({
      redis: backend.clients[0]!,
      secret: SECRET,
      now: () => clock,
    }).refresh(rejected, refuseGrant);
    clock += 5_000;
    const second = await redisRefreshCoordinator({
      redis: backend.clients[1]!,
      secret: SECRET,
      now: () => clock,
    }).refresh(rejected, refuseGrant);
    expect(first).toEqual({ kind: 'REJECTED', firstRejectedAt: 1_000_000 });
    expect(second).toEqual({ kind: 'REJECTED', firstRejectedAt: 1_000_000 });
    expect(await backend.pttl(resultKeyOf(rejected))).toBeGreaterThan(REJECTION_MEMORY_MS - 5_000);

    const rotated = `refresh-ttl-r-${Date.now()}`;
    await redisRefreshCoordinator({ redis: backend.clients[0]!, secret: SECRET }).refresh(
      rotated,
      async () => rotation('r'),
    );
    const rotatedTtl = await backend.pttl(resultKeyOf(rotated));
    expect(rotatedTtl).toBeGreaterThan(25_000);
    expect(rotatedTtl).toBeLessThanOrEqual(30_000);

    const refused = `refresh-ttl-x-${Date.now()}`;
    await redisRefreshCoordinator({ redis: backend.clients[0]!, secret: SECRET }).refresh(
      refused,
      async () => {
        throw new OidcError('TOKEN_REQUEST_FAILED', 'the identity provider did not answer');
      },
    );
    expect(await backend.pttl(resultKeyOf(refused))).toBeLessThanOrEqual(5_000);
    // The lease is always gone once an outcome is published.
    for (const token of [rejected, rotated, refused]) {
      expect(await backend.get(lockKeyOf(token))).toBeNull();
    }
  });

  it('spends the token once across two clients', async () => {
    const keycloak = sharedKeycloak();
    const token = `refresh-real-${Date.now()}`;
    const [a, b] = [0, 1].map((index) =>
      redisRefreshCoordinator({ redis: backend.clients[index]!, secret: SECRET, pollMs: 5 }),
    );

    const outcomes = await Promise.all([
      a!.refresh(token, keycloak.refresh),
      b!.refresh(token, keycloak.refresh),
    ]);

    expect(keycloak.calls).toEqual([token]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['ROTATED', 'ROTATED']);
  });
});

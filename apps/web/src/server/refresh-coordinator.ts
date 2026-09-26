import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OidcError, type TokenResponse } from './oidc';
import { open, seal } from './session';

/**
 * One refresh per refresh token — across every replica of this portal.
 *
 * ## The race this closes
 *
 * The realm rotates refresh tokens with no reuse allowed (`revokeRefreshToken:
 * true`, `refreshTokenMaxReuse: 0`). Two requests carrying the same cookie —
 * a navigation and its prefetches, two tabs — must therefore not both present
 * the token: the second is refused. The portal runs as two replicas
 * (`docs/12` § 12.4) and may run several Node workers each, so a map inside
 * one process cannot stop replica B from spending the token replica A is
 * already spending.
 *
 * So the refresh is coordinated through the platform's Redis:
 *
 *   1. A lock keyed by a **hash** of the refresh token (`SET … NX PX`). The
 *      winner alone calls Keycloak.
 *   2. The winner stores the outcome under a result key for a short while,
 *      **sealed** with the session secret (AES-256-GCM, `session.ts`) and
 *      bound to that key, then releases the lock.
 *   3. Everybody else waits for the result and uses it, so every replica
 *      writes the *same* rotated cookie.
 *
 * Redis never holds a token in the clear, nor a key from which one could be
 * derived: the key is a SHA-256 of a high-entropy secret, and the value opens
 * only with `WEB_SESSION_SECRET`. The binding means a value copied under
 * somebody else's key does not open as theirs.
 *
 * ## What a refusal means, and what it does not
 *
 * Coordination narrows the race; it cannot make a refusal proof that the
 * session is over. Redis can be unreachable, a replica can die holding the
 * lock after spending the token, and during a rolling deploy a replica
 * without this code can spend it outside the lock. In each of those a refusal
 * may mean "somebody else already rotated it" — and the cookie that somebody
 * else sent back is the good one. So a refusal is reported as `REFUSED`, and
 * **`REFUSED` never clears the cookie** (`session-refresh.ts`). Only facts
 * about the cookie itself — it does not open, or it is past its absolute
 * lifetime — end a session, and those are the same on every replica at every
 * moment.
 *
 * ## Inside one process
 *
 * Requests on one replica share one flight before Redis is even asked, so a
 * burst costs one round trip, not one per request. Each flight is kept for a
 * short window after it settles — a request that arrives a moment later with
 * the spent token still gets the rotated result — and is then dropped by its
 * own timer, unref'd so it never keeps a process alive. A hard cap bounds how
 * many are held at once.
 */

export type RefreshOutcome =
  | { readonly kind: 'ROTATED'; readonly tokens: TokenResponse }
  /**
   * The provider refused, or did not answer in time, or the winner of a
   * coordinated refresh could not be heard from. Never proof the session is
   * dead — see the file comment.
   */
  | { readonly kind: 'REFUSED' };

export interface RefreshCoordinator {
  /**
   * Refreshes `refreshToken` once, sharing the outcome with every caller
   * presenting the same token. An `OidcError` from `call` becomes `REFUSED`;
   * any other error is a bug and propagates.
   */
  refresh(
    refreshToken: string,
    call: (refreshToken: string) => Promise<TokenResponse>,
  ): Promise<RefreshOutcome>;
}

/** The hash every key is derived from, so no map or store holds the token. */
export function refreshKeyOf(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf8').digest('base64url');
}

async function called(
  refreshToken: string,
  call: (refreshToken: string) => Promise<TokenResponse>,
): Promise<RefreshOutcome> {
  try {
    return { kind: 'ROTATED', tokens: await call(refreshToken) };
  } catch (error) {
    if (error instanceof OidcError) return { kind: 'REFUSED' };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// One process
// ---------------------------------------------------------------------------

/**
 * How long a settled flight is still shared. Longer than the token endpoint's
 * deadline, so a request arriving while the first still waits is covered;
 * short enough that the tokens do not outstay their purpose in memory.
 */
export const LOCAL_FLIGHT_WINDOW_MS = 30_000;

/**
 * How long a *refusal* is shared — much shorter. Sharing it at all spares the
 * provider a burst of retries of a dead token; sharing it for long would keep
 * showing a person as signed out for that long after a provider that merely
 * timed out has recovered.
 */
export const REFUSAL_WINDOW_MS = 5_000;

/**
 * At most this many flights are held at once. Each is one refresh, so this is
 * far above any real burst on one replica; past it the oldest is dropped —
 * which costs, at worst, one more refresh — rather than memory growing with
 * whoever is sending requests.
 */
export const LOCAL_FLIGHT_LIMIT = 1_000;

interface Flight {
  readonly outcome: Promise<RefreshOutcome>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The per-process layer: one flight per refresh-token hash.
 *
 * Every entry removes itself on its own timer — started when the flight
 * settles, so a slow refresh is still shared for the full window after it —
 * and the map never exceeds its cap. Nothing sweeps on the request path.
 */
export class LocalRefreshFlights {
  private readonly flights = new Map<string, Flight>();

  constructor(
    private readonly windowMs: number = LOCAL_FLIGHT_WINDOW_MS,
    private readonly limit: number = LOCAL_FLIGHT_LIMIT,
    private readonly refusalWindowMs: number = REFUSAL_WINDOW_MS,
  ) {}

  share(key: string, start: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
    const existing = this.flights.get(key);
    if (existing) return existing.outcome;

    while (this.flights.size >= this.limit) {
      const oldest = this.flights.keys().next().value as string;
      this.drop(oldest);
    }

    const outcome = start();
    const flight: Flight = { outcome };
    this.flights.set(key, flight);

    const expire = (settled: RefreshOutcome) => {
      // Only this flight: a later one under the same key is its own entry.
      if (this.flights.get(key) !== flight) return;
      const window = settled.kind === 'REFUSED' ? this.refusalWindowMs : this.windowMs;
      flight.timer = setTimeout(() => this.drop(key, flight), window);
      flight.timer.unref?.();
    };
    // A rejected flight is dropped at once: the error is the caller's to see,
    // and the next request should try again rather than inherit it.
    outcome.then(expire, () => this.drop(key, flight));

    return outcome;
  }

  /** How many flights are held. For tests and the cap. */
  get size(): number {
    return this.flights.size;
  }

  clear(): void {
    for (const key of [...this.flights.keys()]) this.drop(key);
  }

  private drop(key: string, only?: Flight): void {
    const flight = this.flights.get(key);
    if (!flight || (only && flight !== only)) return;
    if (flight.timer) clearTimeout(flight.timer);
    this.flights.delete(key);
  }
}

/** Coordination within one process only: used when no Redis is configured. */
export function processRefreshCoordinator(
  flights: LocalRefreshFlights = new LocalRefreshFlights(),
): RefreshCoordinator & { readonly flights: LocalRefreshFlights } {
  return {
    flights,
    refresh: (refreshToken, call) =>
      flights.share(refreshKeyOf(refreshToken), () => called(refreshToken, call)),
  };
}

// ---------------------------------------------------------------------------
// Every replica
// ---------------------------------------------------------------------------

/** The subset of a Redis client this needs — `ioredis` satisfies it. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<'OK' | null>;
  exists(key: string): Promise<number>;
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>;
}

export interface RedisCoordinationOptions {
  readonly redis: RedisLike;
  /** `WEB_SESSION_SECRET`: seals the stored outcome. */
  readonly secret: string;
  /**
   * How long the winner may hold the lock. Longer than the token endpoint's
   * whole deadline (`TOKEN_ENDPOINT_TIMEOUT_MS`, 10 s), so a winner is never
   * overtaken while it is still waiting for Keycloak.
   */
  readonly lockTtlMs?: number;
  /** How long a stored outcome is served to latecomers. */
  readonly resultTtlMs?: number;
  /** How often a waiting replica looks for the outcome. */
  readonly pollMs?: number;
  readonly flights?: LocalRefreshFlights;
  /** Told when Redis fails and a refresh goes ahead uncoordinated. Names no token. */
  readonly onRedisError?: (error: unknown) => void;
}

const KEY_PREFIX = 'rasta:web:refresh';

/** Deletes the lock only if this replica still holds it. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** What is stored under the result key: the outcome, bound to its own key. */
const storedOutcomeSchema = z.object({
  key: z.string().min(1),
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('ROTATED'),
      tokens: z.object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1),
        id_token: z.string().min(1),
        expires_in: z.number().int().positive(),
        token_type: z.string(),
      }),
    }),
    z.object({ kind: z.literal('REFUSED') }),
  ]),
});

class RedisUnavailable extends Error {
  constructor(cause: unknown) {
    super('Redis is unavailable for refresh coordination', { cause });
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Coordinates every replica through Redis, on top of the per-process layer.
 *
 * Redis failing is not a reason to fail a person's request: the refresh then
 * goes ahead uncoordinated, which is exactly the pre-coordination behaviour —
 * and safe, because the refusal it can cause never clears a cookie.
 */
export function redisRefreshCoordinator(
  options: RedisCoordinationOptions,
): RefreshCoordinator & { readonly flights: LocalRefreshFlights } {
  const {
    redis,
    secret,
    lockTtlMs = 15_000,
    resultTtlMs = LOCAL_FLIGHT_WINDOW_MS,
    pollMs = 100,
    flights = new LocalRefreshFlights(),
    onRedisError = () => undefined,
  } = options;

  const redisOp = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (error) {
      throw new RedisUnavailable(error);
    }
  };

  const readOutcome = async (key: string): Promise<RefreshOutcome | null> => {
    const stored = await redisOp(() => redis.get(`${KEY_PREFIX}:result:${key}`));
    if (!stored) return null;
    const opened = open(stored, secret, storedOutcomeSchema);
    // Unopenable, or sealed for another key: not ours, and not evidence of
    // anything. Treated as absent.
    if (!opened || opened.key !== key) return null;
    return opened.outcome;
  };

  const coordinated = async (
    refreshToken: string,
    key: string,
    call: (refreshToken: string) => Promise<TokenResponse>,
  ): Promise<RefreshOutcome> => {
    const lockKey = `${KEY_PREFIX}:lock:${key}`;

    // Two rounds: the second covers a winner that vanished — crashed, or hit
    // a bug — without leaving an outcome, so somebody else takes its place.
    for (let round = 0; round < 2; round += 1) {
      const done = await readOutcome(key);
      if (done) return done;

      const owner = randomUUID();
      const won = await redisOp(() => redis.set(lockKey, owner, 'PX', lockTtlMs, 'NX'));

      if (won === 'OK') {
        try {
          // Somebody may have finished between the read above and the lock.
          const meanwhile = await readOutcome(key);
          if (meanwhile) return meanwhile;

          const outcome = await called(refreshToken, call);
          await redis
            .set(
              `${KEY_PREFIX}:result:${key}`,
              seal({ key, outcome }, secret),
              'PX',
              outcome.kind === 'REFUSED' ? Math.min(resultTtlMs, REFUSAL_WINDOW_MS) : resultTtlMs,
            )
            .catch(onRedisError);
          return outcome;
        } finally {
          await redis.eval(RELEASE_SCRIPT, 1, lockKey, owner).catch(onRedisError);
        }
      }

      // Somebody else is refreshing: wait for what they find.
      const deadline = Date.now() + lockTtlMs + pollMs;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        const outcome = await readOutcome(key);
        if (outcome) return outcome;
        if ((await redisOp(() => redis.exists(lockKey))) === 0) break;
      }
      const late = await readOutcome(key);
      if (late) return late;
    }

    // Nobody could be heard from. Not proof of anything — so a refusal, which
    // leaves the cookie exactly as the browser has it.
    return { kind: 'REFUSED' };
  };

  return {
    flights,
    refresh: (refreshToken, call) => {
      const key = refreshKeyOf(refreshToken);
      return flights.share(key, async () => {
        try {
          return await coordinated(refreshToken, key, call);
        } catch (error) {
          if (!(error instanceof RedisUnavailable)) throw error;
          onRedisError(error.cause);
          // Uncoordinated, as before coordination existed; a resulting
          // refusal still never clears a cookie.
          return called(refreshToken, call);
        }
      });
    },
  };
}

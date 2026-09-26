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
 *   1. A lease keyed by a **hash** of the refresh token (`SET … NX PX`),
 *      holding a random owner token. The holder alone calls Keycloak.
 *   2. The holder publishes the outcome and releases the lease in one Lua
 *      script, **fenced** by its owner token (`PUBLISH_SCRIPT`, Codex #113
 *      R2-1): a holder that lost its lease cannot release its successor's, and
 *      cannot store a refusal over anything. A rotation, though, is stored
 *      whoever reports it and is never overwritten — it is the one thing that
 *      is now true of the token. The outcome is **sealed** with the session
 *      secret (AES-256-GCM, `session.ts`) and bound to its key.
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
 * lease after spending the token, and a replica without this code can spend
 * it outside the lease. So:
 *
 *   - no answer, a 5xx or a malformed body is `REFUSED`, which never clears
 *     the cookie;
 *   - `invalid_grant` is `REJECTED`, remembered with the time the token was
 *     first refused, and `session-refresh.ts` clears the cookie only once a
 *     grace has passed with no rotation of that token having appeared
 *     (Codex #113 R2-2). A rotation stored in the meantime outranks it.
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
   * The provider did not answer in time, answered with something that says
   * nothing about the grant (a 5xx, a malformed body), or the winner of a
   * coordinated refresh could not be heard from. Transient or ambiguous:
   * never proof the session is dead — see the file comment.
   */
  | { readonly kind: 'REFUSED' }
  /**
   * The provider refused the grant itself (`invalid_grant`). Terminal for the
   * token — but a *rotation* of the same token by somebody else is refused
   * the same way, so on its own it still does not end the session.
   * `firstRejectedAt` is when this token was first seen refused, shared by
   * every replica; `session-refresh.ts` ends the session only once a grace
   * period has passed since then with no rotation having appeared.
   */
  | { readonly kind: 'REJECTED'; readonly firstRejectedAt: number };

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
  now: () => number = Date.now,
): Promise<RefreshOutcome> {
  try {
    return { kind: 'ROTATED', tokens: await call(refreshToken) };
  } catch (error) {
    if (!(error instanceof OidcError)) throw error;
    return error.reason === 'INVALID_GRANT'
      ? { kind: 'REJECTED', firstRejectedAt: now() }
      : { kind: 'REFUSED' };
  }
}

/**
 * How long a token's rejection is remembered. Long enough that a session the
 * provider refused is ended from the memory rather than by asking the
 * provider again on every request; far shorter than a session's lifetime.
 */
export const REJECTION_MEMORY_MS = 10 * 60_000;

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
      const window = settled.kind === 'ROTATED' ? this.windowMs : this.refusalWindowMs;
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

/**
 * When each refresh token was first refused, per process — the no-Redis
 * counterpart of the stored `REJECTED` outcome. Bounded and self-expiring
 * like the flights.
 */
export class RejectionMemory {
  private readonly entries = new Map<
    string,
    { at: number; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly ttlMs: number = REJECTION_MEMORY_MS,
    private readonly limit: number = LOCAL_FLIGHT_LIMIT,
  ) {}

  /** The first time `key` was refused, recording `at` if it is the first. */
  firstRejectedAt(key: string, at: number): number {
    const existing = this.entries.get(key);
    if (existing) return existing.at;
    while (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next().value as string;
      clearTimeout(this.entries.get(oldest)!.timer);
      this.entries.delete(oldest);
    }
    const timer = setTimeout(() => this.entries.delete(key), this.ttlMs);
    timer.unref?.();
    this.entries.set(key, { at, timer });
    return at;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    for (const { timer } of this.entries.values()) clearTimeout(timer);
    this.entries.clear();
  }
}

/** Coordination within one process only: used when no Redis is configured. */
export function processRefreshCoordinator(
  flights: LocalRefreshFlights = new LocalRefreshFlights(),
  rejections: RejectionMemory = new RejectionMemory(),
): RefreshCoordinator & { readonly flights: LocalRefreshFlights } {
  return {
    flights,
    refresh: (refreshToken, call) => {
      const key = refreshKeyOf(refreshToken);
      return flights.share(key, async () => {
        const outcome = await called(refreshToken, call);
        return outcome.kind === 'REJECTED'
          ? {
              kind: 'REJECTED',
              firstRejectedAt: rejections.firstRejectedAt(key, outcome.firstRejectedAt),
            }
          : outcome;
      });
    },
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
   * The lease. At least twice the owner's bounded worst case — after taking
   * the lock it does one Redis read (≤ 2 s, `commandTimeout`), one token call
   * (≤ 10 s, `TOKEN_ENDPOINT_TIMEOUT_MS`) and one publish (≤ 2 s): 14 s. A
   * holder past that (a paused process) loses the lease to a waiter, and the
   * fencing in `PUBLISH_SCRIPT` keeps what it reports afterwards honest.
   */
  readonly lockTtlMs?: number;
  /**
   * How long a waiter waits for the holder before giving up with a
   * (non-terminal) refusal: the holder's bounded worst case and a margin.
   * Shorter than the lease on purpose — a person's request does not sit out
   * a lease that only exists to fence a holder that is past its bound.
   */
  readonly waitMs?: number;
  /** How long a rotation is served to latecomers. */
  readonly resultTtlMs?: number;
  /** How often a waiting replica looks for the outcome. */
  readonly pollMs?: number;
  readonly flights?: LocalRefreshFlights;
  /** Told when Redis fails and a refresh goes ahead uncoordinated. Names no token. */
  readonly onRedisError?: (error: unknown) => void;
  /** The clock `firstRejectedAt` is read from. A seam for tests. */
  readonly now?: () => number;
}

const KEY_PREFIX = 'rasta:web:refresh';

/** The lease, and how long a waiter waits for its holder (see the options). */
export const LOCK_TTL_MS = 30_000;
export const WAIT_MS = 16_000;

/** Deletes the lock only if this replica still holds it. */
export const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Publishes an outcome and releases the lease, atomically, fenced by the
 * owner token (Codex #113 R2-1).
 *
 * The stored value starts with its kind — `R` rotated, `X` refused, `J`
 * rejected — which is not secret; the tokens after it are sealed. Precedence:
 *
 *   - a rotation is written whoever reports it: it is the truth about what
 *     happened to the token, and a holder that lost its lease still learned
 *     it — nothing else can ever be true of that token again;
 *   - nothing overwrites a rotation;
 *   - a refusal or rejection is written only by the current holder, and a
 *     rejection keeps the first rejection's time;
 *   - the lease is deleted only by its holder.
 *
 * Returns what is stored afterwards, so a holder that lost the race still
 * hands its caller the authoritative outcome.
 *
 * KEYS[1] lock, KEYS[2] result; ARGV[1] owner, ARGV[2] kind, ARGV[3] value,
 * ARGV[4] ttl (ms).
 */
export const PUBLISH_SCRIPT = `
local holder = redis.call('GET', KEYS[1])
local isOwner = holder == ARGV[1]
local current = redis.call('GET', KEYS[2])
local currentKind = ''
if current then currentKind = string.sub(current, 1, 1) end
local write = false
if ARGV[2] == 'R' then
  write = true
elseif currentKind == 'R' then
  write = false
elseif isOwner then
  write = not (ARGV[2] == 'J' and currentKind == 'J')
end
if write then
  redis.call('SET', KEYS[2], ARGV[3], 'PX', tonumber(ARGV[4]))
end
if isOwner then
  redis.call('DEL', KEYS[1])
end
return redis.call('GET', KEYS[2])
`;

const KIND_CODE = { ROTATED: 'R', REFUSED: 'X', REJECTED: 'J' } as const;

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
    z.object({ kind: z.literal('REJECTED'), firstRejectedAt: z.number().int().nonnegative() }),
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
    lockTtlMs = LOCK_TTL_MS,
    waitMs = WAIT_MS,
    resultTtlMs = LOCAL_FLIGHT_WINDOW_MS,
    pollMs = 100,
    flights = new LocalRefreshFlights(),
    onRedisError = () => undefined,
    now = Date.now,
  } = options;

  const redisOp = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (error) {
      throw new RedisUnavailable(error);
    }
  };

  const decode = (key: string, stored: string | null): RefreshOutcome | null => {
    if (!stored) return null;
    const separator = stored.indexOf(':');
    const opened = open(stored.slice(separator + 1), secret, storedOutcomeSchema);
    // Unopenable, sealed for another key, or labelled as a kind it is not:
    // not ours, and not evidence of anything. Treated as absent.
    if (!opened || opened.key !== key) return null;
    if (stored.slice(0, separator) !== KIND_CODE[opened.outcome.kind]) return null;
    return opened.outcome;
  };

  const readOutcome = async (key: string): Promise<RefreshOutcome | null> =>
    decode(key, await redisOp(() => redis.get(`${KEY_PREFIX}:result:${key}`)));

  const ttlOf = (outcome: RefreshOutcome): number =>
    outcome.kind === 'ROTATED'
      ? resultTtlMs
      : outcome.kind === 'REJECTED'
        ? REJECTION_MEMORY_MS
        : Math.min(resultTtlMs, REFUSAL_WINDOW_MS);

  /** The holder's part: call the provider once, publish fenced, release. */
  const asHolder = async (
    refreshToken: string,
    key: string,
    lockKey: string,
    owner: string,
    call: (refreshToken: string) => Promise<TokenResponse>,
  ): Promise<RefreshOutcome> => {
    let released = false;
    try {
      // Somebody may have finished between the caller's read and the lock.
      const meanwhile = await readOutcome(key);
      if (meanwhile) return meanwhile;

      const outcome = await called(refreshToken, call, now);
      try {
        const stored = (await redis.eval(
          PUBLISH_SCRIPT,
          2,
          lockKey,
          `${KEY_PREFIX}:result:${key}`,
          owner,
          KIND_CODE[outcome.kind],
          `${KIND_CODE[outcome.kind]}:${seal({ key, outcome }, secret)}`,
          String(ttlOf(outcome)),
        )) as string | null;
        released = true;
        return decode(key, stored) ?? outcome;
      } catch (error) {
        onRedisError(error);
        return outcome;
      }
    } finally {
      if (!released) await redis.eval(RELEASE_SCRIPT, 1, lockKey, owner).catch(onRedisError);
    }
  };

  const coordinated = async (
    refreshToken: string,
    key: string,
    call: (refreshToken: string) => Promise<TokenResponse>,
  ): Promise<RefreshOutcome> => {
    const lockKey = `${KEY_PREFIX}:lock:${key}`;

    // Two rounds: the second covers a holder that vanished — crashed, or hit
    // a bug — without leaving an outcome, so somebody else takes its place.
    for (let round = 0; round < 2; round += 1) {
      const done = await readOutcome(key);
      if (done) return done;

      const owner = randomUUID();
      const won = await redisOp(() => redis.set(lockKey, owner, 'PX', lockTtlMs, 'NX'));
      if (won === 'OK') return asHolder(refreshToken, key, lockKey, owner, call);

      // Somebody else is refreshing: wait for what they find — for as long
      // as a holder can legitimately take, not for the whole lease.
      const deadline = Date.now() + waitMs;
      let held = true;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        const outcome = await readOutcome(key);
        if (outcome) return outcome;
        if ((await redisOp(() => redis.exists(lockKey))) === 0) {
          held = false;
          break;
        }
      }
      const late = await readOutcome(key);
      if (late) return late;
      // A holder past its bound still holds the lease: not proof of anything,
      // so a refusal — this request only; the next one asks again.
      if (held) return { kind: 'REFUSED' };
    }

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
          return called(refreshToken, call, now);
        }
      });
    },
  };
}

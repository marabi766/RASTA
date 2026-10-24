import { createHash, createHmac, randomBytes } from 'node:crypto';

import Redis from 'ioredis';
import { z } from 'zod';

import { webServerEnv } from './env';
import type { RedisLike } from './refresh-coordinator';
import type { WebSession } from './session';
import { signPayload, verifyPayload } from './signed-payload';
import {
  INFLIGHT_LEASE_MS,
  MAX_PENDING_PER_LOGIN,
  memoryUnresolvedStore,
  PENDING_KEY_PREFIX,
  RECORD_RETENTION_AFTER_MS,
  redisUnresolvedStore,
  UnresolvedStoreUnavailable,
  type HeldReason,
  type SettleMode,
  type StoredRecord,
  type UnresolvedStore,
} from './unresolved-request-store';

/**
 * Keeps one **unresolved write request** per scope, on the server, from before
 * it is dispatched until its outcome is known: the key it is sent under, a
 * digest of what it carries, and until when that key may be sent again.
 *
 * ## Why
 *
 * A write whose answer was lost may have committed. The form that sent it is
 * gone after a reload, and a page drawn afterwards mints a fresh key — so the
 * same inputs pressed again would be a second record. A filtered list cannot
 * settle that either (the new record may simply not match the filter). So the
 * request is remembered until a confirmed outcome, or until the person says,
 * knowingly, that they checked the full list and want a new one.
 *
 * ## Where (r4: server-side, not a cookie)
 *
 * A signed response cookie was lost with the response it rode on, could not
 * stop two tabs dispatching two keys, and grew without bound against the
 * header limit. The state now lives in the platform's Redis
 * (`unresolved-request-store.ts`: keys, persistence, memory-full, the
 * development fallback) and **no cookie carries any of it**.
 *
 * ## The life of a request
 *
 *   1. `reserveUnresolved` — one atomic step, **before** the dispatch. No record:
 *      a `RESERVED` one is created (the per-login capacity is checked in the
 *      same step). A record in flight, or another key, or another body: `HELD`,
 *      nothing is sent. An `UNRESOLVED` record with this very key and body: sent
 *      again only when the purpose's policy says the service answers a repeated
 *      key with the first result (`retry`); otherwise the person reconciles.
 *      The store unreachable or unreadable: `UNAVAILABLE` — nothing is sent.
 *   2. The dispatch.
 *   3. `settleUnresolved`, fenced by the record's `id` and this attempt's id:
 *      `CONFIRMED` deletes; `REFUSED` / `NEVER_SENT` delete only a record this
 *      attempt created and that was never ambiguous (a refusal of a *retry* says
 *      nothing about the earlier attempt), else put it back to `UNRESOLVED`;
 *      `UNRESOLVED` keeps it. A settle that cannot reach the store is not an
 *      error to the person: the in-flight record turns `UNRESOLVED` by itself
 *      once its lease (`INFLIGHT_LEASE_MS`) runs out.
 *
 * ## The deadline
 *
 * A record's `deadline` is fixed when it is created as the earlier of the
 * signed stamp's deadline and `issuedAt + window(configuration then)`, and on
 * every retry it is the earlier of the stored one and `issuedAt +
 * window(configuration now)`: it only ever shrinks. Past it nothing is sent and
 * the record is kept. The record expires 30 days after the deadline (after its
 * creation when there is none).
 *
 * It holds **no body**, only a keyed digest, no token and no personal data.
 */

/** What an earlier version kept in cookies. Logout still removes them. */
export const LEGACY_UNRESOLVED_COOKIE_PREFIX = 'rasta_ur_';

const RELEASE_PURPOSE = 'unresolved-release';
const RELEASE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const PURPOSE_SLUG = /^[a-z0-9-]{1,40}$/;

export interface UnresolvedScope {
  readonly purpose: string;
  readonly target?: string;
}

/** What a page or an action may know of a held request. */
export interface UnresolvedRequest {
  /** The generation of the record: a release names it. */
  readonly id: string;
  /** The idempotency key the request was sent under. */
  readonly key: string;
  /** `requestDigest` of the body it carried. */
  readonly digest: string;
  /** Last instant the key may be sent again (ms since the epoch); null when the service has no limit. */
  readonly deadline: number | null;
  /** Opaque, short: whatever the caller must hand back to its form (a signed stamp). */
  readonly ref: string | null;
  /** True while an attempt is being dispatched right now. */
  readonly inFlight: boolean;
}

function scopeLabel(scope: UnresolvedScope): string {
  if (!PURPOSE_SLUG.test(scope.purpose)) throw new Error('unresolved-request: bad purpose');
  return `${scope.purpose}\n${scope.target ?? ''}`;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface Keys {
  readonly recordKey: string;
  readonly setKey: string;
  readonly bind: string;
}

/** Every key names the organization (ADR-007) and is bound to this person's login. */
function keysFor(session: WebSession, scope: UnresolvedScope): Keys {
  const org = encodeURIComponent(session.organizationId ?? 'none');
  const login = `${session.subject}\n${session.csrfToken}`;
  const bind = sha256(`${login}\n${scopeLabel(scope)}`);
  return {
    recordKey: `${PENDING_KEY_PREFIX}:org:${org}:pw:${bind}`,
    setKey: `${PENDING_KEY_PREFIX}:org:${org}:pwl:${sha256(login)}`,
    bind,
  };
}

/**
 * A keyed digest of `body` for this person and purpose: equal bodies give equal
 * digests (keys sorted, so property order does not matter), and the digest of a
 * guessable body cannot be checked by anybody without the server's secret.
 * The caller canonicalizes values first (decimals, line endings, instants).
 */
export function requestDigest(session: WebSession, purpose: string, body: unknown): string {
  const key = createHmac('sha256', webServerEnv().WEB_SESSION_SECRET)
    .update(`rasta-web/request-digest/v1:${purpose}`)
    .digest();
  return createHmac('sha256', key)
    .update(`${session.subject}\n${canonicalJson(body)}`)
    .digest('base64url');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---------------------------------------------------------------------------
// The store in use
// ---------------------------------------------------------------------------

let store: UnresolvedStore | undefined;
const lastWarned = new Map<string, number>();

/** Warnings an operator must see, at most once a minute each. Names no key. */
function warnOperator(code: string, message: string): void {
  const now = Date.now();
  if (now - (lastWarned.get(code) ?? 0) < 60_000) return;
  lastWarned.set(code, now);
  process.emitWarning(message, { code });
}

/**
 * Redis when `WEB_REDIS_URL` is set. With none, this process alone — but only
 * outside production (development, test: one process, nobody to agree with).
 * In production the variable is required at start (`env.ts`); if it is still
 * missing here the store is unavailable and nothing is sent.
 */
function defaultStore(): UnresolvedStore {
  if (store) return store;
  const env = webServerEnv();
  if (env.WEB_REDIS_URL) {
    const redis = new Redis(env.WEB_REDIS_URL, {
      // Bounded: a command waits for a connection being made, never past
      // `commandTimeout`; then the action sends nothing.
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    redis.on('error', () => undefined);
    store = redisUnresolvedStore(redis as unknown as RedisLike);
  } else if (process.env.NODE_ENV !== 'production') {
    warnOperator(
      'RASTA_WEB_PENDING_UNSHARED',
      'WEB_REDIS_URL is not set: unresolved write requests are held in this process only.',
    );
    store = memoryUnresolvedStore();
  } else {
    throw new UnresolvedStoreUnavailable(new Error('WEB_REDIS_URL is required in production'));
  }
  return store;
}

/** Test seam: use `replacement` (or the default again) and forget the default. */
export function useUnresolvedStore(replacement?: UnresolvedStore): void {
  store = replacement;
  lastWarned.clear();
}

function viewOf(record: StoredRecord, now: number): UnresolvedRequest {
  return {
    id: record.id,
    key: record.key,
    digest: record.digest,
    deadline: record.deadline ?? null,
    ref: record.ref,
    inFlight: record.state === 'RESERVED' && now - record.reservedAt <= INFLIGHT_LEASE_MS,
  };
}

/** A record found under a key it does not belong to is not trusted. */
function trusted(record: StoredRecord, keys: Keys): boolean {
  return record.bind === keys.bind;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type UnresolvedRead =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'PENDING'; readonly request: UnresolvedRequest }
  /** The store could not say (error, timeout, malformed or unverifiable record): never "no hold". */
  | { readonly kind: 'UNAVAILABLE' };

/**
 * The request still held for `scope` by this person, acting for this
 * organization, in this login. It is returned **past its deadline** too: an
 * expired key is still an unresolved request; `deadline` says whether it may be
 * sent again. **Fails closed**: anything but a clean answer is `UNAVAILABLE`.
 */
export async function readUnresolved(
  session: WebSession,
  scope: UnresolvedScope,
  now: number = Date.now(),
): Promise<UnresolvedRead> {
  try {
    const keys = keysFor(session, scope);
    const record = await defaultStore().read(keys.recordKey, now);
    if (record === null) return { kind: 'NONE' };
    if (!trusted(record, keys)) return { kind: 'UNAVAILABLE' };
    return { kind: 'PENDING', request: viewOf(record, now) };
  } catch (error) {
    if (!(error instanceof UnresolvedStoreUnavailable)) throw error;
    warnOperator(
      'RASTA_WEB_PENDING_UNAVAILABLE',
      'The pending-request store is unavailable: writes that need it are refused.',
    );
    return { kind: 'UNAVAILABLE' };
  }
}

// ---------------------------------------------------------------------------
// Reserving, settling
// ---------------------------------------------------------------------------

/** What the caller must hand back to `settleUnresolved`. */
export interface UnresolvedAttempt {
  readonly recordKey: string;
  readonly setKey: string;
  readonly id: string;
  readonly attemptId: string;
}

export interface ReserveInput {
  /** The idempotency key the request is sent under. */
  readonly key: string;
  readonly digest: string;
  /** Handed back to the pinned form (a signed stamp). */
  readonly ref: string | null;
  /** When the stamp was issued (ms). */
  readonly issuedAt: number;
  /**
   * The deadline for a record created now: the earlier of the stamp's and
   * `issuedAt + window(now)`. Null for a purpose without one.
   */
  readonly deadline: number | null;
  /** `window(configuration now)` in ms, bounding a retry; null for a purpose without one. */
  readonly windowMs: number | null;
  /**
   * Whether an unresolved record with this very key and body may be sent again:
   * true only when the service answers a repeated key with the first result.
   * False: the person reconciles, and the record is only ever released.
   */
  readonly retry: boolean;
}

export type ReserveOutcome =
  | { readonly kind: 'RESERVED'; readonly attempt: UnresolvedAttempt; readonly retry: boolean }
  | { readonly kind: 'HELD'; readonly reason: HeldReason; readonly request: UnresolvedRequest }
  | { readonly kind: 'EXPIRED'; readonly request: UnresolvedRequest }
  | { readonly kind: 'CAPACITY' }
  /** The store could not be reached or read: nothing may be sent. */
  | { readonly kind: 'UNAVAILABLE' };

const newId = () => randomBytes(16).toString('hex');

export async function reserveUnresolved(
  session: WebSession,
  scope: UnresolvedScope,
  input: ReserveInput,
  now: number = Date.now(),
): Promise<ReserveOutcome> {
  try {
    const keys = keysFor(session, scope);
    const id = newId();
    const attemptId = newId();
    const reply = await defaultStore().reserve({
      recordKey: keys.recordKey,
      setKey: keys.setKey,
      now,
      cap: MAX_PENDING_PER_LOGIN,
      leaseMs: INFLIGHT_LEASE_MS,
      retry: input.retry,
      windowMs: input.windowMs,
      key: input.key,
      digest: input.digest,
      attemptId,
      expireAt: (input.deadline ?? now) + RECORD_RETENTION_AFTER_MS,
      fresh: {
        v: 1,
        id,
        attemptId,
        key: input.key,
        digest: input.digest,
        issuedAt: input.issuedAt,
        ref: input.ref,
        deadline: input.deadline,
        state: 'RESERVED',
        wasUnresolved: false,
        createdAt: now,
        reservedAt: now,
        bind: keys.bind,
      },
    });
    if (reply.kind === 'CAPACITY') return { kind: 'CAPACITY' };
    if (!trusted(reply.record, keys)) return { kind: 'UNAVAILABLE' };
    const request = viewOf(reply.record, now);
    if (reply.kind === 'HELD') return { kind: 'HELD', reason: reply.reason, request };
    if (reply.kind === 'EXPIRED') return { kind: 'EXPIRED', request };
    return {
      kind: 'RESERVED',
      retry: reply.retry,
      attempt: {
        recordKey: keys.recordKey,
        setKey: keys.setKey,
        id: reply.record.id,
        attemptId: reply.record.attemptId,
      },
    };
  } catch (error) {
    if (!(error instanceof UnresolvedStoreUnavailable)) throw error;
    warnOperator(
      'RASTA_WEB_PENDING_UNAVAILABLE',
      'The pending-request store is unavailable: writes that need it are refused.',
    );
    return { kind: 'UNAVAILABLE' };
  }
}

export type SettleOutcome = 'CONFIRMED' | 'REFUSED' | 'NEVER_SENT' | 'UNRESOLVED';

const MODE: Record<SettleOutcome, SettleMode> = {
  CONFIRMED: 'DONE',
  REFUSED: 'REVERT',
  NEVER_SENT: 'REVERT',
  UNRESOLVED: 'UNRESOLVED',
};

/**
 * Ends `attempt` with what the dispatch showed. Never throws: a store that
 * cannot be reached leaves the in-flight record to turn `UNRESOLVED` by itself,
 * which is the safe side. Returns whether the store took the change.
 */
export async function settleUnresolved(
  attempt: UnresolvedAttempt,
  outcome: SettleOutcome,
): Promise<boolean> {
  try {
    const reply = await defaultStore().settle(
      attempt.recordKey,
      attempt.setKey,
      attempt.id,
      attempt.attemptId,
      MODE[outcome],
    );
    return reply === 'DELETED' || reply === 'UNRESOLVED';
  } catch (error) {
    if (!(error instanceof UnresolvedStoreUnavailable)) throw error;
    warnOperator(
      'RASTA_WEB_PENDING_UNAVAILABLE',
      'The pending-request store is unavailable: an unresolved request will be settled by its lease.',
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Releasing ("send as new"), logout
// ---------------------------------------------------------------------------

const releaseSchema = z.object({ scope: z.string(), id: z.string().regex(/^[0-9a-f]{32}$/) });

/** The token the release form carries: names the record it was drawn for, bound to this login. */
export function releaseToken(
  session: WebSession,
  scope: UnresolvedScope,
  request: UnresolvedRequest,
  now: number = Date.now(),
): string {
  return signPayload(
    session,
    RELEASE_PURPOSE,
    { scope: scopeLabel(scope), id: request.id },
    RELEASE_TOKEN_TTL_SECONDS,
    now,
  );
}

export type ReleaseOutcome =
  | 'RELEASED'
  /** The record is not the one the form was drawn for (or the form is not ours): nothing changed. */
  | 'STALE'
  /** There is no record any more. */
  | 'GONE'
  /** A dispatch is in flight right now. */
  | 'IN_PROGRESS'
  | 'UNAVAILABLE';

/** Compare-and-delete: the record goes only if it is still the one `token` names. */
export async function releaseUnresolved(
  session: WebSession,
  scope: UnresolvedScope,
  token: unknown,
  now: number = Date.now(),
): Promise<ReleaseOutcome> {
  const named = verifyPayload(session, RELEASE_PURPOSE, token, releaseSchema, now);
  if (named === null || named.scope !== scopeLabel(scope)) return 'STALE';
  try {
    const keys = keysFor(session, scope);
    return await defaultStore().release(
      keys.recordKey,
      keys.setKey,
      named.id,
      now,
      INFLIGHT_LEASE_MS,
    );
  } catch (error) {
    if (!(error instanceof UnresolvedStoreUnavailable)) throw error;
    return 'UNAVAILABLE';
  }
}

/** Logout: deletes every record this login holds and its capacity set. True when the store took it. */
export async function purgeUnresolved(session: WebSession): Promise<boolean> {
  try {
    await defaultStore().purge(keysFor(session, { purpose: 'purge' }).setKey);
    return true;
  } catch (error) {
    if (!(error instanceof UnresolvedStoreUnavailable)) throw error;
    return false;
  }
}

/** True while `request` may still be sent: no deadline, or not yet reached. */
export function mayResend(request: UnresolvedRequest, now: number = Date.now()): boolean {
  return request.deadline === null || now <= request.deadline;
}

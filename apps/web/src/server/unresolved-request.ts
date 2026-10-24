import { createHash, createHmac, randomBytes } from 'node:crypto';

import Redis from 'ioredis';
import { z } from 'zod';

import { webServerEnv } from './env';
import type { RedisLike } from './refresh-coordinator';
import type { WebSession } from './session';
import { signPayload, verifyPayload } from './signed-payload';
import { MAX_CLOCK_SKEW_MS, policyOf } from './unresolved-request-policy';
import {
  deadlineOf,
  INFLIGHT_LEASE_MS,
  MAX_PENDING_PER_LOGIN,
  memoryUnresolvedStore,
  PENDING_KEY_PREFIX,
  redisUnresolvedStore,
  UnresolvedStoreUnavailable,
  type HeldReason,
  type RecordBinding,
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
 * What a purpose may do — retry or not, and whether it has a deadline — is one
 * table (`unresolved-request-policy.ts`). A record's `deadline` is **required**
 * for a purpose that resends: fixed when it is created as the earlier of the
 * signed stamp's deadline and `issuedAt + window(configuration then)`, and on
 * every retry the earlier of the **stored** one and `issuedAt +
 * window(configuration now)`: it only ever shrinks, and a record without a valid
 * stored deadline is corrupt (unavailable), never rebuilt from the current
 * window. It is checked inside the store's script against the store's own
 * clock, less a skew budget, on the first send as well as every retry. Past it
 * nothing is sent and the record is kept. The record expires 30 days after the
 * deadline (after its creation for a purpose that has none, stored as
 * `"NONE"`). Time: see `unresolved-request-store.ts` and the policy file.
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
  /** True while an attempt is being dispatched right now (by the store's clock, not this replica's). */
  readonly inFlight: boolean;
}

function scopeLabel(scope: UnresolvedScope): string {
  if (!PURPOSE_SLUG.test(scope.purpose)) throw new Error('unresolved-request: bad purpose');
  return `${scope.purpose}\n${scope.target ?? ''}`;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Every key names the organization (ADR-007) and is bound to this person's login; the record carries the same binding. */
function keysFor(session: WebSession, scope: UnresolvedScope): RecordBinding {
  const org = encodeURIComponent(session.organizationId ?? 'none');
  const login = `${session.subject}\n${session.csrfToken}`;
  const bind = sha256(`${login}\n${scopeLabel(scope)}`);
  const loginDigest = sha256(login);
  return {
    recordKey: `${PENDING_KEY_PREFIX}:org:${org}:pw:${bind}`,
    setKey: `${PENDING_KEY_PREFIX}:org:${org}:pwl:${loginDigest}`,
    org,
    login: loginDigest,
    purpose: scope.purpose,
    target: scope.target ?? '',
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

/** `now` is the store's time (Redis `TIME`), never this replica's. */
function viewOf(record: StoredRecord, now: number): UnresolvedRequest {
  return {
    id: record.id,
    key: record.key,
    digest: record.digest,
    deadline: deadlineOf(record),
    ref: record.ref,
    inFlight: record.state === 'RESERVED' && now - record.reservedAt <= INFLIGHT_LEASE_MS,
  };
}

/** A record found under a key it does not belong to is not trusted (the store checked it too). */
function trusted(record: StoredRecord, keys: RecordBinding): boolean {
  return record.bind === keys.bind;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type UnresolvedRead =
  | { readonly kind: 'NONE' }
  /** `now` is the store's time at the read: what `inFlight` and `mayResend` are judged by. */
  | { readonly kind: 'PENDING'; readonly request: UnresolvedRequest; readonly now: number }
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
): Promise<UnresolvedRead> {
  try {
    const keys = keysFor(session, scope);
    const { record, now } = await defaultStore().read(keys);
    if (record === null) return { kind: 'NONE' };
    if (!trusted(record, keys)) return { kind: 'UNAVAILABLE' };
    return { kind: 'PENDING', request: viewOf(record, now), now };
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
  readonly binding: RecordBinding;
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
   * `issuedAt + window(now)`. A finite number for a purpose whose policy says
   * `REQUIRED`; null exactly for one that says `NONE`.
   */
  readonly deadline: number | null;
  /** `window(configuration now)` in ms, bounding a retry; null exactly when `deadline` is. */
  readonly windowMs: number | null;
}

export type ReserveOutcome =
  | { readonly kind: 'RESERVED'; readonly attempt: UnresolvedAttempt; readonly retry: boolean }
  | { readonly kind: 'HELD'; readonly reason: HeldReason; readonly request: UnresolvedRequest }
  /** Past its deadline (less the skew budget). `request` is null for a first send: nothing was kept. */
  | { readonly kind: 'EXPIRED'; readonly request: UnresolvedRequest | null }
  | { readonly kind: 'CAPACITY' }
  /** The store could not be reached or read: nothing may be sent. */
  | { readonly kind: 'UNAVAILABLE' };

const newId = () => randomBytes(16).toString('hex');

/**
 * Whether a retry may be sent again, and whether a deadline is kept, come from
 * the purpose's row in the policy table — not from the caller. The caller's
 * numbers must agree with the row, or nothing is reserved.
 */
export async function reserveUnresolved(
  session: WebSession,
  scope: UnresolvedScope,
  input: ReserveInput,
): Promise<ReserveOutcome> {
  try {
    const keys = keysFor(session, scope);
    const policy = policyOf(scope.purpose);
    const numeric = policy?.deadline === 'REQUIRED';
    if (
      !policy ||
      (numeric
        ? !Number.isSafeInteger(input.deadline) ||
          !Number.isSafeInteger(input.windowMs) ||
          (input.deadline as number) < 0 ||
          (input.windowMs as number) < 0
        : input.deadline !== null || input.windowMs !== null)
    ) {
      throw new UnresolvedStoreUnavailable(new Error('input does not fit the purpose policy'));
    }
    const id = newId();
    const attemptId = newId();
    const reply = await defaultStore().reserve({
      binding: keys,
      cap: MAX_PENDING_PER_LOGIN,
      leaseMs: INFLIGHT_LEASE_MS,
      windowMs: input.windowMs,
      key: input.key,
      digest: input.digest,
      attemptId,
      fresh: {
        v: 2,
        purpose: keys.purpose,
        target: keys.target,
        org: keys.org,
        login: keys.login,
        id,
        attemptId,
        key: input.key,
        digest: input.digest,
        issuedAt: input.issuedAt,
        ref: input.ref,
        deadline: input.deadline ?? 'NONE',
        state: 'RESERVED',
        wasUnresolved: false,
        bind: keys.bind,
      },
    });
    if (reply.kind === 'CAPACITY') return { kind: 'CAPACITY' };
    if (reply.record === null) return { kind: 'EXPIRED', request: null };
    if (!trusted(reply.record, keys)) return { kind: 'UNAVAILABLE' };
    const request = viewOf(reply.record, reply.now);
    if (reply.kind === 'HELD') return { kind: 'HELD', reason: reply.reason, request };
    if (reply.kind === 'EXPIRED') return { kind: 'EXPIRED', request };
    return {
      kind: 'RESERVED',
      retry: reply.retry,
      attempt: { binding: keys, id: reply.record.id, attemptId: reply.record.attemptId },
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
      attempt.binding,
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
  /** Only the signed token's own expiry uses this replica's clock; the lease is judged by the store's. */
  tokenNow: number = Date.now(),
): Promise<ReleaseOutcome> {
  const named = verifyPayload(session, RELEASE_PURPOSE, token, releaseSchema, tokenNow);
  if (named === null || named.scope !== scopeLabel(scope)) return 'STALE';
  try {
    return await defaultStore().release(keysFor(session, scope), named.id, INFLIGHT_LEASE_MS);
  } catch (error) {
    if (!(error instanceof UnresolvedStoreUnavailable)) throw error;
    return 'UNAVAILABLE';
  }
}

/**
 * Logout: deletes every record this login holds and its capacity set. True when
 * the store did; false when it could not be reached **or** found a member that
 * is not valid (then it deleted nothing — see the store header).
 */
export async function purgeUnresolved(session: WebSession): Promise<boolean> {
  try {
    const keys = keysFor(session, { purpose: 'purge' });
    return await defaultStore().purge({ setKey: keys.setKey, org: keys.org, login: keys.login });
  } catch (error) {
    if (!(error instanceof UnresolvedStoreUnavailable)) throw error;
    return false;
  }
}

/**
 * True while `request` may still be sent: no deadline, or not yet reached by
 * `now` (the store's time, as the read returned it) plus the skew budget — the
 * same comparison the store's script makes, so the page never offers a send the
 * script would refuse.
 */
export function mayResend(request: UnresolvedRequest, now: number): boolean {
  return request.deadline === null || now + MAX_CLOCK_SKEW_MS <= request.deadline;
}

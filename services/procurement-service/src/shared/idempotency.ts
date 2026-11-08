import { createHash, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import type { ExtendedPrismaClient, PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from './prisma-errors';
import { idempotentReplaysTotal } from '../observability/metrics';
import { SERVICE_NAME, type ProcurementEnv } from '../config/env';
import {
  IN_FLIGHT_WAIT_MS,
  WAIT_TRANSACTION_SLACK_MS,
  replayFenceBudgetMs,
} from '../config/operation-budgets';
import type { DatabaseClock } from './clock';

export { IN_FLIGHT_WAIT_MS };

/** `Retry-After` on the in-flight 409, as docs/06 § 6.8 states it. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/** Between looks at a claim whose holder has not yet begun its transaction. */
const IN_FLIGHT_POLL_MS = 100;

/**
 * How many times one claim tries to reserve a key it keeps finding vanished or expired:
 * each retry means another request changed the row in between.
 */
const CLAIM_ATTEMPTS = 3;

/** An attempt that reserved nothing and must be made again. */
const RETRY_CLAIM = Symbol('retry-claim');
/** The key is another request's, still in flight. */
const IN_FLIGHT = Symbol('in-flight');

/** Bounds on the header: long enough to be unique, short enough to store. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** PostgreSQL's `lock_not_available`, raised when `lock_timeout` elapses. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Nothing of the key in what the exception filter logs (S-09): the endpoint locates it. */
function inFlight(endpoint: string): RastaError {
  return new RastaError('CONFLICT', 'This request is already being processed; retry shortly', {
    internalContext: { endpoint },
    retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS,
  });
}

/**
 * The claim this request took is no longer its own — its lease lapsed and a retry re-took
 * it, or it was purged — so its work must not commit. The key is either free or another
 * request's, and a retry learns which.
 */
function claimLost(endpoint: string): RastaError {
  return new RastaError(
    'CONFLICT',
    'This request took too long and its Idempotency-Key lapsed; retry shortly',
    { internalContext: { endpoint }, retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS },
  );
}

/**
 * Proven refusal, before anything is read or written: the deadline has passed on this service's
 * clock. Fixed message, nothing of the key's state.
 */
function windowClosed(endpoint: string): RastaError {
  return new RastaError(
    'REPLAY_WINDOW_CLOSED',
    'The time allowed for this request has passed; this attempt did nothing',
    { internalContext: { endpoint } },
  );
}

/**
 * Proven refusal, before anything is read or written: the deadline is later than the retention can
 * guarantee. Fixed message, depending on nothing stored.
 */
function deadlineBeyondRetention(endpoint: string): RastaError {
  return new RastaError('VALIDATION_FAILED', `${REPLAY_DEADLINE_HEADER} is invalid`, {
    details: [
      {
        path: REPLAY_DEADLINE_HEADER,
        code: 'beyond_retention',
        message: 'is later than this service can guarantee; this attempt did nothing',
      },
    ],
    internalContext: { endpoint },
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A **required** `Idempotency-Key`, trimmed (docs/06 § 6.8). Missing or blank is
 * `400 VALIDATION_FAILED` with code `required`; present but outside 8–255 characters is the
 * same refusal with code `invalid`.
 *
 * The service demands it itself and does not rely on the gateway (ADR-020): the protection
 * must not depend on which door a request used.
 */
export function requiredIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw RastaError.validation(
      [
        {
          path: 'Idempotency-Key',
          code: 'required',
          message: 'This endpoint requires an Idempotency-Key header',
        },
      ],
      'Idempotency-Key is required',
    );
  }
  const key = value.trim();
  if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw RastaError.validation(
      [
        {
          path: 'Idempotency-Key',
          code: 'invalid',
          message: `An Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN_LENGTH} to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
        },
      ],
      'Idempotency-Key is invalid',
    );
  }
  return key;
}

/** The header the replay fence reads: epoch milliseconds, canonical. */
export const REPLAY_DEADLINE_HEADER = 'Idempotency-Replay-Deadline';

const CANONICAL_EPOCH_MS = /^[1-9][0-9]{0,15}$/;

/**
 * Reads `Idempotency-Replay-Deadline` (construction-service's parser, FU-156). Absent → `undefined`.
 * Present → exactly one canonical safe-integer epoch-ms value (no sign, leading zero, space or
 * exponent; a duplicated header arrives comma-joined or as an array and fails). Anything else is
 * `400 VALIDATION_FAILED` before any claim.
 */
export function parseReplayDeadline(raw: string | string[] | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const refuse = (message: string): never => {
    throw RastaError.validation(
      [{ path: REPLAY_DEADLINE_HEADER, code: 'invalid', message }],
      `${REPLAY_DEADLINE_HEADER} is invalid`,
    );
  };
  if (typeof raw !== 'string') return refuse('must be sent once');
  if (!CANONICAL_EPOCH_MS.test(raw)) {
    return refuse('must be one canonical integer: milliseconds since the epoch');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return refuse('must be a safe integer');
  return value;
}

declare const idempotentRequestBrand: unique symbol;

/**
 * A keyed command's identity as the caller sent it: the key and, when sent, its replay deadline.
 * Made only by {@link idempotentRequest}, and the only thing {@link IdempotencyStore.execute}
 * accepts — so no command can pass a key without its deadline having been read (FU-156: the fence
 * is the store's, not each controller's).
 */
export interface IdempotentRequest {
  readonly key: string;
  readonly replayDeadlineMs: number | undefined;
  readonly [idempotentRequestBrand]: true;
}

/** The request headers a keyed command reads, as Nest's `@Headers()` hands them over. */
export type IdempotencyHeaders = Record<string, string | string[] | undefined>;

/**
 * The key ({@link requiredIdempotencyKey}) and the replay deadline ({@link parseReplayDeadline}) of a
 * keyed command, both judged here before any claim.
 */
export function idempotentRequest(headers: IdempotencyHeaders): IdempotentRequest {
  const rawKey = headers['idempotency-key'];
  const key = requiredIdempotencyKey(Array.isArray(rawKey) ? rawKey.join(', ') : rawKey);
  const replayDeadlineMs = parseReplayDeadline(headers[REPLAY_DEADLINE_HEADER.toLowerCase()]);
  return { key, replayDeadlineMs } as IdempotentRequest;
}

/**
 * What the work does with its claim **inside its own transaction**: `hold` is the
 * transaction's first statement and `complete` its last, so the claim check, the change, its
 * outbox row and the stored response commit together — or none of them does.
 */
export interface ClaimFence<T> {
  /**
   * Locks this claim's row (`SELECT … FOR UPDATE`) by its token. Throws — and so aborts the
   * whole transaction — when the claim is no longer this request's: its lease lapsed, or it
   * was released and re-taken by a retry.
   */
  hold(tx: ExtendedPrismaClient): Promise<void>;
  /**
   * Stores `result` as the response to replay, on the row `hold` locked, and starts the key's
   * lifetime from now. Returns the stored JSON, which is what this caller and every replay
   * receive.
   */
  complete(tx: ExtendedPrismaClient, result: T): Promise<T>;
}

/**
 * Re-checks, before a completed response is replayed, that the caller may still see what it
 * names — by the same rule a fresh request applies now, not the one that held when the
 * response was stored. Throws what that fresh request would answer; the stored body is then
 * never returned.
 */
export type ReplayGuard<T> = (stored: T) => Promise<void>;

/**
 * How a request is recognised: the digest stored with its claim, and whether a later request is
 * the same one. The default is the plain SHA-256 of the caller and the canonical body; a command
 * whose body is a secret (a quotation's price, plan PR 8) passes a keyed, salted one, whose
 * digests never compare as strings — so recognising is `matches`, never equality.
 */
export interface RequestHasher {
  hash(body: unknown): string;
  matches(stored: string, body: unknown): boolean;
}

type Claim =
  | { kind: 'PROCEED'; token: string; claimedAt: Date }
  | { kind: 'REPLAY'; status: number; body: unknown };

export type IdempotencyEnv = Pick<
  ProcurementEnv,
  | 'PROCUREMENT_IDEMPOTENCY_TTL_HOURS'
  | 'PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS'
  | 'PROCUREMENT_CLOCK_SKEW_SECONDS'
>;

/**
 * When a completed response stops being replayed: its retention from completion, and never before
 * `B` past the caller's replay deadline (FU-156). Completion can be read on another replica than the
 * claim, whose clock may be `2·skew` behind; this floor keeps the proof below independent of that.
 */
export function completedExpiryMs(
  completedAtMs: number,
  ttlHours: number,
  replayDeadlineMs: number | undefined,
  budgetMs: number,
): number {
  const retained = completedAtMs + ttlHours * 60 * 60 * 1000;
  return replayDeadlineMs === undefined
    ? retained
    : Math.max(retained, replayDeadlineMs + budgetMs);
}

/**
 * Idempotent commands (docs/06 § 6.8) — the store asset-service (#169) and
 * maintenance-service use, in this service's own copy (services share no source, A-02).
 *
 * | situation                               | response                                    |
 * | --------------------------------------- | ------------------------------------------- |
 * | no key, or one outside 8–255 characters | `400 VALIDATION_FAILED`, nothing claimed    |
 * | new key                                 | the work runs; its response is stored       |
 * | same key, same request, same caller     | the stored response, nothing runs again —   |
 * |                                         | if the caller may still see what it names   |
 * | same key, different request or caller   | `409 IDEMPOTENCY_KEY_REUSED`, no body       |
 * | key in flight past {@link IN_FLIGHT_WAIT_MS} | `409 CONFLICT` + `Retry-After: 1`      |
 *
 * Keys are the caller's organization's (`organization_id` leads the primary key): the same
 * key in two organizations is two requests, and one tenant can never reach another's stored
 * response. The route (`endpoint`) and the request, with its target demand and the caller's
 * user id, are hashed: a key reused for another demand, body or user is refused rather than
 * answered with a response that request never asked for.
 *
 * ## Claim first; then check, work and complete in one transaction
 *
 * The claim is committed on its own before the work starts, so a concurrent duplicate finds
 * `IN_PROGRESS` at once and waits for the stored response rather than racing the work. The
 * work's own transaction locks the claim row by its token before anything else
 * ({@link ClaimFence.hold}) and stores the response on it as its last statement
 * ({@link ClaimFence.complete}):
 *
 * - a duplicate that arrives while the work runs waits **on that row lock** (bounded by
 *   `lock_timeout`), and reads the stored response the moment the work commits;
 * - a command that outlives its claim cannot commit: once the lease lapsed and a retry
 *   re-took the key, `hold` finds no row with this token and the whole command aborts — the
 *   token fences the work, not only the row;
 * - a claim whose lease lapses while its work holds the lock cannot be re-taken under it:
 *   the retry's removal of the lapsed row waits for the lock — for what is left of the
 *   request's budget, never longer — then finds the row completed with a fresh lifetime;
 * - the response cannot fail to be stored after the change committed.
 *
 * Any failure of the work releases the claim, but only this claim's own in-flight row, never
 * a completed one or a successor's.
 *
 * ## A claim is a lease, not a lock for a day
 *
 * A claim in flight lives `PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS` (two minutes by
 * default); only a **completed** response lives `PROCUREMENT_IDEMPOTENCY_TTL_HOURS`. Past its
 * lease an abandoned claim is removed by the next retry, which takes the key under a **new
 * token** — the takeover is bounded.
 *
 * ## The replay fence (FU-156, PM decision D-125 — construction-service's, D-065/D-067)
 *
 * An expired key is reusable, which is right for a caller that never asked for more — and wrong
 * for one that retries a request which may have committed: after the response is purged the same
 * request runs as a NEW one (PR-830 r1 F2: a retry delayed past the retention made a second
 * demand). No caller can close that alone — a pause between its own check and this service's claim
 * is unbounded — so the store closes it with its own clocks, for every keyed command at once.
 *
 * A command may carry `Idempotency-Replay-Deadline` `H` (epoch ms, {@link parseReplayDeadline}): the
 * last instant it may be executed under its key. With `C` this replica's clock at the attempt,
 * `TTL` the retention and `B = 2·PROCUREMENT_CLOCK_SKEW_SECONDS + margin` ({@link replayFenceBudgetMs}):
 *
 *   - `C > H` → `409 REPLAY_WINDOW_CLOSED`, before anything is read or written — a replay of a
 *     stored response included; equality is allowed;
 *   - `H > C + TTL − B` → `400 VALIDATION_FAILED` (`beyond_retention`), before anything is read or
 *     written; never clamped. An honest client never meets it: the portal and this service are tied
 *     to `PROCUREMENT_MAX_REPLAY_WINDOW_SECONDS` and each refuses to boot when its settings break it;
 *   - the insert of a claim and the last word on `H` are ONE transaction: after the insert (and any
 *     lock wait it made) the DATABASE clock `T` is read ({@link DatabaseClock}), and `T > H` throws
 *     `REPLAY_WINDOW_CLOSED`, rolling the claim back — a request suspended between the check above
 *     and the insert cannot be admitted late;
 *   - a stored response is replayed only after the same decision on a FRESH database clock, read
 *     after every wait the replay made (the duplicate insert, the read, the guard) — never on the
 *     reading `C` taken before them (FU-172): `T > H` → `REPLAY_WINDOW_CLOSED`, nothing returned;
 *   - a completed response is kept until `max(completion + TTL, H + B)` ({@link completedExpiryMs}).
 *
 * Why an accepted `H` can never run twice: every clock (replicas', the database's) is within `s` of
 * true time `t`, `B = 2s + m`, `m > 0`. Executing needs a clock reading `≤ H` after the insert, so
 * `t ≤ H + s`. The completed response may be removed (by the claim's takeover or the purge, both
 * `expires_at ≤ now` on some replica) only at `t ≥ expiresAt − s ≥ H + B − s = H + s + m`. So the
 * only time a retry carrying `H` can be admitted is while the first execution's response still
 * exists: it is replayed, not run. A lapsed in-flight claim that is taken over committed nothing
 * (its work's `hold` fails), so re-admitting under it is a first execution.
 *
 * Not covered, stated: a request without the header behaves as before; a caller that deliberately
 * sends a NEW, later deadline for the same key after its response was purged makes a new request.
 */
export class IdempotencyStore {
  private readonly logger = new Logger(IdempotencyStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: IdempotencyEnv,
    private readonly clock: Pick<DatabaseClock, 'now'>,
  ) {}

  /**
   * Runs `work` at most once for this key, and returns its result — or the stored result of
   * the request that already ran it, once `stillVisible` has confirmed the caller may still
   * see what it names. Either way the value is the JSON the first request answered with.
   */
  async execute<T>(
    endpoint: string,
    request: IdempotentRequest,
    body: unknown,
    successStatus: number,
    work: (fence: ClaimFence<T>) => Promise<T>,
    stillVisible: ReplayGuard<T>,
    hasher: RequestHasher = this.sha256,
  ): Promise<{ result: T; executed: boolean }> {
    const { key, replayDeadlineMs } = request;
    const claim = await this.claim(endpoint, key, body, hasher, replayDeadlineMs);
    if (claim.kind === 'REPLAY') {
      const stored = claim.body as T;
      await stillVisible(stored);
      // The last word on the deadline, as for a new claim — after every wait this replay made (the
      // duplicate insert, the read of the stored row, the guard), on a fresh database clock
      // (FU-172, PR-844 r1 F1). Nothing was written, so refusing here changes nothing.
      await this.assertWindowOpen(this.prisma.client, endpoint, replayDeadlineMs);
      return { result: stored, executed: false };
    }

    let stored: { value: T } | undefined;
    const fence: ClaimFence<T> = {
      hold: (tx) => this.hold(tx, endpoint, key, claim.token),
      complete: async (tx, result) => {
        const value = JSON.parse(JSON.stringify(result)) as T;
        await this.storeResponse(
          tx,
          endpoint,
          key,
          claim.token,
          successStatus,
          value,
          replayDeadlineMs,
        );
        stored = { value };
        return value;
      },
    };

    try {
      await work(fence);
    } catch (error) {
      // The work's own failure is the answer. A release that fails on top of it (the database that
      // refused the work may refuse this too) must not replace it with an unrelated error: it is logged, and the claim simply stays until its
      // lease lapses (PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS, docs/06 § 6.8), after which a retry
      // takes the key over. Until then a retry with the same key is 409 CONFLICT with Retry-After.
      // A refusal releases the claim like any failure: a request that could succeed on retry must
      // be free to (docs/06 § 6.8).
      await this.releaseQuietly(endpoint, key, claim.token);
      throw error;
    }
    // A work that returned without completing its claim committed nothing the key can
    // replay: a defect, never a success to report.
    if (!stored) {
      await this.releaseQuietly(endpoint, key, claim.token);
      throw new Error(`${endpoint}: the work returned without completing its idempotency claim`);
    }
    return { result: stored.value, executed: true };
  }

  /**
   * {@link ClaimFence.hold}: the first statement of the work's transaction. Not lapsed by
   * this service's clock — the one the takeover in `claimOnce` reads — and still this
   * claim's, or the transaction aborts.
   */
  private async hold(
    tx: ExtendedPrismaClient,
    endpoint: string,
    key: string,
    token: string,
  ): Promise<void> {
    const organizationId = getOrganizationId();
    const rows = await tx.$queryRaw<{ held: number }[]>`
      SELECT 1 AS held FROM idempotency_key
      WHERE organization_id = ${organizationId} AND endpoint = ${endpoint} AND key = ${key}
        AND claim_token = ${token} AND state = 'IN_PROGRESS' AND expires_at > ${new Date()}
      FOR UPDATE`;
    if (rows.length === 0) {
      this.logLostClaim('hold', endpoint);
      throw claimLost(endpoint);
    }
  }

  /**
   * {@link ClaimFence.complete}: the response for replay, on the row `hold` locked, in the
   * work's own transaction. The key lives `PROCUREMENT_IDEMPOTENCY_TTL_HOURS` from now — from
   * the response, not the claim, which only ever held a lease — and never less than `B` past the
   * replay deadline ({@link completedExpiryMs}). Matched on the token, so a stale holder's
   * completion is refused even if `hold` was skipped.
   */
  async storeResponse(
    tx: ExtendedPrismaClient,
    endpoint: string,
    key: string,
    token: string,
    status: number,
    body: unknown,
    replayDeadlineMs: number | undefined,
  ): Promise<void> {
    const organizationId = getOrganizationId();
    const { count } = await tx.idempotencyKey.updateMany({
      where: { organizationId, endpoint, key, claimToken: token, state: 'IN_PROGRESS' },
      data: {
        state: 'COMPLETED',
        responseStatus: status,
        responseBody: body as object,
        expiresAt: new Date(
          completedExpiryMs(
            Date.now(),
            this.env.PROCUREMENT_IDEMPOTENCY_TTL_HOURS,
            replayDeadlineMs,
            this.budgetMs(),
          ),
        ),
      },
    });
    if (count !== 1) {
      this.logLostClaim('complete', endpoint);
      throw claimLost(endpoint);
    }
  }

  /**
   * THE deadline decision (FU-172): the one place `H` is judged against the clock that decides, for a
   * new claim's admission (inside its transaction, after the insert) and for a stored response's
   * replay (after the read and every wait before it) alike. The database clock is read fresh here —
   * never a reading taken before a wait — and `T > H` is `REPLAY_WINDOW_CLOSED`; equality is allowed.
   * No deadline, no fence. A clock that cannot be read throws ({@link DatabaseClock}): refused.
   */
  private async assertWindowOpen(
    client: ExtendedPrismaClient,
    endpoint: string,
    replayDeadlineMs: number | undefined,
  ): Promise<void> {
    if (replayDeadlineMs === undefined) return;
    const databaseNow = await this.clock.now(client);
    if (!(databaseNow.getTime() <= replayDeadlineMs)) throw windowClosed(endpoint);
  }

  /** B, the replay fence's budget ({@link replayFenceBudgetMs}). */
  private budgetMs(): number {
    return replayFenceBudgetMs(this.env.PROCUREMENT_CLOCK_SKEW_SECONDS);
  }

  /** When a claim still **in flight** may be taken over by a retry. */
  private lease(from: Date): Date {
    return new Date(from.getTime() + this.env.PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS * 1000);
  }

  /** SHA-256 over the canonical request and the caller who sent it. */
  hash(body: unknown): string {
    return hashRequest({ caller: getContext().userId ?? null, body });
  }

  private readonly sha256: RequestHasher = {
    hash: (body) => this.hash(body),
    matches: (stored, body) => stored === this.hash(body),
  };

  /**
   * Reserves the key, waits on it while another request holds it, or reports the stored
   * response to replay. The two conflicts and the replay fence's refusals throw.
   */
  async claim(
    endpoint: string,
    key: string,
    body: unknown,
    hasher: RequestHasher,
    replayDeadlineMs: number | undefined,
  ): Promise<Claim> {
    const requestHash = hasher.hash(body);
    const sameRequest = (stored: string) => hasher.matches(stored, body);
    const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
    let retries = 0;
    for (;;) {
      const outcome = await this.claimOnce(
        endpoint,
        key,
        requestHash,
        sameRequest,
        deadline,
        replayDeadlineMs,
      );
      if (outcome === RETRY_CLAIM) {
        retries += 1;
        if (retries >= CLAIM_ATTEMPTS) throw inFlight(endpoint);
        continue;
      }
      if (outcome === IN_FLIGHT) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw inFlight(endpoint);
        await this.awaitHolder(endpoint, key, remaining);
        continue;
      }
      return outcome;
    }
  }

  /**
   * One attempt. `PROCEED` only from the insert that wrote the row: a request that lost the
   * insert and then found no row, or a lapsed one, reserved nothing and tries again. A lapsed
   * row is removed only while it is still lapsed — the removal waits for a holder's lock and
   * re-checks — never a fresh claim or a response that replaced it.
   *
   * Every statement here that can wait on another transaction's lock waits only for what
   * remains of the request's {@link IN_FLIGHT_WAIT_MS} budget ({@link withinBudget}), and
   * running out is the retryable `409 CONFLICT`, never a hang.
   */
  private async claimOnce(
    endpoint: string,
    key: string,
    requestHash: string,
    sameRequest: (stored: string) => boolean,
    deadline: number,
    replayDeadlineMs: number | undefined,
  ): Promise<Claim | typeof RETRY_CLAIM | typeof IN_FLIGHT> {
    const organizationId = getOrganizationId();
    const now = new Date();

    // The replay fence, before anything is read or written: it depends on nothing stored, so it
    // discloses nothing about the key. Every attempt re-reads the clock (a wait on a holder is one).
    if (replayDeadlineMs !== undefined) {
      if (now.getTime() > replayDeadlineMs) throw windowClosed(endpoint);
      const retentionMs = this.env.PROCUREMENT_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
      if (replayDeadlineMs > now.getTime() + retentionMs - this.budgetMs()) {
        throw deadlineBeyondRetention(endpoint);
      }
    }

    const token = randomUUID();
    try {
      await this.withinBudget(endpoint, deadline, async (tx) => {
        await tx.idempotencyKey.create({
          data: {
            organizationId,
            endpoint,
            key,
            requestHash,
            claimToken: token,
            state: 'IN_PROGRESS',
            // The lease, not the response's lifetime: `storeResponse` moves it to that.
            expiresAt: this.lease(now),
          },
        });
        // Admission, on the database clock, after the insert and any lock wait it made: a request
        // suspended between the check above and here is refused, and throwing rolls the claim back.
        await this.assertWindowOpen(tx, endpoint, replayDeadlineMs);
      });
      return { kind: 'PROCEED', token, claimedAt: now };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.client.idempotencyKey.findFirst({
      where: { organizationId, endpoint, key },
    });
    if (!existing) return RETRY_CLAIM;

    if (existing.expiresAt <= now) {
      // Waits for a holder still in its transaction — within the budget only.
      await this.withinBudget(
        endpoint,
        deadline,
        (tx) => tx.$executeRaw`DELETE FROM idempotency_key
          WHERE organization_id = ${organizationId} AND endpoint = ${endpoint} AND key = ${key}
            AND expires_at <= ${now}`,
      );
      return RETRY_CLAIM;
    }

    // Before anything about the stored state: another request or another caller learns
    // nothing of it, not even that it is still in flight.
    if (!sameRequest(existing.requestHash)) throw RastaError.idempotencyKeyReused();

    if (existing.state === 'IN_PROGRESS') return IN_FLIGHT;

    idempotentReplaysTotal.inc({ service: SERVICE_NAME, endpoint });
    return {
      kind: 'REPLAY',
      status: existing.responseStatus ?? 200,
      body: existing.responseBody,
    };
  }

  /**
   * Runs one claim-side statement in a short transaction of its own, whose `lock_timeout` is
   * what is left of the request's budget: a lock it cannot get in that time is the retryable
   * `409 CONFLICT` (`Retry-After: 1`), never an unbounded wait. A budget already spent
   * refuses before asking.
   */
  private async withinBudget<R>(
    endpoint: string,
    deadline: number,
    statement: (tx: ExtendedPrismaClient) => Promise<R>,
  ): Promise<R> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw inFlight(endpoint);
    const waitMs = Math.max(1, Math.ceil(remaining));
    try {
      return await this.prisma.transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${waitMs}ms`}, true)`;
          return statement(tx);
        },
        { timeoutMs: waitMs + WAIT_TRANSACTION_SLACK_MS },
      );
    } catch (error) {
      if (isLockTimeout(error)) throw inFlight(endpoint);
      throw error;
    }
  }

  /**
   * Waits for the request holding this key: on its row lock while its work's transaction
   * runs — so the wait ends the moment that commits or rolls back — and, when the holder has
   * not begun its transaction yet, for a short poll. Bounded by `remainingMs` through
   * `lock_timeout`; running out is not an error here, the caller's deadline decides.
   */
  private async awaitHolder(endpoint: string, key: string, remainingMs: number): Promise<void> {
    const organizationId = getOrganizationId();
    const waitMs = Math.max(1, Math.ceil(remainingMs));
    const started = Date.now();
    try {
      await this.prisma.transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${waitMs}ms`}, true)`;
          await tx.$queryRaw`
            SELECT 1 FROM idempotency_key
            WHERE organization_id = ${organizationId} AND endpoint = ${endpoint} AND key = ${key}
            FOR SHARE`;
        },
        { timeoutMs: waitMs + WAIT_TRANSACTION_SLACK_MS },
      );
    } catch (error) {
      if (!isLockTimeout(error)) throw error;
      return;
    }
    const waited = Date.now() - started;
    if (waited < IN_FLIGHT_POLL_MS) await sleep(IN_FLIGHT_POLL_MS - waited);
  }

  /** {@link release} on a failure path: never throws, so it can never mask the failure being answered. */
  private async releaseQuietly(endpoint: string, key: string, token: string): Promise<void> {
    try {
      await this.release(endpoint, key, token);
    } catch (releaseError: unknown) {
      this.logger.error(
        `Could not release the idempotency claim of ${endpoint} (${
          releaseError instanceof Error ? releaseError.name : 'unknown'
        }); it expires with its lease`,
      );
    }
  }

  /**
   * Frees a claim whose work failed, so a corrected retry with the same key can run — only
   * this claim's own in-flight row, never a completed one or a successor's.
   */
  async release(endpoint: string, key: string, token: string): Promise<void> {
    const organizationId = getOrganizationId();
    const { count } = await this.prisma.client.idempotencyKey.deleteMany({
      where: { organizationId, endpoint, key, claimToken: token, state: 'IN_PROGRESS' },
    });
    if (count === 0) this.logLostClaim('release', endpoint);
  }

  /** Nothing of the key or token in the log (S-09). */
  private logLostClaim(operation: 'hold' | 'complete' | 'release', endpoint: string): void {
    this.logger.warn(
      `idempotency ${operation} matched no in-progress row for this claim (lapsed, purged or re-taken); left untouched: ${endpoint}`,
    );
  }

  /**
   * Removes expired records, on the upkeep timer. Unscoped by necessity — the timer runs
   * outside any request — and safe: the predicate is age alone, so it can only remove records
   * `claim` already refuses to honour.
   */
  async purgeExpired(): Promise<number> {
    return runUnscoped(
      'expired idempotency records are platform upkeep, deleted by age alone and never by tenant',
      async () => {
        const now = new Date();
        const keys = await this.prisma.client.idempotencyKey.deleteMany({
          where: { expiresAt: { lt: now } },
        });
        return keys.count;
      },
    );
  }
}

/** A `lock_timeout` that elapsed, as Prisma reports it from a raw query. */
function isLockTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const meta = (error as { meta?: { code?: unknown } }).meta;
  if (meta?.code === LOCK_NOT_AVAILABLE) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('lock timeout');
}

/**
 * Canonical SHA-256 of a request: object keys sorted recursively, so the same request
 * serialised in another key order is recognised as a retry.
 *
 * Every own key is hashed, whatever its name. The sorted copies have no prototype
 * (`Object.create(null)`): assigning `"__proto__"` into a plain `{}` would set its prototype
 * instead of creating a key, and `JSON.stringify` would then drop it — two different bodies
 * would hash alike and the second would replay the first's response.
 */
export function hashRequest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(value)))
    .digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}

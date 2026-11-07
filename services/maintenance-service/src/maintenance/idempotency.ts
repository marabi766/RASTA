import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { isUniqueViolation } from './maintenance.repository';
import { idempotentReplaysTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type MaintenanceEnv } from '../config/env';
import {
  IN_FLIGHT_WAIT_MS,
  WAIT_TRANSACTION_SLACK_MS,
  replayFenceBudgetMs,
} from '../config/operation-budgets';

export { IN_FLIGHT_WAIT_MS };

/** `Retry-After` on the in-flight 409, as docs/06 § 6.8 states it. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

const IN_FLIGHT_POLL_MS = 100;

/**
 * How many times one claim tries to reserve a key it keeps finding vanished or
 * expired: each retry means another request changed the row in between.
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
 * The claim this request took is no longer its own — expired, purged, or
 * re-taken by a retry — so its work must not commit. The key is either free
 * or another request's, and a retry learns which.
 */
function claimLost(endpoint: string): RastaError {
  return new RastaError(
    'CONFLICT',
    'This request took too long and its Idempotency-Key lapsed; retry shortly',
    { internalContext: { endpoint }, retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS },
  );
}

/**
 * Proven refusal: the deadline has passed, and this attempt wrote nothing. Fixed
 * message, nothing of the key's state.
 */
function windowClosed(endpoint: string): RastaError {
  return new RastaError(
    'REPLAY_WINDOW_CLOSED',
    'The time allowed for this request has passed; this attempt did nothing',
    { internalContext: { endpoint } },
  );
}

/**
 * Proven refusal, before anything is read or written: the deadline is later than
 * the retention can guarantee. Fixed message, depending on nothing stored.
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
 * What the work does with its claim **inside its own transaction** (round 1 on
 * #171): `hold` is the transaction's first statement and `complete` its last,
 * so the claim check, the domain write, its outbox rows and the stored
 * response commit together — or none of them does.
 */
export interface ClaimFence<T> {
  /**
   * Locks this claim's row (`SELECT … FOR UPDATE`) by its token. Throws — and
   * so aborts the whole transaction — when the claim is no longer this
   * request's: expired, or released and re-taken by a retry.
   */
  hold(tx: ExtendedPrismaClient): Promise<void>;
  /**
   * Stores `result` as the response to replay, on the row `hold` locked, and
   * starts the key's lifetime from now (never less than the replay fence's
   * floor). Returns the stored JSON, which is what this caller and every replay
   * receive.
   */
  complete(tx: ExtendedPrismaClient, result: T): Promise<T>;
}

type Claim = { kind: 'PROCEED'; token: string } | { kind: 'REPLAY'; status: number; body: unknown };

/**
 * An optional `Idempotency-Key` (docs/06 § 6.8, #157), trimmed; `undefined`
 * when the header is absent, which keeps the create path as it was. A key
 * that is present but empty or out of bounds is refused, never ignored: a
 * client that sent one relies on it.
 */
export function optionalIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
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

/**
 * A **required** `Idempotency-Key`, trimmed — for the writes that add money to a
 * bill or close one, where a retried post must be the same post. Missing or
 * empty is `400 VALIDATION_FAILED` with code `required`; present but out of
 * bounds is the same refusal with code `invalid`, exactly as for an optional key.
 *
 * The gateway demands the header on these routes too; the service does not
 * assume it was only reached through the gateway (ADR-020), because the
 * protection against a double post must not depend on which door a request
 * used.
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
  return optionalIdempotencyKey(value) as string;
}

/** The header the replay fence reads: epoch milliseconds, canonical. */
export const REPLAY_DEADLINE_HEADER = 'Idempotency-Replay-Deadline';

const CANONICAL_EPOCH_MS = /^[1-9][0-9]{0,15}$/;

/**
 * Reads `Idempotency-Replay-Deadline` (procurement's parser, FU-156). Absent →
 * `undefined`. Present → exactly one canonical safe-integer epoch-ms value (no
 * sign, leading zero, space or exponent; a duplicated header arrives comma-joined
 * or as an array and fails). Anything else is `400 VALIDATION_FAILED` before any
 * claim.
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
 * A keyed command's identity as the caller sent it: the key and, when sent, its
 * replay deadline. Made only by {@link idempotentRequest} and
 * {@link optionalIdempotentRequest}, and the only thing
 * {@link IdempotencyStore.execute} accepts — so no command can pass a key without
 * its deadline having been read (FU-171: the fence is the store's, not each
 * controller's).
 */
export interface IdempotentRequest {
  readonly key: string;
  readonly replayDeadlineMs: number | undefined;
  readonly [idempotentRequestBrand]: true;
}

/** The request headers a keyed command reads, as Nest's `@Headers()` hands them over. */
export type IdempotencyHeaders = Record<string, string | string[] | undefined>;

const rawKeyOf = (headers: IdempotencyHeaders): string | undefined => {
  const raw = headers['idempotency-key'];
  return Array.isArray(raw) ? raw.join(', ') : raw;
};

const deadlineOf = (headers: IdempotencyHeaders): number | undefined =>
  parseReplayDeadline(headers[REPLAY_DEADLINE_HEADER.toLowerCase()]);

/** The key ({@link requiredIdempotencyKey}) and deadline of a command that must have a key. */
export function idempotentRequest(headers: IdempotencyHeaders): IdempotentRequest {
  const key = requiredIdempotencyKey(rawKeyOf(headers));
  return { key, replayDeadlineMs: deadlineOf(headers) } as IdempotentRequest;
}

/**
 * The same, for a command whose key is optional: `undefined` only when neither
 * header came, which keeps that path as it was. A deadline with no key is refused,
 * never ignored: a caller that sent one relies on it, and nothing could hold a
 * keyless request to it.
 */
export function optionalIdempotentRequest(
  headers: IdempotencyHeaders,
): IdempotentRequest | undefined {
  const key = optionalIdempotencyKey(rawKeyOf(headers));
  const replayDeadlineMs = deadlineOf(headers);
  if (key === undefined && replayDeadlineMs === undefined) return undefined;
  return { key: key ?? requiredIdempotencyKey(undefined), replayDeadlineMs } as IdempotentRequest;
}

/**
 * When a completed response stops being replayed: its retention from completion,
 * and never before `B` past the caller's replay deadline (FU-171). Completion can
 * be read on another replica than the claim, whose clock may be `2·skew` behind;
 * this floor keeps the fence's proof independent of that.
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
 * Idempotent creation of maintenance requests (docs/06 § 6.8, #157) — the
 * shape marketplace-service uses since #147, in this service's own copy
 * (services share no source, A-02).
 *
 * | situation                               | response                                    |
 * | --------------------------------------- | ------------------------------------------- |
 * | no key                                  | the work runs, as before                    |
 * | new key                                 | the work runs; its 201 body is stored       |
 * | same key, same body, same caller        | the stored 201 body, nothing runs again     |
 * | same key, different body or caller      | `409 IDEMPOTENCY_KEY_REUSED`                |
 * | key in flight, still after {@link IN_FLIGHT_WAIT_MS} | `409 CONFLICT` + `Retry-After: 1` |
 * | past its replay deadline, a replay too  | `409 REPLAY_WINDOW_CLOSED`, nothing written |
 * | a replay deadline beyond the retention  | `400 VALIDATION_FAILED`, nothing claimed    |
 *
 * Keys are the tenant's (`organization_id` leads the primary key): the same
 * key in two organizations is two requests. The caller's user id is part of
 * the hashed request, so a key reused by another user of the same tenant is
 * refused rather than replaying a request that user may not be allowed to see
 * (a DRIVER sees only what they reported).
 *
 * A replay is the response as it was at creation. A request closed or
 * cancelled since is not raised again while the key is live: that is the
 * point of the key.
 *
 * ## Claim first; then check, work and complete in one transaction
 *
 * The claim is committed on its own before the work starts, so a concurrent
 * duplicate finds `IN_PROGRESS` at once and waits for the stored response
 * rather than racing the work. The work's own transaction then locks the claim
 * row by its token before anything else ({@link ClaimFence.hold}) and stores
 * the response on it as its last statement ({@link ClaimFence.complete})
 * (round 1 on #171):
 *
 * - a create that outlives its claim cannot commit: once the claim expired
 *   and a retry re-took it, `hold` finds no row with this token and the whole
 *   create aborts — the token fences the work, not only the row;
 * - a claim that expires while its create holds the lock cannot be re-taken
 *   under it: the retry's removal of the expired row waits for the lock, and
 *   then finds the row completed with a fresh lifetime, and replays it;
 * - the response cannot fail to be stored after the request committed: it
 *   commits with the request and its outbox rows, or nothing does.
 *
 * Any failure of the work — its own, or the claim being lost — releases the
 * claim, but only this claim's own in-flight row, never a successor's.
 *
 * ## A claim is a lease, not a lock for a day
 *
 * A process can die after its claim committed and before the work did. So a
 * claim in flight lives `MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS` (two
 * minutes by default), and only a **completed** response lives
 * `MAINTENANCE_IDEMPOTENCY_TTL_HOURS`. Past its lease an abandoned claim is
 * removed by the next retry, which takes the key under a **new token**: the old
 * holder, if it is merely slow rather than dead, can then neither pass `hold`
 * nor store a response, because both match on the token it no longer has — and
 * a claim whose work already holds the row's lock cannot be taken from under
 * it, because the removal waits for that lock and then finds the response.
 * That wait — like the insert's, behind an uncommitted removal — lasts only
 * what is left of the request's {@link IN_FLIGHT_WAIT_MS}, and running out is
 * the retryable `409 CONFLICT`, never a hang (#194).
 *
 * ## The replay fence (FU-171, PM decision D-133 — procurement's, FU-156, with PR-844 r1 F1 closed)
 *
 * An expired key is reusable, which is right for a caller that never asked for
 * more — and wrong for one that retries a request which may have committed: a cost
 * line has no other backstop, so after the response is purged the same request
 * adds it to the bill again. No caller can close that alone — a pause between its
 * own check and this service's claim is unbounded — so the store closes it with
 * its own clocks, for every keyed command.
 *
 * A command may carry `Idempotency-Replay-Deadline` `H` (epoch ms,
 * {@link parseReplayDeadline}): the last instant it may be admitted under its key,
 * or answered from its stored response. With `C` this replica's clock at the
 * attempt, `T` the database clock, `TTL` the retention and
 * `B = 2·MAINTENANCE_CLOCK_SKEW_SECONDS + margin` ({@link replayFenceBudgetMs}):
 *
 *   - `C > H` → `409 REPLAY_WINDOW_CLOSED`, before anything is read or written —
 *     the order the request names included ({@link IdempotencyStore.assertAdmissible}),
 *     so the answer depends on nothing stored; equality is allowed;
 *   - `H > C + TTL − B` → `400 VALIDATION_FAILED` (`beyond_retention`), just as
 *     early; never clamped. An honest client never meets it: this service is tied
 *     to `MAINTENANCE_MAX_REPLAY_WINDOW_SECONDS` and refuses to boot when its
 *     settings break it;
 *   - **one decision on `T` for both ways through a claim**
 *     ({@link IdempotencyStore.assertWindowOpen}), read fresh after every wait: a
 *     new claim's insert and `T` are ONE transaction, so `T > H` rolls the claim
 *     back; a stored response is selected only after `T` is read past the insert
 *     that lost and the read of the row, and nothing waits between that reading
 *     and the response leaving (the caller's right to the order is asked before the
 *     claim, not after it);
 *   - a completed response is kept until `max(completion + TTL, H + B)`
 *     ({@link completedExpiryMs}).
 *
 * Why an accepted `H` can never run twice: every clock (replicas', the database's)
 * is within `s` of true time `t`, `B = 2s + m`, `m > 0`. Executing needs `T ≤ H`
 * after the insert, so `t ≤ H + s`. The completed response may be removed (by a
 * takeover or the purge, both `expires_at ≤ now` on some replica) only at
 * `t ≥ expiresAt − s ≥ H + B − s = H + s + m`. So the only time a retry carrying
 * `H` can be admitted is while the first execution's response still exists: it is
 * replayed, not run. A lapsed in-flight claim that is taken over committed nothing
 * (its work's `hold` fails), so re-admitting under it is a first execution.
 *
 * Not covered, stated: a request without the header behaves as before (D-133: the
 * header becomes required later); a caller that sends a NEW, later deadline for the
 * same key — or a first deadline on a retry whose first attempt had none — is not
 * held to a floor nobody stored, and after that response is purged it makes a new
 * request; a claim admitted at `H` may finish its work after `H`, for at most its
 * lease, and that one execution is still the only one.
 */
@Injectable()
export class IdempotencyStore {
  private readonly logger = new Logger(IdempotencyStore.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV)
    private readonly env: Pick<
      MaintenanceEnv,
      | 'MAINTENANCE_IDEMPOTENCY_TTL_HOURS'
      | 'MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS'
      | 'MAINTENANCE_CLOCK_SKEW_SECONDS'
    >,
  ) {}

  /**
   * Runs `work` at most once for this key, and returns its result — or the
   * stored result of the request that already ran it. Either way the value is
   * the JSON the first request answered with, so both callers of a double
   * submit receive the same body — when the first finishes within
   * {@link IN_FLIGHT_WAIT_MS}. Past that, the duplicate is answered
   * `409 CONFLICT` with `Retry-After`, and its retry gets the same body.
   */
  async execute<T>(
    endpoint: string,
    request: IdempotentRequest,
    body: unknown,
    successStatus: number,
    work: (fence: ClaimFence<T>) => Promise<T>,
  ): Promise<{ result: T; executed: boolean }> {
    const { key, replayDeadlineMs } = request;
    const claim = await this.claim(endpoint, key, body, replayDeadlineMs);
    if (claim.kind === 'REPLAY') return { result: claim.body as T, executed: false };

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
      await this.release(endpoint, key, claim.token);
      throw error;
    }
    // A work that returned without completing its claim committed nothing the
    // key can replay: a defect, never a success to report.
    if (!stored) {
      await this.release(endpoint, key, claim.token);
      throw new Error(`${endpoint}: the work returned without completing its idempotency claim`);
    }
    return { result: stored.value, executed: true };
  }

  /**
   * {@link ClaimFence.hold}: the first statement of the work's transaction.
   * Not expired by this service's clock, and still this claim's — or the
   * transaction aborts.
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
   * {@link ClaimFence.complete}: the response for replay, on the row `hold`
   * locked, in the work's own transaction. The key lives
   * `MAINTENANCE_IDEMPOTENCY_TTL_HOURS` from now — from the response, not the
   * claim, which only ever held a lease — and never less than `B` past the replay
   * deadline ({@link completedExpiryMs}), so a retry that waited on the lock finds
   * it live and replays it.
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
            this.env.MAINTENANCE_IDEMPOTENCY_TTL_HOURS,
            replayDeadlineMs,
            this.budgetMs(),
          ),
        ),
      },
    });
    // Held since the transaction began, so never 0 — unless `hold` was skipped.
    if (count !== 1) throw claimLost(endpoint);
  }

  /** B, the replay fence's budget ({@link replayFenceBudgetMs}). */
  private budgetMs(): number {
    return replayFenceBudgetMs(this.env.MAINTENANCE_CLOCK_SKEW_SECONDS);
  }

  /**
   * The fence's early refusals, on this replica's clock: they depend on nothing
   * stored, so they disclose nothing — whatever the key or the order named. Asked
   * by every attempt at a claim, and by a command that reads before it claims, so
   * a request refused here read nothing.
   */
  assertAdmissible(endpoint: string, request: Pick<IdempotentRequest, 'replayDeadlineMs'>): void {
    const { replayDeadlineMs } = request;
    if (replayDeadlineMs === undefined) return;
    const nowMs = Date.now();
    if (nowMs > replayDeadlineMs) throw windowClosed(endpoint);
    const retentionMs = this.env.MAINTENANCE_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
    if (replayDeadlineMs > nowMs + retentionMs - this.budgetMs()) {
      throw deadlineBeyondRetention(endpoint);
    }
  }

  /**
   * The one deadline decision, for a new claim and a stored response alike: a fresh
   * reading of the database clock, on the connection given, past `H` is
   * `REPLAY_WINDOW_CLOSED`. Called after every wait; no deadline, no reading. A
   * reading that fails throws, and nothing is admitted or replayed.
   */
  private async assertWindowOpen(
    db: ExtendedPrismaClient,
    endpoint: string,
    replayDeadlineMs: number | undefined,
  ): Promise<void> {
    if (replayDeadlineMs === undefined) return;
    const databaseNow = await this.readDatabaseClock(db);
    if (!(databaseNow.getTime() <= replayDeadlineMs)) throw windowClosed(endpoint);
  }

  /** `clock_timestamp()`, the fence's last word; a bad reading aborts, never this replica's clock. */
  protected async readDatabaseClock(db: ExtendedPrismaClient): Promise<Date> {
    const rows = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const now = rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('clock_timestamp() did not return a timestamp; refusing to admit');
    }
    return now;
  }

  /**
   * When a claim still **in flight** may be taken over: a short lease, not a
   * response's lifetime. A request that died holding one is retried, under a
   * new token, after this — not after a day.
   */
  private lease(from: Date): Date {
    return new Date(from.getTime() + this.env.MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS * 1000);
  }

  /** SHA-256 over the canonical request and the caller who sent it. */
  hash(body: unknown): string {
    return hashRequest({ caller: getContext().userId ?? null, body });
  }

  /**
   * Reserves the key, waits on it while another request holds it, or reports
   * the stored response to replay. The two conflicts and the replay fence's
   * refusals throw.
   */
  async claim(
    endpoint: string,
    key: string,
    body: unknown,
    replayDeadlineMs: number | undefined,
  ): Promise<Claim> {
    const requestHash = this.hash(body);
    const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
    let retries = 0;
    for (;;) {
      const outcome = await this.claimOnce(endpoint, key, requestHash, deadline, replayDeadlineMs);
      if (outcome === RETRY_CLAIM) {
        retries += 1;
        if (retries >= CLAIM_ATTEMPTS) throw inFlight(endpoint);
        continue;
      }
      if (outcome === IN_FLIGHT) {
        if (Date.now() >= deadline) throw inFlight(endpoint);
        await sleep(IN_FLIGHT_POLL_MS);
        continue;
      }
      return outcome;
    }
  }

  /**
   * One attempt. `PROCEED` only from the insert that wrote the row: a request
   * that lost the insert and then found no row, or an expired one, reserved
   * nothing and tries again. An expired row is removed only while it is still
   * expired, never a fresh claim that replaced it.
   *
   * Every statement here that can wait on another transaction's lock — the
   * insert, behind an uncommitted removal of the same key; the removal,
   * behind a holder still in its transaction — waits only for what remains of
   * the request's budget ({@link withinBudget}).
   */
  private async claimOnce(
    endpoint: string,
    key: string,
    requestHash: string,
    deadline: number,
    replayDeadlineMs: number | undefined,
  ): Promise<Claim | typeof RETRY_CLAIM | typeof IN_FLIGHT> {
    const organizationId = getOrganizationId();
    // Before anything is read or written; every attempt re-reads the clock (a wait
    // on a holder is one).
    this.assertAdmissible(endpoint, { replayDeadlineMs });
    const now = new Date();
    // The lease, not the response's lifetime: `storeResponse` moves it to that.
    const expiresAt = this.lease(now);

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
            expiresAt,
          },
        });
        // After the insert and any lock wait it made: a request suspended since the
        // check above is refused, and throwing rolls the claim back.
        await this.assertWindowOpen(tx, endpoint, replayDeadlineMs);
      });
      return { kind: 'PROCEED', token };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.client.idempotencyKey.findFirst({
      where: { organizationId, endpoint, key },
    });
    // Both the insert that lost and this read may have waited (PR-844 r1 F1). Before
    // anything about the row: a late request removes nothing, replays nothing and
    // learns nothing of it.
    await this.assertWindowOpen(this.prisma.client, endpoint, replayDeadlineMs);
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

    if (existing.requestHash !== requestHash) throw RastaError.idempotencyKeyReused();

    if (existing.state === 'IN_PROGRESS') return IN_FLIGHT;

    idempotentReplaysTotal.inc({ service: SERVICE_NAME, endpoint });
    return {
      kind: 'REPLAY',
      status: existing.responseStatus ?? 200,
      body: existing.responseBody,
    };
  }

  /**
   * Runs one claim-side statement in a short transaction of its own, whose
   * `lock_timeout` is what is left of the request's budget: a lock it cannot
   * get in that time is the retryable `409 CONFLICT` (`Retry-After: 1`), never
   * an unbounded wait. A budget already spent refuses before asking.
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
   * Frees a claim whose work failed, so a corrected retry with the same key
   * can run — only this claim's own in-flight row, never a completed one or a
   * successor's.
   */
  async release(endpoint: string, key: string, token: string): Promise<void> {
    const organizationId = getOrganizationId();
    const { count } = await this.prisma.client.idempotencyKey.deleteMany({
      where: { organizationId, endpoint, key, claimToken: token, state: 'IN_PROGRESS' },
    });
    if (count === 0) this.logLostClaim('release', endpoint);
  }

  /** Nothing of the key or token in the log (S-09). */
  private logLostClaim(operation: 'hold' | 'release', endpoint: string): void {
    this.logger.warn(
      `idempotency ${operation} matched no in-progress row for this claim (expired, purged or already finished); left untouched: ${endpoint}`,
    );
  }

  /**
   * Removes expired records, on the upkeep timer. Unscoped by necessity — the
   * timer runs outside any request — and safe: the predicate is age alone, so
   * it can only remove records `claim` already refuses to honour.
   */
  async purgeExpired(): Promise<number> {
    const result = await runUnscoped(
      'expired idempotency records are platform upkeep, deleted by age alone and never by tenant',
      () =>
        this.prisma.client.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    );
    return result.count;
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
 * Canonical SHA-256 of a request: object keys sorted recursively, so the same
 * request serialised in another key order is recognised as a retry.
 *
 * Every own key is hashed, whatever its name. The sorted copies have no
 * prototype (`Object.create(null)`): assigning `"__proto__"` into a plain `{}`
 * would set its prototype instead of creating a key, and `JSON.stringify`
 * would then drop it — two different bodies would hash alike and the second
 * would replay the first's response instead of being refused as
 * `IDEMPOTENCY_KEY_REUSED` (#194).
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

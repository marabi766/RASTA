import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { isUniqueViolation } from '../shared/prisma-errors';
import { idempotentReplaysTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type MarketplaceEnv } from '../config/env';
import { CLAIM_WAIT_MS, WAIT_TRANSACTION_SLACK_MS } from '../config/operation-budgets';

export { CLAIM_WAIT_MS };

/** `Retry-After` on the in-flight 409, as docs/06 § 6.8 states it. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/**
 * How many times one `claim` tries to reserve a key it keeps finding vanished
 * or expired. A few is plenty: each retry means another request changed the
 * row in between, and the answer after the last is the in-flight 409.
 */
const CLAIM_ATTEMPTS = 3;

/** PostgreSQL's `lock_not_available`, raised when `lock_timeout` elapses. */
const LOCK_NOT_AVAILABLE = '55P03';

/** An attempt that reserved nothing and must be made again. */
const RETRY_CLAIM = Symbol('retry-claim');

/**
 * Nothing of the key in the context the exception filter logs (S-09): the
 * endpoint and the request's correlationId locate the clash. The wait is the
 * typed field the filter sends as `Retry-After`, not context.
 */
function inFlight(endpoint: string): RastaError {
  return new RastaError('CONFLICT', 'This request is already being processed; retry shortly', {
    internalContext: { endpoint },
    retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS,
  });
}

/**
 * The claim this request took is no longer its own — it expired and was purged,
 * perhaps re-taken by a retry — so its work must not commit. Retryable: the
 * key is either free again or another request's, and a retry learns which.
 */
function claimLost(endpoint: string): RastaError {
  return new RastaError(
    'CONFLICT',
    'This request took too long and its Idempotency-Key lapsed; retry shortly',
    { internalContext: { endpoint }, retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS },
  );
}

/**
 * Stores the response for replay **inside the work's own transaction** `tx`,
 * as its last statement. The work and its completed key commit together, or
 * neither does.
 */
export type RecordResponse<T> = (tx: ExtendedPrismaClient, response: T) => Promise<void>;

/**
 * Runs before a stored response is replayed: the **current** read and object
 * authorization of what the stored response names, by the rule a fresh request
 * would meet now — not the one that held when it was stored. No mutation and
 * no state-transition check. Throws what the live endpoint would answer (403
 * or 404); the stored body is then never returned (#253).
 */
export type ReplayGuard<T> = (stored: T) => Promise<void>;

/**
 * Idempotent financial writes (docs/06 § 6.8).
 *
 * The platform has declared this mechanism since the API architecture was
 * written — the `@Idempotent()` decorator, the gateway's
 * `requiresIdempotencyKey` routes, and an `idempotency_key` table asset-service
 * declares but never uses. **This is the service where it actually matters**,
 * because this is where a retried POST would charge twice, so this is where it
 * is implemented.
 *
 * ## The contract, exactly as docs/06 § 6.8 states it
 *
 * | situation                          | response                              |
 * | ---------------------------------- | ------------------------------------- |
 * | new key                            | execute, store the response, return   |
 * | same key, same body, same caller   | the stored response, no re-execution  |
 * |                                    | — if the caller may still see what it |
 * |                                    | names ({@link ReplayGuard})           |
 * | same key, different body or caller | `409 IDEMPOTENCY_KEY_REUSED`          |
 * | key currently in flight            | `409 CONFLICT` + `Retry-After: 1`     |
 * | missing key on a required endpoint | `400 VALIDATION_FAILED`               |
 *
 * Retention is 24 hours, configurable. Request matching is SHA-256 over a
 * canonical form of the body **and the authenticated caller** ({@link hash}).
 *
 * ## A replay is bound to its caller and re-authorized (#253)
 *
 * Keys are the organization's, and the stored response was produced under the
 * original caller's authority. Hashed over the body alone, a supplier in the
 * same organization who sent an operator's key, target and body received the
 * operator's response — another organization's draft offer — without any owner
 * check. So the caller is part of the request: another user's identical
 * request is `409 IDEMPOTENCY_KEY_REUSED`, never a replay. And before the
 * stored response is returned, the endpoint's {@link ReplayGuard} re-runs the
 * current read and object check for what it names: an original caller who has
 * since lost the role or the ownership gets the 403 or 404 the live endpoint
 * would give, not the stored body.
 *
 * ## Why the claim is its own committed transaction
 *
 * The reservation row is written and **committed** before the work begins,
 * rather than inside the work's transaction. If it shared that transaction,
 * two concurrent retries would each open a transaction, each insert the
 * reservation, and the loser would block until the winner committed — then
 * fail on the unique key having only just discovered the duplicate, after
 * doing all the work. Committing the claim first makes the second request find
 * `IN_PROGRESS` immediately and back off, which is the behaviour the table
 * above describes.
 *
 * The cost of that choice: a process that dies mid-execution, or a release that
 * fails on the failure path, leaves an `IN_PROGRESS` row, and a retry gets `409
 * CONFLICT` rather than a re-execution — but only for the claim's **lease**
 * (`MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS`, 60 s by default), not for
 * the response's retention. While in flight the row's `expiresAt` is the lease;
 * {@link complete} moves it to the retention. Past the lease a retry removes
 * the lapsed row — only while it is still lapsed — and claims the key under a
 * new token. The token fences the old holder: its {@link complete} matches no
 * row and its work rolls back, and its {@link release} frees nothing. Exactly
 * one of the two commits.
 *
 * ## Why the response is stored inside the work's transaction
 *
 * The work receives {@link RecordResponse} and calls it as the last statement
 * of its own transaction, as construction-service does (docs/06 § 6.8). The
 * change and its completed key are one commit:
 *
 * - a failure to store the response rolls the change back with it — no order
 *   exists, the claim is released, and a retry with the same key runs. Stored
 *   after the commit, the same failure answered 500 for an order that existed;
 * - a crash after the commit leaves a `COMPLETED` key, never an `IN_PROGRESS`
 *   one;
 * - a claim that expired and was re-taken while the work ran fails the token
 *   check in {@link complete}, and the change rolls back: two requests can
 *   never both commit under one key.
 *
 * No marketplace endpoint stores its response after the commit any more: each
 * one's work is a single transaction that already holds the response it
 * returns.
 */
@Injectable()
export class IdempotencyStore {
  private readonly logger = new Logger(IdempotencyStore.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: MarketplaceEnv,
  ) {}

  /**
   * SHA-256 over the canonical form of the request **and the caller who sent
   * it** (see {@link hashRequestBody}): another user's identical request is a
   * different request, refused as a reused key, never a replay of a response
   * produced under someone else's authority (#253).
   */
  hash(body: unknown): string {
    return hashRequestBody({ caller: callerIdentity(), body });
  }

  /** When a **completed** response stops being replayed. */
  private expiry(from: Date): Date {
    return new Date(from.getTime() + this.env.MARKETPLACE_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
  }

  /** When a claim still **in flight** may be taken over by a retry. */
  private lease(from: Date): Date {
    return new Date(from.getTime() + this.env.MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS * 1000);
  }

  /**
   * Reserves the key, or reports what to do instead.
   *
   * Returns:
   *   `{ kind: 'PROCEED', token }` — the caller owns the key and should do the
   *                          work; `token` is its claim, which `complete` and
   *                          `release` require
   *   `{ kind: 'REPLAY' }`   — a stored response to return unchanged
   *
   * and throws for the two conflict cases, because they are errors rather than
   * outcomes.
   */
  async claim(
    endpoint: string,
    key: string,
    body: unknown,
  ): Promise<
    { kind: 'PROCEED'; token: string } | { kind: 'REPLAY'; status: number; body: unknown }
  > {
    const requestHash = this.hash(body);
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await this.claimOnce(endpoint, key, requestHash, deadline);
      if (outcome !== RETRY_CLAIM) return outcome;
    }
    // Every attempt found the key vanishing under it: other requests are
    // churning it right now. The same answer as a key in flight.
    throw inFlight(endpoint);
  }

  /**
   * One attempt at the reservation.
   *
   * **`PROCEED` is returned only by the insert that wrote the row** (review of
   * #141). A request that lost the insert and then found no row, or an expired
   * one, reserved nothing, so it tries the insert again rather than
   * proceeding. Proceeding there ran the work with no claim behind it: its
   * completion matched no row, the key stayed free, and the next request with
   * the same key placed a second order. economic-service settled the same race
   * the same way (economic batch 2, item g).
   *
   * An expired row is removed **only while it is still expired**. Deleting by
   * key alone could remove the fresh claim a concurrent request had just put
   * in its place, and a `delete` of a row a racer had already removed threw.
   * An `IN_PROGRESS` row expires with its lease; if its holder is completing it
   * right now, the removal waits for that lock (within the budget) and then
   * finds the row completed with a fresh lifetime, so it removes nothing.
   */
  private async claimOnce(
    endpoint: string,
    key: string,
    requestHash: string,
    deadline: number,
  ): Promise<
    | { kind: 'PROCEED'; token: string }
    | { kind: 'REPLAY'; status: number; body: unknown }
    | typeof RETRY_CLAIM
  > {
    const organizationId = getOrganizationId();
    const now = new Date();

    const token = randomUUID();
    try {
      // Waits behind an uncommitted removal of the same key — within the budget only.
      await this.withinBudget(endpoint, deadline, (tx) =>
        tx.idempotencyKey.create({
          data: {
            key,
            organizationId,
            endpoint,
            requestHash,
            claimToken: token,
            state: 'IN_PROGRESS',
            // The lease, not the response's lifetime: `complete` moves it to that.
            expiresAt: this.lease(now),
          },
        }),
      );
      return { kind: 'PROCEED', token };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.client.idempotencyKey.findUnique({
      where: { organizationId_endpoint_key: { organizationId, endpoint, key } },
    });

    // Released, purged or expired-and-removed between the failed insert and
    // this read: nothing is reserved yet.
    if (!existing) return RETRY_CLAIM;

    if (existing.expiresAt <= now) {
      // Waits for a cleanup or a request still holding the row — within the
      // budget only.
      await this.withinBudget(endpoint, deadline, (tx) =>
        tx.idempotencyKey.deleteMany({
          where: { organizationId, endpoint, key, expiresAt: { lte: now } },
        }),
      );
      return RETRY_CLAIM;
    }

    if (existing.requestHash !== requestHash) {
      throw RastaError.idempotencyKeyReused();
    }

    if (existing.state === 'IN_PROGRESS') throw inFlight(endpoint);

    return {
      kind: 'REPLAY',
      status: existing.responseStatus ?? 200,
      body: existing.responseBody,
    };
  }

  /**
   * Runs one claim-side statement — the insert or the removal of an expired
   * row, the two that can wait on another transaction's lock on the key — in a
   * short transaction of its own, whose `lock_timeout` is what is left of the
   * claim's {@link CLAIM_WAIT_MS} budget. A lock it cannot get in that time is
   * the retryable in-flight `409 CONFLICT` with `Retry-After`, never an
   * unbounded wait; a budget already spent refuses before asking.
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
      return await this.prisma.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${waitMs}ms`}, true)`;
          return statement(tx as unknown as ExtendedPrismaClient);
        },
        { timeout: waitMs + WAIT_TRANSACTION_SLACK_MS },
      );
    } catch (error) {
      if (isLockTimeout(error)) throw inFlight(endpoint);
      throw error;
    }
  }

  /**
   * Records the response so a retry can replay it — **inside the work's own
   * transaction** `tx`, as its last statement.
   *
   * Matches only the row this claim's `token` was minted for. If it matches
   * nothing — the lease lapsed and the row was removed, perhaps re-taken by
   * another request under a new token — it throws, and the work's transaction
   * rolls back with it: the work is never committed without its key, and never
   * twice under one. The key then lives `MARKETPLACE_IDEMPOTENCY_TTL_HOURS`
   * from now — from the response, not the claim, which only held a lease.
   */
  async complete(
    tx: ExtendedPrismaClient,
    endpoint: string,
    key: string,
    token: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    const organizationId = getOrganizationId();
    const { count } = await tx.idempotencyKey.updateMany({
      where: { organizationId, endpoint, key, claimToken: token, state: 'IN_PROGRESS' },
      data: {
        state: 'COMPLETED',
        responseStatus: status,
        responseBody: body as object,
        expiresAt: this.expiry(new Date()),
      },
    });
    if (count === 0) {
      this.logLostClaim('complete', endpoint);
      throw claimLost(endpoint);
    }
  }

  /**
   * Releases a claim whose work failed.
   *
   * A failed attempt must not block a corrected retry: a settlement refused
   * for insufficient balance should be retryable once the wallet is topped up,
   * with the same key. Only this claim's own `IN_PROGRESS` row is removed, so
   * a completed response is never dropped and a successor's claim is never
   * freed by the request that lost it.
   */
  async release(endpoint: string, key: string, token: string): Promise<void> {
    const organizationId = getOrganizationId();
    const { count } = await this.prisma.client.idempotencyKey.deleteMany({
      where: { organizationId, endpoint, key, claimToken: token, state: 'IN_PROGRESS' },
    });
    if (count === 0) this.logLostClaim('release', endpoint);
  }

  /**
   * {@link release} on a failure path: never throws, so it can never replace
   * the failure being answered (#253). The database that refused the work may
   * refuse this too; the claim then stays `IN_PROGRESS` until its lease lapses,
   * after which an identical retry takes the key over. The log names the
   * endpoint and the error's class and code — nothing of the key, the token or
   * the request (S-09).
   */
  private async releaseQuietly(endpoint: string, key: string, token: string): Promise<void> {
    try {
      await this.release(endpoint, key, token);
    } catch (releaseError: unknown) {
      this.logger.error(
        { endpoint, ...errorIdentity(releaseError) },
        'Could not release the idempotency claim after its work failed; it lapses with its lease',
      );
    }
  }

  /**
   * Keeps a claim whose work returned without recording its response blocked
   * for the full retention rather than its lease — a programming error, after
   * which the work may well have committed, so the key must not be taken over
   * for a second execution a minute later. Never throws, for the same reason
   * as {@link releaseQuietly}.
   */
  private async pinQuietly(endpoint: string, key: string, token: string): Promise<void> {
    const organizationId = getOrganizationId();
    try {
      await this.prisma.client.idempotencyKey.updateMany({
        where: { organizationId, endpoint, key, claimToken: token, state: 'IN_PROGRESS' },
        data: { expiresAt: this.expiry(new Date()) },
      });
    } catch (pinError: unknown) {
      this.logger.error(
        { endpoint, ...errorIdentity(pinError) },
        'Could not hold the idempotency claim of a work that did not record its response',
      );
    }
  }

  /** Nothing of the key or token in the log (S-09): the endpoint locates it. */
  private logLostClaim(operation: 'complete' | 'release', endpoint: string): void {
    this.logger.warn(
      `idempotency ${operation} matched no in-progress row for this claim (lapsed, purged, re-taken or already finished); left untouched: ${endpoint}`,
    );
  }

  /**
   * Runs `work` at most once for this key.
   *
   * The wrapper every idempotent endpoint uses, so the claim/complete/release
   * sequence is written once. A handler that forgot the `release` on failure
   * would leave a key wedged until expiry, and that is exactly the kind of
   * detail that is got wrong when it is repeated per endpoint.
   *
   * `work` receives `record`, which it must call inside its own transaction
   * with the response it is about to return. That is what makes the change
   * and its completed key one commit.
   *
   * `stillVisible` is required, so no endpoint can replay without it: it runs
   * before a stored response is returned and throws what the live endpoint
   * would answer if the caller may no longer see what that response names.
   */
  async run<T>(
    endpoint: string,
    key: string,
    body: unknown,
    successStatus: number,
    work: (record: RecordResponse<T>) => Promise<T>,
    stillVisible: ReplayGuard<T>,
  ): Promise<T> {
    return (await this.execute(endpoint, key, body, successStatus, work, stillVisible)).result;
  }

  /**
   * {@link run}, and whether `work` actually ran in this request.
   *
   * A caller with a side effect **outside** `work` — an order command that
   * signals its saga after the commit — needs to know, because a replay runs
   * nothing: no party check, no transition check, no write. Anything the
   * caller does next on the strength of a replayed response is done without
   * any of those checks having run, which is how a replay once delivered a
   * saga signal to an order the caller had no right to touch. Only the read
   * and object check runs on a replay — `stillVisible` — never a transition
   * check and never a write.
   */
  async execute<T>(
    endpoint: string,
    key: string,
    body: unknown,
    successStatus: number,
    work: (record: RecordResponse<T>) => Promise<T>,
    stillVisible: ReplayGuard<T>,
  ): Promise<{ result: T; executed: boolean }> {
    const claim = await this.claim(endpoint, key, body);
    if (claim.kind === 'REPLAY') {
      const stored = claim.body as T;
      // The live endpoint's answer when the caller may no longer see it; the
      // stored body is then never returned.
      await stillVisible(stored);
      idempotentReplaysTotal.inc({ service: SERVICE_NAME, endpoint });
      return { result: stored, executed: false };
    }

    let recorded = false;
    let result: T;
    try {
      result = await work(async (tx, response) => {
        await this.complete(tx, endpoint, key, claim.token, successStatus, response);
        recorded = true;
      });
    } catch (error) {
      // Unconditional, and safe to be: a failure that surfaced after the
      // transaction committed finds the row COMPLETED and removes nothing; a
      // transaction that rolled back — the response store's own failure
      // included — took its completion with it, so the claim is freed and a
      // retry with the same key runs (the order does not exist). The work's
      // own error is the answer: a release that fails on top of it is logged,
      // never thrown in its place, and the claim lapses with its lease.
      await this.releaseQuietly(endpoint, key, claim.token);
      throw error;
    }
    if (!recorded) {
      // A programming error: the work may have committed without its key. The
      // claim stays IN_PROGRESS for the full retention — retries are refused —
      // rather than lapsing with its lease into a second execution.
      await this.pinQuietly(endpoint, key, claim.token);
      throw new Error(`Idempotent work for ${endpoint} did not record its response`);
    }
    return { result, executed: true };
  }

  /**
   * Removes expired records. Called on the same timer as the other upkeep.
   *
   * Unscoped, and it has to be. The timer in `app.module.ts` runs outside any
   * request, so there is no tenant in context — and the tenant guard refuses a
   * `deleteMany` it cannot scope. Until this crossing was written the call
   * threw `Request has no organizationId` on every pass, into a `catch` that
   * exists so upkeep can never take the service down; the table therefore grew
   * without bound while the failure was invisible.
   *
   * Crossing the guard is safe here in a way it very rarely is: the predicate
   * is `expiresAt < now` and nothing else, so it can only ever remove records
   * that are already unusable — a key past its window is refused on read by
   * `claim()` regardless of who asks. It reads no tenant data and returns none.
   * A claim past its lease is one of them: `claim()` would take it over, and its
   * holder can no longer complete it either way, because its token is gone.
   */
  async purgeExpired(): Promise<number> {
    const result = await runUnscoped(
      'expired idempotency records are platform upkeep, deleted by age alone and never by tenant',
      () =>
        this.prisma.client.idempotencyKey.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        }),
    );
    return result.count;
  }
}

/**
 * Refuses an unsafe request that arrived without a key.
 *
 * `400 VALIDATION_FAILED` exactly as `docs/06` § 6.8's table specifies. The
 * gateway enforces this for the `orders`, `products` and `offers` prefixes
 * too; both exist because the gateway is not the only way to reach this port.
 */
export function requireIdempotencyKey(value: string | undefined): string {
  if (!value || value.trim().length < 8) {
    throw RastaError.validation(
      [
        {
          path: 'Idempotency-Key',
          code: 'required',
          message: 'This operation requires an Idempotency-Key header of at least 8 characters',
        },
      ],
      'Idempotency-Key is required for this operation',
    );
  }
  return value.trim();
}

/**
 * The request identity of a route that acts on one resource.
 *
 * The endpoint a key is stored under is the route **template** —
 * `POST /v1/orders/:id/cancel` — so that the replay metric's label set stays
 * bounded. That leaves the target id to the body hash, and a route that hashed
 * only its DTO made two different orders the same request: key K with the same
 * body, reused on a second order, replayed the first order's response without
 * running any check against the second. Folding the id in turns that into the
 * documented `409 IDEMPOTENCY_KEY_REUSED` (docs/06 § 6.8).
 *
 * With no body it is `{ id }` exactly, which is what `confirm` already hashed —
 * so its stored keys still match after this change. The same shape as
 * economic-service's helper of the same name; each service keeps its own copy
 * because services share no source (A-02).
 */
export function targeted(id: string, body?: unknown): { id: string; body?: unknown } {
  return body === undefined ? { id } : { id, body };
}

/**
 * Canonical hash of a request body.
 *
 * Keys are sorted recursively so that `{a:1,b:2}` and `{b:2,a:1}` — the same
 * request, serialised by two different clients — produce the same hash and are
 * therefore recognised as a retry rather than refused as a key reused with a
 * different body (docs/06 § 6.8).
 *
 * Exported as a free function so the canonicalisation can be tested without a
 * database: it is the part most likely to be quietly wrong, and the failure
 * mode is a legitimate retry being rejected with 409.
 */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(canonicalise(body)).digest('hex');
}

/**
 * Stable JSON with recursively sorted object keys.
 *
 * `bigint` cannot appear in a parsed request body, and every amount in this
 * API is a string, so no BigInt-aware replacer is needed here.
 *
 * Every own key is kept, whatever its name: the sorted copies have no
 * prototype (`Object.create(null)`). Assigned into a plain `{}`, a
 * `"__proto__"` key would set the copy's prototype instead of becoming a key,
 * `JSON.stringify` would drop it, and two different bodies would hash alike —
 * the second replaying the first's response instead of being refused as
 * `IDEMPOTENCY_KEY_REUSED` (#194).
 */
function canonicalise(value: unknown): string {
  return JSON.stringify(sortKeys(value));
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

/**
 * Who sent the request, as the request hash includes it (#253): the
 * authenticated user, or for a service token the calling service. Two tokens of
 * the same person can carry two user ids (`RequestContext.platformUserId`); the
 * second is then a different caller, and its retry is refused as a reused key
 * rather than answered with a response it may not be entitled to — the
 * conservative side of that ambiguity.
 */
function callerIdentity(): { authType: string; userId: string | null; service: string | null } {
  const context = getContext();
  return {
    authType: context.authType,
    userId: context.userId ?? null,
    service: context.callerService ?? null,
  };
}

/**
 * What a failure-path log may say about an error (S-09): its class and a
 * driver code such as Prisma's `P1001` — never its message, which can quote
 * the statement's values.
 */
function errorIdentity(error: unknown): { errorName: string; errorCode?: string } {
  if (typeof error !== 'object' || error === null) return { errorName: typeof error };
  const name = error instanceof Error ? error.name : 'unknown';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? { errorName: name, errorCode: code } : { errorName: name };
}

/** A `lock_timeout` that elapsed, as Prisma reports it. */
function isLockTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const meta = (error as { meta?: { code?: unknown } }).meta;
  if (meta?.code === LOCK_NOT_AVAILABLE) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('lock timeout');
}

import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ERROR_STATUS, type ErrorCode } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { isUniqueViolation } from '../ledger/ledger.repository';
import { idempotentReplaysTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type EconomicEnv } from '../config/env';

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
 * | same key, same body                | the stored response, no re-execution  |
 * | same key, different body           | `409 IDEMPOTENCY_KEY_REUSED`          |
 * | same key, different actor          | `409 IDEMPOTENCY_KEY_REUSED`          |
 * | key currently in flight            | `409 CONFLICT` + `Retry-After: 1`     |
 * | missing key on a required endpoint | `400 VALIDATION_FAILED`               |
 *
 * Retention is 24 hours, configurable. Body matching is SHA-256 over a
 * canonical form.
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
 * The cost of that choice is stated honestly in {@link release}: a process that
 * dies mid-execution leaves an `IN_PROGRESS` row, and a retry gets `409
 * CONFLICT` rather than a re-execution until the record expires. For a
 * financial write that is the right way round — a caller retrying too early is
 * a nuisance, and a caller charged twice is an incident.
 *
 * ## Why the answer is stored inside the effect's transaction
 *
 * The work receives an {@link IdempotentAnswer} and stores its response — or
 * a declared terminal refusal — through it, inside the transaction that
 * applies its effect, from the rows that transaction wrote. The effect and its
 * completed key are one commit, so nothing that fails after that commit can
 * free the key: {@link release} only ever removes an `IN_PROGRESS` row, and the
 * row is `COMPLETED` by then. A retry with the same key replays the answer.
 *
 * The response used to be stored after the commit, and the work's own
 * post-commit steps — reading the transaction back for the response — ran
 * inside the `try` that releases the claim. A read that failed there freed the
 * key of an applied state change; the retry was judged against the moved state
 * and refused `INVALID_STATE_TRANSITION`, and the order saga never learnt that
 * its authorisation had succeeded (review of #283, finding 2; docs/23 D-054).
 *
 * ## Who may be answered from a record
 *
 * A record answers **the actor who made it, and only while that actor may
 * still reach its object** (review of #287, finding 1). The key was scoped to
 * the acting organization, the endpoint and — through the hash — the target,
 * but not to the person: a `SYSTEM_ADMIN` acting in A authorised a B↔C
 * transaction with key K, and an `ORGANIZATION_ADMIN` of A who sent the same
 * target and K was handed B and C's transaction, where a fresh key got
 * `NOT_FOUND`. Two rules close it:
 *
 *   - the record carries a hash of the actor who reserved it
 *     ({@link requestActor}); the same key from anyone else is `409
 *     IDEMPOTENCY_KEY_REUSED` — the answer to the same key with another body —
 *     and never a replay;
 *   - before any stored answer is returned, the endpoint's own object checks
 *     run again, as the caller now is ({@link ReplayGuard}) — not the
 *     transition, only who may see and act on its object. A caller who lost
 *     that access gets the `NOT_FOUND` (or `403`) a fresh request gets.
 *
 * ## Whose claim a completion completes
 *
 * Each reservation carries a random claim token, and completing, recording a
 * refusal and releasing all require it (review of #287, finding 2). Matching
 * by key and state alone let a request whose claim had expired and been
 * replaced complete the replacement: its effect committed under another
 * request's key, and that request's retries replayed the wrong answer. A stale
 * token matches nothing, so the late effect rolls back with a retryable
 * conflict and the replacement claim is left to its owner.
 */
@Injectable()
export class IdempotencyStore {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: EconomicEnv,
  ) {}

  /** SHA-256 over the canonical form. See {@link hashRequestBody}. */
  hash(body: unknown): string {
    return hashRequestBody(body);
  }

  /**
   * Reserves the key, or reports what to do instead.
   *
   * Returns:
   *   `{ kind: 'PROCEED', token }` — the caller owns the key, under `token`,
   *                                  and should do the work
   *   `{ kind: 'REPLAY' }`         — a stored response, for {@link run} to
   *                                  return once its replay guard has passed
   *
   * and throws for the conflict cases — another body or another actor under
   * the key, or the key in flight — because they are errors rather than
   * outcomes.
   */
  async claim(endpoint: string, key: string, body: unknown): Promise<Claim> {
    const requestHash = this.hash(body);
    const actorHash = this.hash(requestActor());
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await this.claimOnce(endpoint, key, requestHash, actorHash, deadline);
      if (outcome !== RETRY_CLAIM) return outcome;
    }
    // Every attempt found the key vanishing under it: other requests are
    // churning it right now. The same answer as a key in flight.
    throw inFlight(endpoint);
  }

  /**
   * One attempt at the reservation.
   *
   * **`PROCEED` is returned only by the insert that wrote the row.** A request
   * that lost the insert and then found no row, or an expired one, did not
   * reserve anything, so it tries again rather than proceeding (economic
   * batch 2, item g). Proceeding there let two requests run one key: the
   * row it lost to had been released or purged, and a third request could
   * insert and proceed alongside it.
   *
   * An expired row is removed **only while it is still expired**. Deleting by
   * key alone could remove the fresh claim a concurrent request had just put
   * in its place — and then both proceed — and a `delete` of a row a racer
   * had already removed threw a 500.
   */
  private async claimOnce(
    endpoint: string,
    key: string,
    requestHash: string,
    actorHash: string,
    deadline: number,
  ): Promise<Claim | typeof RETRY_CLAIM> {
    const organizationId = getOrganizationId();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.env.ECONOMIC_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
    );
    const claimToken = randomUUID();

    try {
      // Waits behind an uncommitted removal of the same key — within the budget only.
      await this.withinBudget(endpoint, deadline, (tx) =>
        tx.idempotencyKey.create({
          data: {
            key,
            organizationId,
            endpoint,
            requestHash,
            actorHash,
            claimToken,
            state: 'IN_PROGRESS',
            expiresAt,
          },
        }),
      );
      return { kind: 'PROCEED', token: claimToken };
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

    // Another body, or another actor: a different request under the same key,
    // refused alike and with nothing of the record (review of #287, finding
    // 1). A record from before actors were bound has none; it is answered only
    // through the replay guard, and only until it expires.
    if (
      existing.requestHash !== requestHash ||
      (existing.actorHash !== null && existing.actorHash !== actorHash)
    ) {
      throw RastaError.idempotencyKeyReused();
    }

    if (existing.state === 'IN_PROGRESS') throw inFlight(endpoint);

    idempotentReplaysTotal.inc({ service: SERVICE_NAME, endpoint });
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
   * Records the answer so a retry can replay it — **inside the work's own
   * transaction** `tx`, the one that applies its effect.
   *
   * A failure here rolls the effect back with it: the claim is then released
   * and a retry with the same key runs the work, which never happened. A
   * claim that is no longer this request's `IN_PROGRESS` reservation — it
   * outlived its retention and was purged, or taken over by another request
   * under a new token — matches nothing, and that throws too, so the effect is
   * never committed without its key, nor under another request's.
   */
  private async complete(
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
      data: { state: 'COMPLETED', responseStatus: status, responseBody: body as object },
    });
    if (count !== 1) throw claimLost(endpoint);
  }

  /**
   * Releases a claim whose work failed.
   *
   * A failed attempt must not block a corrected retry: a settlement refused
   * for insufficient balance should be retryable once the wallet is topped up,
   * with the same key. Only this request's own `IN_PROGRESS` reservation is
   * removed — never a completed response, and never the claim another request
   * took over after this one's expired.
   */
  async release(endpoint: string, key: string, token: string): Promise<void> {
    const organizationId = getOrganizationId();
    await this.prisma.client.idempotencyKey.deleteMany({
      where: { organizationId, endpoint, key, claimToken: token, state: 'IN_PROGRESS' },
    });
  }

  /**
   * Runs `work` at most once for this key.
   *
   * The wrapper every idempotent endpoint uses, so the claim/complete/release
   * sequence is written once. A handler that forgot the `release` on failure
   * would leave a key wedged until expiry, and that is exactly the kind of
   * detail that is got wrong when it is repeated per endpoint.
   *
   * `work` answers through `answer`, inside the transaction that applies its
   * effect, and what it answered is what this returns — the same body a
   * replay returns. A work that returns normally must have answered in a
   * transaction that committed.
   *
   * `options.mayReplay` is required: no endpoint can return a stored answer
   * without saying who may still have it (see the class comment).
   */
  async run<T>(
    endpoint: string,
    key: string,
    body: unknown,
    successStatus: number,
    work: (answer: IdempotentAnswer<T>) => Promise<unknown>,
    options: { mayReplay: ReplayGuard<T>; terminalRefusals?: TerminalRefusals },
  ): Promise<T> {
    const claim = await this.claim(endpoint, key, body);
    if (claim.kind === 'REPLAY') {
      const refused = claim.status >= REFUSAL_STATUS_FLOOR;
      // Before anything of the record leaves: what a fresh request would be
      // refused, the replay is refused too.
      await options.mayReplay(refused ? undefined : (claim.body as T));
      if (refused) throw replayedRefusal(claim.body, options.terminalRefusals);
      return claim.body as T;
    }
    const { token } = claim;

    let answered: { response: T } | undefined;
    const answer = new IdempotentAnswer<T>(
      async (tx, response) => {
        await this.complete(tx, endpoint, key, token, successStatus, response);
        answered = { response };
      },
      async (tx, refusal) => {
        // An undeclared refusal is not one the store can replay: it is left
        // to the release below, and the effect it ends is never rolled back
        // for it.
        if (!declaredBy(options.terminalRefusals, refusal)) return;
        await this.complete(tx, endpoint, key, token, refusal.status, {
          refusal: refusal.refusal,
        });
      },
    );

    try {
      await work(answer);
    } catch (error) {
      // Unconditional, and safe to be: an answer stored in a transaction that
      // committed left the row COMPLETED, which the release never removes —
      // whatever failed afterwards, a retry replays it. A transaction that
      // rolled back took its answer with it, and the key is freed.
      if (
        error instanceof TerminalRefusalError &&
        declaredBy(options.terminalRefusals, error) &&
        (await this.completeRefusal(endpoint, key, token, error))
      ) {
        throw error;
      }
      await this.release(endpoint, key, token);
      throw error;
    }
    if (!answered) {
      // A programming error: the work may have committed without its answer.
      // The claim stays IN_PROGRESS for its retention, so retries are refused
      // rather than run a second time.
      throw RastaError.internal(`Idempotent work for ${endpoint} did not store its answer`);
    }
    return answered.response;
  }

  /**
   * Records a terminal refusal as the key's completed outcome: its HTTP status
   * and the closed refusal name — nothing else (S-09). Returns whether it was
   * recorded; when not, the caller releases the key as it does for any other
   * error, because a refusal the store could not record is not one it can
   * replay.
   *
   * For a refusal that ends work with no effect. One that ends a transaction
   * which did change something — a declined refund returning its hold — is
   * recorded in that transaction through {@link IdempotentAnswer.refuse}, and
   * this then finds the row COMPLETED and matches nothing.
   */
  private async completeRefusal(
    endpoint: string,
    key: string,
    token: string,
    error: TerminalRefusalError,
  ): Promise<boolean> {
    const organizationId = getOrganizationId();
    try {
      const { count } = await this.prisma.client.idempotencyKey.updateMany({
        where: { organizationId, endpoint, key, claimToken: token, state: 'IN_PROGRESS' },
        data: {
          state: 'COMPLETED',
          responseStatus: error.status,
          responseBody: { refusal: error.refusal },
        },
      });
      return count === 1;
    } catch {
      return false;
    }
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
 * A business refusal an endpoint treats as the final answer to its request: the
 * same key and body will never be answered otherwise, so the store records it
 * and replays it instead of releasing the key (docs/06 § 6.8).
 *
 * **Closed on purpose.** A refusal is a name this table declares, with the
 * error code and the fixed, author-written message it is answered with — the
 * store keeps the name and the status, never the thrown error's message,
 * context or any client input (S-09). Declare only a refusal that cannot turn
 * into success later: an insufficient balance can (a top-up), an unavailable
 * dependency can, a 5xx can — those stay released.
 */
export interface TerminalRefusal {
  code: ErrorCode;
  message: string;
}

export type TerminalRefusals = Readonly<Record<string, TerminalRefusal>>;

/** A declared refusal: thrown by an endpoint's work, recorded and replayed by the store. */
export class TerminalRefusalError extends RastaError {
  constructor(
    readonly refusal: string,
    definition: TerminalRefusal,
    internalContext?: Record<string, unknown>,
  ) {
    super(definition.code, definition.message, { internalContext });
    this.name = 'TerminalRefusalError';
  }
}

/** Stores an answer in the transaction that applies the effect it answers for. */
type Store<A> = (tx: ExtendedPrismaClient, answer: A) => Promise<void>;

/**
 * How an idempotent command answers its key: **inside the transaction that
 * applies its effect**, built from the rows that transaction wrote (review of
 * #283, finding 2). The effect and the completed key then commit together, so
 * a failure after the commit — a read, a serialisation, a lost connection —
 * can only ever be answered by replaying what was applied, never by freeing
 * the key as if nothing had been.
 *
 * Call it as late in the transaction as possible: anything after it that fails
 * rolls the answer back with the effect, which is correct, but is wasted work.
 * A work that answers twice — a first transaction that rolled back, a second
 * that committed — leaves the later answer, which is the committed one.
 */
export class IdempotentAnswer<T> {
  constructor(
    private readonly storeResponse: Store<T>,
    private readonly storeRefusal: Store<TerminalRefusalError>,
  ) {}

  /** The success response — exactly what this request and every replay return. */
  respond(tx: ExtendedPrismaClient, response: T): Promise<void> {
    return this.storeResponse(tx, response);
  }

  /**
   * A declared terminal refusal the work throws **after** this transaction
   * commits, recorded with the effect that ended in it. An undeclared one is
   * ignored: the store releases the key for it as for any other error.
   */
  refuse(tx: ExtendedPrismaClient, refusal: TerminalRefusalError): Promise<void> {
    return this.storeRefusal(tx, refusal);
  }

  /**
   * The same answer for a service that returns its own result type: `view`
   * turns that result into the response, inside the same transaction.
   */
  map<R>(view: (result: R) => T): IdempotentAnswer<R> {
    return new IdempotentAnswer<R>(
      (tx, result) => this.storeResponse(tx, view(result)),
      this.storeRefusal,
    );
  }
}

/** What {@link IdempotencyStore.claim} reserved, or the stored answer it found. */
export type Claim =
  { kind: 'PROCEED'; token: string } | { kind: 'REPLAY'; status: number; body: unknown };

/**
 * The endpoint's own object checks, run again before a stored answer is
 * returned — as the caller now is, against the object as it now is (review of
 * #287, finding 1). Throws what a fresh request would be refused with: the
 * `NOT_FOUND` of an object the caller cannot see, the `403` of one it may see
 * but not act on. It never re-runs the transition: whether the command could
 * be applied again is not the question, who may see what it did is.
 *
 * `stored` is the success response being replayed, or `undefined` for a
 * recorded refusal. A route with no target in its path (creating a
 * transaction) has only the response to name its object.
 */
export type ReplayGuard<T> = (stored: T | undefined) => Promise<void>;

/**
 * Who sent this request, as the record binds it: the token's stable identity
 * (issuer and subject), the platform user id, and for a service call the
 * calling service — the fields reconciliation's `boundTo` already folded into
 * its keys (Codex on #175, MED 3), now for every endpoint. The acting
 * organization and the endpoint are the record's primary key; the target is in
 * the request hash ({@link targeted}). Roles are not part of it: they are
 * what the replay guard asks about, as they are now.
 */
export function requestActor(): Record<string, string | null> {
  const context = getContext();
  return {
    authType: context.authType,
    issuer: context.issuer ?? null,
    subject: context.subject ?? null,
    userId: context.userId ?? null,
    callerService: context.callerService ?? null,
  };
}

/** A stored status at or above this is a recorded refusal, not a response body. */
const REFUSAL_STATUS_FLOOR = 400;

function isDeclared(refusals: TerminalRefusals, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(refusals, name);
}

function declaredBy(refusals: TerminalRefusals | undefined, error: TerminalRefusalError): boolean {
  return refusals !== undefined && isDeclared(refusals, error.refusal);
}

/**
 * The error a recorded refusal is answered with. A stored name the endpoint no
 * longer declares is a fault, answered as a server error — never as a success
 * and never as a refusal nobody can name.
 */
function replayedRefusal(stored: unknown, refusals: TerminalRefusals = {}): RastaError {
  const name =
    typeof stored === 'object' && stored !== null
      ? (stored as { refusal?: unknown }).refusal
      : undefined;
  if (typeof name === 'string' && isDeclared(refusals, name)) {
    const definition = refusals[name] as TerminalRefusal;
    if (ERROR_STATUS[definition.code] >= REFUSAL_STATUS_FLOOR) {
      return new TerminalRefusalError(name, definition);
    }
  }
  return RastaError.internal('A recorded refusal is not declared by its endpoint');
}

/**
 * How many times one `claim` tries to reserve a key it keeps finding vanished
 * or expired. A few is plenty: each retry means another request changed the
 * row in between, and the answer after the last is the in-flight 409.
 */
const CLAIM_ATTEMPTS = 3;

/**
 * The most one claim waits on another transaction's lock on its key, over all
 * its attempts — the same bound the other services' stores keep. A cleanup or
 * a racing request holding the key past it gets the in-flight 409 with
 * `Retry-After`, never an unbounded wait.
 */
export const CLAIM_WAIT_MS = 5_000;
/** Slack for a claim-side transaction beyond its lock wait, so the wait ends first. */
const WAIT_TRANSACTION_SLACK_MS = 2_000;
/** PostgreSQL's `lock_not_available`, raised when `lock_timeout` elapses. */
const LOCK_NOT_AVAILABLE = '55P03';

/** An attempt that reserved nothing and must be made again. */
const RETRY_CLAIM = Symbol('retry-claim');

/** `Retry-After` on the in-flight 409, as docs/06 § 6.8 states it. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/**
 * Nothing derived from the key (S-09, review of #135): a truncated SHA-256 of
 * a client-chosen key is guessable when the key has little entropy. The
 * endpoint and the request's correlationId locate the clash. The wait is the
 * typed field the exception filter sends as `Retry-After`, not context.
 */
function inFlight(endpoint: string): RastaError {
  return new RastaError('CONFLICT', 'This request is already being processed; retry shortly', {
    internalContext: { endpoint },
    retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS,
  });
}

/**
 * The claim this request took is no longer `IN_PROGRESS` — it outlived its
 * retention and was purged, perhaps taken over by a retry — so its work must
 * not commit. Retryable: the key is either free again or another request's,
 * and a retry learns which.
 */
function claimLost(endpoint: string): RastaError {
  return new RastaError(
    'CONFLICT',
    'This request took too long and its Idempotency-Key lapsed; retry shortly',
    { internalContext: { endpoint }, retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS },
  );
}

/**
 * The request identity of a route that acts on one resource.
 *
 * The endpoint a key is stored under is the route **template** —
 * `POST /v1/transactions/:id/refund` — so that the replay metric's label set
 * stays bounded. That leaves the target id to the body hash, and a route that
 * hashed only its DTO made two different resources the same request: key K
 * with the same reason, reused on a second transaction, replayed the first
 * transaction's response and never touched the second. Folding the id in
 * turns that into the documented `409 IDEMPOTENCY_KEY_REUSED` (docs/06 § 6.8).
 *
 * With no body it is `{ id }` exactly, which is what `authorise-settlement`
 * already hashed — so its stored keys still match after this change.
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

/** A `lock_timeout` that elapsed, as Prisma reports it. */
function isLockTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const meta = (error as { meta?: { code?: unknown } }).meta;
  if (meta?.code === LOCK_NOT_AVAILABLE) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('lock timeout');
}

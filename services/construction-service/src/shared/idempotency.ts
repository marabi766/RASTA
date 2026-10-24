import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { isUniqueViolation } from '../shared/prisma-errors';
import { idempotentReplaysTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import {
  CLAIM_WAIT_MS,
  WAIT_TRANSACTION_SLACK_MS,
  replayFenceBudgetMs,
} from '../config/operation-budgets';

export { CLAIM_WAIT_MS };

/**
 * Idempotent creation (docs/06 § 6.8).
 *
 * | situation                          | response                              |
 * | ---------------------------------- | ------------------------------------- |
 * | new key                            | execute, store the response, return   |
 * | same key, same body                | the stored response, no re-execution  |
 * | same key, different body           | `409 IDEMPOTENCY_KEY_REUSED`          |
 * | key currently in flight            | `409 CONFLICT` + `Retry-After: 1`     |
 *
 * Used by the create endpoints (`POST /v1/projects`,
 * `POST /v1/projects/{id}/needs`, `POST /v1/projects/{id}/progress`,
 * `POST /v1/approval-policies`, `POST /v1/projects/{id}/tenders`,
 * `POST /v1/criteria-templates`), where a retried request would otherwise
 * create a second project, need, progress draft, policy version, tender or
 * template, by scoring a bid, and by the tender commands whose retry would
 * otherwise do something new (task 060): publishing, cancelling and awarding
 * (behind the approval gate, a retried request would open a new round once the
 * first was rejected), inviting, and the opening's three (proposing, withdrawing
 * the proposal, opening). The key is **optional** there: a request without one
 * simply is not deduplicated. Submitting a bid **requires** one (docs/06 § 6.8,
 * construction audit F4: {@link requiredIdempotencyKey}) and stores its request
 * under a keyed hash ({@link RequestHasher}). A command's key is claimed only
 * once the caller is authorised. Every request stored names the caller — the
 * creates' as `{ requester, body }` (PR-350 r1 F3), a score's as its evaluator,
 * a bid's in its keyed hash — so the same key and body from another person of
 * the organization is `IDEMPOTENCY_KEY_REUSED`, never their answer; the key is
 * the organization's (`organizationId` is part of it), so another organization
 * never meets it at all. A create stored before its request named the caller
 * (its hash is of the body alone) matches no request since: a retry under such
 * a key is `IDEMPOTENCY_KEY_REUSED` for everyone, its author included, until the
 * record expires (`CONSTRUCTION_IDEMPOTENCY_TTL_HOURS`) — refused, never
 * replayed, and nothing is created twice under it. Every other command carries
 * `expectedVersion` (or a bid's `expectedRevision`), or answers its own repeat
 * without writing, and a retry of one that already committed is refused by the
 * compare-and-set, or answered as it stands, instead.
 *
 * ## Two transactions, and why the second is the domain's own
 *
 * 1. **The claim** is its own committed insert, before the work begins, so a
 *    concurrent duplicate finds `IN_PROGRESS` at once instead of doing the
 *    work and colliding afterwards. Each claim mints a `claimToken`.
 * 2. **The completion** — response, status and the id of the created resource
 *    — is written **inside the domain transaction**, by the `record` callback
 *    the work receives, and only if the row still carries this claim's token.
 *    The resource and its completed key therefore commit together or not at
 *    all:
 *    - a crash after the domain commit leaves a `COMPLETED` key, never an
 *      `IN_PROGRESS` one that would run the request again once it expired;
 *    - a claim that was purged and re-taken by another caller while this one
 *      worked fails the token check, which rolls the domain write back — two
 *      callers can never both create under one key;
 *    - a crash before the domain commit leaves an `IN_PROGRESS` key with
 *      nothing behind it: retries get `409 CONFLICT` until it expires, and then
 *      the request runs for the first time.
 *
 * A caller never proceeds without owning a claim it inserted itself. A
 * collision whose row has vanished by the time it is read (released or
 * purged) retries the atomic insert; an expired row is removed by a delete
 * conditioned on that row's own token and expiry, then the insert is retried.
 *
 * That delete waits for a domain transaction still holding the expired row
 * (its completion locked it), and the insert can wait behind an uncommitted
 * delete of the same key. Both wait only for what is left of
 * {@link CLAIM_WAIT_MS} from the start of the claim; running out is the
 * retryable `409 CONFLICT`, never a hang (#194).
 */

/**
 * ## The replay fence (PM decision D-065; project creation only so far)
 *
 * An expired key is reusable, which is right for a caller that never asked for more — and wrong for one
 * that retries a request which may have committed: after the key is gone the same request runs as a
 * NEW one. No caller can close that alone (clock jumps, paused processes and replica skew all sit
 * between its clock and this one), so the owning service closes it with its own clock.
 *
 * A request may carry `Idempotency-Replay-Deadline` (epoch ms, one canonical safe integer; only with an
 * `Idempotency-Key`): the last instant it may be executed under that key. Let `C` be the claiming
 * replica's clock when the key is first claimed, `TTL` the retention and
 * `B = 2·CONSTRUCTION_CLOCK_SKEW_SECONDS + margin` ({@link replayFenceBudgetMs}). The FIRST claim stores
 *
 *     D = min(header, C + TTL − B)          expiresAt = C + TTL            (so  D + B ≤ expiresAt)
 *
 * in `replayDeadlineAt`. A header can only narrow: a forged later value is clamped, so it needs no
 * signature. Afterwards, for a request that matches the stored one (same requester and body — the
 * actor and tenant checks stay first, so another actor's or tenant's request meets exactly what it met
 * before):
 *
 *   - service-now `>` D  →  `409 REPLAY_WINDOW_CLOSED`, before any write. Never the
 *     expired → delete → PROCEED path, whether the row is completed, in flight or past `expiresAt`;
 *   - service-now `≤` D  →  the row is live whatever `expiresAt` says, and answers as always.
 *
 * A first claim whose header is already behind service-now is refused the same way, nothing written.
 * Equality: `now == D` is still allowed; the refusal is strictly `now > D`.
 *
 * The purge keeps the row for the fence: it deletes a row carrying a deadline only when
 * `expiresAt < now − B` (strictly; a row without a deadline as before, `expiresAt < now`).
 * Retention inequality — every clock within `skew` of true time `t`, B = 2·skew + margin:
 *
 *     a request passes the check on clock R ≤ D          ⇒  t ≤ D + skew
 *     the purge deletes on clock P > expiresAt + B ≥ D + 2B   ⇒  t > D + 2B − skew
 *     D + skew < D + 2B − skew  ⇔  skew < B           (B = 2·skew + margin, margin > 0)
 *
 * so a request that passed the check always still finds its row. The claiming replica's own offset
 * does not enter: D and `expiresAt` are stored numbers. The stored `expiresAt` and `replayDeadlineAt`
 * govern: a TTL shortened by configuration never shortens a row that exists, and a purge uses the
 * skew budget of the day — enough whenever the real offset is within the configured bound.
 *
 * What it does NOT cover (stated, not hidden): a request without the header, a row with a null
 * deadline (written before this fence), a key already purged before it shipped — all behave as before.
 * The guarantee covers header-carrying requests whose header is at most `C + TTL − B` (the caller's
 * window must be shorter than the retention; the clamp makes the stored one so, but a later request
 * claiming a purged key with a larger header meets a first claim).
 */

/**
 * How a request is stored to be recognised again: by default the unkeyed SHA-256 of its canonical
 * form ({@link hashRequestBody}). An endpoint whose body must say nothing to a reader of the
 * database (a sealed bid's price) brings a keyed one; `matches` compares a stored hash with a
 * request, so a hash made under an older key, or with a salt of its own, is still recognised. The
 * claim — and its hash — is committed before the work judges anything, so a hash that could be
 * guessed at must not be comparable across claims either (Codex r1 on #250, R1): the bid's is salted
 * per claim and bound to the requester.
 */
export interface RequestHasher {
  hash(body: unknown): string;
  matches(stored: string, body: unknown): boolean;
}

const SHA256_HASHER: RequestHasher = {
  hash: (body) => hashRequestBody(body),
  matches: (stored, body) => stored === hashRequestBody(body),
};

/**
 * A **required** `Idempotency-Key` (docs/06 § 6.8: «ثبت پیشنهاد» is one of the mandatory
 * endpoints). Missing or blank is `400 VALIDATION_FAILED` with code `required`, judged by the
 * service itself so that the protection does not depend on which door a request used (the
 * gateway is one, a direct call another). The bounds are the header parser's
 * (`parseIdempotencyKey`).
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
  return value.trim();
}

/** The header the fence reads: epoch milliseconds, canonical (no sign, no leading zero, no space, no exponent). */
export const REPLAY_DEADLINE_HEADER = 'Idempotency-Replay-Deadline';

const CANONICAL_EPOCH_MS = /^[1-9][0-9]{0,15}$/;

/**
 * Reads `Idempotency-Replay-Deadline`. Absent → `undefined` (no fence: today's behaviour). Present →
 * exactly one canonical safe-integer epoch-ms value, with an `Idempotency-Key` beside it; a duplicated
 * header reaches here comma-joined and fails the canonical form. Anything else is `400`, before any
 * claim is made: a deadline without a key would run the request with no key to fence.
 */
export function parseReplayDeadline(
  raw: string | string[] | undefined,
  idempotencyKey: string | undefined,
): number | undefined {
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
  if (idempotencyKey === undefined) return refuse('is accepted only with an Idempotency-Key');
  return value;
}

/**
 * Records the completion inside the caller's domain transaction. `status` is the one the response
 * was answered with, when a command answers more than one (a gated command: 200 executed, 202
 * asked for approval); by default the call's `successStatus`.
 */
export type RecordCompletion<T> = (
  tx: ExtendedPrismaClient,
  resourceId: string,
  response: T,
  status?: number,
) => Promise<void>;

interface Claim {
  organizationId: string;
  endpoint: string;
  key: string;
  token: string;
}

/** How often a claim retries the atomic insert after its collision vanished. */
const CLAIM_ATTEMPTS = 3;

/** `Retry-After` on the in-flight 409, as docs/06 § 6.8 states it. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/** PostgreSQL's `lock_not_available`, raised when `lock_timeout` elapses. */
const LOCK_NOT_AVAILABLE = '55P03';

@Injectable()
export class IdempotencyStore {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: ConstructionEnv,
  ) {}

  /**
   * This replica's clock, in ms. The one reading every expiry, deadline and purge of the store goes
   * through; a test stands in a skewed replica by overriding it.
   */
  protected nowMs(): number {
    return Date.now();
  }

  /** SHA-256 over the canonical form. See {@link hashRequestBody}. */
  hash(body: unknown): string {
    return hashRequestBody(body);
  }

  /**
   * Reserves the key, or reports what to do instead.
   *
   * Returns `PROCEED` with the claim this caller inserted, or `REPLAY` with a
   * stored response; throws for the conflict cases, because they are
   * errors rather than outcomes, and when the claim could not be settled in
   * {@link CLAIM_ATTEMPTS} attempts. `replayDeadlineMs` is the caller's
   * `Idempotency-Replay-Deadline` (see the replay fence above).
   */
  async claim(
    endpoint: string,
    key: string,
    body: unknown,
    hasher: RequestHasher = SHA256_HASHER,
    replayDeadlineMs?: number,
  ): Promise<{ kind: 'PROCEED'; claim: Claim } | { kind: 'REPLAY'; body: unknown }> {
    const organizationId = getOrganizationId();
    const requestHash = hasher.hash(body);
    const where = { organizationId_endpoint_key: { organizationId, endpoint, key } };
    const deadline = Date.now() + CLAIM_WAIT_MS;
    const budgetMs = replayFenceBudgetMs(this.env.CONSTRUCTION_CLOCK_SKEW_SECONDS);

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const nowMs = this.nowMs();
      const now = new Date(nowMs);
      const token = randomUUID();
      const expiresAt = new Date(
        nowMs + this.env.CONSTRUCTION_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
      );

      // A request whose own deadline is behind this clock is refused before anything is read or
      // written: it depends on nothing stored, so it discloses nothing about the key.
      if (replayDeadlineMs !== undefined && nowMs > replayDeadlineMs) {
        throw this.windowClosed(endpoint);
      }
      // D = min(header, C + TTL − B): a header can only narrow (see the replay fence above).
      const replayDeadlineAt =
        replayDeadlineMs === undefined
          ? null
          : new Date(Math.min(replayDeadlineMs, expiresAt.getTime() - budgetMs));

      try {
        await this.withinBudget(endpoint, deadline, (tx) =>
          tx.idempotencyKey.create({
            data: {
              key,
              organizationId,
              endpoint,
              requestHash,
              claimToken: token,
              state: 'IN_PROGRESS',
              expiresAt,
              replayDeadlineAt,
            },
          }),
        );
        return { kind: 'PROCEED', claim: { organizationId, endpoint, key, token } };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }

      const existing = await this.prisma.client.idempotencyKey.findUnique({ where });

      // Released or purged between the failed insert and this read. Nothing
      // is owned yet: try the insert again rather than proceeding.
      if (!existing) continue;

      const matches = hasher.matches(existing.requestHash, body);

      // The fence: a row that carries a deadline answers the request it stored by that deadline, on this
      // replica's clock — never by `expiresAt`. Past it: refused, whatever the row's state, and never the
      // delete-and-proceed below. Before it: live, even if `expiresAt` were behind us. A request that is
      // not the stored one (another requester, another body) does not meet the fence and gets exactly
      // what it always got.
      const storedDeadline =
        existing.replayDeadlineAt instanceof Date ? existing.replayDeadlineAt : null;
      const fenced = storedDeadline !== null && matches;
      if (fenced && nowMs > storedDeadline.getTime()) {
        throw this.windowClosed(endpoint);
      }

      if (!fenced && existing.expiresAt <= now) {
        // Only the row that was read, and only while it is still expired: a
        // fresh claim another caller inserted meanwhile is never touched.
        // Waits for a domain transaction still holding it — within the budget only.
        await this.withinBudget(endpoint, deadline, (tx) =>
          tx.idempotencyKey.deleteMany({
            where: {
              organizationId,
              endpoint,
              key,
              claimToken: existing.claimToken,
              expiresAt: { lte: now },
            },
          }),
        );
        continue;
      }

      if (!matches) throw this.reused(endpoint);

      if (existing.state === 'IN_PROGRESS') throw this.inFlight(endpoint);

      idempotentReplaysTotal.inc({ service: SERVICE_NAME, endpoint });
      return { kind: 'REPLAY', body: existing.responseBody };
    }

    throw this.inFlight(endpoint);
  }

  /**
   * Runs one claim-side statement in a short transaction of its own, whose
   * `lock_timeout` is what is left of the claim's budget: a lock it cannot get
   * in that time is the retryable `409 CONFLICT` (`Retry-After: 1`), never an
   * unbounded wait. A budget already spent refuses before asking.
   */
  private async withinBudget<R>(
    endpoint: string,
    deadline: number,
    statement: (tx: ExtendedPrismaClient) => Promise<R>,
  ): Promise<R> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw this.inFlight(endpoint);
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
      if (isLockTimeout(error)) throw this.inFlight(endpoint);
      throw error;
    }
  }

  /**
   * Marks the claim completed, inside the domain transaction `tx`.
   *
   * Matches only this claim's own `IN_PROGRESS` row. If it matches nothing —
   * the claim expired and was purged, and perhaps re-taken — it throws, and
   * the domain transaction rolls back with it: the work is not done twice.
   */
  async complete(
    tx: ExtendedPrismaClient,
    claim: Claim,
    status: number,
    resourceId: string,
    response: unknown,
  ): Promise<void> {
    const { count } = await tx.idempotencyKey.updateMany({
      where: {
        organizationId: claim.organizationId,
        endpoint: claim.endpoint,
        key: claim.key,
        claimToken: claim.token,
        state: 'IN_PROGRESS',
      },
      data: {
        state: 'COMPLETED',
        responseStatus: status,
        responseBody: response as object,
        resourceId,
      },
    });
    if (count === 0) throw this.inFlight(claim.endpoint);
  }

  /**
   * Releases a claim whose work failed, so a corrected retry is not blocked.
   *
   * Only this claim's own `IN_PROGRESS` row. If the domain transaction did
   * commit — and with it the completion — before the failure surfaced, the row
   * is `COMPLETED` and this removes nothing.
   */
  async release(claim: Claim): Promise<void> {
    await this.prisma.client.idempotencyKey.deleteMany({
      where: {
        organizationId: claim.organizationId,
        endpoint: claim.endpoint,
        key: claim.key,
        claimToken: claim.token,
        state: 'IN_PROGRESS',
      },
    });
  }

  /**
   * Runs `work` at most once for this key; without a key, simply runs it.
   *
   * `work` receives `record`, which it must call inside its own domain
   * transaction with the created resource's id and the response. That is what
   * makes the resource and its completed key one commit.
   */
  async run<T>(
    endpoint: string,
    key: string | undefined,
    body: unknown,
    successStatus: number,
    work: (record: RecordCompletion<T>) => Promise<T>,
    hasher?: RequestHasher,
    replayDeadlineMs?: number,
  ): Promise<T> {
    return (await this.execute(endpoint, key, body, successStatus, work, hasher, replayDeadlineMs))
      .result;
  }

  /**
   * {@link run}, and whether `work` actually ran in this request.
   *
   * A replay runs nothing — no authorization, no transition check, no write —
   * so a caller with a side effect outside `work` must know which it got.
   */
  async execute<T>(
    endpoint: string,
    key: string | undefined,
    body: unknown,
    successStatus: number,
    work: (record: RecordCompletion<T>) => Promise<T>,
    hasher?: RequestHasher,
    replayDeadlineMs?: number,
  ): Promise<{ result: T; executed: boolean }> {
    if (key === undefined) {
      return { result: await work(async () => undefined), executed: true };
    }

    const claimed = await this.claim(endpoint, key, body, hasher, replayDeadlineMs);
    if (claimed.kind === 'REPLAY') return { result: claimed.body as T, executed: false };

    let recorded = false;
    let result: T;
    try {
      result = await work(async (tx, resourceId, response, status) => {
        await this.complete(tx, claimed.claim, status ?? successStatus, resourceId, response);
        recorded = true;
      });
    } catch (error) {
      // Unconditional: if the domain transaction committed (and the key with
      // it) before the failure surfaced, the row is COMPLETED and this removes
      // nothing; if it rolled back, even after recording, the claim is freed.
      await this.release(claimed.claim);
      throw error;
    }
    if (!recorded) {
      // A programming error: the work committed without its key. The claim is
      // left IN_PROGRESS (retries are refused) rather than released.
      throw new Error(`Idempotent work for ${endpoint} did not record its completion`);
    }
    return { result, executed: true };
  }

  /**
   * Removes expired records. Called on the same timer as the other upkeep.
   *
   * Unscoped, and it has to be: the timer in `app.module.ts` runs outside any
   * request, so there is no tenant in context. Safe because the predicate is
   * `expiresAt < now` (a row with a replay deadline: `expiresAt < now − B`, so
   * the fence still finds it — see the replay fence above) and nothing else: it can only remove records
   * that are already unusable, and it reads no tenant data. A work still running under
   * a purged claim cannot complete it (see {@link complete}).
   */
  async purgeExpired(): Promise<number> {
    const nowMs = this.nowMs();
    const beyondFence = new Date(
      nowMs - replayFenceBudgetMs(this.env.CONSTRUCTION_CLOCK_SKEW_SECONDS),
    );
    const result = await runUnscoped(
      'expired idempotency records are platform upkeep, deleted by age alone and never by tenant',
      () =>
        this.prisma.client.idempotencyKey.deleteMany({
          where: {
            OR: [
              { replayDeadlineAt: null, expiresAt: { lt: new Date(nowMs) } },
              { replayDeadlineAt: { not: null }, expiresAt: { lt: beyondFence } },
            ],
          },
        }),
    );
    return result.count;
  }

  // Nothing of the key reaches an error, and so a log (S-09): a client's key
  // can be guessable or meaningful, and whoever holds it can replay the stored
  // response. Not a digest either — an unkeyed SHA-256 of a low-entropy key is
  // reversed by guessing (review of #135). The endpoint and the request's
  // correlationId locate the clash. The wait is the typed field the exception
  // filter sends as `Retry-After`, not context.

  private inFlight(endpoint: string): RastaError {
    return new RastaError('CONFLICT', 'This request is already being processed; retry shortly', {
      internalContext: { endpoint },
      retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS,
    });
  }

  /** Proven refusal: nothing was written by this attempt. Fixed message, no state of the key. */
  private windowClosed(endpoint: string): RastaError {
    return new RastaError(
      'REPLAY_WINDOW_CLOSED',
      'The time allowed for this request has passed; this attempt did nothing',
      { internalContext: { endpoint } },
    );
  }

  private reused(endpoint: string): RastaError {
    return new RastaError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request body',
      { internalContext: { endpoint } },
    );
  }
}

/**
 * The request identity of a route that acts on one resource.
 *
 * Keys are stored under the route **template** (`POST /v1/projects/:id/needs`)
 * so the replay metric's label set stays bounded, which leaves the target id
 * to the body hash. Folding it in makes the same key and body on a second
 * project the documented `409 IDEMPOTENCY_KEY_REUSED` rather than a replay of
 * the first project's response.
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
export function canonicalise(value: unknown): string {
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

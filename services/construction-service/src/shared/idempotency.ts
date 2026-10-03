import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { isUniqueViolation } from '../shared/prisma-errors';
import { idempotentReplaysTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';

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
 * Used by the four create endpoints (`POST /v1/projects`,
 * `POST /v1/projects/{id}/needs`, `POST /v1/projects/{id}/progress` and
 * `POST /v1/approval-policies`), where a retried request would otherwise
 * create a second project, need, progress draft or policy version. The key is
 * **optional** there: the gateway does not require it for these prefixes, and
 * a request without one simply is not deduplicated. Every other command carries `expectedVersion`, and a retry of
 * one that already committed is refused by the compare-and-set instead.
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

/** Records the completion inside the caller's domain transaction. */
export type RecordCompletion<T> = (
  tx: ExtendedPrismaClient,
  resourceId: string,
  response: T,
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

/**
 * The most one claim waits on another transaction's lock on its key, over all
 * its attempts — the same bound the other services' stores keep.
 */
export const CLAIM_WAIT_MS = 5_000;
/** Slack for a claim-side transaction beyond its lock wait, so the wait ends first. */
const WAIT_TRANSACTION_SLACK_MS = 2_000;

/** PostgreSQL's `lock_not_available`, raised when `lock_timeout` elapses. */
const LOCK_NOT_AVAILABLE = '55P03';

@Injectable()
export class IdempotencyStore {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: ConstructionEnv,
  ) {}

  /** SHA-256 over the canonical form. See {@link hashRequestBody}. */
  hash(body: unknown): string {
    return hashRequestBody(body);
  }

  /**
   * Reserves the key, or reports what to do instead.
   *
   * Returns `PROCEED` with the claim this caller inserted, or `REPLAY` with a
   * stored response; throws for the two conflict cases, because they are
   * errors rather than outcomes, and when the claim could not be settled in
   * {@link CLAIM_ATTEMPTS} attempts.
   */
  async claim(
    endpoint: string,
    key: string,
    body: unknown,
  ): Promise<{ kind: 'PROCEED'; claim: Claim } | { kind: 'REPLAY'; body: unknown }> {
    const organizationId = getOrganizationId();
    const requestHash = this.hash(body);
    const where = { organizationId_endpoint_key: { organizationId, endpoint, key } };
    const deadline = Date.now() + CLAIM_WAIT_MS;

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const now = new Date();
      const token = randomUUID();
      const expiresAt = new Date(
        now.getTime() + this.env.CONSTRUCTION_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
      );

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

      if (existing.expiresAt <= now) {
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

      if (existing.requestHash !== requestHash) throw this.reused(endpoint);

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
  ): Promise<T> {
    return (await this.execute(endpoint, key, body, successStatus, work)).result;
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
  ): Promise<{ result: T; executed: boolean }> {
    if (key === undefined) {
      return { result: await work(async () => undefined), executed: true };
    }

    const claimed = await this.claim(endpoint, key, body);
    if (claimed.kind === 'REPLAY') return { result: claimed.body as T, executed: false };

    let recorded = false;
    let result: T;
    try {
      result = await work(async (tx, resourceId, response) => {
        await this.complete(tx, claimed.claim, successStatus, resourceId, response);
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
   * `expiresAt < now` and nothing else — it can only remove records that are
   * already unusable, and it reads no tenant data. A work still running under
   * a purged claim cannot complete it (see {@link complete}).
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

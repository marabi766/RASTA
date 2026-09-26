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
 * | key currently in flight            | `409 CONFLICT`                        |
 *
 * Used by the two create endpoints (`POST /v1/projects`,
 * `POST /v1/projects/{id}/needs`), where a retried request would otherwise
 * create a second project or need. The key is **optional** there: the gateway
 * does not require it for `projects`, and a request without one simply is not
 * deduplicated. Every other command carries `expectedVersion`, and a retry of
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

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const now = new Date();
      const token = randomUUID();
      const expiresAt = new Date(
        now.getTime() + this.env.CONSTRUCTION_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
      );

      try {
        await this.prisma.client.idempotencyKey.create({
          data: {
            key,
            organizationId,
            endpoint,
            requestHash,
            claimToken: token,
            state: 'IN_PROGRESS',
            expiresAt,
          },
        });
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
        await this.prisma.client.idempotencyKey.deleteMany({
          where: {
            organizationId,
            endpoint,
            key,
            claimToken: existing.claimToken,
            expiresAt: { lte: now },
          },
        });
        continue;
      }

      if (existing.requestHash !== requestHash) throw this.reused(endpoint, key);

      if (existing.state === 'IN_PROGRESS') throw this.inFlight(endpoint, key);

      idempotentReplaysTotal.inc({ service: SERVICE_NAME, endpoint });
      return { kind: 'REPLAY', body: existing.responseBody };
    }

    throw this.inFlight(endpoint, key);
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
    if (count === 0) throw this.inFlight(claim.endpoint, claim.key);
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

  // The raw key never reaches an error, and so never a log (S-09): a client's
  // key can be guessable or meaningful, and whoever holds it can replay the
  // stored response. The digest still lets an operator match two log lines.

  private inFlight(endpoint: string, key: string): RastaError {
    return new RastaError('CONFLICT', 'This request is already being processed; retry shortly', {
      internalContext: { endpoint, keyDigest: keyDigest(key), retryAfterSeconds: 1 },
    });
  }

  private reused(endpoint: string, key: string): RastaError {
    return new RastaError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request body',
      { internalContext: { endpoint, keyDigest: keyDigest(key) } },
    );
  }
}

/**
 * A one-way digest of an Idempotency-Key, for logs: the first 16 hex digits of
 * its SHA-256. Enough to tell two keys apart in an incident, useless for
 * replaying either.
 */
export function keyDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
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
 */
function canonicalise(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}

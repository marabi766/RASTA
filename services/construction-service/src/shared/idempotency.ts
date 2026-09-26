import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../shared/prisma-errors';
import { idempotentReplaysTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';

/**
 * Idempotent creation (docs/06 § 6.8) — the marketplace mechanism, copied
 * because services share no source (A-02).
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
 * The claim is its own committed transaction, before the work begins, so a
 * concurrent duplicate finds `IN_PROGRESS` immediately rather than doing the
 * work and discovering the collision afterwards.
 */
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
   * Returns:
   *   `{ kind: 'PROCEED' }`  — the caller owns the key and should do the work
   *   `{ kind: 'REPLAY' }`   — a stored response to return unchanged
   *
   * and throws for the two conflict cases, because they are errors rather than
   * outcomes.
   */
  async claim(
    endpoint: string,
    key: string,
    body: unknown,
  ): Promise<{ kind: 'PROCEED' } | { kind: 'REPLAY'; status: number; body: unknown }> {
    const organizationId = getOrganizationId();
    const requestHash = this.hash(body);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.env.CONSTRUCTION_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
    );

    try {
      await this.prisma.client.idempotencyKey.create({
        data: { key, organizationId, endpoint, requestHash, state: 'IN_PROGRESS', expiresAt },
      });
      return { kind: 'PROCEED' };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.client.idempotencyKey.findUnique({
      where: { organizationId_endpoint_key: { organizationId, endpoint, key } },
    });

    // Expired between the failed insert and this read. Treat it as absent and
    // let the caller retry the whole claim rather than guessing.
    if (!existing) return { kind: 'PROCEED' };

    if (existing.expiresAt <= now) {
      await this.prisma.client.idempotencyKey.delete({
        where: { organizationId_endpoint_key: { organizationId, endpoint, key } },
      });
      return this.claim(endpoint, key, body);
    }

    if (existing.requestHash !== requestHash) {
      throw RastaError.idempotencyKeyReused(key);
    }

    if (existing.state === 'IN_PROGRESS') {
      throw new RastaError('CONFLICT', 'This request is already being processed; retry shortly', {
        internalContext: { endpoint, key, retryAfterSeconds: 1 },
      });
    }

    idempotentReplaysTotal.inc({ service: SERVICE_NAME, endpoint });
    return {
      kind: 'REPLAY',
      status: existing.responseStatus ?? 200,
      body: existing.responseBody,
    };
  }

  /**
   * Records the response so a retry can replay it.
   *
   * Deliberately **not** inside the caller's transaction: if the work
   * committed and this write then failed, a retry finds `IN_PROGRESS` and is
   * refused — annoying, and safe. Sharing the transaction would roll back a
   * creation that had already succeeded.
   */
  async complete(endpoint: string, key: string, status: number, body: unknown): Promise<void> {
    const organizationId = getOrganizationId();
    await this.prisma.client.idempotencyKey.updateMany({
      where: { organizationId, endpoint, key, state: 'IN_PROGRESS' },
      data: { state: 'COMPLETED', responseStatus: status, responseBody: body as object },
    });
  }

  /**
   * Releases a claim whose work failed.
   *
   * A failed attempt must not block a corrected retry with the same key. Only
   * `IN_PROGRESS` rows are removed, so a completed response is never dropped.
   */
  async release(endpoint: string, key: string): Promise<void> {
    const organizationId = getOrganizationId();
    await this.prisma.client.idempotencyKey.deleteMany({
      where: { organizationId, endpoint, key, state: 'IN_PROGRESS' },
    });
  }

  /**
   * Runs `work` at most once for this key.
   *
   * The wrapper every idempotent endpoint uses, so the claim/complete/release
   * sequence is written once. A handler that forgot the `release` on failure
   * would leave a key wedged until expiry, and that is exactly the kind of
   * detail that is got wrong when it is repeated per endpoint.
   */
  async run<T>(
    endpoint: string,
    key: string,
    body: unknown,
    successStatus: number,
    work: () => Promise<T>,
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
    key: string,
    body: unknown,
    successStatus: number,
    work: () => Promise<T>,
  ): Promise<{ result: T; executed: boolean }> {
    const claim = await this.claim(endpoint, key, body);
    if (claim.kind === 'REPLAY') return { result: claim.body as T, executed: false };

    try {
      const result = await work();
      await this.complete(endpoint, key, successStatus, result);
      return { result, executed: true };
    } catch (error) {
      await this.release(endpoint, key);
      throw error;
    }
  }

  /**
   * Removes expired records. Called on the same timer as the other upkeep.
   *
   * Unscoped, and it has to be: the timer in `app.module.ts` runs outside any
   * request, so there is no tenant in context. Safe because the predicate is
   * `expiresAt < now` and nothing else — it can only remove records that are
   * already unusable, and it reads no tenant data.
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

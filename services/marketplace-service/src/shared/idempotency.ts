import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../shared/prisma-errors';
import { idempotentReplaysTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type MarketplaceEnv } from '../config/env';

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
 */
@Injectable()
export class IdempotencyStore {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: MarketplaceEnv,
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
      now.getTime() + this.env.MARKETPLACE_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
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
   * Deliberately **not** inside the caller's transaction. Recording the
   * response is not part of the financial effect: if the effect committed and
   * this write then failed, the money has moved and a retry would find
   * `IN_PROGRESS` and be refused — annoying, and safe. If it shared the
   * transaction, a failure here would roll back a settlement that had already
   * succeeded, which is not.
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
   * A failed attempt must not block a corrected retry: a settlement refused
   * for insufficient balance should be retryable once the wallet is topped up,
   * with the same key. Only `IN_PROGRESS` rows are removed, so a completed
   * response is never dropped.
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
    const claim = await this.claim(endpoint, key, body);
    if (claim.kind === 'REPLAY') return claim.body as T;

    try {
      const result = await work();
      await this.complete(endpoint, key, successStatus, result);
      return result;
    } catch (error) {
      await this.release(endpoint, key);
      throw error;
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

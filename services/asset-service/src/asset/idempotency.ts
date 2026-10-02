import { createHash, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import type { ExtendedPrismaClient, PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from './asset.repository';
import { idempotentReplaysTotal } from '../observability/metrics';
import { SERVICE_NAME, type AssetEnv } from '../config/env';

/** `Retry-After` on the in-flight 409, as docs/06 § 6.8 states it. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/**
 * How long a request waits on a key another request is still working on,
 * before it answers `409 CONFLICT` with `Retry-After`. A registration takes a
 * fraction of a second, so a double submit is normally answered with the first
 * request's own 201.
 */
export const IN_FLIGHT_WAIT_MS = 5_000;
/** Between looks at a claim whose holder has not yet begun its transaction. */
const IN_FLIGHT_POLL_MS = 100;
/** Slack for the waiting transaction beyond its lock wait, so the wait ends first. */
const WAIT_TRANSACTION_SLACK_MS = 2_000;

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
 * The claim this request took is no longer its own — its lease lapsed and a
 * retry re-took it, or it was purged — so its work must not commit. The key is
 * either free or another request's, and a retry learns which.
 */
function claimLost(endpoint: string): RastaError {
  return new RastaError(
    'CONFLICT',
    'This request took too long and its Idempotency-Key lapsed; retry shortly',
    { internalContext: { endpoint }, retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS },
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A **required** `Idempotency-Key`, trimmed (#169). Missing or blank is
 * `400 VALIDATION_FAILED` with code `required`; present but outside 8–255
 * characters is the same refusal with code `invalid`.
 *
 * The service demands it itself and does not rely on the gateway (ADR-020):
 * the protection against registering one machine twice must not depend on
 * which door a request used.
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

/**
 * What the work does with its claim **inside its own transaction**: `hold` is
 * the transaction's first statement and `complete` its last, so the claim
 * check, the asset, its outbox row and the stored response commit together —
 * or none of them does.
 */
export interface ClaimFence<T> {
  /**
   * Locks this claim's row (`SELECT … FOR UPDATE`) by its token. Throws — and
   * so aborts the whole transaction — when the claim is no longer this
   * request's: its lease lapsed, or it was released and re-taken by a retry.
   */
  hold(tx: ExtendedPrismaClient): Promise<void>;
  /**
   * Stores `result` as the response to replay, on the row `hold` locked, and
   * starts the key's lifetime from now. Returns the stored JSON, which is what
   * this caller and every replay receive.
   */
  complete(tx: ExtendedPrismaClient, result: T): Promise<T>;
}

type Claim = { kind: 'PROCEED'; token: string } | { kind: 'REPLAY'; status: number; body: unknown };

export type IdempotencyEnv = Pick<
  AssetEnv,
  'ASSET_IDEMPOTENCY_TTL_HOURS' | 'ASSET_IDEMPOTENCY_CLAIM_LEASE_SECONDS'
>;

/**
 * Idempotent registration of assets (#169, docs/06 § 6.8) — the store
 * maintenance-service uses since #171 and #187 and marketplace-service since
 * #147, in this service's own copy (services share no source, A-02).
 *
 * | situation                               | response                                    |
 * | --------------------------------------- | ------------------------------------------- |
 * | no key, or one outside 8–255 characters | `400 VALIDATION_FAILED`, nothing claimed    |
 * | new key                                 | the work runs; its 201 body is stored       |
 * | same key, same body, same caller        | the stored 201 body, nothing runs again     |
 * | same key, different body or caller      | `409 IDEMPOTENCY_KEY_REUSED`, no body       |
 * | key in flight past {@link IN_FLIGHT_WAIT_MS} | `409 CONFLICT` + `Retry-After: 1`      |
 *
 * Keys are the tenant's (`organization_id` leads the primary key): the same key
 * in two organizations is two requests, and one tenant can never reach another
 * tenant's stored response. The caller's user id is part of the hashed request,
 * so a key reused by another user of the same tenant is refused rather than
 * answered with a response that user never asked for. The route's role check
 * runs before the controller, so nothing is replayed to a caller who may not
 * register an asset at all.
 *
 * ## Claim first; then check, work and complete in one transaction
 *
 * The claim is committed on its own before the work starts, so a concurrent
 * duplicate finds `IN_PROGRESS` at once and waits for the stored response
 * rather than racing the work. The work's own transaction locks the claim row
 * by its token before anything else ({@link ClaimFence.hold}) and stores the
 * response on it as its last statement ({@link ClaimFence.complete}):
 *
 * - a duplicate that arrives while the work runs waits **on that row lock**
 *   (bounded by `lock_timeout`), and reads the stored response the moment the
 *   work commits;
 * - a registration that outlives its claim cannot commit: once the lease lapsed
 *   and a retry re-took the key, `hold` finds no row with this token and the
 *   whole registration aborts — the token fences the work, not only the row;
 * - a claim whose lease lapses while its work holds the lock cannot be re-taken
 *   under it: the retry's removal of the lapsed row waits for the lock, then
 *   finds the row completed with a fresh lifetime, and replays it;
 * - the response cannot fail to be stored after the asset committed.
 *
 * Any failure of the work releases the claim, but only this claim's own
 * in-flight row, never a completed one or a successor's.
 *
 * ## A claim is a lease, not a lock for a day
 *
 * A claim in flight lives `ASSET_IDEMPOTENCY_CLAIM_LEASE_SECONDS` (two minutes
 * by default); only a **completed** response lives `ASSET_IDEMPOTENCY_TTL_HOURS`.
 * Past its lease an abandoned claim — its process died between the claim and
 * the asset — is removed by the next retry, which takes the key under a **new
 * token**.
 */
export class IdempotencyStore {
  private readonly logger = new Logger(IdempotencyStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: IdempotencyEnv,
  ) {}

  /**
   * Runs `work` at most once for this key, and returns its result — or the
   * stored result of the request that already ran it. Either way the value is
   * the JSON the first request answered with.
   */
  async execute<T>(
    endpoint: string,
    key: string,
    body: unknown,
    successStatus: number,
    work: (fence: ClaimFence<T>) => Promise<T>,
  ): Promise<{ result: T; executed: boolean }> {
    const claim = await this.claim(endpoint, key, body);
    if (claim.kind === 'REPLAY') return { result: claim.body as T, executed: false };

    let stored: { value: T } | undefined;
    const fence: ClaimFence<T> = {
      hold: (tx) => this.hold(tx, endpoint, key, claim.token),
      complete: async (tx, result) => {
        const value = JSON.parse(JSON.stringify(result)) as T;
        await this.storeResponse(tx, endpoint, key, claim.token, successStatus, value);
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
   * Not lapsed by this service's clock — the one the takeover in `claimOnce`
   * reads — and still this claim's — or the
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
   * `ASSET_IDEMPOTENCY_TTL_HOURS` from now — from the response, not the claim,
   * which only ever held a lease. Matched on the token, so a stale holder's
   * completion is refused even if `hold` was skipped.
   */
  async storeResponse(
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
    if (count !== 1) {
      this.logLostClaim('complete', endpoint);
      throw claimLost(endpoint);
    }
  }

  /** When a **completed** response stops being replayed. */
  private expiry(from: Date): Date {
    return new Date(from.getTime() + this.env.ASSET_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
  }

  /** When a claim still **in flight** may be taken over by a retry. */
  private lease(from: Date): Date {
    return new Date(from.getTime() + this.env.ASSET_IDEMPOTENCY_CLAIM_LEASE_SECONDS * 1000);
  }

  /** SHA-256 over the canonical request and the caller who sent it. */
  hash(body: unknown): string {
    return hashRequest({ caller: getContext().userId ?? null, body });
  }

  /**
   * Reserves the key, waits on it while another request holds it, or reports
   * the stored response to replay. The two conflicts throw.
   */
  async claim(endpoint: string, key: string, body: unknown): Promise<Claim> {
    const requestHash = this.hash(body);
    const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
    let retries = 0;
    for (;;) {
      const outcome = await this.claimOnce(endpoint, key, requestHash);
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
   * One attempt. `PROCEED` only from the insert that wrote the row: a request
   * that lost the insert and then found no row, or a lapsed one, reserved
   * nothing and tries again. A lapsed row is removed only while it is still
   * lapsed — the removal waits for a holder's lock and re-checks — never a
   * fresh claim or a response that replaced it.
   */
  private async claimOnce(
    endpoint: string,
    key: string,
    requestHash: string,
  ): Promise<Claim | typeof RETRY_CLAIM | typeof IN_FLIGHT> {
    const organizationId = getOrganizationId();
    const now = new Date();

    const token = randomUUID();
    try {
      await this.prisma.client.idempotencyKey.create({
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
      return { kind: 'PROCEED', token };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.client.idempotencyKey.findFirst({
      where: { organizationId, endpoint, key },
    });
    if (!existing) return RETRY_CLAIM;

    if (existing.expiresAt <= now) {
      await this.prisma.client.idempotencyKey.deleteMany({
        where: { organizationId, endpoint, key, expiresAt: { lte: now } },
      });
      return RETRY_CLAIM;
    }

    // Before anything about the stored state: another body or another caller
    // learns nothing of it, not even that it is still in flight.
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
   * Waits for the request holding this key: on its row lock while its work's
   * transaction runs — so the wait ends the moment that commits or rolls back —
   * and, when the holder has not begun its transaction yet, for a short poll.
   * Bounded by `remainingMs` through `lock_timeout`; running out is not an
   * error here, the caller's deadline decides.
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
  private logLostClaim(operation: 'hold' | 'complete' | 'release', endpoint: string): void {
    this.logger.warn(
      `idempotency ${operation} matched no in-progress row for this claim (lapsed, purged or re-taken); left untouched: ${endpoint}`,
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
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}

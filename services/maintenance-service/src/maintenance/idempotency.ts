import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { isUniqueViolation } from './maintenance.repository';
import { idempotentReplaysTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type MaintenanceEnv } from '../config/env';

/** `Retry-After` on the in-flight 409, as docs/06 § 6.8 states it. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/**
 * How long a request waits on a key another request is still working on,
 * before it answers `409 CONFLICT` with `Retry-After`. A create takes a
 * fraction of a second, so a double submit — the portal's button pressed
 * twice, a proxy retrying — is normally answered with the first request's own
 * 201 (#157). A create slower than this leaves its duplicate the 409, which
 * the portal shows as in progress and offers again after the wait (round 1 on
 * #171), never as an invalid form.
 */
export const IN_FLIGHT_WAIT_MS = 5_000;
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
   * starts the key's lifetime from now. Returns the stored JSON, which is
   * what this caller and every replay receive.
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
 */
@Injectable()
export class IdempotencyStore {
  private readonly logger = new Logger(IdempotencyStore.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV)
    private readonly env: Pick<
      MaintenanceEnv,
      'MAINTENANCE_IDEMPOTENCY_TTL_HOURS' | 'MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS'
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
   * claim, which only ever held a lease — so a retry that waited on the lock
   * finds it live and replays it.
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
    // Held since the transaction began, so never 0 — unless `hold` was skipped.
    if (count !== 1) throw claimLost(endpoint);
  }

  /** When a **completed** response stops being replayed. */
  private expiry(from: Date): Date {
    return new Date(from.getTime() + this.env.MAINTENANCE_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
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
   */
  private async claimOnce(
    endpoint: string,
    key: string,
    requestHash: string,
  ): Promise<Claim | typeof RETRY_CLAIM | typeof IN_FLIGHT> {
    const organizationId = getOrganizationId();
    const now = new Date();
    // The lease, not the response's lifetime: `storeResponse` moves it to that.
    const expiresAt = this.lease(now);

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
          expiresAt,
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

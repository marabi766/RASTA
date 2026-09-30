import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from './maintenance.repository';
import { idempotentReplaysTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type MaintenanceEnv } from '../config/env';

/** `Retry-After` on the in-flight 409, as docs/06 § 6.8 states it. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/**
 * How long a request waits on a key another request is still working on,
 * before it answers `409 CONFLICT`. A create takes a fraction of a second, so
 * a double submit — the portal's button pressed twice, a proxy retrying — is
 * answered with the first request's own 201 rather than an error the portal
 * would have to handle (#157).
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
 * ## Claim, then work, then complete — each its own statement
 *
 * The claim is committed before the work starts, so a concurrent duplicate
 * finds `IN_PROGRESS` at once and waits for the stored response rather than
 * racing the work. `complete` and `release` match the claim's own token: a
 * claim that expired and was re-taken can neither finish nor free its
 * successor's row. Only a failure of the work releases the claim; a failure
 * to record the response after the work committed keeps it, so a retry meets
 * the in-flight 409 until expiry instead of raising the work twice.
 */
@Injectable()
export class IdempotencyStore {
  private readonly logger = new Logger(IdempotencyStore.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Pick<MaintenanceEnv, 'MAINTENANCE_IDEMPOTENCY_TTL_HOURS'>,
  ) {}

  /**
   * Runs `work` at most once for this key, and returns its result — or the
   * stored result of the request that already ran it. Either way the value is
   * the JSON the first request answered with, so both callers of a double
   * submit receive the same body.
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

    let result: T;
    try {
      result = await work();
    } catch (error) {
      await this.release(endpoint, key, claim.token);
      throw error;
    }
    const stored = JSON.parse(JSON.stringify(result)) as T;
    await this.complete(endpoint, key, claim.token, successStatus, stored);
    return { result: stored, executed: true };
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
    const expiresAt = new Date(
      now.getTime() + this.env.MAINTENANCE_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
    );

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
   * Stores the response for replay — only on this claim's own in-flight row.
   * A late completion of a claim that expired and was re-taken is a logged
   * no-op: the work committed, and failing here would not undo it.
   */
  async complete(
    endpoint: string,
    key: string,
    token: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    const organizationId = getOrganizationId();
    const { count } = await this.prisma.client.idempotencyKey.updateMany({
      where: { organizationId, endpoint, key, claimToken: token, state: 'IN_PROGRESS' },
      data: { state: 'COMPLETED', responseStatus: status, responseBody: body as object },
    });
    if (count === 0) this.logLostClaim('complete', endpoint);
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
  private logLostClaim(operation: 'complete' | 'release', endpoint: string): void {
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

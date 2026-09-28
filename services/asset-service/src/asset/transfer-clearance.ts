import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { RastaError, tryGetContext, type InternalTokenService } from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';

/**
 * Asks the services that own a machine's open work whether it has any, and
 * fences it while the transfer commits (ADR-062, docs/23 D-033).
 *
 * ## Why the machine's own status is not enough
 *
 * `ASSIGNED` and `IN_MAINTENANCE` are built here from fleet and maintenance
 * events. An assignment or repair whose event has not been consumed yet does
 * not show, and a reported breakdown never changes the status at all. So the
 * transfer asks fleet-service and maintenance-service, whose databases are the
 * authority, through their internal clearance endpoints.
 *
 * ## The answer holds until the transfer lands
 *
 * Each owner counts and, when nothing is open, places a fence in the same
 * transaction, under the lock its own work-start paths take. While the fence
 * is live, no work can start on the machine there. It is lifted by the
 * owner's consumer of `ASSET_TRANSFERRED`, by {@link TransferClearance.release}
 * when the transfer does not happen, or by its expiry.
 *
 * ## Authentication (ADR-020, ADR-035)
 *
 * A fresh `SERVICE` internal token per call, minted for exactly the owner and
 * signed with the organization that owns the machine, which the owner compares
 * with its replica. The organization is never a header.
 *
 * ## Fail closed
 *
 * Only a well-formed `clear: true` about this machine and this transfer, from
 * each owner, lets the transfer go ahead. Open work is a refusal naming the
 * owner and the counts. A machine the owner places elsewhere, or a fence held
 * by another transfer, is a conflict to retry. Anything else — transport
 * error, timeout, `403`, `5xx`, a body that does not parse, a route-level
 * `404` — is unavailable, and unavailable never means clear. Nothing from a
 * failure (URL, token, body, status) is put into the error.
 */

export const FLEET_SERVICE = 'fleet-service';
export const MAINTENANCE_SERVICE = 'maintenance-service';

export type WorkOwner = typeof FLEET_SERVICE | typeof MAINTENANCE_SERVICE;

export const WORK_OWNERS: readonly WorkOwner[] = [FLEET_SERVICE, MAINTENANCE_SERVICE];

/** What one owner said. `open` lists the counts that are above zero. */
export type ClearanceAnswer = { clear: true } | { clear: false; open: Record<string, number> };

export interface TransferClearance {
  /** The fence's life, asked of every owner. */
  readonly fenceTtlSeconds: number;
  /** A monotonic clock in milliseconds; the transfer's commit deadline is measured on it. */
  now(): number;
  ask(
    owner: WorkOwner,
    organizationId: string,
    assetId: string,
    fenceId: string,
  ): Promise<ClearanceAnswer>;
  /** Best effort: never throws. The fence's expiry is the backstop. */
  release(
    owner: WorkOwner,
    organizationId: string,
    assetId: string,
    fenceId: string,
  ): Promise<void>;
}

export const TRANSFER_CLEARANCE = Symbol('ASSET_TRANSFER_CLEARANCE');

/**
 * What a service built without a clearance gets: every transfer refused. A
 * missing dependency must never read as "nothing is open".
 */
export const UNCONFIGURED_TRANSFER_CLEARANCE: TransferClearance = {
  fenceTtlSeconds: 600,
  now: () => performance.now(),
  ask: async (owner) => {
    throw RastaError.upstreamUnavailable(owner);
  },
  release: async () => undefined,
};

const COUNT_FIELDS: Record<WorkOwner, readonly string[]> = {
  [FLEET_SERVICE]: ['openAssignments'],
  [MAINTENANCE_SERVICE]: ['openRequests', 'openRepairOrders'],
};

const count = z.number().int().min(0);

const answerSchemas: Record<WorkOwner, z.ZodType<Record<string, unknown>>> = {
  [FLEET_SERVICE]: z.object({
    assetId: z.string(),
    fenceId: z.string(),
    clear: z.boolean(),
    fencedUntil: z.string().datetime({ offset: true }).nullable(),
    openAssignments: count,
  }),
  [MAINTENANCE_SERVICE]: z.object({
    assetId: z.string(),
    fenceId: z.string(),
    clear: z.boolean(),
    fencedUntil: z.string().datetime({ offset: true }).nullable(),
    openRequests: count,
    openRepairOrders: count,
  }),
};

const platformErrorSchema = z.object({ code: z.string(), message: z.string() });

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface TransferClearanceClientOptions {
  readonly baseUrls: Readonly<Record<WorkOwner, string>>;
  /** `ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS`: one exchange, body included. */
  readonly timeoutMs: number;
  /** `ASSET_TRANSFER_FENCE_TTL_SECONDS`. */
  readonly fenceTtlSeconds: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seams for tests. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class TransferClearanceClient implements TransferClearance {
  readonly fenceTtlSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;

  constructor(private readonly options: TransferClearanceClientOptions) {
    this.fenceTtlSeconds = options.fenceTtlSeconds;
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.now ?? (() => performance.now());
  }

  now(): number {
    return this.clock();
  }

  async ask(
    owner: WorkOwner,
    organizationId: string,
    assetId: string,
    fenceId: string,
  ): Promise<ClearanceAnswer> {
    const response = await this.call(
      owner,
      organizationId,
      'POST',
      `/v1/internal/assets/${encodeURIComponent(assetId)}/transfer-clearance`,
      JSON.stringify({ fenceId, ttlSeconds: this.fenceTtlSeconds }),
    );

    if (response.status === 404 || response.status === 409) {
      // Only the owner's own refusal counts as an answer: the platform error
      // body, naming the machine or the state. A proxy's 404 proves nothing.
      const body = platformErrorSchema.safeParse(await readJson(response, owner));
      const recognised =
        body.success &&
        ((response.status === 404 &&
          body.data.code === 'NOT_FOUND' &&
          body.data.message === 'Asset not found') ||
          (response.status === 409 && body.data.code === 'INVALID_STATE_TRANSITION'));
      if (!recognised) throw RastaError.upstreamUnavailable(owner);
      throw RastaError.invalidStateTransition(
        'Asset',
        'ACTIVE',
        'TRANSFERRED',
        response.status === 404
          ? `${owner} does not yet place this asset with its owner. Try the transfer again shortly.`
          : 'Another transfer of this asset is in progress.',
      );
    }
    if (response.status !== 200) throw RastaError.upstreamUnavailable(owner);

    const parsed = answerSchemas[owner].safeParse(await readJson(response, owner));
    if (!parsed.success) throw RastaError.upstreamUnavailable(owner);
    const body = parsed.data as {
      assetId: string;
      fenceId: string;
      clear: boolean;
      fencedUntil: string | null;
    } & Record<string, unknown>;

    // An answer about another machine or another transfer is not an answer.
    if (body.assetId !== assetId || body.fenceId !== fenceId) {
      throw RastaError.upstreamUnavailable(owner);
    }

    const open: Record<string, number> = {};
    for (const field of COUNT_FIELDS[owner]) {
      const value = body[field] as number;
      if (value > 0) open[field] = value;
    }

    if (body.clear) {
      // "Clear" with open work, or without a fence, contradicts itself.
      if (Object.keys(open).length > 0 || body.fencedUntil === null) {
        throw RastaError.upstreamUnavailable(owner);
      }
      return { clear: true };
    }
    // "Not clear" with nothing open says nothing either.
    if (Object.keys(open).length === 0) throw RastaError.upstreamUnavailable(owner);
    return { clear: false, open };
  }

  async release(
    owner: WorkOwner,
    organizationId: string,
    assetId: string,
    fenceId: string,
  ): Promise<void> {
    try {
      await this.call(
        owner,
        organizationId,
        'DELETE',
        `/v1/internal/assets/${encodeURIComponent(assetId)}/transfer-clearance/${encodeURIComponent(fenceId)}`,
      );
    } catch {
      // The expiry lifts it.
    }
  }

  private async call(
    owner: WorkOwner,
    organizationId: string,
    method: 'POST' | 'DELETE',
    path: string,
    body?: string,
  ): Promise<Response> {
    const token = await this.options.tokens.issue(SERVICE_NAME, owner, 'SERVICE', organizationId);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-internal-token': token,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const context = tryGetContext();
    if (context && SAFE_CORRELATION_ID.test(context.correlationId)) {
      headers['x-correlation-id'] = context.correlationId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(
        `${this.options.baseUrls[owner].replace(/\/+$/, '')}${path}`,
        { method, headers, body, signal: controller.signal },
      );
      // The body is read inside the deadline too, and an answer that arrives
      // after it is not taken, even from a transport that ignored the abort.
      const text = await response.text();
      if (controller.signal.aborted) throw new Error('deadline passed');
      return new Response(text.length > 0 ? text : null, { status: response.status });
    } catch {
      // No cause attached: a runtime's transport error can quote the URL.
      throw controller.signal.aborted
        ? RastaError.upstreamTimeout(owner, this.options.timeoutMs)
        : RastaError.upstreamUnavailable(owner);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readJson(response: Response, owner: WorkOwner): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw RastaError.upstreamUnavailable(owner);
  }
}

import { z } from 'zod';
import { RastaError, tryGetContext, type InternalTokenService } from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';

/**
 * Asks a fact's owning service what it actually recorded (ADR-061 § 4).
 *
 * ## Why a consumer with a financial effect cannot take the event's word
 *
 * A Kafka envelope is written entirely by its publisher (`producer`, `tenantId`,
 * `actor`, the payload), and the broker does not yet authenticate publishers.
 * Anything that reaches it can publish `MAINTENANCE_APPROVED` for any
 * organization and any amount, or `USAGE_RECORDED` naming any user as the
 * actor. So before this service records an obligation or grants a reward, it
 * reads the fact from the service that owns it, and acts on that.
 *
 * ## The boundary
 *
 * REST to the owner's `/v1/internal/…` read, never its database (A-01/A-02),
 * and no import from its source tree. The response shapes are declared below,
 * on this side of the wire.
 *
 * ## Authentication (ADR-020, ADR-035)
 *
 * A fresh `SERVICE` internal token per call, minted for exactly the owning
 * service and **signed with the organization the event names**. The owner reads
 * the record inside that organization only, so an event that names the wrong
 * one finds nothing. The organization travels in the signature, never in a
 * header, because a header is exactly the kind of claim this exists to stop
 * trusting.
 *
 * ## Three answers, and only three
 *
 * - the fact, parsed against the declared shape;
 * - `null`: the owner answered `404` **with the platform error body naming the
 *   resource it was asked for** (`{ code: 'NOT_FOUND', message: 'UsageRecord not
 *   found' }`), meaning no such record in that organization. Any other `404` (a
 *   route missing during a rolling deploy, a wrong base path, a proxy) proves
 *   nothing about the record and is treated as unavailable (PR #110 review #4);
 * - a thrown `UPSTREAM_UNAVAILABLE` or `UPSTREAM_TIMEOUT` for everything else:
 *   transport errors, timeouts, a `403` from a misconfigured allowlist, a `5xx`,
 *   a body that does not parse. The consumer retries those and never acts on
 *   them. Fail closed: an owner that cannot be asked never means yes.
 *
 * Nothing from a failure leaks into the error (no URL, token, body or
 * status), because the error ends up in a DLQ header.
 */

export const MAINTENANCE_SERVICE = 'maintenance-service';
export const FLEET_SERVICE = 'fleet-service';

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

const minorAmount = z.string().regex(/^\d+$/);
const instant = z.string().datetime({ offset: true });

const maintenanceRequestFactSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  assetId: z.string().min(1),
  type: z.string().min(1),
  scheduleId: z.string().nullable(),
  status: z.string().min(1),
  completedAt: instant.nullable(),
  completedBy: z.string().nullable(),
  downtimeMinutes: z.number().int().nullable(),
  approvedAt: instant.nullable(),
  approvedBy: z.string().nullable(),
  totalCostMinor: minorAmount,
  currency: z.string().min(3),
  workshopOrganizationId: z.string().nullable(),
});

export type MaintenanceRequestFact = z.infer<typeof maintenanceRequestFactSchema>;

const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .nullable();

const usageRecordFactSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  assetId: z.string().min(1),
  driverId: z.string().nullable(),
  assignmentId: z.string().nullable(),
  periodStart: instant,
  periodEnd: instant,
  hours: decimal,
  kilometres: decimal,
  hourMeter: decimal,
  odometer: decimal,
  source: z.string().min(1),
  recordedAt: instant,
  recordedBy: z.string().min(1),
});

export type UsageRecordFact = z.infer<typeof usageRecordFactSchema>;

/**
 * What the consumers depend on. An interface so a test can stand in for the
 * owning services without a network.
 */
export interface SourceFacts {
  /** The maintenance request as maintenance-service records it, or `null`. */
  maintenanceRequest(organizationId: string, id: string): Promise<MaintenanceRequestFact | null>;
  /** The usage record as fleet-service records it, or `null`. */
  usageRecord(organizationId: string, id: string): Promise<UsageRecordFact | null>;
}

export interface SourceFactsClientOptions {
  /** `MAINTENANCE_SERVICE_URL`. */
  readonly maintenanceBaseUrl: string;
  /** `FLEET_SERVICE_URL`. */
  readonly fleetBaseUrl: string;
  /** `ECONOMIC_SOURCE_REQUEST_TIMEOUT_MS`: the whole exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

export class SourceFactsClient implements SourceFacts {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SourceFactsClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  maintenanceRequest(organizationId: string, id: string): Promise<MaintenanceRequestFact | null> {
    return this.read(
      MAINTENANCE_SERVICE,
      this.options.maintenanceBaseUrl,
      `/v1/internal/maintenance-requests/${encodeURIComponent(id)}`,
      'MaintenanceRequest',
      organizationId,
      id,
      maintenanceRequestFactSchema,
    );
  }

  usageRecord(organizationId: string, id: string): Promise<UsageRecordFact | null> {
    return this.read(
      FLEET_SERVICE,
      this.options.fleetBaseUrl,
      `/v1/internal/usage-records/${encodeURIComponent(id)}`,
      'UsageRecord',
      organizationId,
      id,
      usageRecordFactSchema,
    );
  }

  private async read<T extends { id: string; organizationId: string }>(
    service: string,
    baseUrl: string,
    path: string,
    resourceType: string,
    organizationId: string,
    id: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const token = await this.options.tokens.issue(SERVICE_NAME, service, 'SERVICE', organizationId);

    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-internal-token': token,
    };
    const context = tryGetContext();
    if (context && SAFE_CORRELATION_ID.test(context.correlationId)) {
      headers['x-correlation-id'] = context.correlationId;
    }
    if (context?.traceId && context.spanId && TRACE_ID.test(context.traceId)) {
      if (SPAN_ID.test(context.spanId)) {
        headers.traceparent = `00-${context.traceId}-${context.spanId}-01`;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref?.();

    const failed = () =>
      controller.signal.aborted
        ? RastaError.upstreamTimeout(service, this.options.timeoutMs)
        : RastaError.upstreamUnavailable(service);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } catch {
        // No cause attached: a runtime's transport error can quote the URL.
        throw failed();
      }

      if (response.status === 404) {
        // Absence only when the owner's own handler said so, about this kind
        // of record. Unavailable otherwise: retried, never taken as "no".
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw failed();
        }
        if (isRecordNotFound(body, resourceType)) return null;
        throw RastaError.upstreamUnavailable(service);
      }
      if (response.status !== 200) throw RastaError.upstreamUnavailable(service);

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw failed();
      }

      const parsed = schema.safeParse(body);
      if (!parsed.success) throw RastaError.upstreamUnavailable(service);

      // An answer about another record is not an answer. The organization is
      // compared by the consumer, which reports it as its own mismatch.
      if (parsed.data.id !== id) throw RastaError.upstreamUnavailable(service);

      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The platform's error body for a record the owner looked for and did not
 * find: `RastaError.notFound(resourceType, id)` rendered by the global
 * exception filter. A route-level 404 goes through the same filter with the
 * same code, but its message is Nest's `Cannot GET …`, so the message is what
 * tells the two apart.
 */
const notFoundBodySchema = z.object({ code: z.literal('NOT_FOUND'), message: z.string() });

export function isRecordNotFound(body: unknown, resourceType: string): boolean {
  const parsed = notFoundBodySchema.safeParse(body);
  return parsed.success && parsed.data.message === `${resourceType} not found`;
}

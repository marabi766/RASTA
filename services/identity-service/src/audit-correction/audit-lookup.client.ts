import { z } from 'zod';
import { RastaError, tryGetContext, type InternalTokenService } from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';

/**
 * The one question identity-service asks audit-service: does this correction
 * target exist, and which scope does it belong to (ADR-053 § 7, AUD-003 correction).
 *
 * ## The boundary
 *
 * REST, to audit-service's internal lookup, never its database (A-01/A-02), and
 * no import from its source tree. The contract is the three-field answer below,
 * declared here, on identity's side of the wire.
 *
 * ## Authentication (ADR-020, ADR-035)
 *
 * A fresh `SERVICE` internal token per call, minted for exactly `audit-service`
 * and short-lived. It carries **no** organization claim, and no
 * `X-Organization-Id` is sent: the lookup is platform-wide by nature — the
 * producer must learn the target's true scope in order to copy it — and naming
 * the administrator's own tenant would add a claim nobody checks. The caller's
 * bearer token is never forwarded: it is not this service's to pass on, and
 * audit-service authorises the *producer*, not the person.
 *
 * ## What may leak from a failure: nothing
 *
 * Transport errors, timeouts and unexpected statuses become one of two bounded
 * platform errors — `UPSTREAM_TIMEOUT` or `UPSTREAM_UNAVAILABLE` — with no URL,
 * token, response body, status or target tenant in the message or in the cause.
 * A `404`, and an answer that is not *exactly* the requested id and instant,
 * both become "no such target", which the command turns into its own `404`.
 */

export const AUDIT_SERVICE = 'audit-service';

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

const auditTargetSchema = z
  .object({
    id: z.string().min(1).max(64),
    organizationId: z.string().min(1).max(128).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** A correction target, as audit-service proved it. */
export interface AuditTarget {
  readonly id: string;
  /** `null` only for a genuinely platform-scoped record. */
  readonly organizationId: string | null;
  readonly occurredAt: Date;
}

export interface AuditLookupClientOptions {
  /** `AUDIT_SERVICE_URL`. */
  readonly baseUrl: string;
  /** `AUDIT_REQUEST_TIMEOUT_MS` — covers the whole exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

export class AuditLookupClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: AuditLookupClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** The target, or `null` when it does not exist exactly as named. */
  async findTarget(id: string, occurredAt: Date): Promise<AuditTarget | null> {
    const token = await this.options.tokens.issue(SERVICE_NAME, AUDIT_SERVICE, 'SERVICE');

    const url =
      `${this.baseUrl}/v1/internal/audit-events/${encodeURIComponent(id)}` +
      `?occurredAt=${encodeURIComponent(occurredAt.toISOString())}`;

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

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
      } catch {
        // No cause attached: a runtime's transport error can quote the URL.
        throw controller.signal.aborted
          ? RastaError.upstreamTimeout(AUDIT_SERVICE, this.options.timeoutMs)
          : RastaError.upstreamUnavailable(AUDIT_SERVICE);
      }

      if (response.status === 404) return null;
      if (response.status !== 200) throw RastaError.upstreamUnavailable(AUDIT_SERVICE);

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw controller.signal.aborted
          ? RastaError.upstreamTimeout(AUDIT_SERVICE, this.options.timeoutMs)
          : RastaError.upstreamUnavailable(AUDIT_SERVICE);
      }

      const parsed = auditTargetSchema.safeParse(body);
      if (!parsed.success) throw RastaError.upstreamUnavailable(AUDIT_SERVICE);

      // Exactly the record named, or no record at all.
      const answeredAt = new Date(parsed.data.occurredAt);
      if (parsed.data.id !== id || answeredAt.getTime() !== occurredAt.getTime()) return null;

      return { id: parsed.data.id, organizationId: parsed.data.organizationId, occurredAt };
    } finally {
      clearTimeout(timer);
    }
  }
}

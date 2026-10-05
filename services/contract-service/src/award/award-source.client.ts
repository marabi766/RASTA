import { z } from 'zod';
import { RastaError, tryGetContext, type InternalTokenService } from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';
import { awardFactSchema, type AwardFact } from './award-confirm';

/**
 * Asks the owner of an award what it recorded (ADR-061 § 4, ADR-068 § 3).
 *
 * ## Why a contract cannot take the event's word
 *
 * A Kafka envelope is written entirely by its publisher, and the broker does not yet
 * authenticate publishers. Anything that reaches it can publish `TENDER_AWARDED` for any
 * organization. And the event carries no amount at all, on purpose (#199). So before a
 * contract is drafted, the award is read from the service that owns it, and the contract
 * is made from **that** answer.
 *
 * ## The boundary
 *
 * `GET {CONSTRUCTION_SERVICE_URL}/v1/tenders/{tenderId}/award`: REST to the owner, never
 * its database (A-01/A-02), and no import from its source tree. The response shape is
 * declared on this side of the wire (`award-confirm.ts`).
 *
 * ## Authentication (ADR-020, ADR-035)
 *
 * A fresh `SERVICE` internal token per call, minted for exactly construction-service and
 * **signed with the organization the event names** — the tender's owner. The owner reads
 * the award inside that organization only, so an event that names the wrong one finds
 * nothing. The organization travels in the signature, never in a header, because a header
 * is exactly the kind of claim this exists to stop trusting. Construction-service admits
 * only `contract-service` on this route and audits each read as `READ_AWARD`.
 *
 * ## Three answers, and only three
 *
 * - the award, parsed against the declared shape;
 * - `null`: the owner answered `404` **with the platform error body naming the resource
 *   it was asked for** (`{ code: 'NOT_FOUND', message: 'Tender not found' }`, or
 *   `'TenderAward not found'`), meaning no such award in that organization. Any other
 *   `404` (a route missing during a rolling deploy, a wrong base path, a proxy) proves
 *   nothing about the award and is treated as unavailable;
 * - a thrown `UPSTREAM_UNAVAILABLE` or `UPSTREAM_TIMEOUT` for everything else: transport
 *   errors, timeouts, a `403` from a misconfigured allowlist, a `5xx`, a body that does not
 *   parse or is too large. The consumer retries those and never acts on them. Fail
 *   closed: an owner that cannot be asked never means yes.
 *
 * Nothing from a failure leaks into the error (no URL, token, body or status), because the
 * error ends up in a DLQ header.
 */

export const CONSTRUCTION_SERVICE = 'construction-service';

/** The award view is a few hundred bytes; anything near this is not the contract. */
export const MAX_AWARD_BYTES = 16 * 1024;

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/** What the consumer depends on. An interface so a test can stand in for construction-service. */
export interface AwardSource {
  /** The award of a tender as its owner records it, or `null` when there is none. */
  award(organizationId: string, tenderId: string): Promise<AwardFact | null>;
}

export interface AwardSourceClientOptions {
  /** `CONSTRUCTION_SERVICE_URL`. */
  readonly baseUrl: string;
  /** `CONTRACT_AWARD_REQUEST_TIMEOUT_MS`: the whole exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

/** The resource types the owner names when it has no such award. */
const ABSENT_RESOURCES = ['Tender', 'TenderAward'] as const;

export class AwardSourceClient implements AwardSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AwardSourceClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async award(organizationId: string, tenderId: string): Promise<AwardFact | null> {
    const token = await this.options.tokens.issue(
      SERVICE_NAME,
      CONSTRUCTION_SERVICE,
      'SERVICE',
      organizationId,
    );

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
        ? RastaError.upstreamTimeout(CONSTRUCTION_SERVICE, this.options.timeoutMs)
        : RastaError.upstreamUnavailable(CONSTRUCTION_SERVICE);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.options.baseUrl.replace(/\/+$/, '')}/v1/tenders/${encodeURIComponent(tenderId)}/award`,
          { method: 'GET', headers, signal: controller.signal },
        );
      } catch {
        // No cause attached: a runtime's transport error can quote the URL.
        throw failed();
      }

      if (response.status !== 200 && response.status !== 404) {
        await response.body?.cancel().catch(() => undefined);
        throw RastaError.upstreamUnavailable(CONSTRUCTION_SERVICE);
      }

      let text: string | null;
      try {
        text = await readCapped(response, MAX_AWARD_BYTES);
      } catch {
        throw failed();
      }
      if (text === null) throw RastaError.upstreamUnavailable(CONSTRUCTION_SERVICE);

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw failed();
      }

      if (response.status === 404) {
        // Absence only when the owner's own handler said so, about this kind of record.
        // Unavailable otherwise: retried, never taken as "no".
        if (isAwardNotFound(body)) return null;
        throw RastaError.upstreamUnavailable(CONSTRUCTION_SERVICE);
      }

      const parsed = awardFactSchema.safeParse(body);
      if (!parsed.success) throw RastaError.upstreamUnavailable(CONSTRUCTION_SERVICE);
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The body as text, or `null` once it exceeds `limit` bytes (reading stops). */
export async function readCapped(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The platform's error body for a record the owner looked for and did not find:
 * `RastaError.notFound(resourceType, id)` rendered by the global exception filter. A
 * route-level 404 goes through the same filter with the same code, but its message is
 * Nest's `Cannot GET …`, so the message is what tells the two apart.
 */
const notFoundBodySchema = z.object({ code: z.literal('NOT_FOUND'), message: z.string() });

export function isAwardNotFound(body: unknown): boolean {
  const parsed = notFoundBodySchema.safeParse(body);
  return (
    parsed.success && ABSENT_RESOURCES.some((type) => parsed.data.message === `${type} not found`)
  );
}

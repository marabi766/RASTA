import { InternalHttpClient } from '@rasta/nest-common';
import { z } from 'zod';
import {
  RastaError,
  tryGetContext,
  upstreamExchange,
  type InternalTokenService,
} from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';

/**
 * Asks the owner of a return request what it recorded, and reserves its dispatch there (ADR-048
 * § 2, ADR-061 § 4, A-13; Codex r1 on #336, findings 1 and 2).
 *
 * ## Why a shipment cannot take the operator's word
 *
 * A return shipment names a marketplace request, its order and its buyer, and the buyer then
 * reads the shipment's progress as its return's. Taken on trust, an operator of any organization
 * could record a shipment naming another organization's return. So the request is read from
 * marketplace-service, which owns it, and the shipment is checked against **that** answer
 * (`return-request-check.ts`).
 *
 * ## Why it reserves
 *
 * Until marketplace hears of the shipment (its mirror consumer, later or never), the request reads
 * AUTHORIZED and the buyer could cancel it while the goods are on the road. The reservation is
 * taken under the request's row lock in marketplace — the lock a cancellation takes — so the two
 * never both succeed (Q-133 (5)).
 *
 * ## The boundary
 *
 * `GET {MARKETPLACE_SERVICE_URL}/v1/internal/returns/{id}` and
 * `POST …/v1/internal/returns/{id}/dispatch-reservation`: REST to the owner, never its database
 * (A-01/A-02), and no import from its source tree — the answer's shape is declared here.
 *
 * ## Authentication (ADR-020, ADR-035)
 *
 * A fresh `SERVICE` internal token per call, minted for exactly marketplace-service and **signed
 * with the acting organization** — the supplier the shipment is recorded for. Marketplace answers
 * a request of that supplier only, so a request of anybody else's is simply not found. The
 * organization travels in the signature, never in a header.
 *
 * ## The answers, and only these
 *
 * - the request, parsed against the declared shape;
 * - `null`: marketplace answered `404` **with the platform error body naming a return request**
 *   — no such request of this supplier. Any other `404` (a route missing during a rolling deploy,
 *   a proxy) proves nothing and is unavailable;
 * - for the reservation, `'NOT_DISPATCHABLE'`: `422 BUSINESS_RULE_VIOLATION` — the request is not
 *   AUTHORIZED (any more);
 * - a thrown `UPSTREAM_UNAVAILABLE` or `UPSTREAM_TIMEOUT` for everything else: transport errors,
 *   timeouts, a `403` from a misconfigured allowlist, a `409`, a `5xx`, a body that does not parse
 *   or is too large. Fail closed: an owner that cannot be asked never means yes, and the dispatch
 *   is refused with nothing written.
 *
 * Nothing from a failure leaks into the error (no URL, token, body or status).
 */

export const MARKETPLACE_SERVICE = 'marketplace-service';

/** A request is under 50 lines of ids; anything near this is not the contract. */
export const MAX_RETURN_REQUEST_BYTES = 64 * 1024;

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The request as marketplace states it (its `ReturnDispatchSourceView`). Unknown fields ignored. */
export const returnRequestFactSchema = z.object({
  returnRequestId: z.string().min(1),
  orderId: z.string().min(1),
  buyerOrganizationId: z.string().min(1),
  supplierOrganizationId: z.string().min(1),
  status: z.string().min(1),
  lines: z
    .array(
      z.object({
        orderLineId: z.string().min(1),
        productId: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  /** The reservation a shipment is recorded under (Q-133 (9)(a)); `null` while none stands. */
  dispatchReservationId: z.string().nullable(),
  dispatchReservedAt: z.string().nullable(),
  partialDispatchAllowed: z.boolean(),
});
export type ReturnRequestFact = z.infer<typeof returnRequestFactSchema>;

/** What the dispatch depends on. An interface so a test can stand in for marketplace-service. */
export interface ReturnRequestSource {
  /** The request as its owner records it, or `null` when the supplier has no such request. */
  read(supplierOrganizationId: string, returnRequestId: string): Promise<ReturnRequestFact | null>;
  /**
   * Reserves the request's dispatch: the request as it then stands, `null` when the supplier has
   * no such request, `'NOT_DISPATCHABLE'` when it is not AUTHORIZED.
   */
  reserve(
    supplierOrganizationId: string,
    returnRequestId: string,
  ): Promise<ReturnRequestFact | null | 'NOT_DISPATCHABLE'>;
}

/** Nest's injection token for {@link ReturnRequestSource}. */
export const RETURN_REQUEST_SOURCE = Symbol('RETURN_REQUEST_SOURCE');

export interface ReturnRequestSourceClientOptions {
  /** `MARKETPLACE_SERVICE_URL`. */
  readonly baseUrl: string;
  /** `INVENTORY_MARKETPLACE_REQUEST_TIMEOUT_MS`: one exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

export class ReturnRequestSourceClient implements ReturnRequestSource {
  /** Absent: internalFetch's own fetch, the only raw one (Q-155 boundary). */
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(private readonly options: ReturnRequestSourceClientOptions) {
    this.fetchImpl = options.fetch;
  }

  async read(supplierOrganizationId: string, returnRequestId: string) {
    const answer = await this.exchange('GET', supplierOrganizationId, returnRequestId, '');
    if (answer.status === 422) throw RastaError.upstreamUnavailable(MARKETPLACE_SERVICE);
    return answer.fact;
  }

  async reserve(supplierOrganizationId: string, returnRequestId: string) {
    const answer = await this.exchange(
      'POST',
      supplierOrganizationId,
      returnRequestId,
      '/dispatch-reservation',
    );
    return answer.status === 422 ? ('NOT_DISPATCHABLE' as const) : answer.fact;
  }

  private async exchange(
    method: 'GET' | 'POST',
    organizationId: string,
    returnRequestId: string,
    suffix: string,
  ): Promise<{ status: 200 | 404 | 422; fact: ReturnRequestFact | null }> {
    const sender = await new InternalHttpClient(this.options.tokens, this.fetchImpl).authorize({
      from: SERVICE_NAME,
      to: MARKETPLACE_SERVICE,
      purpose: 'SERVICE',
      organizationId,
    });
    const headers: Record<string, string> = { accept: 'application/json' };
    const context = tryGetContext();
    if (context && SAFE_CORRELATION_ID.test(context.correlationId)) {
      headers['x-correlation-id'] = context.correlationId;
    }

    return upstreamExchange(
      MARKETPLACE_SERVICE,
      this.options.timeoutMs,
      (signal) =>
        sender.send(
          `${this.options.baseUrl.replace(/\/+$/, '')}/v1/internal/returns/${encodeURIComponent(returnRequestId)}${suffix}`,
          { method, headers, signal },
        ),
      async (response) => {
        const status = response.status;
        if (status !== 200 && status !== 404 && status !== 422) {
          throw RastaError.upstreamUnavailable(MARKETPLACE_SERVICE);
        }

        const text = await readCapped(response, MAX_RETURN_REQUEST_BYTES);
        if (text === null) throw RastaError.upstreamUnavailable(MARKETPLACE_SERVICE);
        const body: unknown = JSON.parse(text);

        if (status === 404) {
          // Absence only when the owner's own handler said so, about a return request.
          if (isReturnRequestNotFound(body)) return { status, fact: null };
          throw RastaError.upstreamUnavailable(MARKETPLACE_SERVICE);
        }
        if (status === 422) {
          if (isBusinessRuleRefusal(body)) return { status, fact: null };
          throw RastaError.upstreamUnavailable(MARKETPLACE_SERVICE);
        }

        const parsed = returnRequestFactSchema.safeParse(body);
        // An answer about another request is no answer about this one.
        if (!parsed.success || parsed.data.returnRequestId !== returnRequestId) {
          throw RastaError.upstreamUnavailable(MARKETPLACE_SERVICE);
        }
        return { status, fact: parsed.data };
      },
    );
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
 * `RastaError.notFound('ReturnRequest', id)` rendered by the global exception filter. A route-level
 * 404 goes through the same filter with the same code, but its message is Nest's `Cannot GET …`,
 * so the message is what tells the two apart.
 */
const errorBodySchema = z.object({ code: z.string(), message: z.string() });

export function isReturnRequestNotFound(body: unknown): boolean {
  const parsed = errorBodySchema.safeParse(body);
  return (
    parsed.success &&
    parsed.data.code === 'NOT_FOUND' &&
    parsed.data.message === 'ReturnRequest not found'
  );
}

function isBusinessRuleRefusal(body: unknown): boolean {
  const parsed = errorBodySchema.safeParse(body);
  return parsed.success && parsed.data.code === 'BUSINESS_RULE_VIOLATION';
}

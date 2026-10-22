import { z } from 'zod';
import { RastaError, tryGetContext, type InternalTokenService } from '@rasta/nest-common';
import { readCapped } from '../award/award-source.client';
import { SERVICE_NAME } from '../config/env';
import { obligationFactSchema, type ObligationFact } from './obligation-confirm';

/**
 * Asks economic-service what it holds for a statement's obligation (ADR-068 § 6 (3), ADR-061 § 4).
 *
 * ## Why a statement cannot take the event's word
 *
 * `SETTLEMENT_COMPLETED` is written entirely by its publisher, and the broker does not yet
 * authenticate publishers: anything that reaches it can publish one for any organization. A SETTLED
 * statement says its money was paid (I5), so before one is, the obligation is read from the service
 * that owns it and the statement is settled from **that** answer.
 *
 * ## The boundary
 *
 * `GET {ECONOMIC_SERVICE_URL}/v1/internal/obligations/by-source/STATEMENT/{statementId}` (#340): REST
 * to the owner, never its database (A-01/A-02), and no import from its source tree. The response
 * shape is declared on this side of the wire (`obligation-confirm.ts`).
 *
 * ## Authentication (ADR-020, ADR-035)
 *
 * A fresh `SERVICE` internal token per call, minted for exactly economic-service and **signed with
 * the employer's organization** — the statement's tenant, the obligation's payer. economic reads the
 * obligation inside that organization only, so a statement of another finds nothing. The token goes
 * in `X-Internal-Token` with no `Authorization`, and the organization travels in its signature,
 * never in a header. economic admits only `contract-service` on this route.
 *
 * ## Three answers, and only three
 *
 * - the obligation, parsed against the declared shape;
 * - `null`: economic answered `404` **with its own `{ code: 'NOT_FOUND', message: 'Obligation not
 *   found' }`** — no obligation for that statement and payer. Any other `404` (a route missing during
 *   a rolling deploy, a wrong base path, a proxy) proves nothing and is treated as unavailable;
 * - a thrown `UPSTREAM_UNAVAILABLE` or `UPSTREAM_TIMEOUT` for everything else: transport errors,
 *   timeouts, a `403` from a misconfigured allowlist, a `5xx`, a body that does not parse or is too
 *   large. The consumer retries those and never acts on them. Fail closed: an owner that cannot be
 *   asked never means paid.
 *
 * Nothing from a failure leaks into the error (no URL, token, body or status): the error ends up in a
 * DLQ header.
 */

export const ECONOMIC_SERVICE = 'economic-service';

/** The obligation view is a few hundred bytes; anything near this is not the contract. */
export const MAX_OBLIGATION_BYTES = 16 * 1024;

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/** What the consumer depends on. An interface so a test can stand in for economic-service. */
export interface ObligationSource {
  /** economic's obligation for a statement of `organizationId`, or `null` when there is none. */
  obligation(organizationId: string, statementId: string): Promise<ObligationFact | null>;
}

export interface ObligationSourceClientOptions {
  /** `ECONOMIC_SERVICE_URL`. */
  readonly baseUrl: string;
  /** `CONTRACT_SETTLEMENT_REQUEST_TIMEOUT_MS`: the whole exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

export class ObligationSourceClient implements ObligationSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ObligationSourceClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async obligation(organizationId: string, statementId: string): Promise<ObligationFact | null> {
    const token = await this.options.tokens.issue(
      SERVICE_NAME,
      ECONOMIC_SERVICE,
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
        ? RastaError.upstreamTimeout(ECONOMIC_SERVICE, this.options.timeoutMs)
        : RastaError.upstreamUnavailable(ECONOMIC_SERVICE);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.options.baseUrl.replace(/\/+$/, '')}/v1/internal/obligations/by-source/STATEMENT/${encodeURIComponent(statementId)}`,
          { method: 'GET', headers, signal: controller.signal },
        );
      } catch {
        // No cause attached: a runtime's transport error can quote the URL.
        throw failed();
      }

      if (response.status !== 200 && response.status !== 404) {
        await response.body?.cancel().catch(() => undefined);
        throw RastaError.upstreamUnavailable(ECONOMIC_SERVICE);
      }

      let text: string | null;
      try {
        text = await readCapped(response, MAX_OBLIGATION_BYTES);
      } catch {
        throw failed();
      }
      if (text === null) throw RastaError.upstreamUnavailable(ECONOMIC_SERVICE);

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw failed();
      }

      if (response.status === 404) {
        // Absence only when economic's own handler said so, about an obligation. Unavailable
        // otherwise: retried, never taken as "no".
        if (isObligationNotFound(body)) return null;
        throw RastaError.upstreamUnavailable(ECONOMIC_SERVICE);
      }

      const parsed = obligationFactSchema.safeParse(body);
      if (!parsed.success) throw RastaError.upstreamUnavailable(ECONOMIC_SERVICE);
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * economic's error body for an obligation it looked for and did not find: `RastaError.notFound(
 * 'Obligation')` rendered by the platform's exception filter. A route-level 404 goes through the same
 * filter with the same code, but its message is Nest's `Cannot GET …`, so the message tells the two
 * apart.
 */
const notFoundBodySchema = z.object({ code: z.literal('NOT_FOUND'), message: z.string() });

export function isObligationNotFound(body: unknown): boolean {
  const parsed = notFoundBodySchema.safeParse(body);
  return parsed.success && parsed.data.message === 'Obligation not found';
}

import { InternalHttpClient } from '@rasta/nest-common';
import { Logger } from '@nestjs/common';
import {
  ExchangeDeadlineError,
  RastaError,
  exchangeWithDeadline,
  tryGetContext,
  type InternalTokenService,
} from '@rasta/nest-common';
import { z } from 'zod';
import { isoDateTime } from '@rasta/contracts';
import { SERVICE_NAME } from '../config/env';

/**
 * Asks the owner of a return's goods — inventory-service (ADR-048 § 2, A-13) — what it recorded,
 * and, for a reconciliation, to withdraw one dispatch reservation (Codex r1 on #339, findings 2
 * and 3; PM ruling on Q-133 (9)(a)).
 *
 * ## The two questions
 *
 * - **Is there a shipment for this request?** Asked before an AUTHORIZED request is cancelled: a
 *   request authorized before the dispatch reservation existed — or whose inventory dispatched it
 *   without one — may have goods on the road that this service never heard of (its mirror off or
 *   behind). Only inventory knows. A new dispatch cannot slip in after the answer: it must reserve
 *   here first, under the row lock the cancellation then takes.
 * - **Withdraw this reservation.** Asked by a reconciliation of a reserved request. Inventory,
 *   under its own lock, either names the shipment that exists for the request, or records the
 *   reservation id as withdrawn — after which a dispatch carrying that id is refused there, however
 *   late it arrives. Only that definite "withdrawn" lets this service clear the reservation.
 *
 * `GET {INVENTORY_SERVICE_URL}/v1/internal/return-requests/{id}/return-shipment` and
 * `POST …/v1/internal/return-requests/{id}/dispatch-withdrawal` (`{ reservationId }`): REST to the
 * owner, never its database (A-01/A-02), and no import from its source tree.
 *
 * ## Authentication (ADR-020, ADR-035)
 *
 * A fresh `SERVICE` internal token per call, minted for exactly inventory-service and **signed for
 * the request's supplier** — the organization whose books hold the shipment. The organization
 * travels in the signature, never in a header.
 *
 * ## Fail closed
 *
 * Only a `200` whose body parses against the declared shape and names the request (and the
 * reservation) asked about is an answer. Every other outcome — a transport error, the timeout
 * (which covers the body), any other status (a `404` from a route missing in a rolling deploy
 * included), a body too large or malformed — is `UPSTREAM_UNAVAILABLE` (503) or `UPSTREAM_TIMEOUT`
 * (504), and the cancellation or reconciliation it was asked for writes nothing. "Could not
 * confirm there is no shipment" is never read as "there is none".
 */

export const INVENTORY_SERVICE = 'inventory-service';

/** An answer is a few ids and a timestamp; anything near this is not the contract. */
export const MAX_GOODS_ANSWER_BYTES = 4 * 1024;

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const shipmentSchema = z.object({ id: z.string().min(1), status: z.string().min(1) });

const shipmentAnswerSchema = z.object({
  returnRequestId: z.string().min(1),
  returnShipment: shipmentSchema.nullable(),
});

const withdrawalAnswerSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('WITHDRAWN'),
    returnRequestId: z.string().min(1),
    reservationId: z.string().min(1),
    withdrawnAt: z.string().check(isoDateTime({ offset: true })),
    returnShipment: z.null(),
  }),
  z.object({
    outcome: z.literal('DISPATCHED'),
    returnRequestId: z.string().min(1),
    reservationId: z.string().min(1),
    withdrawnAt: z.null(),
    returnShipment: shipmentSchema,
  }),
]);

/** The shipment inventory recorded for a request: its id and status. */
export type GoodsShipment = z.infer<typeof shipmentSchema>;

/** Inventory's answer to a withdrawal: the reservation is fenced, or goods exist for the request. */
export type WithdrawalAnswer =
  | { outcome: 'WITHDRAWN'; withdrawnAt: Date }
  | { outcome: 'DISPATCHED'; returnShipment: GoodsShipment };

/** What the cancellation and the reconciliation depend on. An interface so a test can stand in. */
export interface ReturnGoodsOwner {
  /** The request's shipment, or `null` when inventory definitely has none. */
  shipmentOf(
    supplierOrganizationId: string,
    returnRequestId: string,
  ): Promise<GoodsShipment | null>;
  /** Withdraws one reservation, unless a shipment exists for the request. */
  withdraw(
    supplierOrganizationId: string,
    returnRequestId: string,
    reservationId: string,
  ): Promise<WithdrawalAnswer>;
}

/** Nest's injection token for {@link ReturnGoodsOwner}. */
export const RETURN_GOODS_OWNER = Symbol('RETURN_GOODS_OWNER');

export interface ReturnGoodsClientOptions {
  /** `INVENTORY_SERVICE_URL`. */
  readonly baseUrl: string;
  /** `MARKETPLACE_INVENTORY_REQUEST_TIMEOUT_MS`: one exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

export class ReturnGoodsClient implements ReturnGoodsOwner {
  private readonly logger = new Logger(ReturnGoodsClient.name);
  /** Absent: internalFetch's own fetch, the only raw one (Q-155 boundary). */
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(private readonly options: ReturnGoodsClientOptions) {
    this.fetchImpl = options.fetch;
  }

  async shipmentOf(supplierOrganizationId: string, returnRequestId: string) {
    const body = await this.exchange(
      'GET',
      supplierOrganizationId,
      `${encodeURIComponent(returnRequestId)}/return-shipment`,
      undefined,
    );
    const parsed = shipmentAnswerSchema.safeParse(body);
    // An answer about another request is no answer about this one.
    if (!parsed.success || parsed.data.returnRequestId !== returnRequestId) {
      throw this.refused('a shipment answer that is not the contract');
    }
    return parsed.data.returnShipment;
  }

  async withdraw(
    supplierOrganizationId: string,
    returnRequestId: string,
    reservationId: string,
  ): Promise<WithdrawalAnswer> {
    const body = await this.exchange(
      'POST',
      supplierOrganizationId,
      `${encodeURIComponent(returnRequestId)}/dispatch-withdrawal`,
      { reservationId },
    );
    const parsed = withdrawalAnswerSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.returnRequestId !== returnRequestId ||
      parsed.data.reservationId !== reservationId
    ) {
      throw this.refused('a withdrawal answer that is not the contract');
    }
    return parsed.data.outcome === 'WITHDRAWN'
      ? { outcome: 'WITHDRAWN', withdrawnAt: new Date(parsed.data.withdrawnAt) }
      : { outcome: 'DISPATCHED', returnShipment: parsed.data.returnShipment };
  }

  /** One exchange under one deadline (headers, body, parse); the parsed JSON of a `200`, only. */
  private async exchange(
    method: 'GET' | 'POST',
    organizationId: string,
    path: string,
    payload: Record<string, string> | undefined,
  ): Promise<unknown> {
    const sender = await new InternalHttpClient(this.options.tokens, this.fetchImpl).authorize({
      from: SERVICE_NAME,
      to: INVENTORY_SERVICE,
      purpose: 'SERVICE',
      organizationId,
    });
    const headers: Record<string, string> = { accept: 'application/json' };
    if (payload) headers['content-type'] = 'application/json';
    const context = tryGetContext();
    if (context && SAFE_CORRELATION_ID.test(context.correlationId)) {
      headers['x-correlation-id'] = context.correlationId;
    }

    try {
      return await exchangeWithDeadline(
        this.options.timeoutMs,
        (signal) =>
          sender.send(
            `${this.options.baseUrl.replace(/\/+$/, '')}/v1/internal/return-requests/${path}`,
            {
              method,
              headers,
              signal,
              ...(payload ? { body: JSON.stringify(payload) } : {}),
            },
          ),
        async (response) => {
          if (response.status !== 200) throw this.refused(`status ${response.status}`);
          const text = await readCapped(response, MAX_GOODS_ANSWER_BYTES);
          if (text === null) throw this.refused('a body larger than the contract');
          try {
            return JSON.parse(text) as unknown;
          } catch {
            throw this.refused('a body that is not JSON');
          }
        },
      );
    } catch (error) {
      if (error instanceof ExchangeDeadlineError) {
        throw RastaError.upstreamTimeout(INVENTORY_SERVICE, this.options.timeoutMs);
      }
      if (error instanceof RastaError) throw error;
      // No cause attached: a runtime's transport error can quote the URL.
      throw this.refused('no answer');
    }
  }

  private refused(why: string): RastaError {
    this.logger.warn(`inventory-service gave ${why}; refusing (fail closed)`);
    return RastaError.upstreamUnavailable(INVENTORY_SERVICE);
  }
}

/** The body as text, or `null` once it exceeds `limit` bytes (reading stops). */
async function readCapped(response: Response, limit: number): Promise<string | null> {
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

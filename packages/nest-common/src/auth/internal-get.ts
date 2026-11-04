import { InternalHttpClient, type InternalTokenService } from '../http/internal-http-client';
import { tryGetContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';
import { readCappedText } from '../http/bounded-body';
import { upstreamExchange } from '../http/exchange-deadline';

/** The default byte ceiling of an internal answer (PR #722 r1 F1). */
export const INTERNAL_GET_MAX_BYTES = 1024 * 1024;

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface InternalGetOptions {
  /** The calling service (the token's issuer). */
  readonly from: string;
  /** The service asked (the token's audience); also what an error names. */
  readonly to: string;
  readonly baseUrl: string;
  /** One exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Byte ceiling of the body, decoded; past it the read is `UPSTREAM_UNAVAILABLE`. */
  readonly maxBodyBytes?: number;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

export interface InternalGetResult {
  readonly status: number;
  /** Parsed JSON, or `undefined` when the body was not JSON. */
  readonly body: unknown;
}

/**
 * One authenticated read of another service's `/v1/internal/…` route (ADR-061
 * § 4): a fresh `SERVICE` token signed with `organizationId`, a deadline over
 * the whole exchange, and nothing from a failure in the error — a runtime's
 * transport error can quote the URL, so none is attached.
 *
 * Plumbing only. The caller decides what a status means; a transport failure
 * or a timeout is an `UPSTREAM_*` error, which a consumer's handler turns into
 * a retry and, past its limit, a dead letter.
 */
export async function internalGet(
  options: InternalGetOptions,
  path: string,
  organizationId: string,
): Promise<InternalGetResult> {
  const sender = await new InternalHttpClient(options.tokens, options.fetch).authorize({
    from: options.from,
    to: options.to,
    purpose: 'SERVICE',
    organizationId,
  });
  const headers: Record<string, string> = { accept: 'application/json' };
  const context = tryGetContext();
  if (context && SAFE_CORRELATION_ID.test(context.correlationId)) {
    headers['x-correlation-id'] = context.correlationId;
  }

  const { status, text } = await upstreamExchange(
    options.to,
    options.timeoutMs,
    (signal) =>
      sender.send(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'GET',
        headers,
        signal,
      }),
    async (response) => {
      const body = await readCappedText(response, options.maxBodyBytes ?? INTERNAL_GET_MAX_BYTES);
      if (body === null) throw RastaError.upstreamUnavailable(options.to);
      return { status: response.status, text: body };
    },
  );
  return { status, body: parseJson(text) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

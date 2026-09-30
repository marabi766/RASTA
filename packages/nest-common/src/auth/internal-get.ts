import { tryGetContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';
import type { InternalTokenService } from './token-verifier';

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
  const token = await options.tokens.issue(options.from, options.to, 'SERVICE', organizationId);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-internal-token': token,
  };
  const context = tryGetContext();
  if (context && SAFE_CORRELATION_ID.test(context.correlationId)) {
    headers['x-correlation-id'] = context.correlationId;
  }

  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    if (controller.signal.aborted) throw new Error('deadline passed');
    return { status: response.status, body: parseJson(text) };
  } catch {
    throw controller.signal.aborted
      ? RastaError.upstreamTimeout(options.to, options.timeoutMs)
      : RastaError.upstreamUnavailable(options.to);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

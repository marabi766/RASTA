import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '../context/request-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';
export const TRACEPARENT_HEADER = 'traceparent';

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface MinimalResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Establishes the request context for everything downstream.
 *
 * Runs as middleware rather than as an interceptor because middleware wraps
 * the *entire* remaining pipeline: guards, pipes, the handler and the exception
 * filter all see the same async context. An interceptor runs after guards, so
 * the auth guard would have nowhere to record the resolved tenant.
 *
 * The context starts anonymous and is upgraded once the auth guard has
 * verified the token — see `upgradeContext`.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: MinimalRequest, res: MinimalResponse, next: () => void): void {
    const correlationId = readHeader(req, CORRELATION_ID_HEADER) ?? ulid();
    const requestId = ulid();
    const { traceId, spanId } = parseTraceparent(readHeader(req, TRACEPARENT_HEADER));

    const context: RequestContext = {
      correlationId,
      requestId,
      traceId,
      spanId,
      roles: [],
      authType: 'ANONYMOUS',
      ip: req.ip ?? req.socket?.remoteAddress,
      userAgent: readHeader(req, 'user-agent'),
      method: req.method,
      path: req.originalUrl ?? req.url,
      startedAt: Date.now(),
    };

    // Echo both back so a user reporting a problem can quote one identifier
    // and an operator can find the request, the events it produced and the
    // ledger entries that followed.
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    if (traceId) res.setHeader('x-trace-id', traceId);

    runWithContext(context, () => next());
  }
}

function readHeader(req: MinimalRequest, name: string): string | undefined {
  const raw = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Parses a W3C `traceparent` header: `00-<32 hex trace>-<16 hex span>-<flags>`.
 *
 * Returns nothing for a malformed value rather than throwing — a broken trace
 * header from some intermediary should degrade observability, never reject the
 * request.
 */
export function parseTraceparent(header: string | undefined): {
  traceId?: string;
  spanId?: string;
} {
  if (!header) return {};

  const parts = header.split('-');
  if (parts.length < 4) return {};

  const [version, traceId, spanId] = parts;
  if (version !== '00') return {};
  if (!traceId || !/^[0-9a-f]{32}$/.test(traceId) || traceId === '0'.repeat(32)) return {};
  if (!spanId || !/^[0-9a-f]{16}$/.test(spanId) || spanId === '0'.repeat(16)) return {};

  return { traceId, spanId };
}

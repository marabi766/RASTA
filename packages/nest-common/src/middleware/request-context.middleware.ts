import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '../context/request-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';
export const TRACEPARENT_HEADER = 'traceparent';

/** Bounds an adopted correlation id; the longest the platform mints is well under it. */
export const CORRELATION_ID_MAX_LENGTH = 128;

/** Crockford base32, as `ULID_REGEX` in `@rasta/contracts` — what `ulid()` emits. */
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
/** What `randomUUID()` emits (the web app's ids). */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * The shapes the platform mints: a ULID or a UUID, optionally behind labels —
 * `COR_<ULID>`, `e2e-<UUID>`, `maintenance-due-MSC_<ULID>`. The random tail
 * is what makes it an identifier; a header without one is not one of ours.
 */
const WELL_FORMED_CORRELATION_ID = new RegExp(`^(?:[A-Za-z0-9]+[-_])*(?:${ULID}|${UUID})$`);

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
    const correlationId = adoptedCorrelationId(readHeader(req, CORRELATION_ID_HEADER)) ?? ulid();
    const requestId = ulid();
    const { traceId, spanId } = parseTraceparent(readHeader(req, TRACEPARENT_HEADER));
    const target = req.originalUrl ?? req.url;

    const context: RequestContext = {
      correlationId,
      requestId,
      traceId,
      spanId,
      roles: [],
      // An unauthenticated request asserts no memberships. The auth guard
      // replaces this with the token's set once it has verified one; until
      // then "no memberships" is the honest answer, and the safe one.
      organizationIds: [],
      authType: 'ANONYMOUS',
      ip: req.ip ?? req.socket?.remoteAddress,
      userAgent: readHeader(req, 'user-agent'),
      method: req.method,
      // The path only: it reaches every error body and its log line, and the
      // query is the client's data — a cursor, a search term (S-09).
      path: target === undefined ? undefined : requestPath(target),
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

/**
 * A request target's path, without its query or fragment: `/v1/x?q=1#f` →
 * `/v1/x`.
 *
 * What a request is reported as — `path` in the error envelope, in the
 * exception filter's log line, in Nest's `Cannot GET …` — wherever the
 * report leaves the handler (S-09). Routing reads the request itself, never
 * this.
 */
export function requestPath(target: string): string {
  const end = target.search(/[?#]/);
  return end === -1 ? target : target.slice(0, end);
}

/**
 * Whether `value` has the shape of a correlation id the platform mints.
 *
 * The header is the caller's to set, and whatever is adopted reaches every
 * response header, error body and log line of the request (S-09) — so only
 * an identifier is adopted.
 */
export function isWellFormedCorrelationId(value: string): boolean {
  return value.length <= CORRELATION_ID_MAX_LENGTH && WELL_FORMED_CORRELATION_ID.test(value);
}

/**
 * The incoming correlation id, when it is one; otherwise nothing, and the
 * request gets a fresh id. A refused value is not logged: it is exactly what
 * must not reach a log.
 */
function adoptedCorrelationId(header: string | undefined): string | undefined {
  return header !== undefined && isWellFormedCorrelationId(header) ? header : undefined;
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

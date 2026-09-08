import type { z } from 'zod';
import { ApiFailure, CLIENT_ERROR_CODES, failureFromResponse } from './errors';

/**
 * The one place this application talks to the platform.
 *
 * Nothing else in `apps/web` may call `fetch`. Concentrating it here is what
 * makes the four cross-cutting guarantees checkable in one file rather than
 * hoped for in twenty:
 *
 *  1. **Only the gateway.** Every request resolves against
 *     `NEXT_PUBLIC_API_BASE_URL` and is refused if it lands on another origin.
 *     A browser reaching `localhost:3106` directly would bypass JWT
 *     verification, tenant resolution, rate limiting, correlation and the
 *     circuit breaker — every control ADR-009 puts in the gateway.
 *  2. **Bearer token from the live session**, read at call time, never stored
 *     here.
 *  3. **`X-Organization-Id` only after a membership check.** The header is
 *     unsigned and the gateway re-validates it (ADR-035); sending one this
 *     client knows to be wrong would simply produce a `403` the user cannot
 *     act on.
 *  4. **A correlation id on every request**, so a support conversation can
 *     start with an identifier instead of a description.
 */

export interface SessionSnapshot {
  readonly accessToken: string;
  /** The organization the user has selected, or `null` before they choose. */
  readonly organizationId: string | null;
  /** The signed `org_ids` claim — the authoritative membership set. */
  readonly organizationIds: readonly string[];
}

export type SessionReader = () => SessionSnapshot | null;

export interface GatewayRequest<T> {
  /** Gateway path including the version segment, e.g. `/v1/products`. */
  readonly path: `/v1/${string}`;
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /**
   * The contract this response must satisfy.
   *
   * Required, not optional. An unvalidated response is a promise that the
   * backend has not changed since this build, and the failure mode is a page
   * rendering `undefined` where a price should be.
   */
  readonly schema: z.ZodType<T>;
  readonly signal?: AbortSignal;
  /**
   * Required by the gateway for anything with a financial or irreversible
   * effect (docs/06 § 6.8). Unused by this milestone, which only reads.
   */
  readonly idempotencyKey?: string;
}

export interface GatewayResult<T> {
  readonly data: T;
  readonly correlationId: string;
  readonly status: number;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly session: SessionReader;
  readonly fetchImpl?: typeof fetch;
  readonly newCorrelationId?: () => string;
}

export class ApiClient {
  private readonly base: URL;
  private readonly session: SessionReader;
  private readonly fetchImpl: typeof fetch;
  private readonly newCorrelationId: () => string;

  constructor(options: ApiClientOptions) {
    this.base = new URL(options.baseUrl);
    this.session = options.session;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.newCorrelationId = options.newCorrelationId ?? defaultCorrelationId;
  }

  async request<T>(request: GatewayRequest<T>): Promise<GatewayResult<T>> {
    const correlationId = this.newCorrelationId();
    const url = this.resolve(request, correlationId);
    const session = this.session();

    if (!session) {
      throw new ApiFailure({
        code: CLIENT_ERROR_CODES.NO_SESSION,
        status: null,
        correlationId,
      });
    }

    const organizationId = this.resolveTenant(session, correlationId);

    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${session.accessToken}`,
      'x-correlation-id': correlationId,
    });
    if (organizationId) headers.set('x-organization-id', organizationId);
    if (request.body !== undefined) headers.set('content-type', 'application/json');
    if (request.idempotencyKey) headers.set('idempotency-key', request.idempotencyKey);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: request.method ?? 'GET',
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: request.signal,
        // The gateway authenticates with a bearer token, not a cookie. Sending
        // credentials would widen the CSRF surface for nothing.
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiFailure({
        code: CLIENT_ERROR_CODES.NETWORK_UNAVAILABLE,
        status: null,
        correlationId,
      });
    }

    // The gateway echoes the id it actually used. Preferring it over the one
    // sent means the id on screen is the id in the platform's logs even if
    // something in between replaced it.
    const effectiveCorrelationId = response.headers.get('x-correlation-id') || correlationId;
    const payload = await readJson(response);

    if (!response.ok) {
      throw failureFromResponse(response.status, payload, effectiveCorrelationId);
    }

    const parsed = request.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiFailure({
        code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
        status: response.status,
        correlationId: effectiveCorrelationId,
        details: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return { data: parsed.data, correlationId: effectiveCorrelationId, status: response.status };
  }

  /**
   * Builds the target URL and refuses anything that is not the gateway.
   *
   * The check is on the resolved origin rather than on the caller's string,
   * so an absolute URL, a protocol-relative one and a `../` traversal are all
   * caught by the same test.
   */
  private resolve(request: GatewayRequest<unknown>, correlationId: string): URL {
    const url = new URL(`${this.base.pathname.replace(/\/+$/, '')}${request.path}`, this.base);

    if (url.origin !== this.base.origin || !url.pathname.startsWith('/v1/')) {
      throw new ApiFailure({
        code: CLIENT_ERROR_CODES.NON_GATEWAY_TARGET,
        status: null,
        correlationId,
      });
    }

    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    return url;
  }

  /**
   * Decides which organization this request acts for.
   *
   * A selection the token does not back is refused here rather than sent. The
   * gateway would refuse it too — that is the control that matters — but
   * sending it anyway spends a round trip to produce an error the client
   * already had the information to explain.
   */
  private resolveTenant(session: SessionSnapshot, correlationId: string): string | null {
    if (!session.organizationId) return null;

    if (!session.organizationIds.includes(session.organizationId)) {
      throw new ApiFailure({
        code: CLIENT_ERROR_CODES.TENANT_NOT_IN_MEMBERSHIPS,
        status: null,
        correlationId,
      });
    }

    return session.organizationId;
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function defaultCorrelationId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  // jsdom below Node 19 and a handful of older browsers have no randomUUID.
  // Uniqueness matters here for log correlation, not for unpredictability.
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

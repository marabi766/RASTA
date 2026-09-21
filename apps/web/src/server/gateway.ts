import { randomUUID } from 'node:crypto';

/**
 * The only way this portal reaches the platform (ADR-058 § 3, ADR-059 § 3).
 *
 * Everything the browser asks for is fetched by server code, and server code
 * calls exactly one origin: the API Gateway. Every cross-cutting control lives
 * there — JWT verification, tenant resolution, rate limiting, correlation, the
 * circuit breaker — and a request that went straight to a service port would
 * run with none of them.
 *
 * That rule was a sentence in an ADR until now. `refuseForeignOrigin` makes it
 * a function, and `gateway.spec.ts` makes it a test.
 */

export class GatewayOriginError extends Error {
  constructor(attempted: string) {
    super(
      `The portal may only call the API Gateway. Refused: ${attempted}. ` +
        'Every platform control lives at the gateway (ADR-058 § 3).',
    );
    this.name = 'GatewayOriginError';
  }
}

export class GatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly correlationId: string,
  ) {
    super(`The gateway answered ${status}`);
    this.name = 'GatewayRequestError';
  }
}

/**
 * Builds the absolute URL for a gateway path, refusing anything else.
 *
 * Takes a path, never a URL, and still checks the result. A caller that passes
 * `http://localhost:3106/v1/orders` — a service port, which is exactly the
 * mistake this guards — produces an absolute URL that does not sit under the
 * gateway base, and that is refused rather than fetched.
 */
export function gatewayUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const resolved = new URL(path, base);

  const sameOrigin = resolved.origin === base.origin;
  const underBasePath = resolved.pathname.startsWith(base.pathname.replace(/\/+$/, ''));
  if (!sameOrigin || !underBasePath) throw new GatewayOriginError(resolved.toString());

  return resolved.toString();
}

export interface GatewayCall {
  readonly baseUrl: string;
  readonly path: string;
  readonly accessToken: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Reused when the caller already has one; a fresh one otherwise. */
  readonly correlationId?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface GatewayResponse<T> {
  readonly data: T;
  readonly correlationId: string;
}

/**
 * One authenticated call, with the correlation id the platform follows.
 *
 * `cache: 'no-store'`, always. A tenant's data cached by a framework between
 * two people's requests is the worst bug this file could have, and opting out
 * once here is cheaper than remembering it at every call site.
 */
export async function callGateway<T>(call: GatewayCall): Promise<GatewayResponse<T>> {
  const url = gatewayUrl(call.baseUrl, call.path);
  const correlationId = call.correlationId ?? randomUUID();
  const fetchImpl = call.fetchImpl ?? fetch;

  const response = await fetchImpl(url, {
    method: call.method ?? 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${call.accessToken}`,
      'x-correlation-id': correlationId,
      ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    cache: 'no-store',
  });

  if (!response.ok) {
    // The status and the correlation id, and nothing from the body. The body
    // can carry a tenant's data, and this error is rendered to a person —
    // `docs/16 § ۱۶٫۱۱` puts the correlation id in the error state precisely
    // so support can find the rest without the page showing it.
    throw new GatewayRequestError(response.status, correlationId);
  }

  return { data: (await response.json()) as T, correlationId };
}

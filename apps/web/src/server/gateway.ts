import { randomUUID } from 'node:crypto';
import { z } from 'zod';

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

/**
 * The part of a platform error a screen may act on (docs/06 § 6 envelope).
 *
 * Parsed with a schema that keeps four fields and drops the rest, and only
 * when the response says it is JSON. A 4xx body is where a service explains a
 * refusal — which field, and why — and a form that could not read it would
 * have to answer every rejection with the same sentence. What is *not* kept:
 * anything else the body might carry. The same rule as every read module —
 * a field that never enters this process cannot be rendered or logged.
 */
export const gatewayProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z
    .array(z.object({ path: z.string(), message: z.string(), code: z.string().optional() }))
    .optional(),
});

export type GatewayProblem = z.infer<typeof gatewayProblemSchema>;

export class GatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly correlationId: string,
    /** Present when the response carried a well-formed platform error. */
    readonly problem: GatewayProblem | null = null,
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
  /**
   * Sent as `Idempotency-Key`. The gateway requires it on the prefixes whose
   * effects are financial or irreversible (docs/06 § 6.8) and ignores it
   * elsewhere, so a write always sends its submission id and the decision
   * about which routes need one stays where it belongs — in the gateway.
   */
  readonly idempotencyKey?: string;
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
      ...(call.idempotencyKey === undefined ? {} : { 'idempotency-key': call.idempotencyKey }),
    },
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    cache: 'no-store',
  });

  if (!response.ok) {
    // The status, the correlation id, and — for a 4xx that explains itself —
    // the platform error's code, message and field details, through a schema
    // that keeps nothing else. `docs/16 § ۱۶٫۱۱` puts the correlation id in
    // the error state so support can find the rest without the page showing
    // it; a 5xx body is never read at all.
    throw new GatewayRequestError(
      response.status,
      correlationId,
      response.status < 500 ? await readProblem(response) : null,
    );
  }

  return { data: (await response.json()) as T, correlationId };
}

async function readProblem(response: Response): Promise<GatewayProblem | null> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    const parsed = gatewayProblemSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

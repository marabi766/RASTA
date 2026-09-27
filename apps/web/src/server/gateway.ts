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
 * The request may have reached the platform, but no answer it could be judged
 * by came back: the connection failed after it was opened, this portal's own
 * deadline passed, or a 2xx arrived whose body would not parse.
 *
 * A read treats it like any other unavailable gateway — it still *is* a
 * `GatewayRequestError`, with the status it always had. A write must not
 * (Codex post-merge review of #106): the service may have committed, and
 * fleet, for one, keeps no HTTP idempotency ledger, so telling a person that
 * nothing was saved invites a retry that duplicates the effect. `write.ts`
 * turns this into `UNKNOWN_OUTCOME`.
 */
export class GatewayOutcomeUnknownError extends GatewayRequestError {
  constructor(
    status: number,
    correlationId: string,
    readonly reason: 'TRANSPORT' | 'UNREADABLE_BODY',
  ) {
    super(status, correlationId, null);
    this.name = 'GatewayOutcomeUnknownError';
  }
}

/**
 * Connection failures that happen before a single byte of the request is
 * sent — nothing reached the gateway, so the outcome is known: nothing
 * happened. Anything else, including this portal's own deadline, may have
 * been sent, and is treated as unknown. Read from the error and every
 * `cause` below it: undici wraps the socket error as `TypeError('fetch
 * failed', { cause })`.
 */
const NEVER_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function neverSent(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_SENT_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
  /** Overrides {@link GATEWAY_TIMEOUT_MS}. Exists for tests. */
  readonly timeoutMs?: number;
}

/**
 * How long this portal waits on the gateway before giving up.
 *
 * Named rather than left to whatever the hosting runtime happens to enforce
 * (`docs/16 § ۱۶٫۱۱`): an upstream that accepts the connection and then never
 * answers would otherwise hold the request — and a server-render along with
 * it — for as long as the platform's own socket timeout, which is a much
 * longer and much less predictable number than this one.
 */
const GATEWAY_TIMEOUT_MS = 15_000;

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

  let response: Response;
  try {
    response = await fetchImpl(url, {
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
      signal: AbortSignal.timeout(call.timeoutMs ?? GATEWAY_TIMEOUT_MS),
    });
  } catch (error) {
    // A refused connection, a DNS failure, a reset, or this function's own
    // timeout above all reject `fetch` rather than answering it, and none of
    // them carries a platform status. Every read and write module already
    // maps `GatewayRequestError` to a safe outcome; wrapping a transport
    // failure as one here — rather than in each of those modules — is what
    // makes that mapping actually total (`docs/16 § ۱۶٫۱۱`). Only a failure
    // before anything was sent is a plain one; after that, whether the
    // platform acted is unknown.
    if (neverSent(error)) throw new GatewayRequestError(503, correlationId, null);
    throw new GatewayOutcomeUnknownError(503, correlationId, 'TRANSPORT');
  }

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

  // `204 No Content` is a success with nothing to parse, and the platform
  // answers it wherever the result is the absence of something —
  // `POST /v1/memberships/:id/revoke` is `@HttpCode(204)`. Calling `.json()`
  // on an empty body throws `Unexpected end of JSON input`, which would
  // surface as a failed write *after* the service had already succeeded: the
  // membership revoked, the page saying it was not, and a person retrying a
  // thing that already happened. The caller's schema then parses `undefined`,
  // which is what actually came back.
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return { data: undefined as T, correlationId };
  }

  try {
    return { data: (await response.json()) as T, correlationId };
  } catch {
    // A 2xx whose body does not parse is the gateway's contract broken, not
    // something a screen mid-form can be asked to make sense of — but it is
    // still a 2xx: a write it answers has most likely happened.
    throw new GatewayOutcomeUnknownError(502, correlationId, 'UNREADABLE_BODY');
  }
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

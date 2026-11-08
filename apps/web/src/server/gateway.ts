import { randomUUID } from 'node:crypto';
import { refusedBeforeSending } from '@rasta/config';
import { z } from 'zod';

import { readBoundedJson } from './bounded-body';
import { credentialFetch } from './credential-fetch';
import { credentialHeaders, type GatewayCredential } from './session-organization';
import { MAX_REQUEST_TIMEOUT_MS } from './unresolved-request-policy';

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
    /**
     * The response's `Retry-After`, in seconds, when it gave one as a number:
     * the platform's way of saying "this will change if you wait" — an
     * in-flight request with the same Idempotency-Key, an open circuit, a
     * rate limit. `null` when absent or not a plain number.
     */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`The gateway answered ${status}`);
    this.name = 'GatewayRequestError';
  }
}

/**
 * The request may have reached the platform, but no answer it could be judged
 * by came back: the connection failed after it was opened, this portal's own
 * deadline passed, a redirect was refused (`credentialFetch`), or a 2xx
 * arrived whose body would not parse.
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
 * The request provably never left this portal (connection refused, DNS failure
 * …, see `neverSent`; or the transport refused an altered runtime before
 * sending, `refusedBeforeSending`): nothing reached the platform, so nothing happened. A
 * `GatewayRequestError` with status 503 as before — every reader treats it so —
 * but a write can tell it from a 503 that came back from the platform, which
 * may follow a commit (`write.ts` carries it as `neverSent`).
 */
export class GatewayNeverSentError extends GatewayRequestError {
  constructor(correlationId: string) {
    super(503, correlationId, null);
    this.name = 'GatewayNeverSentError';
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
  /**
   * The bearer **and** the organization this call acts for, minted from the
   * session by `tenantCredential` (or, for the person's own record only,
   * `personalCredential`) in `session-organization.ts` — never a bare token.
   * Sent as `Authorization` and `X-Organization-Id`, so the guard acts for the
   * organization the session is pinned to and refuses the call if the token
   * no longer grants it; it is never answered for the token's active
   * organization instead (audit F2, task 118).
   */
  readonly credential: GatewayCredential;
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
  /**
   * Sent as `Idempotency-Replay-Deadline`: the last instant (ms since the epoch) this request may be
   * executed under its key. The owning service compares it with the clock that expires its
   * idempotency record and refuses a later attempt with `409 REPLAY_WINDOW_CLOSED` before it writes
   * anything (PM decision D-065) — the guarantee a clock in this portal can never give. Only with an
   * `idempotencyKey`, and only a positive safe integer; anything else is a programming error.
   */
  readonly replayDeadline?: number;
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
const GATEWAY_TIMEOUT_MS = MAX_REQUEST_TIMEOUT_MS;

/** Byte ceilings of a gateway answer and of a refusal's problem body, decoded (PR #722 r1 F1). */
const MAX_GATEWAY_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PROBLEM_BODY_BYTES = 64 * 1024;

export interface GatewayResponse<T> {
  readonly data: T;
  readonly correlationId: string;
}

const REQUEST_PROPERTIES = new Set([
  'baseUrl',
  'path',
  'credential',
  'method',
  'body',
  'correlationId',
  'idempotencyKey',
  'replayDeadline',
  'fetchImpl',
  'timeoutMs',
]);
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FIELD_TYPES = [
  ['correlationId', 'string'],
  ['idempotencyKey', 'string'],
  ['replayDeadline', 'number'],
  ['timeoutMs', 'number'],
  ['fetchImpl', 'function'],
] as const;
/** What only a write may carry, even as `undefined`. */
const WRITE_PROPERTIES = ['body', 'idempotencyKey', 'replayDeadline'] as const;

/**
 * The request as one snapshot of its own data properties, taken before anything reads it
 * (FU-219): a getter, a proxy trap that runs later, an inherited or unknown property is refused, so
 * nothing the caller's object does can change the method after this decides it. A read is GET with
 * no body, idempotency key or replay deadline (not even `undefined`); a write names its method.
 */
function snapshotRequest(input: GatewayCall, write: boolean): GatewayCall {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const snapshot = Object.create(null) as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(descriptors).length > 0)
    throw new Error('unclassified gateway request property');
  for (const key of Object.getOwnPropertyNames(descriptors)) {
    if (!REQUEST_PROPERTIES.has(key)) throw new Error('unclassified gateway request property');
    const descriptor = descriptors[key]!;
    if (!Object.hasOwn(descriptor, 'value'))
      throw new Error('gateway request needs own data properties');
    snapshot[key] = descriptor.value;
  }
  if (
    typeof snapshot.baseUrl !== 'string' ||
    typeof snapshot.path !== 'string' ||
    !Object.hasOwn(snapshot, 'credential')
  )
    throw new Error('gateway request needs own data properties');
  // What reaches a header or the deadline is a primitive of its type, so no caller code runs later.
  for (const [key, type] of FIELD_TYPES)
    if (snapshot[key] !== undefined && typeof snapshot[key] !== type)
      throw new Error(`gateway request ${key} must be a ${type}`);
  const method = snapshot.method ?? 'GET';
  if (write ? !WRITE_METHODS.has(method as string) : method !== 'GET')
    throw new Error(write ? 'gateway write needs a write method' : 'gateway read sends only GET');
  if (!write && WRITE_PROPERTIES.some((key) => Object.hasOwn(snapshot, key)))
    throw new Error('gateway read refuses write properties');
  snapshot.method = method;
  return Object.freeze(snapshot) as unknown as GatewayCall;
}

/**
 * One authenticated call, with the correlation id the platform follows.
 *
 * `cache: 'no-store'`, always. A tenant's data cached by a framework between
 * two people's requests is the worst bug this file could have, and opting out
 * once here is cheaper than remembering it at every call site.
 */
export async function callGateway<T>(
  input: Omit<GatewayCall, 'method' | 'body' | 'idempotencyKey' | 'replayDeadline'> & {
    readonly method?: 'GET';
  },
): Promise<GatewayResponse<T>> {
  return exchangeGateway<T>(snapshotRequest(input, false));
}

/**
 * Only write.ts may import this entry, enforced by the write-classifier guard (named import,
 * called, never handed on). The limit is static on purpose: a module gives a function no
 * identity for its importer, so a run-time check could prove only that one module holds it.
 */
export async function callGatewayWrite<T>(input: GatewayCall): Promise<GatewayResponse<T>> {
  return exchangeGateway<T>(snapshotRequest(input, true));
}

async function exchangeGateway<T>(call: GatewayCall): Promise<GatewayResponse<T>> {
  // Decide from the snapshot before URL coercion, credential checks or body serialization.
  const method = call.method;
  const url = gatewayUrl(call.baseUrl, call.path);
  // Before anything else: a credential this portal did not mint is refused
  // here, not sent.
  const identity = credentialHeaders(call.credential);
  if (
    call.replayDeadline !== undefined &&
    (call.idempotencyKey === undefined ||
      !Number.isSafeInteger(call.replayDeadline) ||
      call.replayDeadline <= 0)
  ) {
    throw new Error('a replay deadline needs an idempotency key and a positive safe integer');
  }
  const correlationId = call.correlationId ?? randomUUID();
  // Absent: credentialFetch's own fetch, the only raw one (Q-155 boundary).
  const fetchImpl = call.fetchImpl;

  // The timer behind the signal is not the whole deadline: the body is also
  // checked against this instant between chunks (PR #722 r1 F2).
  const timeoutMs = call.timeoutMs ?? GATEWAY_TIMEOUT_MS;
  const deadlineAt = performance.now() + timeoutMs;
  let response: Response;
  try {
    // Never follows a redirect: the bearer token, and a write's key and body,
    // are sent to this URL once and nowhere else (Q-155).
    response = await credentialFetch(
      url,
      {
        method,
        headers: {
          accept: 'application/json',
          ...identity,
          'x-correlation-id': correlationId,
          ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(call.idempotencyKey === undefined ? {} : { 'idempotency-key': call.idempotencyKey }),
          ...(call.replayDeadline === undefined
            ? {}
            : { 'idempotency-replay-deadline': String(call.replayDeadline) }),
        },
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      },
      fetchImpl,
    );
  } catch (error) {
    // A refused connection, a DNS failure, a reset, or this function's own
    // timeout above all reject `fetch` rather than answering it, and none of
    // them carries a platform status. Every read and write module already
    // maps `GatewayRequestError` to a safe outcome; wrapping a transport
    // failure as one here — rather than in each of those modules — is what
    // makes that mapping actually total (`docs/16 § ۱۶٫۱۱`). Only a failure
    // before anything was sent is a plain one; after that, whether the
    // platform acted is unknown. A refused redirect is one of those: the
    // request was sent and answered with a 3xx that says nothing about whether
    // it was applied, so a write it answered is unconfirmed, never `neverSent`.
    // The transport's own refusal of an altered runtime (FU-249) is thrown
    // before it sends, so it is never-sent too — never an unknown outcome that
    // would hold a write nobody sent.
    if (refusedBeforeSending(error) || neverSent(error))
      throw new GatewayNeverSentError(correlationId);
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
      response.status < 500 ? await readProblem(response, deadlineAt) : null,
      parseRetryAfter(response.headers.get('retry-after')),
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
    // Heard after the deadline: as unanswered as a timeout before the headers
    // (PR #722 r2 F2) — a write it answers is unconfirmed, never applied.
    if (performance.now() >= deadlineAt) {
      await response.body?.cancel().catch(() => undefined);
      throw new GatewayOutcomeUnknownError(503, correlationId, 'TRANSPORT');
    }
    return { data: undefined as T, correlationId };
  }

  try {
    return {
      data: (await readBoundedJson(response, MAX_GATEWAY_BODY_BYTES, deadlineAt)) as T,
      correlationId,
    };
  } catch {
    // Past the byte ceiling or the deadline too (PR #722 r1 F1/F2): the
    // answer was not read, and a write it answered is still unconfirmed.
    // A 2xx whose body does not parse is the gateway's contract broken, not
    // something a screen mid-form can be asked to make sense of — but it is
    // still a 2xx: a write it answers has most likely happened.
    throw new GatewayOutcomeUnknownError(502, correlationId, 'UNREADABLE_BODY');
  }
}

/**
 * `Retry-After` as delay-seconds (RFC 9110 § 10.2.3), the only form the
 * platform sends (`nest-common`'s exception filter). An HTTP-date, or
 * anything else, is `null`: no wait this portal could honour exactly.
 */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return null;
  return Number(value.trim());
}

async function readProblem(response: Response, deadlineAt: number): Promise<GatewayProblem | null> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    const parsed = gatewayProblemSchema.safeParse(
      await readBoundedJson(response, MAX_PROBLEM_BODY_BYTES, deadlineAt),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The transport every credential-bearing request goes through.
 *
 * Every request an `Actor` sends holds a bearer token or an internal token, so nothing about
 * how a request failed may carry its headers into an error, a log, a timeout message, a trace
 * or the uploaded report (Codex r5 on #241). Two things follow:
 *
 * - **Not Playwright's `APIRequestContext`.** Playwright records each API call as a report step,
 *   and a call that fails at the transport stores its error — whose call log lists every request
 *   header, `authorization` included — in the HTML report, with tracing off and even when the
 *   test catches and replaces the error. Node's `fetch` keeps the request out of the runner's
 *   instrumentation altogether.
 * - **A transport failure is replaced, not wrapped.** `TransportError` is built from fixed text,
 *   the method, the path, the status class and a cause code. It keeps no `cause`, because a
 *   reporter prints the cause chain too.
 * - **An answer that is not the one asked for is described, not quoted** (Codex r6 on #241).
 *   `AnswerError` names the call and the status class, and at most a code that looks like an
 *   identifier: never a body excerpt, never a parser's message (`JSON.parse` quotes its input,
 *   and a token response's input is a credential).
 * - **Every request has a deadline it keeps** (Codex r6 on #241). The timeout aborts the
 *   request, and `send` also stops waiting at it, so a transport that ignores the abort cannot
 *   hold a caller — a token grant included — past it.
 * - **No request follows a redirect** (Q-155). 301/302/303/307/308 is a `TransportError` with
 *   cause `REDIRECT`, before the body is read, whatever credential the request carries — not
 *   only an internal token. Every other status (304 included) is an answer as before.
 *
 * Keycloak's calls go through it too (`keycloak-transport.ts`): they carry a password, an admin
 * token or a bearer token, and a misconfigured `KEYCLOAK_URL` would otherwise reach a report.
 *
 * No extensionless imports, so `node --test` loads it (`actor.test.ts`).
 */

/** Playwright's own default for an API request, kept when the transport moved. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** A cause code is an identifier (`ECONNREFUSED`, `UND_ERR_SOCKET`), never free text. */
const CAUSE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
/** An error code in an answer (`invalid_grant`, `unknown_error`): an identifier, nothing more. */
const ANSWER_CODE = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;
/** How far down `cause` / `AggregateError.errors` a code is looked for. */
const CAUSE_DEPTH = 4;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  /** The origin the path is sent to: the gateway, or a labelled direct service. */
  baseUrl: string;
  path: string;
  headers: Record<string, string>;
  /** Serialised as JSON; `undefined` sends no body. */
  body?: unknown;
  /** Sent form-encoded instead (a token grant); takes precedence over `body`. */
  form?: Record<string, string>;
}

export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** `fetch`, injectable so a test can make the transport fail on purpose. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A request that got no usable HTTP answer: refused, reset, timed out, or a body that could not
 * be read. The message is the whole of what is known — the request's headers are never in it.
 */
export class TransportError extends Error {
  readonly causeCode: string;

  constructor(
    request: Pick<HttpRequest, 'method' | 'path'>,
    status: number | undefined,
    causeCode: string,
  ) {
    super(
      `Transport failure: ${request.method} ${routeOf(request.path)} ` +
        `(status ${status === undefined ? 'none' : statusClass(status)}, cause ${causeCode})`,
    );
    this.name = 'TransportError';
    this.causeCode = causeCode;
  }
}

/**
 * An answer that was not the one asked for: refused, or a body that is not what it should be.
 * The message is `what` (fixed text the caller wrote), the call, the status class and a fixed
 * detail — `error <code>` with a code read by `answerCodeOf`, or a phrase such as
 * `body not JSON`. Nothing the answer said is copied into it but that code.
 */
export class AnswerError extends Error {
  readonly statusClass: string;

  constructor(
    what: string,
    request: Pick<HttpRequest, 'method' | 'path'>,
    status: number,
    detail?: string,
  ) {
    super(
      `${what}: ${request.method} ${routeOf(request.path)} answered ${statusClass(status)}` +
        (detail ? ` (${detail})` : ''),
    );
    this.name = 'AnswerError';
    this.statusClass = statusClass(status);
  }
}

/** The path without its query string: the route is the evidence, the parameters are not. */
function routeOf(path: string): string {
  return path.split('?')[0] ?? path;
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * `error <code>` from an answer's JSON `error` field (OAuth's `invalid_grant`), when it is an
 * identifier; otherwise nothing. The body is parsed, never quoted.
 */
export function answerCodeOf(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const code =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { error?: unknown }).error
      : undefined;
  return typeof code === 'string' && ANSWER_CODE.test(code) ? `error ${code}` : undefined;
}

/** An answer's body as JSON, or an `AnswerError` that says only that it was not. */
export function jsonOf<T>(
  what: string,
  request: Pick<HttpRequest, 'method' | 'path'>,
  answer: HttpAnswer,
): T {
  try {
    return JSON.parse(answer.text) as T;
  } catch {
    throw new AnswerError(what, request, answer.status, 'body not JSON');
  }
}

/**
 * The code naming why a request failed, read only from fields that hold codes: `code` on the
 * error or its causes (undici puts the socket's `ECONNREFUSED` there), and `TimeoutError` for
 * the request timeout. Messages are never read, so nothing a message carries can get through.
 */
export function causeCodeOf(error: unknown, depth = 0): string {
  if (typeof error !== 'object' || error === null || depth > CAUSE_DEPTH) return 'UNKNOWN';
  const { code, name, cause, errors } = error as {
    code?: unknown;
    name?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof code === 'string' && CAUSE_CODE.test(code)) return code;
  if (name === 'TimeoutError') return 'TIMEOUT';
  for (const inner of [cause, ...(Array.isArray(errors) ? (errors as unknown[]) : [])]) {
    const found = causeCodeOf(inner, depth + 1);
    if (found !== 'UNKNOWN') return found;
  }
  return 'UNKNOWN';
}

/** What `beforeDeadline` resolves to when the deadline came first. */
export const DEADLINE_PASSED: unique symbol = Symbol('deadline passed');

/**
 * `work`, or `DEADLINE_PASSED` once `deadline` (epoch ms) is reached, whichever is first. The
 * work is not cancelled — the caller stops waiting for it — and a rejection it settles with
 * later is swallowed: nobody is listening any more.
 */
export async function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T | typeof DEADLINE_PASSED> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), DEADLINE_PASSED);
  });
  try {
    return await Promise.race([work, passed]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one request. A non-2xx is an answer like any other — these tests assert on refusals as
 * much as on successes — and only a missing answer throws, as a `TransportError`: refused,
 * reset, or not answered (headers and body) within `timeoutMs` (cause `TIMEOUT`).
 */
export async function send(
  request: HttpRequest,
  fetchImpl: Fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<HttpAnswer> {
  const deadline = Date.now() + timeoutMs;
  const body =
    request.form !== undefined
      ? new URLSearchParams(request.form).toString()
      : request.body !== undefined
        ? JSON.stringify(request.body)
        : undefined;
  let response: Response | typeof DEADLINE_PASSED;
  try {
    response = await beforeDeadline(
      fetchImpl(`${request.baseUrl}${request.path}`, {
        method: request.method,
        // Every request here carries a credential — a bearer or internal token, a password or
        // client grant, the admin token — so none follows a redirect (Q-155).
        redirect: 'manual',
        headers: {
          ...request.headers,
          ...(request.form !== undefined
            ? { 'content-type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      deadline,
    );
  } catch (error) {
    throw new TransportError(request, undefined, causeCodeOf(error));
  }
  if (response === DEADLINE_PASSED) throw new TransportError(request, undefined, 'TIMEOUT');
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    throw new TransportError(request, response.status, 'REDIRECT');
  }
  let text: string | typeof DEADLINE_PASSED;
  try {
    text = await beforeDeadline(response.text(), deadline);
  } catch (error) {
    throw new TransportError(request, response.status, causeCodeOf(error));
  }
  if (text === DEADLINE_PASSED) throw new TransportError(request, response.status, 'TIMEOUT');
  return { status: response.status, headers: Object.fromEntries(response.headers), text };
}

const REDACTED = '[redacted]';
/** A bearer credential as a header value, whatever follows the scheme. */
const BEARER = /\bBearer\s+\S+/gi;
/** A JWT anywhere: three base64url segments, the first a JSON header (`{"` → `eyJ`). */
const JWT = /\beyJ[\w-]*\.[\w-]+\.[\w-]*/g;

/** Text with every bearer value and JWT replaced: the last line of defence, not the first. */
export function redactCredentials(text: string): string {
  return text.replace(BEARER, `Bearer ${REDACTED}`).replace(JWT, REDACTED);
}

/**
 * What a poll may say about the last failure it saw: a `TransportError`'s or `AnswerError`'s
 * fixed message as it is, anything else as its name and message with credentials redacted.
 * Never the stack, the cause chain or the object's own fields.
 */
export function failureMessage(error: unknown): string {
  if (error instanceof TransportError || error instanceof AnswerError) return error.message;
  if (error instanceof Error) return redactCredentials(`${error.name}: ${error.message}`);
  return redactCredentials(String(error));
}

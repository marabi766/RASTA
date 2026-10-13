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
 *
 * No extensionless imports, so `node --test` loads it (`actor.test.ts`).
 */

/** Playwright's own default for an API request, kept when the transport moved. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** A cause code is an identifier (`ECONNREFUSED`, `UND_ERR_SOCKET`), never free text. */
const CAUSE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
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
        `(status ${status === undefined ? 'none' : `${Math.floor(status / 100)}xx`}, cause ${causeCode})`,
    );
    this.name = 'TransportError';
    this.causeCode = causeCode;
  }
}

/** The path without its query string: the route is the evidence, the parameters are not. */
function routeOf(path: string): string {
  return path.split('?')[0] ?? path;
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

/**
 * Sends one request. A non-2xx is an answer like any other — these tests assert on refusals as
 * much as on successes — and only a missing answer throws, as a `TransportError`.
 */
export async function send(request: HttpRequest, fetchImpl: Fetch = fetch): Promise<HttpAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(`${request.baseUrl}${request.path}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TransportError(request, undefined, causeCodeOf(error));
  }
  try {
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      text: await response.text(),
    };
  } catch (error) {
    throw new TransportError(request, response.status, causeCodeOf(error));
  }
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
 * What a poll may say about the last failure it saw: a `TransportError`'s fixed message as it
 * is, anything else as its name and message with credentials redacted. Never the stack, the
 * cause chain or the object's own fields.
 */
export function failureMessage(error: unknown): string {
  if (error instanceof TransportError) return error.message;
  if (error instanceof Error) return redactCredentials(`${error.name}: ${error.message}`);
  return redactCredentials(String(error));
}

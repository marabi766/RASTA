import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { E2eConfig } from './env';
import {
  beforeDeadline,
  DEADLINE_PASSED,
  failureMessage,
  REQUEST_TIMEOUT_MS,
  send,
  type Fetch,
  type HttpMethod,
} from './http.ts';
import type { E2eUser } from './keycloak';
import { CHECK_STILL_RUNNING } from './poll.ts';

/**
 * The authenticated client every scenario drives the platform through, and the poll that reads
 * through it.
 *
 * Separate from `api.ts` (the Playwright fixtures) so that `node --test` can load it without the
 * runner (`actor.test.ts`): no extensionless runtime imports, no parameter properties.
 */

export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Record<string, string>;
  /** The correlation id this request carried, for asserting the event path. */
  correlationId: string;
}

export interface CallOptions {
  /** Sent as `Idempotency-Key`. Required by the gateway on economic writes. */
  idempotencyKey?: string;
  /** Sent as `Idempotency-Replay-Deadline` (epoch ms): the last instant the request may still be executed under its key. */
  replayDeadline?: number | string;
  /** Sent as `X-Correlation-Id`. Generated when absent so every call has one. */
  correlationId?: string;
  /** Sent as `X-Organization-Id` — the tenant the caller asks to act for. */
  organizationId?: string;
  body?: unknown;
  /**
   * Talk to something other than the gateway.
   *
   * Used in exactly one place — the per-journal ledger read, which the gateway
   * currently makes unreachable for every role (docs/24 Q-27) — and labelled at
   * the call site. Everything else in this suite goes through the front door,
   * because the gateway's routing, rate limiting and idempotency enforcement
   * are part of what is under test.
   */
  baseUrl?: string;
  /**
   * Sent as `X-Internal-Token`, and **instead of** the bearer token.
   *
   * A service-to-service call is not a user call wearing a different hat: it
   * carries no user credential at all, and the guard treats a request holding
   * both as the user's (the internal token then names only the relaying hop).
   * Passing this therefore drops the `Authorization` header, which is what a
   * calling service actually sends.
   */
  internalToken?: string;
}

/** How long before its `exp` a token is replaced: clock skew, plus the request in flight. */
const TOKEN_RENEWAL_MARGIN_MS = 60_000;

/** One poll per second: the gateway allows 300 calls a minute per user. */
export const POLL_INTERVAL_MS = 1_000;

/**
 * An access token that renews itself before it expires.
 *
 * The realm issues tokens for 15 minutes, and a scenario that provisions its
 * cast and then waits out tender windows and sweepers outlives that. A token
 * that lapsed mid-run answers 401 `TOKEN_EXPIRED`, which a poll would read as
 * "not yet" and report as a timeout somewhere else entirely. So the token is
 * replaced — with the same grant that issued it — once less than the margin is
 * left, and every request carries one that is valid when it is sent.
 *
 * The token itself is never part of an error message.
 *
 * A renewal is bounded like any request (Codex r6 on #241): the grants go through `send`, and
 * whatever grant this is given, a renewal that has not answered within `grantTimeoutMs` fails
 * rather than holding every request that waits on it.
 */
export class SessionToken {
  private current: { value: string; renewAt: number };
  private renewing: Promise<string> | undefined;
  /** Issues a new token for the same account: the grant the first one came from. */
  private readonly grant: () => Promise<string>;
  private readonly grantTimeoutMs: number;

  constructor(
    initial: string,
    grant: () => Promise<string>,
    grantTimeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {
    this.grant = grant;
    this.grantTimeoutMs = grantTimeoutMs;
    this.current = SessionToken.read(initial);
  }

  async value(): Promise<string> {
    if (Date.now() < this.current.renewAt) return this.current.value;
    // One renewal at a time, however many requests are waiting on it.
    this.renewing ??= beforeDeadline(this.grant(), Date.now() + this.grantTimeoutMs)
      .then((token) => {
        if (token === DEADLINE_PASSED) {
          throw new Error(`The token renewal did not answer within ${this.grantTimeoutMs}ms`);
        }
        this.current = SessionToken.read(token);
        return token;
      })
      .finally(() => {
        this.renewing = undefined;
      });
    return this.renewing;
  }

  /**
   * When to renew, from the token's own `exp` and `iat`. The margin is capped at
   * half the lifetime, so a realm with short-lived tokens is not asked for a new
   * one on every request.
   */
  private static read(token: string): { value: string; renewAt: number } {
    const segment = token.split('.')[1] ?? '';
    let claims: { exp?: unknown; iat?: unknown } = {};
    try {
      claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as typeof claims;
    } catch {
      // Reported below, without the token.
    }
    if (typeof claims.exp !== 'number') {
      throw new Error('The identity provider issued an access token without a numeric exp claim');
    }
    const expiresAt = claims.exp * 1000;
    const lifetime = typeof claims.iat === 'number' ? expiresAt - claims.iat * 1000 : Infinity;
    return {
      value: token,
      renewAt: expiresAt - Math.min(TOKEN_RENEWAL_MARGIN_MS, lifetime / 2),
    };
  }
}

/**
 * A 401 answered to a call made while polling.
 *
 * Every actor's token is valid when sent, so a 401 is never "not yet": it is the
 * finding, and a poll that retried it would report a timeout instead.
 */
export class UnauthenticatedError extends Error {}

const failingOnUnauthenticated = new AsyncLocalStorage<true>();

/**
 * Runs one polling check so that any 401 an actor receives inside it throws an
 * `UnauthenticatedError` carrying the call and the platform's answer, rather
 * than returning a response the check would read as "not yet". Outside a check,
 * a 401 is data like any other status.
 */
export function failOnUnauthenticated<T>(check: () => Promise<T>): Promise<T> {
  return failingOnUnauthenticated.run(true, check);
}

/**
 * Polls `check` until it returns a value; never a fixed sleep. A 401 is not retried: every
 * actor's token is renewed before it expires, so it fails the wait at once with the platform's
 * own answer instead of surfacing later as a timeout. The timeout names the last failure only
 * through `failureMessage` — a transport failure's fixed text, never a request's headers.
 *
 * The deadline holds around each check too (Codex r6 on #241): a check that does not answer —
 * a call whose token renewal stalled — is overtaken at the deadline, and the poll fails with the
 * timeout it declared.
 */
export async function until<T>(
  description: string,
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = POLL_INTERVAL_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let overtaken = false;
  while (Date.now() < deadline) {
    try {
      const value = await beforeDeadline(failOnUnauthenticated(check), deadline);
      if (value === DEADLINE_PASSED) {
        overtaken = true;
        break;
      }
      if (value !== undefined) return value;
    } catch (error) {
      if (error instanceof UnauthenticatedError) throw error;
      last = failureMessage(error);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))),
    );
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
      (last ? `; ${last}` : '') +
      (overtaken ? `; ${CHECK_STILL_RUNNING}` : ''),
  );
}

/**
 * One authenticated actor, talking to the platform the way a client would.
 *
 * Deliberately thin: it adds headers and parses JSON, and does nothing that
 * could paper over a difference between what the platform returned and what a
 * test asserts. Its requests go through `send` (`http.ts`), never through
 * Playwright's request context, so a credential can reach neither the report
 * nor an error: a request that gets no answer throws a `TransportError`.
 */
export class Actor {
  /** A seeded user (`E2E_USERS`), or an account a scenario provisioned through the platform. */
  readonly username: E2eUser | (string & {});
  private readonly token: SessionToken;
  private readonly config: Pick<E2eConfig, 'gatewayUrl'>;
  private readonly fetchImpl: Fetch;

  constructor(
    username: E2eUser | (string & {}),
    token: SessionToken,
    config: Pick<E2eConfig, 'gatewayUrl'>,
    fetchImpl: Fetch = fetch,
  ) {
    this.username = username;
    this.token = token;
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get(path: string, options: CallOptions = {}): Promise<ApiResponse<unknown>> {
    return this.call('GET', path, options);
  }

  post(path: string, options: CallOptions = {}): Promise<ApiResponse<unknown>> {
    return this.call('POST', path, options);
  }

  patch(path: string, options: CallOptions = {}): Promise<ApiResponse<unknown>> {
    return this.call('PATCH', path, options);
  }

  /** A whole replacement — a tender's criteria, a bid's next revision. */
  put(path: string, options: CallOptions = {}): Promise<ApiResponse<unknown>> {
    return this.call('PUT', path, options);
  }

  /**
   * Deletion, which on this platform is a tombstone rather than a removal.
   *
   * It carries a body — document-service requires a stated reason, because a
   * tombstone that answers "who and when" but not "why" is not the audit
   * record it exists to be.
   */
  delete(path: string, options: CallOptions = {}): Promise<ApiResponse<unknown>> {
    return this.call('DELETE', path, options);
  }

  async call(
    method: HttpMethod,
    path: string,
    options: CallOptions = {},
  ): Promise<ApiResponse<unknown>> {
    const correlationId = options.correlationId ?? randomUUID();

    const headers: Record<string, string> = {
      'x-correlation-id': correlationId,
      accept: 'application/json',
      ...(options.internalToken
        ? { 'x-internal-token': options.internalToken }
        : { authorization: `Bearer ${await this.token.value()}` }),
    };
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    if (options.replayDeadline !== undefined) {
      headers['idempotency-replay-deadline'] = String(options.replayDeadline);
    }
    if (options.organizationId) headers['x-organization-id'] = options.organizationId;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    // These tests assert on 4xx as much as on 2xx, so a non-2xx is data, not a
    // transport failure.
    const answer = await send(
      {
        method,
        baseUrl: options.baseUrl ?? this.config.gatewayUrl,
        path,
        headers,
        body: options.body,
      },
      this.fetchImpl,
    );

    let body: unknown = answer.text;
    if (answer.text.length > 0) {
      try {
        body = JSON.parse(answer.text) as unknown;
      } catch {
        // Left as text. A non-JSON body from a JSON API is itself a finding,
        // and swallowing it into `{}` would hide it.
      }
    }

    if (answer.status === 401 && failingOnUnauthenticated.getStore()) {
      throw new UnauthenticatedError(
        `${method} ${path} as ${this.username} answered 401 while polling ` +
          `(correlation ${correlationId}): ${typeof body === 'string' ? body : JSON.stringify(body)}`,
      );
    }

    return { status: answer.status, body, headers: answer.headers, correlationId };
  }
}

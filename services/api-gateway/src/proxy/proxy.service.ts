import { InternalHttpClient } from '@rasta/nest-common';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  ExchangeCancelledError,
  ExchangeDeadlineError,
  RastaError,
  exchangeWithDeadline,
  getContext,
  httpStatusToCode,
  requestPath,
  type InternalTokenService,
} from '@rasta/nest-common';
import { apiErrorSchema, type ApiError } from '@rasta/contracts';
import type { GatewayEnv } from '../config/env';
import {
  TENDER_OPENING_ROUTES,
  deadlineMethodOf,
  serviceUrl,
  type ServiceName,
  type ServiceUrls,
  type UpstreamDeadlineRoute,
} from '../config/routes';
import {
  CircuitBreakers,
  type CircuitOutcome,
  type CircuitPermit,
  type CircuitStateView,
} from './circuit-breaker';

export { circuitRetryAfterSeconds } from './circuit-breaker';

/**
 * Forwards a request to the owning service.
 *
 * Three concerns live here and nowhere else:
 *
 *  - **Context propagation.** The correlation id, tenant and actor travel as
 *    headers, so one identifier links a browser click to a ledger entry
 *    (docs/13 § 13.1).
 *
 *  - **Service authentication.** A short-lived internal token is minted per
 *    call, scoped to the target service, so a leaked token for
 *    notification-service cannot be replayed against economic-service
 *    (ADR-020).
 *
 *  - **Circuit breaking.** A downstream that is down should fail fast rather
 *    than hold connections until every gateway worker is blocked — that is how
 *    one sick service takes the whole platform with it. The state machine is
 *    `CircuitBreakers` (circuit-breaker.ts); what each request proved is
 *    decided here, once, when it is over.
 */

export interface ProxyRequest {
  service: ServiceName;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /**
   * Aborted when the caller has gone away. Cancels the upstream call wherever
   * it is — before it is sent, waiting for headers, reading the body — and the
   * request then proves nothing about the service (#381 r4 F2), except that a
   * 5xx status already received is a failure. Once sent, the service may still
   * be acting on it: a probe abandoned then keeps the probe slot until its
   * deadline (#460 r1 F1). Without a signal, the call runs to its deadline, as
   * before.
   */
  signal?: AbortSignal;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Hop-by-hop headers, which must not be forwarded (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** Response headers that belong to the gateway's CORS policy, never an upstream's. */
const CORS_HEADER_PREFIX = 'access-control-';

export interface ProxyOptions {
  timeoutMs: number;
  failureThreshold: number;
  resetAfterMs: number;
  /**
   * Requests whose owning service may legitimately work longer than `timeoutMs`, each with its
   * own deadline (Codex r2 on #250, G1). The first match wins; anything else gets `timeoutMs`.
   */
  routeDeadlines?: readonly (UpstreamDeadlineRoute & { timeoutMs: number })[];
  /** The breaker's clock, in milliseconds. Monotonic (`performance.now`) unless a test sets it. */
  now?: () => number;
}

/**
 * Raised by `forward` when the caller went away before the exchange was over.
 * Not an upstream failure and not an answer: there is nobody left to answer.
 */
export class ClientCancelledError extends Error {
  constructor(readonly service: ServiceName) {
    super(`The caller went away before ${service} answered`);
    this.name = 'ClientCancelledError';
  }
}

/**
 * The forwarder's settings from configuration: one deadline for every route, and
 * `GATEWAY_TENDER_OPEN_TIMEOUT_MS` for the tender opening routes alone.
 */
export function proxyOptionsOf(env: GatewayEnv): ProxyOptions {
  return {
    timeoutMs: env.GATEWAY_UPSTREAM_TIMEOUT_MS,
    failureThreshold: env.GATEWAY_CIRCUIT_FAILURE_THRESHOLD,
    resetAfterMs: env.GATEWAY_CIRCUIT_RESET_MS,
    routeDeadlines: TENDER_OPENING_ROUTES.map((route) => ({
      ...route,
      timeoutMs: env.GATEWAY_TENDER_OPEN_TIMEOUT_MS,
    })),
  };
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly circuits: CircuitBreakers;

  constructor(
    private readonly urls: ServiceUrls,
    private readonly internalTokens: InternalTokenService,
    private readonly options: ProxyOptions,
  ) {
    this.circuits = new CircuitBreakers({
      failureThreshold: options.failureThreshold,
      resetAfterMs: options.resetAfterMs,
      now: options.now ?? (() => performance.now()),
    });
  }

  /** How long this request may wait for its upstream. */
  deadlineFor(request: Pick<ProxyRequest, 'service' | 'method' | 'path'>): number {
    const method = deadlineMethodOf(request.method);
    const route = this.options.routeDeadlines?.find(
      (candidate) =>
        candidate.service === request.service &&
        candidate.method === method &&
        candidate.path.test(request.path),
    );
    return route?.timeoutMs ?? this.options.timeoutMs;
  }

  async forward(request: ProxyRequest): Promise<ProxyResponse> {
    // Refused here, before anything is sent, when the circuit is OPEN or its
    // HALF_OPEN probe is taken. Otherwise this request holds a permit, and the
    // `finally` below settles it on every exit — the probe slot is never
    // left taken.
    const permit = this.circuits.admit(request.service);
    // What this request proved about the service, decided exactly once. Until
    // an answer is complete it proved nothing: a gateway-local fault (token
    // issuance) or a caller gone away before anything was sent is a `release`.
    let outcome: CircuitOutcome = 'release';
    try {
      const exchanged = await this.exchange(request, permit);
      outcome = exchanged.outcome;
      return exchanged.response;
    } catch (error) {
      if (error instanceof UpstreamFailure) {
        outcome = 'failure';
        throw error.reported;
      }
      if (error instanceof CallerGoneAfterSending) {
        outcome = error.outcome;
        throw error.reported;
      }
      throw error;
    } finally {
      this.circuits.settle(permit, outcome);
    }
  }

  /**
   * One exchange with the owning service. Resolves with the response and what
   * it proved; rejects with an `UpstreamFailure` when the service failed, or
   * with anything else when it proved nothing.
   */
  private async exchange(
    request: ProxyRequest,
    permit: CircuitPermit,
  ): Promise<{ response: ProxyResponse; outcome: CircuitOutcome }> {
    const cancelled = request.signal;
    if (cancelled?.aborted) throw new ClientCancelledError(request.service);

    const context = getContext();
    const target = `${serviceUrl(this.urls, request.service)}${request.path}${request.query}`;

    // Scoped to this specific service, short-lived, and minted as a RELAY.
    //
    // The gateway never acts on its own authority — everything it sends is
    // somebody else's request being forwarded. Saying so in the token is what
    // lets the downstream tell a forwarded anonymous request (judged by
    // `@Public`) from a genuine service-to-service call (judged by
    // `@AllowService`), without loosening either. It also means a token minted
    // here can never satisfy `@AllowService` on any service (ADR-020, D-007).
    const sender = await new InternalHttpClient(this.internalTokens).authorize({
      from: 'api-gateway',
      to: `${request.service}-service`,
      purpose: 'RELAY',
    });
    // Gone while the token was minted: nothing has been sent, nothing is.
    if (cancelled?.aborted) throw new ClientCancelledError(request.service);

    const headers: Record<string, string> = {
      ...this.forwardableHeaders(request.headers),
      // Two tokens, carrying two different claims:
      //
      //   authorization    the caller's own token, forwarded unchanged so the
      //                    downstream verifies the user *itself* rather than
      //                    trusting a header. That independent check is what
      //                    ADR-020 means by Zero Trust — the gateway is a
      //                    filter, not an authority.
      //
      //   x-internal-token proof that this hop came from the gateway, scoped
      //                    to this one service so it cannot be replayed
      //                    against another. The sender sets it, replacing
      //                    any the caller sent in whatever letter case.
      //
      // An earlier version replaced the caller's token with the internal one.
      // The downstream then tried to verify an HS256 service token as an RS256
      // user token and rejected every request with ERR_JOSE_ALG_NOT_ALLOWED.
      'x-correlation-id': context.correlationId,
      'x-request-id': context.requestId,
      // The tenant was resolved and verified at the edge. The service still
      // re-checks it — this header is context, not a grant of trust.
      ...(context.organizationId ? { 'x-organization-id': context.organizationId } : {}),
      ...(context.userId ? { 'x-user-id': context.userId } : {}),
      ...(context.roles.length > 0 ? { 'x-user-roles': context.roles.join(',') } : {}),
    };

    // One deadline for the whole exchange — headers and body alike — ended by
    // whichever comes first: the deadline (an upstream failure) or the caller
    // leaving (no verdict). The response is released with it, read or not.
    const timeoutMs = this.deadlineFor(request);
    // The status line, once it has arrived: a 5xx is evidence even if its body never is.
    let status: number | undefined;

    try {
      // From here the service may receive it: a caller leaving is no longer a
      // `release` (nothing reached the service) but `abandoned`.
      this.circuits.dispatched(permit, timeoutMs);
      return await exchangeWithDeadline(
        timeoutMs,
        (signal) =>
          sender.send(target, {
            method: request.method,
            headers,
            body: this.bodyFor(request.method, request.body),
            signal,
          }),
        async (response) => {
          status = response.status;
          // Nothing is decided on the status line: a 200 whose body then stalls or
          // is cut off is a failure, and a 5xx is judged once its body is in.
          const text = await response.text();

          if (response.status >= 500) {
            // A 5xx counts toward the circuit, once. (#381's expected identity
            // refusals would be the one exception: `release`, never `success` —
            // and only with the body complete; see the caller-gone branch below.)
            //
            // Parsed once, and only the parsed, allow-listed fields travel. The
            // schema accepting a body says nothing about what else the body held:
            // a `stack` or an internal field beside a valid envelope would reach
            // the caller if the original object were forwarded.
            const envelope = platformErrorEnvelope(response.status, text, request);
            if (envelope) {
              return {
                outcome: 'failure',
                response: {
                  status: response.status,
                  headers: this.responseHeaders(response),
                  body: envelope,
                },
              };
            }
            // L1-06. A 5xx that is not the platform's own error envelope is a
            // crash page, a proxy's HTML or a stack trace — reflecting it hands
            // internals to the caller. The shape, status and content type are
            // logged; the body never is (S-09), because it is exactly the part
            // that may hold what must not leak.
            this.logger.error(
              `${request.service} answered ${response.status} without a platform error body ` +
                `(content-type ${response.headers.get('content-type') ?? 'none'}, ${text.length} chars)`,
            );
            throw new UpstreamFailure(
              RastaError.upstreamUnavailable(request.service, {
                upstreamStatus: response.status,
                reason: 'malformed-error-body',
              }),
            );
          }

          // 4xx does not count against the circuit: a client sending bad requests
          // is not evidence that the downstream is unhealthy — it answered.
          if (response.status >= 400) {
            return {
              outcome: 'success',
              response: {
                status: response.status,
                headers: this.responseHeaders(response),
                body: this.relayedClientError(request, response, text),
              },
            };
          }

          return {
            outcome: 'success',
            response: {
              status: response.status,
              headers: this.responseHeaders(response),
              body: text.length > 0 ? this.parseJson(text) : undefined,
            },
          };
        },
        { cancel: cancelled },
      );
    } catch (error) {
      if (error instanceof UpstreamFailure) throw error;

      // The caller left: the upstream call was cancelled with it. Cancelling
      // the transport does not stop the service — it may still be acting on
      // it, so this is `abandoned`, never `release`, and nothing here resends
      // it or tells anyone it did not happen. A 5xx status line already
      // received is a `failure`: without its complete body no exemption
      // (#381) can be proven, so none is applied — fail closed.
      if (error instanceof ExchangeCancelledError) {
        throw new CallerGoneAfterSending(
          status !== undefined && status >= 500 ? 'failure' : 'abandoned',
          new ClientCancelledError(request.service),
        );
      }

      if (error instanceof ExchangeDeadlineError) {
        throw new UpstreamFailure(
          new RastaError('UPSTREAM_TIMEOUT', 'The upstream service did not respond in time', {
            internalContext: { service: request.service, timeoutMs },
          }),
        );
      }

      // Refused, reset or cut off mid-body: the service failed.
      throw new UpstreamFailure(
        RastaError.upstreamUnavailable(request.service, {
          message: (error as Error).message,
        }),
      );
    }
  }

  /** Current breaker state, surfaced on the gateway's own health endpoint. */
  circuitStates(): Record<string, CircuitStateView> {
    return this.circuits.states();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private forwardableHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      // `authorization` is deliberately NOT stripped: the downstream must
      // verify the user itself. Cookies are dropped — they are a browser
      // concern and no internal service reads them.
      if (lower === 'cookie') continue;
      if (value === undefined) continue;

      result[lower] = Array.isArray(value) ? value.join(',') : value;
    }

    result['content-type'] = 'application/json';
    return result;
  }

  private responseHeaders(response: Response): Record<string, string> {
    const result: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower)) return;
      if (lower === 'content-encoding') return; // fetch already decoded it
      // The gateway always answers with its own JSON serialisation, so the
      // upstream's type must not travel with it: a `text/html` label on a
      // reflected body is how a JSON response gets rendered as a page.
      if (lower === 'content-type') return;
      // CORS is the gateway's policy, set by its own middleware before the
      // upstream answers (http/cors.ts). A service's `Access-Control-*` copied
      // on top would replace it — its expose list hid `Retry-After` from the
      // browser (review of #141) — or grant an origin the gateway never allowed.
      if (lower.startsWith(CORS_HEADER_PREFIX)) return;
      result[lower] = value;
    });
    return result;
  }

  /**
   * The body to forward, if any.
   *
   * `GET`, `HEAD` and `OPTIONS` never carry one.
   *
   * `DELETE` forwards a body **only when the caller actually sent one**, and
   * that is a fix rather than a nicety. The gateway used to drop it
   * unconditionally, so document-service — which requires a stated reason on
   * every deletion, because a tombstone answering "who and when" but not "why"
   * is not the audit record it exists to be — received an empty object and
   * answered 400. The client had sent the reason; nothing told it where the
   * reason went. RFC 9110 leaves DELETE content's semantics undefined, which
   * means undefined *by the specification* — this platform defines them in its
   * own API contract.
   *
   * Only when non-empty, so a plain `DELETE` stays a plain `DELETE`:
   * fleet-service's assignment alias takes no body and must not start
   * receiving `{}`.
   */
  private bodyFor(method: string, body: unknown): string | undefined {
    const verb = method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(verb)) return undefined;

    if (verb === 'DELETE') {
      if (body === undefined || body === null) return undefined;
      if (typeof body === 'object' && Object.keys(body as object).length === 0) return undefined;
      return JSON.stringify(body);
    }

    return JSON.stringify(body ?? {});
  }

  /**
   * What the caller receives for an upstream 4xx: the platform error envelope,
   * rebuilt from its allow-listed fields — never the body as it came.
   *
   * The query is the caller's data — a cursor, a search term, a token pasted
   * into a link — and the gateway forwarded it, so what it hands back does not
   * rest on every service's filter having kept it out (S-09). A field beside
   * the envelope's own (`url`, a nested `error.path`) is dropped; `path` is
   * reduced to the path; a route-not-found text is written again from the
   * request. A body that is not an envelope at all — HTML, plain text, JSON of
   * another shape, nothing — is replaced by a fixed one; like a malformed 5xx,
   * its shape is logged and its content never is.
   */
  private relayedClientError(request: ProxyRequest, response: Response, text: string): ApiError {
    const envelope = platformErrorEnvelope(response.status, text, request);
    if (envelope) return envelope;

    this.logger.warn(
      `${request.service} answered ${response.status} without a platform error body ` +
        `(content-type ${response.headers.get('content-type') ?? 'none'}, ${text.length} chars)`,
    );
    const context = getContext();
    return {
      code: httpStatusToCode(response.status),
      message: UPSTREAM_REFUSED,
      correlationId: context.correlationId,
      ...(context.traceId ? { traceId: context.traceId } : {}),
      timestamp: new Date().toISOString(),
      ...(context.path ? { path: requestPath(context.path) } : {}),
    };
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      // A downstream returning non-JSON is a contract violation, but the
      // gateway must not turn it into a 500 and hide the real response.
      return { raw: text };
    }
  }
}

/** Raised inside `exchange` for a failure of the service, carrying what the caller is told. */
class UpstreamFailure extends Error {
  constructor(readonly reported: RastaError) {
    super(reported.message);
  }
}

/** Raised inside `exchange` when the caller left after the request was sent. */
class CallerGoneAfterSending extends Error {
  constructor(
    readonly outcome: 'abandoned' | 'failure',
    readonly reported: ClientCancelledError,
  ) {
    super(reported.message);
  }
}

/**
 * The platform error envelope (`@rasta/contracts`) in a body, rebuilt from its
 * named fields only; null when the body is not one.
 *
 * Rebuilt field by field rather than trusting the schema's output: which keys
 * reach a caller is a security property, so it is written down here, not
 * inherited from however the schema happens to treat unknown keys. `path` is
 * the path alone and a route-not-found `message` is the request's own
 * (see {@link relayedMessage}).
 */
function platformErrorEnvelope(
  status: number,
  text: string,
  request: ProxyRequest,
): ApiError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = apiErrorSchema.safeParse(parsed);
  if (!result.success) return null;

  const { code, message, details, correlationId, traceId, timestamp, path } = result.data;
  return {
    code,
    message: relayedMessage(status, message, request),
    ...(details
      ? {
          details: details.map((detail) => ({
            path: detail.path,
            message: detail.message,
            ...(detail.code !== undefined ? { code: detail.code } : {}),
          })),
        }
      : {}),
    correlationId,
    ...(traceId !== undefined ? { traceId } : {}),
    timestamp,
    ...(path !== undefined ? { path: requestPath(path) } : {}),
  };
}

/** What a caller is told when an upstream refused it without a platform error body. */
const UPSTREAM_REFUSED = 'The request was refused';

/** How Nest's route-not-found text begins: `Cannot <method> <request target>`. */
const ROUTE_NOT_FOUND_PREFIX = 'Cannot ';

/**
 * An upstream envelope's `message`, except a route-not-found text: that is
 * written again as `Cannot <method> <path>` from the forwarded request, so the
 * query the upstream may have quoted back — an older filter, another framework
 * — does not travel. Nothing of the upstream's wording is kept for it.
 */
function relayedMessage(status: number, message: string, request: ProxyRequest): string {
  if (status !== HttpStatus.NOT_FOUND || !message.startsWith(ROUTE_NOT_FOUND_PREFIX)) {
    return message;
  }
  return `${ROUTE_NOT_FOUND_PREFIX}${request.method.toUpperCase()} ${requestPath(request.path)}`;
}

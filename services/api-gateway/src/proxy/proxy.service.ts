import { Injectable, Logger } from '@nestjs/common';
import { RastaError, getContext, type InternalTokenService } from '@rasta/nest-common';
import { serviceUrl, type ServiceName, type ServiceUrls } from '../config/routes';

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
 *    one sick service takes the whole platform with it.
 */

interface CircuitState {
  failures: number;
  openedAt: number | null;
}

export interface ProxyRequest {
  service: ServiceName;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
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

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly circuits = new Map<ServiceName, CircuitState>();

  constructor(
    private readonly urls: ServiceUrls,
    private readonly internalTokens: InternalTokenService,
    private readonly options: {
      timeoutMs: number;
      failureThreshold: number;
      resetAfterMs: number;
    },
  ) {}

  async forward(request: ProxyRequest): Promise<ProxyResponse> {
    this.assertCircuitClosed(request.service);

    const context = getContext();
    const target = `${serviceUrl(this.urls, request.service)}${request.path}${request.query}`;

    // Scoped to this specific service, and short-lived.
    const internalToken = await this.internalTokens.issue(
      'api-gateway',
      `${request.service}-service`,
    );

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
      //                    against another.
      //
      // An earlier version replaced the caller's token with the internal one.
      // The downstream then tried to verify an HS256 service token as an RS256
      // user token and rejected every request with ERR_JOSE_ALG_NOT_ALLOWED.
      'x-internal-token': internalToken,
      'x-correlation-id': context.correlationId,
      'x-request-id': context.requestId,
      // The tenant was resolved and verified at the edge. The service still
      // re-checks it — this header is context, not a grant of trust.
      ...(context.organizationId ? { 'x-organization-id': context.organizationId } : {}),
      ...(context.userId ? { 'x-user-id': context.userId } : {}),
      ...(context.roles.length > 0 ? { 'x-user-roles': context.roles.join(',') } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: this.hasBody(request.method) ? JSON.stringify(request.body ?? {}) : undefined,
        signal: controller.signal,
      });

      // 5xx counts toward the circuit; 4xx does not. A client sending bad
      // requests is not evidence that the downstream is unhealthy.
      if (response.status >= 500) this.recordFailure(request.service);
      else this.recordSuccess(request.service);

      const text = await response.text();

      return {
        status: response.status,
        headers: this.responseHeaders(response),
        body: text.length > 0 ? this.parseJson(text) : undefined,
      };
    } catch (error) {
      this.recordFailure(request.service);

      if ((error as Error).name === 'AbortError') {
        throw new RastaError('UPSTREAM_TIMEOUT', 'The upstream service did not respond in time', {
          internalContext: { service: request.service, timeoutMs: this.options.timeoutMs },
        });
      }

      throw RastaError.upstreamUnavailable(request.service, {
        message: (error as Error).message,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  private assertCircuitClosed(service: ServiceName): void {
    const circuit = this.circuits.get(service);
    if (!circuit?.openedAt) return;

    const elapsed = Date.now() - circuit.openedAt;
    if (elapsed < this.options.resetAfterMs) {
      throw RastaError.upstreamUnavailable(service, {
        reason: 'circuit-open',
        retryInMs: this.options.resetAfterMs - elapsed,
      });
    }

    // Half-open: let one request through to test whether it has recovered.
    circuit.openedAt = null;
    circuit.failures = this.options.failureThreshold - 1;
    this.logger.log(`Circuit for ${service} is half-open; probing`);
  }

  private recordFailure(service: ServiceName): void {
    const circuit = this.circuits.get(service) ?? { failures: 0, openedAt: null };
    circuit.failures += 1;

    if (circuit.failures >= this.options.failureThreshold && !circuit.openedAt) {
      circuit.openedAt = Date.now();
      this.logger.error(
        `Circuit for ${service} opened after ${circuit.failures} consecutive failures`,
      );
    }

    this.circuits.set(service, circuit);
  }

  private recordSuccess(service: ServiceName): void {
    const circuit = this.circuits.get(service);
    if (!circuit) return;
    if (circuit.failures > 0 || circuit.openedAt) {
      this.logger.log(`Circuit for ${service} closed`);
    }
    this.circuits.set(service, { failures: 0, openedAt: null });
  }

  /** Current breaker state, surfaced on the gateway's own health endpoint. */
  circuitStates(): Record<string, { failures: number; open: boolean }> {
    const result: Record<string, { failures: number; open: boolean }> = {};
    for (const [service, circuit] of this.circuits) {
      result[service] = { failures: circuit.failures, open: circuit.openedAt !== null };
    }
    return result;
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
      result[lower] = value;
    });
    return result;
  }

  private hasBody(method: string): boolean {
    return !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method.toUpperCase());
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

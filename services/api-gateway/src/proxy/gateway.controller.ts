import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public, RastaError, getContext } from '@rasta/nest-common';
import { authorizationDenialsTotal, normalizeRoute } from '@rasta/observability';
import type { Request, Response } from 'express';
import { ProxyService } from './proxy.service';
import { RateLimiter } from './rate-limiter';
import { resolveRoute, type RouteRule } from '../config/routes';
import { SERVICE_NAME, type GatewayEnv } from '../config/env';
import { GATEWAY_ENV } from '../tokens';

/**
 * The single catch-all route.
 *
 * Order matters and is not arbitrary — each step is cheap-to-expensive, and
 * each rejects before the next one costs anything:
 *
 *   1. route lookup      unknown path never reaches a service
 *   2. authentication    handled by the global AuthGuard before this runs
 *   3. rate limit        before doing real work, so a flood is cheap to refuse
 *   4. idempotency key   before forwarding, so a missing key never charges
 *   5. coarse role check a cheap filter, NOT the authorization decision
 *   6. forward
 *
 * Step 5 deserves emphasis: the service re-checks authorization independently,
 * including object-level ownership, because only it knows which record is
 * being touched. The gateway is a filter, not a trusted authority (ADR-020).
 */
@ApiExcludeController()
@Controller()
export class GatewayController {
  constructor(
    private readonly proxy: ProxyService,
    private readonly rateLimiter: RateLimiter,
    @Inject(GATEWAY_ENV) private readonly env: GatewayEnv,
  ) {}

  @All('v1/*path')
  @Public('Authentication is decided per route from the routing table, not per controller')
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    const path = request.path.replace(/^\/v1/, '');
    const route = resolveRoute(path);

    if (!route) {
      throw RastaError.notFound('Route', request.path);
    }

    const context = getContext();

    // A route without a stated public reason requires a token. Closed by
    // default: adding a route cannot accidentally expose it (AGENTS.md A-12).
    if (!route.publicReason && context.authType === 'ANONYMOUS') {
      throw RastaError.unauthenticated('This endpoint requires authentication');
    }

    await this.enforceRateLimit(request, route, response);
    this.enforceIdempotencyKey(request, route);
    this.enforceRouteRoles(request, route, context.roles);

    const result = await this.proxy.forward({
      service: route.service,
      method: request.method,
      path: `/v1${path}`,
      query: this.queryString(request),
      headers: request.headers,
      body: request.body,
    });

    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value);
    }

    response.status(result.status);
    if (result.body === undefined) response.end();
    else response.json(result.body);
  }

  // -------------------------------------------------------------------------

  private async enforceRateLimit(
    request: Request,
    route: RouteRule,
    response: Response,
  ): Promise<void> {
    const context = getContext();

    const rule = route.rateLimit ?? {
      limit: this.env.GATEWAY_RATE_LIMIT_MAX,
      windowSeconds: Math.ceil(this.env.GATEWAY_RATE_LIMIT_WINDOW_MS / 1000),
    };

    // Anonymous traffic is limited by IP; there is no better identifier, and
    // this is the one surface reachable without a token.
    const scope = context.userId ? 'user' : 'ip';
    const identifier = context.userId ?? request.ip ?? request.socket.remoteAddress ?? 'unknown';

    const effectiveRule = context.userId
      ? rule
      : {
          limit: Math.min(rule.limit, this.env.GATEWAY_ANON_RATE_LIMIT_MAX),
          windowSeconds: rule.windowSeconds,
        };

    const result = await this.rateLimiter.consume(
      `${scope}:${route.prefix}`,
      identifier,
      effectiveRule,
    );

    response.setHeader('X-RateLimit-Limit', String(result.limit));
    response.setHeader('X-RateLimit-Remaining', String(result.remaining));
    response.setHeader('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      response.setHeader('Retry-After', String(Math.max(1, result.retryAfterSeconds)));
      throw new RastaError('RATE_LIMIT_EXCEEDED', 'Too many requests', {
        internalContext: { scope, route: route.prefix },
      });
    }

    // A tenant-wide ceiling on top of the per-user one, so a single busy
    // organization cannot consume the platform's capacity.
    if (context.organizationId) {
      const tenantResult = await this.rateLimiter.consume('tenant', context.organizationId, {
        limit: this.env.GATEWAY_TENANT_RATE_LIMIT_MAX,
        windowSeconds: Math.ceil(this.env.GATEWAY_RATE_LIMIT_WINDOW_MS / 1000),
      });

      if (!tenantResult.allowed) {
        response.setHeader('Retry-After', String(Math.max(1, tenantResult.retryAfterSeconds)));
        throw new RastaError('RATE_LIMIT_EXCEEDED', 'Organization request quota exceeded', {
          internalContext: { organizationId: context.organizationId },
        });
      }
    }
  }

  private enforceIdempotencyKey(request: Request, route: RouteRule): void {
    if (!route.requiresIdempotencyKey) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return;

    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.trim().length === 0) {
      // Refused rather than generated. A key the server invents is useless:
      // the client's retry would carry a different one and charge twice, which
      // is the exact failure this guards against (docs/06 § 6.8).
      throw RastaError.validation([
        {
          path: 'headers.idempotency-key',
          message:
            'This endpoint has financial or irreversible effects and requires an Idempotency-Key header',
          code: 'required',
        },
      ]);
    }
  }

  private enforceRouteRoles(request: Request, route: RouteRule, roles: readonly string[]): void {
    if (!route.roles) return;
    if (route.roles.some((role) => roles.includes(role))) return;

    authorizationDenialsTotal.inc({
      service: SERVICE_NAME,
      reason: 'route_role',
      route: normalizeRoute(request.path),
    });

    throw RastaError.forbidden('You do not have permission to access this resource');
  }

  private queryString(request: Request): string {
    const index = request.originalUrl.indexOf('?');
    return index === -1 ? '' : request.originalUrl.slice(index);
  }
}

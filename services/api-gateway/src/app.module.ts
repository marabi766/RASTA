import {
  Controller,
  Get,
  HttpStatus,
  Module,
  Res,
  VERSION_NEUTRAL,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AllExceptionsFilter,
  AuthGuard,
  AUTH_OPTIONS,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  Public,
  RequestContextMiddleware,
  RolesGuard,
  TokenVerifier,
  toLogContext,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { metricsContentType, metricsText } from '@rasta/observability';
import type { Response } from 'express';
import { GatewayController } from './proxy/gateway.controller';
import { ProxyService } from './proxy/proxy.service';
import { RateLimiter } from './proxy/rate-limiter';
import { loadGatewayEnv, SERVICE_NAME, type GatewayEnv } from './config/env';
import { GATEWAY_ENV, GATEWAY_LOGGER } from './tokens';

/**
 * Health and metrics for the gateway itself.
 *
 * Readiness deliberately does not check the downstream services. The gateway
 * is up if it can accept and route traffic; a sick downstream is reported by
 * its own probe and handled by the circuit breaker. Cascading that into the
 * gateway's readiness would take the entire platform out of rotation because
 * one service is unwell.
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class GatewayHealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly rateLimiter: RateLimiter,
    private readonly proxy: ProxyService,
  ) {}

  @Get('live')
  @Public('Liveness probe; internal network only')
  @ApiOperation({ summary: 'Process liveness' })
  live() {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Get('ready')
  @Public('Readiness probe; internal network only')
  @ApiOperation({ summary: 'Readiness' })
  async ready(@Res({ passthrough: true }) response: Response) {
    const redis = await this.rateLimiter.isHealthy();

    // Redis being down degrades rate limiting but does not stop routing, so it
    // is reported rather than treated as unreadiness.
    response.status(HttpStatus.OK);

    return {
      status: 'ok',
      service: SERVICE_NAME,
      checks: { redis },
      degraded: redis ? [] : ['rate-limiting'],
      circuits: this.proxy.circuitStates(),
    };
  }
}

@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class GatewayMetricsController {
  @Get()
  @Public('Prometheus scrape target; monitoring namespace only')
  async metrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('content-type', metricsContentType);
    return metricsText();
  }
}

@Module({
  controllers: [GatewayHealthController, GatewayMetricsController, GatewayController],
  providers: [
    { provide: GATEWAY_ENV, useFactory: () => loadGatewayEnv() },

    {
      provide: GATEWAY_LOGGER,
      inject: [GATEWAY_ENV],
      useFactory: (env: GatewayEnv): Logger => {
        const logger = createLogger({
          serviceName: SERVICE_NAME,
          serviceVersion: env.SERVICE_VERSION,
          environment: env.NODE_ENV,
          level: env.LOG_LEVEL,
          pretty: env.NODE_ENV === 'development',
        });
        setLogContextProvider(() => toLogContext());
        return logger;
      },
    },
    { provide: EXCEPTION_FILTER_LOGGER, inject: [GATEWAY_LOGGER], useFactory: (l: Logger) => l },

    {
      provide: RateLimiter,
      inject: [GATEWAY_ENV],
      useFactory: (env: GatewayEnv) =>
        new RateLimiter(env.REDIS_URL, env.REDIS_KEY_PREFIX, env.GATEWAY_RATE_LIMIT_FAIL_OPEN),
    },

    {
      provide: InternalTokenService,
      inject: [GATEWAY_ENV],
      useFactory: (env: GatewayEnv) =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    {
      provide: ProxyService,
      inject: [GATEWAY_ENV, InternalTokenService],
      useFactory: (env: GatewayEnv, tokens: InternalTokenService) =>
        new ProxyService(env, tokens, {
          timeoutMs: env.GATEWAY_UPSTREAM_TIMEOUT_MS,
          failureThreshold: env.GATEWAY_CIRCUIT_FAILURE_THRESHOLD,
          resetAfterMs: env.GATEWAY_CIRCUIT_RESET_MS,
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [GATEWAY_ENV],
      // The catch-all route is marked @Public, but that does NOT mean tokens
      // go unverified: AuthGuard falls back to an anonymous context only when
      // no bearer is present. A token that is present is always verified, and
      // the tenant resolved from it. Which routes may proceed anonymously is
      // then decided by the routing table.
      useFactory: (env: GatewayEnv): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        internalTokens: new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
      }),
    },

    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

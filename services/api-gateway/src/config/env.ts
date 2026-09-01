import { z } from 'zod';
import { authEnvSchema, baseEnvSchema, booleanEnv, redisEnvSchema, loadEnv } from '@rasta/config';
import { serviceUrlEnvSchema } from './routes';

/**
 * api-gateway configuration.
 *
 * No database schema here: the gateway owns no data (ADR-009). Redis is used
 * for rate-limit counters and idempotency replay only, both of which are
 * derived state that can be lost without consequence beyond a reset window.
 */
export const gatewayEnvSchema = baseEnvSchema
  .merge(redisEnvSchema)
  .merge(authEnvSchema)
  .merge(serviceUrlEnvSchema)
  .extend({
    GATEWAY_CORS_ORIGINS: z.string().default(''),

    /** Default per-user allowance. Individual routes may tighten this. */
    GATEWAY_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    GATEWAY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),

    /** Tenant-wide ceiling, so one busy organization cannot starve the rest. */
    GATEWAY_TENANT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(3000),

    /** Anonymous callers get far less: only registration is reachable. */
    GATEWAY_ANON_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),

    GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).default(3000),
    GATEWAY_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
    GATEWAY_CIRCUIT_RESET_MS: z.coerce.number().int().min(1000).default(30_000),

    /**
     * Allow traffic when Redis is unreachable.
     *
     * Rate limiting protects against overload; it is not the authorization
     * boundary. Refusing everything because a cache is down converts a
     * degradation into a full outage, so the default is to let traffic
     * through and alert. Set false where abuse risk outweighs availability.
     */
    GATEWAY_RATE_LIMIT_FAIL_OPEN: booleanEnv(true),
  });

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

export function loadGatewayEnv(source: NodeJS.ProcessEnv = process.env): GatewayEnv {
  return loadEnv(gatewayEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? 'api-gateway',
    PORT: source.PORT ?? source.PORT_API_GATEWAY ?? '3000',
  });
}

export function corsOrigins(env: GatewayEnv): string[] {
  return env.GATEWAY_CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'api-gateway';

import { z } from 'zod';

/**
 * Environment loading for Rasta services.
 *
 * Configuration is validated **once, at startup, and loudly**. A service that
 * boots with a missing DATABASE_URL and only discovers it on the first request
 * has turned a deployment error into a production incident. `loadEnv` throws
 * before the HTTP server ever binds.
 */

export const NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * A URL restricted to an expected set of protocols.
 *
 * `z.string().url()` is too permissive for configuration: the WHATWG parser
 * accepts `localhost:5432` as a valid URL, reading `localhost:` as the scheme.
 * A typo'd DATABASE_URL would then pass validation and fail at connection time
 * instead — which is exactly the failure mode this module exists to prevent.
 */
export function urlWithProtocol(protocols: readonly string[], label: string) {
  const expected = protocols.map((p) => `${p}//`).join(' or ');
  return z.string().superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a valid URL` });
      return;
    }
    if (!protocols.includes(parsed.protocol)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must start with ${expected} (received "${parsed.protocol}//")`,
      });
    }
    if (!parsed.hostname) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must include a host` });
    }
  });
}

export const httpUrlSchema = urlWithProtocol(['http:', 'https:'], 'URL');
export const postgresUrlSchema = urlWithProtocol(
  ['postgresql:', 'postgres:'],
  'Database connection string',
);
export const redisUrlSchema = urlWithProtocol(['redis:', 'rediss:'], 'Redis URL');

/** Every Rasta service has these, without exception. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  SERVICE_NAME: z.string().min(1),
  SERVICE_VERSION: z.string().default('0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535),

  // Observability — tracing is opt-out rather than opt-in so that a service
  // deployed without OTel config is still visible, just without a collector.
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrlSchema.optional(),
  OTEL_TRACES_ENABLED: z.coerce.boolean().default(true),
  OTEL_SERVICE_NAMESPACE: z.string().default('rasta'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** Services that own a database. */
export const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrlSchema,
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
});

/** Services that produce or consume domain events. */
export const kafkaEnvSchema = z.object({
  KAFKA_BROKERS: z.string().min(1),
  KAFKA_CLIENT_ID: z.string().min(1),
  KAFKA_CONSUMER_GROUP: z.string().min(1).optional(),
  KAFKA_SCHEMA_STRICT: z.coerce.boolean().default(true),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
});

/** Services that use cache, distributed locks or rate limiting. */
export const redisEnvSchema = z.object({
  REDIS_URL: redisUrlSchema,
  REDIS_KEY_PREFIX: z.string().default('rasta'),
});

/** Services that verify caller identity — which is all of them. */
export const authEnvSchema = z.object({
  OIDC_ISSUER_URL: httpUrlSchema,
  OIDC_JWKS_URI: httpUrlSchema,
  OIDC_AUDIENCE: z.string().min(1),
  /**
   * Shared secret for service-to-service tokens.
   *
   * MVP simplification, logged as risk S-03: production replaces this with
   * mTLS and per-workload identity (ADR-020). The 32-character floor is the
   * minimum for HS256 to be meaningfully secure.
   */
  INTERNAL_TOKEN_SECRET: z.string().min(32),
  INTERNAL_TOKEN_ISSUER: z.string().default('rasta-internal'),
  INTERNAL_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
});

export type EnvIssue = { path: string; message: string };

export class EnvValidationError extends Error {
  constructor(public readonly issues: EnvIssue[]) {
    const detail = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    super(`Invalid environment configuration:\n${detail}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates `source` against `schema` and returns the parsed, typed result.
 * Throws {@link EnvValidationError} listing *every* problem at once — fixing
 * one missing variable per restart is a miserable way to configure 17 services.
 */
export function loadEnv<S extends z.ZodTypeAny>(
  schema: S,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  return result.data;
}

export function isProduction(env: Pick<BaseEnv, 'NODE_ENV'>): boolean {
  return env.NODE_ENV === 'production';
}

export function isTest(env: Pick<BaseEnv, 'NODE_ENV'>): boolean {
  return env.NODE_ENV === 'test';
}

/**
 * True when the service should expose developer affordances — Swagger UI,
 * verbose errors, seed endpoints. Deliberately a single predicate so that
 * "is this safe to expose?" is decided in one place rather than re-derived
 * from NODE_ENV at each call site.
 */
export function allowsDeveloperTooling(env: Pick<BaseEnv, 'NODE_ENV'>): boolean {
  return env.NODE_ENV !== 'production';
}

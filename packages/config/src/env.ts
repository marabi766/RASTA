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

/**
 * A boolean read from an environment variable.
 *
 * **Not `z.coerce.boolean()`.** That applies JavaScript's `Boolean()`, and
 * every non-empty string is truthy — so `FLAG=false`, `FLAG=0` and `FLAG=no`
 * all parse as `true`. A flag that cannot be turned off is worse than no flag:
 * an operator sets it, reads it back from their own configuration, and
 * believes the feature is disabled.
 *
 * This accepts the spellings people actually write, in either case, and
 * refuses anything else rather than guessing — a typo in a security switch
 * should fail at boot rather than silently pick a default.
 *
 * This is the single boolean environment parser for the platform (D-020).
 * Every boolean environment flag reads through it; a service that hand-rolls
 * `z.string().transform((v) => v !== 'false')` reintroduces the same class of
 * defect one spelling at a time — `FLAG=0`, `FLAG=off` and `FLAG=FALSE` all
 * come back `true` under that transform.
 *
 * The accepted spellings, trimmed and case-insensitive:
 *
 *   - true:  `true`, `1`, `yes`, `on`
 *   - false: `false`, `0`, `no`, `off`, and an empty value
 *
 * An empty value is `false`, not "unset": `FLAG=` in a `.env` file is an
 * operator writing something deliberate, and it must not fall through to a
 * `true` default. Anything else is a validation error.
 */
export function booleanEnv(defaultValue: boolean) {
  return booleanish(defaultValue);
}

/**
 * The accepted spellings, in one place.
 *
 * `booleanEnv` and `queryBoolean` are the same parser wearing two labels, and
 * they have to stay that way: the moment an environment flag and a query
 * parameter disagree about what `"off"` means, one of them is a defect waiting
 * to be found.
 */
function booleanish(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      if (typeof value === 'boolean') return value;

      const normalised = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'off', ''].includes(normalised)) return false;

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected a boolean such as "true" or "false", received "${value}"`,
      });
      return z.NEVER;
    });
}

/**
 * Marks a schema as "logically a boolean", carrying the default it publishes.
 *
 * Read with `queryBooleanDefault` by the OpenAPI converters. A symbol rather
 * than a wrapper type so the schema stays an ordinary Zod schema everywhere
 * else — nothing downstream has to know this exists to keep working.
 */
const QUERY_BOOLEAN = Symbol.for('rasta.openapi.queryBoolean');

/**
 * A boolean read from an HTTP query parameter.
 *
 * The runtime half is `booleanEnv`'s, unchanged: a query string carries the
 * same problem an environment variable does, because in both a boolean
 * arrives as text. `?flag=false` under `z.coerce.boolean()` is `true`, and the
 * caller gets the opposite of what they asked for with no error to notice
 * (D-023).
 *
 * The half `booleanEnv` cannot do alone is the **published** contract. Its
 * runtime shape is a `boolean | string` union, and a converter that publishes
 * that shape literally emits `anyOf: [boolean, string]` — which tells a
 * generated client the parameter takes arbitrary strings when the parser
 * rejects every string but eight, and costs it a `boolean` in its typed
 * signature. OpenAPI already defines how a boolean is carried in a query
 * string; saying `type: boolean` is both true and enough.
 *
 * So the accepted-input shape and the published-output shape come from this
 * one call, and cannot drift apart the way two hand-maintained definitions do.
 */
export function queryBoolean(defaultValue: boolean) {
  const schema = booleanish(defaultValue);

  Object.defineProperty(schema, QUERY_BOOLEAN, {
    value: defaultValue,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return schema;
}

/**
 * The default a `queryBoolean` publishes, or `undefined` for anything else.
 *
 * The OpenAPI converters consult this before unwrapping a schema, so a query
 * boolean is published as `{ type: 'boolean', default }` rather than as the
 * union its runtime accepts.
 */
export function queryBooleanDefault(schema: unknown): boolean | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;

  const marker = (schema as Record<symbol, unknown>)[QUERY_BOOLEAN];
  return typeof marker === 'boolean' ? marker : undefined;
}

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
  OTEL_TRACES_ENABLED: booleanEnv(true),
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
  KAFKA_SCHEMA_STRICT: booleanEnv(true),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),

  /**
   * How long a claim owns its rows before another relay may take them back
   * (ADR-050).
   *
   * The floor is 20 rather than 10 seconds, and that is load-bearing. The
   * renewal interval is `lease / 4`, so three renewals are attempted before a
   * lease expires and two may be lost without losing ownership. At a 10-second
   * lease the interval would be 2.5s and the last attempt would land on the
   * expiry instant itself — zero tolerance, which is what the first draft of
   * this ADR claimed to have and did not.
   *
   * 60 is chosen after that analysis, not before it: with renewal the lease no
   * longer has to outlast the worst publish (measured at up to 379 seconds for
   * a single `sendBatch`), it only has to hold three renewal intervals and stay
   * shorter than an acceptable recovery delay.
   */
  OUTBOX_CLAIM_LEASE_SECONDS: z.coerce.number().int().min(20).max(3600).default(60),

  /** Base of the capped exponential retry backoff: `min(2^min(n,10) × base, max)`. */
  OUTBOX_CLAIM_BACKOFF_SECONDS: z.coerce.number().int().min(1).max(3600).default(5),

  /** Ceiling of that backoff, so a poisoned row is retried eventually. */
  OUTBOX_CLAIM_BACKOFF_MAX_SECONDS: z.coerce.number().int().min(1).max(86_400).default(3600),

  /**
   * How long shutdown keeps renewing a lease whose publish is still in flight.
   *
   * Bounded, so a pod cannot sit in `Terminating` behind a Kafka request that
   * KafkaJS gives no way to cancel. When it elapses the relay stops renewing
   * and abandons the row *without releasing it* — releasing a row that may
   * already have reached the broker guarantees a replay, whereas letting the
   * lease lapse replays only if it genuinely has to.
   */
  OUTBOX_SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
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

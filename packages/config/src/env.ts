import { z } from 'zod';
import { DatabaseUrlConflictError, withDatabasePool } from './database-pool';
import { withStatementTimeout, withUtcSession } from './database-session';

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

/**
 * How long shutdown waits for the application to close (in-flight requests,
 * consumers, relays, sweepers) before giving up and exiting non-zero.
 *
 * 25 s sits under the 30 s Kubernetes grace period, leaving room for the
 * telemetry flush that follows, so the process chooses how it ends instead of
 * being SIGKILLed mid-close.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

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

  // Bounded, and bounded *below* the orchestrator's own grace period: see
  // `installGracefulShutdown` in @rasta/nest-common.
  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * The largest `DATABASE_POOL_SIZE`: one replica holding half the production
 * cluster's `max_connections` (200, docs/11 § 11.2) is already more than any
 * service should.
 */
export const DATABASE_POOL_SIZE_MAX = 100;

/**
 * The longest `DATABASE_POOL_TIMEOUT_SECONDS`. A request that has waited a
 * minute for a connection has long been given up on by its caller.
 */
export const DATABASE_POOL_TIMEOUT_SECONDS_MAX = 60;

/** Below a second, ordinary queries under load would be cancelled. */
export const DATABASE_STATEMENT_TIMEOUT_MS_MIN = 1000;

/** An hour: past that, a runtime statement is a stuck one. */
export const DATABASE_STATEMENT_TIMEOUT_MS_MAX = 3_600_000;

/**
 * A whole number read from an environment variable, refused unless it is
 * written as plain digits.
 *
 * Stricter than `z.coerce.number()` on purpose: that reads `1e1` as 10, `0x10`
 * as 16 and an empty value as 0. For a setting that sizes a production pool,
 * anything but the number the operator meant fails at boot.
 */
function wholeNumberEnv(min: number, max: number) {
  return z
    .string()
    .regex(/^[0-9]+$/, 'Expected a whole number written as digits, such as "10"')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

/**
 * Services that own a database.
 *
 * `DATABASE_URL` comes out with `options=-c TimeZone=UTC` added
 * ({@link withUtcSession}): every client a service opens on it — the runtime
 * pool, the startup role check, a CLI — runs its sessions in UTC whatever the
 * server's or the role's default (L7-37).
 *
 * The pool is sized from configuration the same way: `loadEnv` writes
 * `DATABASE_POOL_SIZE` and `DATABASE_POOL_TIMEOUT_SECONDS` into that URL as
 * Prisma's `connection_limit` and `pool_timeout` ({@link withDatabasePool}).
 * Both are optional, and unset means Prisma's own default (`num_physical_cpus
 * * 2 + 1` connections, a 10-second wait) — what every service ran with before
 * they existed. `0` is refused for the wait: to Prisma it means waiting
 * forever, which is the unbounded queue a bounded pool exists to prevent.
 *
 * `DATABASE_STATEMENT_TIMEOUT_MS` goes into the same URL as the session's
 * `statement_timeout` ({@link withStatementTimeout}), so no runtime statement —
 * a lock wait included — holds a pooled connection longer. **Opt-in** (#268
 * r4): unset, nothing is written and the session keeps the database's own
 * setting, as before the variable existed. Set, it must be above every
 * operation budget the service declares ({@link OperationBudget}), or `loadEnv`
 * refuses it; `0` (PostgreSQL's "no limit") is refused for the same reason as
 * the pool's. The migrators never read it (D-045).
 */
export const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrlSchema.transform(withUtcSession),
  DATABASE_POOL_SIZE: wholeNumberEnv(1, DATABASE_POOL_SIZE_MAX).optional(),
  DATABASE_POOL_TIMEOUT_SECONDS: wholeNumberEnv(1, DATABASE_POOL_TIMEOUT_SECONDS_MAX).optional(),
  DATABASE_STATEMENT_TIMEOUT_MS: wholeNumberEnv(
    DATABASE_STATEMENT_TIMEOUT_MS_MIN,
    DATABASE_STATEMENT_TIMEOUT_MS_MAX,
  ).optional(),
});

/** The only SASL mechanism a broker credential is issued for (ADR-061 § 3). */
export const KAFKA_SASL_MECHANISMS = ['scram-sha-512'] as const;

/** Services that produce or consume domain events. */
export const kafkaEnvSchema = z.object({
  KAFKA_BROKERS: z.string().min(1),
  KAFKA_CLIENT_ID: z.string().min(1),
  KAFKA_CONSUMER_GROUP: z.string().min(1).optional(),
  KAFKA_SCHEMA_STRICT: booleanEnv(true),

  /**
   * The service's broker credential (ADR-061 § 3, RUN-006): SASL/SCRAM, one
   * principal per service, named after it. Both absent means PLAINTEXT, which
   * `kafkaConnection` (`nest-common`) refuses unless `KAFKA_ALLOW_PLAINTEXT`
   * is explicitly allowed in development or test.
   *
   * Never committed: `.env.example` holds placeholders only. When
   * `KAFKA_SASL_PASSWORD` is unset, `loadEnv` reads
   * `KAFKA_SASL_PASSWORD_<SERVICE>` (`fleet-service` → `..._FLEET`), so one
   * repository `.env` can describe every service, as it does for
   * `DATABASE_URL_<SERVICE>`. The username defaults to `SERVICE_NAME`.
   */
  KAFKA_SASL_USERNAME: z.string().min(1).max(64).optional(),
  KAFKA_SASL_PASSWORD: z.string().min(1).optional(),
  KAFKA_SASL_MECHANISM: z.enum(KAFKA_SASL_MECHANISMS).default('scram-sha-512'),

  /** TLS to the broker. Required together with SASL unless PLAINTEXT is allowed below. */
  KAFKA_SSL: booleanEnv(false),
  /**
   * The explicit opt-out from the broker credential and TLS (ADR-061 § 3,
   * RUN-006): PLAINTEXT is allowed only with this `true` **and** `NODE_ENV`
   * set explicitly to `development` or `test` ({@link KAFKA_PLAINTEXT_ENVIRONMENTS}).
   * Everywhere else — `staging`, `production`, or `NODE_ENV` left unset — a
   * service connects with its SASL credential and `KAFKA_SSL=true` or refuses
   * to start. Secure by default: forgetting a variable fails closed.
   */
  KAFKA_ALLOW_PLAINTEXT: booleanEnv(false),
  /** PEM file of the CA that signed the broker's certificate; absent = the system trust store. */
  KAFKA_SSL_CA_FILE: z.string().min(1).optional(),

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
   *
   * Must be **shorter than `SHUTDOWN_TIMEOUT_MS`** (`loadEnv` refuses the
   * combination otherwise): the process gives up and exits after that timeout,
   * so a longer grace is a wait the process will never get to finish — the
   * abandon-without-release path would be unreachable and every slow publish
   * would end as a forced exit. The default, 20 s, sits under the default
   * 25 s timeout; it was 30 s, which did not.
   */
  OUTBOX_SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().min(0).max(300).default(20),
});

export type KafkaEnv = z.infer<typeof kafkaEnvSchema>;

/**
 * The scheduled purge of published outbox rows (D-052), for a service that
 * runs one (`OutboxPurgeScheduler` in @rasta/nest-common).
 *
 * Its own schema rather than part of {@link kafkaEnvSchema}: a service merges
 * it when it wires the purge, so a service that has not yet done so does not
 * accept settings it would silently ignore. Every value is bounded and an
 * invalid one stops the service at boot — an empty or misspelled retention
 * must never fall through to "delete everything published".
 */
export const outboxPurgeEnvSchema = z.object({
  /**
   * On by default. Off is a deliberate operator choice, logged at startup,
   * because without the purge `outbox_message` grows without bound (D-052).
   */
  OUTBOX_PURGE_ENABLED: booleanEnv(true),

  /**
   * How long a row is kept after it was published, by the database clock.
   *
   * 168 h is not a new number: it is the seven days `purgePublished` has
   * defaulted to since ADR-050, the window that ADR's sizing argument assumes.
   * The relay never reads a published row again, nor does `stream_seq`
   * allocation (it reads `outbox_stream_sequence` only), so the window serves
   * operators — answering "was this event published, and when?" from the
   * producer's own table during an incident — and is theirs to tune. The floor
   * of one hour refuses a typo that would empty that record as fast as it
   * fills; the ceiling of a year refuses one that would make the purge a no-op.
   */
  OUTBOX_PURGE_RETENTION_HOURS: z.coerce.number().int().min(1).max(8760).default(168),

  /**
   * Pause between the end of one run and the start of the next. A row outlives
   * its retention by at most one interval plus one run — five minutes against a
   * 168-hour window — while an idle run costs a single indexed probe.
   */
  OUTBOX_PURGE_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(86_400).default(300),

  /**
   * Rows deleted per statement. 1000 is the ceiling `OUTBOX_BATCH_SIZE`
   * already allows the relay to lock in one claim, so a purge batch locks no
   * more outbox rows at once than the platform's own relay may.
   */
  OUTBOX_PURGE_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(1000),

  /**
   * Batches per run, so one run is bounded in time too. A run that hits the
   * cap reports `truncated` and the next continues; together with the defaults
   * above that is 10 000 rows per run, 120 000 an hour.
   */
  OUTBOX_PURGE_MAX_BATCHES_PER_RUN: z.coerce.number().int().min(1).max(1000).default(10),

  /**
   * `statement_timeout` for each batch. Bounds how long one batch can hold its
   * row locks or keep a migration's lock request queued behind it. Part of the
   * batch bound that `loadEnv` holds under `SHUTDOWN_TIMEOUT_MS`
   * ({@link outboxPurgeBatchBoundMs}).
   */
  OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),

  /**
   * How long a batch may wait for a pooled connection before its transaction
   * starts (Prisma's `maxWait`). Not covered by `statement_timeout`, which
   * starts only once there is a connection, so it is budgeted on its own: a
   * pool busy with request traffic makes a batch give up and the run end as
   * `failed`, rather than queue behind the service's own work. Part of the
   * batch bound ({@link outboxPurgeBatchBoundMs}).
   */
  OUTBOX_PURGE_MAX_WAIT_MS: z.coerce.number().int().min(100).max(60_000).default(2000),
});

export type OutboxPurgeEnv = z.infer<typeof outboxPurgeEnvSchema>;

/**
 * Prisma's transaction `timeout` for a purge batch is its `statement_timeout`
 * plus this, so the database's statement timeout is what ends a slow DELETE
 * (a clean error, locks released) rather than Prisma abandoning the
 * transaction first. The margin also covers the batch's other round trips —
 * `SET LOCAL`, the advisory-lock probe and COMMIT.
 */
export const OUTBOX_PURGE_TRANSACTION_MARGIN_MS = 5_000;

/**
 * The longest one purge batch can take: waiting for a connection, then
 * running to Prisma's transaction timeout. A stopping scheduler waits for at
 * most one batch, so this is also what shutdown waits for the purge, and
 * `loadEnv` refuses a configuration where it does not fit the shutdown's
 * outbox budget ({@link outboxShutdownBudgetMs}).
 */
export function outboxPurgeBatchBoundMs(settings: {
  maxWaitMs: number;
  statementTimeoutMs: number;
}): number {
  return settings.maxWaitMs + settings.statementTimeoutMs + OUTBOX_PURGE_TRANSACTION_MARGIN_MS;
}

/**
 * The part of `SHUTDOWN_TIMEOUT_MS` kept back from the outbox drain, for what
 * `app.close()` still does after it: Nest's `beforeApplicationShutdown`, the
 * HTTP server close and `onApplicationShutdown`. Those wait on nothing of the
 * outbox's — the drain has returned, its abandoned work bounded by the
 * database's own timeouts — so they need a short, fixed allowance, not a share
 * of a batch. 2 s is that allowance; with the default timeout (25 s) the
 * budget is 23 s, which the relay's default grace (20 s) and the purge's
 * default batch bound (12 s) both fit.
 */
export const OUTBOX_SHUTDOWN_RESERVE_MS = 2_000;

/**
 * How long the outbox drain may take in a service that runs both the relay
 * and the purge (`OutboxShutdown` in @rasta/nest-common): one deadline, shared
 * by the two, which drain concurrently from the start of Nest's destroy phase.
 * `loadEnv` refuses a configuration in which either one's own bound — the
 * relay's grace, the purge's batch bound — does not fit inside it, so the
 * shared deadline only ever cuts a wait that something else already went
 * wrong in.
 */
export function outboxShutdownBudgetMs(env: { SHUTDOWN_TIMEOUT_MS: number }): number {
  return env.SHUTDOWN_TIMEOUT_MS - OUTBOX_SHUTDOWN_RESERVE_MS;
}

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

/**
 * The environments in which `KAFKA_ALLOW_PLAINTEXT=true` is honoured, as
 * `DEMO_SEED_ENVIRONMENTS` is for seeds: `staging` holds data somebody cares
 * about, and an unset `NODE_ENV` is refused rather than read as its
 * `development` default.
 */
export const KAFKA_PLAINTEXT_ENVIRONMENTS = ['development', 'test'] as const;

/**
 * Whether this service may reach Kafka without a credential and TLS: the
 * explicit opt-out, in a development or test environment. `kafkaConnection`
 * (`nest-common`) refuses everything else that lacks SASL and TLS.
 */
export function kafkaPlaintextAllowed(
  env: Pick<BaseEnv, 'NODE_ENV'> & Partial<Pick<KafkaEnv, 'KAFKA_ALLOW_PLAINTEXT'>>,
): boolean {
  return (
    env.KAFKA_ALLOW_PLAINTEXT === true &&
    (KAFKA_PLAINTEXT_ENVIRONMENTS as readonly string[]).includes(env.NODE_ENV)
  );
}

export type EnvIssue = { path: string; message: string };

export class EnvValidationError extends Error {
  constructor(public readonly issues: EnvIssue[]) {
    const detail = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    super(`Invalid environment configuration:\n${detail}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Room for the database work a lock holder does around its upstream calls,
 * where its transaction's own timeout is a fixed allowance rather than one
 * derived from its settings: the 5 s fleet's asset-sync budget already allows.
 */
export const STATEMENT_WAIT_MARGIN_MS = 5_000;

/**
 * One operation a service supports on its runtime database, and how long it
 * is allowed to take (#268 r4): a transaction's timeout, a lock or claim wait,
 * a contention budget, a sweep's batch. A statement inside it — a lock wait
 * included — may legitimately run that long, so a session `statement_timeout`
 * at or below it would cancel a supported operation (`57014`): one that is
 * merely slow would fail, and one that answers its own timeout with 409 would
 * answer 500.
 */
export interface OperationBudget {
  /** The setting it is configured by, or the constant it is fixed at. */
  readonly name: string;
  /** The budget at the configured values, in milliseconds. */
  readonly budgetMs: number;
  /** What it bounds, and how the number is made up. */
  readonly derivation: string;
}

/** Prisma's interactive-transaction `timeout` when a call passes none (Prisma 6). */
export const PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS = 5_000;

/** The budget of every interactive transaction that sets no timeout of its own. */
export const PRISMA_DEFAULT_TRANSACTION_BUDGET: OperationBudget = {
  name: 'PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS',
  budgetMs: PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS,
  derivation:
    'every interactive transaction that sets no timeout of its own, at Prisma’s default: a ' +
    'statement in one may wait on a lock that long',
};

/** One outbox purge batch (D-052), as an operation budget: its transaction's timeout. */
export function outboxPurgeOperationBudget(
  env: Pick<OutboxPurgeEnv, 'OUTBOX_PURGE_STATEMENT_TIMEOUT_MS'>,
): OperationBudget {
  return {
    name: 'OUTBOX_PURGE_STATEMENT_TIMEOUT_MS',
    budgetMs: env.OUTBOX_PURGE_STATEMENT_TIMEOUT_MS + OUTBOX_PURGE_TRANSACTION_MARGIN_MS,
    derivation:
      'one outbox purge batch: its own statement timeout, this setting, + ' +
      `${OUTBOX_PURGE_TRANSACTION_MARGIN_MS} ms`,
  };
}

/**
 * An `Idempotency-Key` claim, as an operation budget: each of its waits runs
 * in its own transaction whose `lock_timeout` is what is left of `waitMs`, and
 * whose timeout is that + `slackMs`. A statement timeout under the wait would
 * end it with `57014` instead of `55P03`, and the retryable 409 would be a 500.
 */
export function idempotencyClaimOperationBudget(
  name: string,
  waitMs: number,
  slackMs: number,
): OperationBudget {
  return {
    name,
    budgetMs: waitMs + slackMs,
    derivation:
      `an Idempotency-Key claim: a lock wait of up to ${waitMs} ms in a transaction of that ` +
      `+ ${slackMs} ms`,
  };
}

/** What a service hands `loadEnv` besides its schema. */
export interface LoadEnvOptions<T> {
  /**
   * Every operation budget the service has, at the parsed values. Required
   * for `DATABASE_STATEMENT_TIMEOUT_MS` to be accepted at all: a service that
   * declares none is refused one rather than trusted to have none (fail
   * closed). Not consulted while the variable is unset.
   */
  readonly operationBudgets?: (env: T) => readonly OperationBudget[];
}

/**
 * Validates `source` against `schema` and returns the parsed, typed result.
 * Throws {@link EnvValidationError} listing *every* problem at once — fixing
 * one missing variable per restart is a miserable way to configure 17 services.
 */
export function loadEnv<S extends z.ZodTypeAny>(
  schema: S,
  source: NodeJS.ProcessEnv = process.env,
  options: LoadEnvOptions<z.infer<S>> = {},
): z.infer<S> {
  const result = schema.safeParse(withKafkaCredentialFallback(source));

  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  assertKafkaPlaintextOptOut(source, result.data);
  assertOutboxGraceWithinShutdown(result.data);
  assertOutboxShutdownWithinTimeout(result.data);
  assertStatementTimeoutAboveBudgets(result.data, options.operationBudgets);
  return withConfiguredDatabase(result.data);
}

/**
 * A configured `DATABASE_STATEMENT_TIMEOUT_MS` must be above every operation
 * budget the service declares (#268 r4), so it can never cancel an operation
 * the service supports. Equal is refused too: the two timeouts would race.
 * Unset, there is nothing to check — no statement timeout is applied.
 */
function assertStatementTimeoutAboveBudgets<T>(
  parsed: T,
  operationBudgets: ((env: T) => readonly OperationBudget[]) | undefined,
): void {
  if (typeof parsed !== 'object' || parsed === null) return;
  const { DATABASE_URL: url, DATABASE_STATEMENT_TIMEOUT_MS: timeoutMs } = parsed as {
    DATABASE_URL?: unknown;
    DATABASE_STATEMENT_TIMEOUT_MS?: unknown;
  };
  if (typeof url !== 'string' || typeof timeoutMs !== 'number') return;
  if (!operationBudgets) {
    throw new EnvValidationError([
      {
        path: 'DATABASE_STATEMENT_TIMEOUT_MS',
        message:
          'is set, but this service declares no operation budgets to check it against, so it ' +
          'could cancel an operation the service supports. Leave it unset',
      },
    ]);
  }
  const budgets = operationBudgets(parsed);
  const undercut = budgets.filter((budget) => budget.budgetMs >= timeoutMs);
  if (undercut.length === 0) return;
  const largest = budgets.reduce((max, budget) => Math.max(max, budget.budgetMs), 0);
  throw new EnvValidationError(
    undercut.map((budget) => ({
      path: 'DATABASE_STATEMENT_TIMEOUT_MS',
      message:
        `(${timeoutMs} ms) is not above ${budget.name}, ${budget.budgetMs} ms ` +
        `(${budget.derivation}), so it would cancel that operation first. Set it above ` +
        `${largest} ms, this service's largest operation budget, or leave it unset`,
    })),
  );
}

/**
 * `DATABASE_URL` with the configured pool and statement timeout written into
 * it, for a service whose schema has `databaseEnvSchema`. Done here rather than
 * in that schema: the URL and the settings are siblings, and a transform over
 * the object would stop it being `.merge`d into each service's schema.
 */
function withConfiguredDatabase<T>(parsed: T): T {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const {
    DATABASE_URL: url,
    DATABASE_POOL_SIZE: size,
    DATABASE_POOL_TIMEOUT_SECONDS: timeoutSeconds,
    DATABASE_STATEMENT_TIMEOUT_MS: statementTimeoutMs,
  } = parsed as {
    DATABASE_URL?: unknown;
    DATABASE_POOL_SIZE?: unknown;
    DATABASE_POOL_TIMEOUT_SECONDS?: unknown;
    DATABASE_STATEMENT_TIMEOUT_MS?: unknown;
  };
  if (typeof url !== 'string') return parsed;
  const pool = {
    size: typeof size === 'number' ? size : undefined,
    timeoutSeconds: typeof timeoutSeconds === 'number' ? timeoutSeconds : undefined,
  };
  try {
    const timed = withStatementTimeout(
      url,
      typeof statementTimeoutMs === 'number' ? statementTimeoutMs : undefined,
    );
    const configured = withDatabasePool(timed, pool);
    return configured === url ? parsed : { ...parsed, DATABASE_URL: configured };
  } catch (error) {
    if (!(error instanceof DatabaseUrlConflictError)) throw error;
    throw new EnvValidationError([{ path: error.variable, message: error.message }]);
  }
}

/**
 * The whole outbox shutdown path of a service with the purge, as one worst
 * case. The relay's grace and the purge's batch bound
 * ({@link outboxPurgeBatchBoundMs}: the wait for a connection and the
 * transaction both) run concurrently against one deadline (`OutboxShutdown`),
 * so the path takes the longer of the two — never their sum — and that must
 * fit in {@link outboxShutdownBudgetMs}, which leaves
 * {@link OUTBOX_SHUTDOWN_RESERVE_MS} of `SHUTDOWN_TIMEOUT_MS` for the rest of
 * the close. Checking each bound against the timeout on its own let a
 * configuration pass whose two waits, run one after the other, overran it.
 */
function assertOutboxShutdownWithinTimeout(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) return;
  const {
    OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: statementTimeoutMs,
    OUTBOX_PURGE_MAX_WAIT_MS: maxWaitMs,
    OUTBOX_SHUTDOWN_GRACE_SECONDS: grace,
    SHUTDOWN_TIMEOUT_MS: timeoutMs,
  } = parsed as {
    OUTBOX_PURGE_STATEMENT_TIMEOUT_MS?: unknown;
    OUTBOX_PURGE_MAX_WAIT_MS?: unknown;
    OUTBOX_SHUTDOWN_GRACE_SECONDS?: unknown;
    SHUTDOWN_TIMEOUT_MS?: unknown;
  };
  if (
    typeof statementTimeoutMs !== 'number' ||
    typeof maxWaitMs !== 'number' ||
    typeof timeoutMs !== 'number'
  ) {
    return;
  }
  const purgeMs = outboxPurgeBatchBoundMs({ maxWaitMs, statementTimeoutMs });
  const graceMs = typeof grace === 'number' ? grace * 1000 : 0;
  const budgetMs = outboxShutdownBudgetMs({ SHUTDOWN_TIMEOUT_MS: timeoutMs });
  const issues: EnvIssue[] = [];
  if (purgeMs > budgetMs) {
    issues.push({
      path: 'OUTBOX_PURGE_STATEMENT_TIMEOUT_MS',
      message:
        `with OUTBOX_PURGE_MAX_WAIT_MS, one purge batch may take ${purgeMs} ms ` +
        `(${maxWaitMs} ms waiting for a connection + ${statementTimeoutMs} ms statement + ` +
        `${OUTBOX_PURGE_TRANSACTION_MARGIN_MS} ms transaction margin), more than the outbox ` +
        `shutdown budget of ${budgetMs} ms (SHUTDOWN_TIMEOUT_MS ${timeoutMs} ms − ` +
        `${OUTBOX_SHUTDOWN_RESERVE_MS} ms for the rest of the close): shutdown waits for the ` +
        'batch in flight. Lower either purge setting, or raise SHUTDOWN_TIMEOUT_MS (and keep it ' +
        'under the orchestrator’s termination period)',
    });
  }
  if (graceMs > budgetMs) {
    issues.push({
      path: 'OUTBOX_SHUTDOWN_GRACE_SECONDS',
      message:
        `(${grace} s) is more than the outbox shutdown budget of ${budgetMs} ms ` +
        `(SHUTDOWN_TIMEOUT_MS ${timeoutMs} ms − ${OUTBOX_SHUTDOWN_RESERVE_MS} ms for the rest of ` +
        'the close), which the relay shares with the purge. Lower the grace or raise ' +
        'SHUTDOWN_TIMEOUT_MS (and keep it under the orchestrator’s termination period)',
    });
  }
  if (issues.length > 0) throw new EnvValidationError(issues);
}

/**
 * The outbox relay's shutdown grace must end before the process's own shutdown
 * timeout does. Two numbers from two schemas (`kafkaEnvSchema`,
 * `baseEnvSchema`) cannot be compared by either, so the comparison is made
 * here, on the merged result, and only for a service that has both.
 */
function assertOutboxGraceWithinShutdown(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) return;
  const { OUTBOX_SHUTDOWN_GRACE_SECONDS: grace, SHUTDOWN_TIMEOUT_MS: timeoutMs } = parsed as {
    OUTBOX_SHUTDOWN_GRACE_SECONDS?: unknown;
    SHUTDOWN_TIMEOUT_MS?: unknown;
  };
  if (typeof grace !== 'number' || typeof timeoutMs !== 'number') return;
  if (grace * 1000 < timeoutMs) return;
  throw new EnvValidationError([
    {
      path: 'OUTBOX_SHUTDOWN_GRACE_SECONDS',
      message:
        `(${grace} s) must be shorter than SHUTDOWN_TIMEOUT_MS (${timeoutMs} ms): the process ` +
        'exits when that timeout ends, so a longer grace could never finish. Lower the grace ' +
        'or raise SHUTDOWN_TIMEOUT_MS (and keep it under the orchestrator’s termination period)',
    },
  ]);
}

/**
 * `KAFKA_ALLOW_PLAINTEXT=true` anywhere it is not honoured is refused at boot
 * rather than ignored: an operator who set it believes it does something. The
 * check reads `NODE_ENV` as given, so an unset one — which the schema would
 * default to `development` — does not count as development.
 */
function assertKafkaPlaintextOptOut(source: NodeJS.ProcessEnv, parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) return;
  if ((parsed as { KAFKA_ALLOW_PLAINTEXT?: unknown }).KAFKA_ALLOW_PLAINTEXT !== true) return;
  const given = source.NODE_ENV?.trim();
  if (given && (KAFKA_PLAINTEXT_ENVIRONMENTS as readonly string[]).includes(given)) return;
  throw new EnvValidationError([
    {
      path: 'KAFKA_ALLOW_PLAINTEXT',
      message:
        `is honoured only with NODE_ENV set explicitly to ${KAFKA_PLAINTEXT_ENVIRONMENTS.join(' or ')}; ` +
        'anywhere else the service connects with its SASL credential and KAFKA_SSL=true (ADR-061 § 3)',
    },
  ]);
}

/**
 * `KAFKA_SASL_PASSWORD_<SERVICE>` for a service that has no
 * `KAFKA_SASL_PASSWORD`, and `SERVICE_NAME` as the username that goes with it.
 * Reading only: nothing is invented, and an empty value counts as unset.
 */
function withKafkaCredentialFallback(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const withoutEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value.length === 0 ? undefined : value;
  const service = withoutEmpty(source.SERVICE_NAME);
  const own = withoutEmpty(source.KAFKA_SASL_PASSWORD);
  const shared = service ? withoutEmpty(source[kafkaPasswordVariable(service)]) : undefined;
  const password = own ?? shared;
  const username = withoutEmpty(source.KAFKA_SASL_USERNAME) ?? (password ? service : undefined);

  const resolved: NodeJS.ProcessEnv = { ...source };
  delete resolved.KAFKA_SASL_PASSWORD;
  delete resolved.KAFKA_SASL_USERNAME;
  if (password !== undefined) resolved.KAFKA_SASL_PASSWORD = password;
  if (username !== undefined) resolved.KAFKA_SASL_USERNAME = username;
  return resolved;
}

/** `fleet-service` → `KAFKA_SASL_PASSWORD_FLEET`, the name the repository `.env` uses. */
export function kafkaPasswordVariable(serviceName: string): string {
  const stem = serviceName
    .replace(/-service$/, '')
    .replace(/-/g, '_')
    .toUpperCase();
  return `KAFKA_SASL_PASSWORD_${stem}`;
}

/** Whether this service has a broker credential, i.e. connects with SASL rather than PLAINTEXT. */
export function kafkaSaslConfigured(
  env: Partial<Pick<KafkaEnv, 'KAFKA_SASL_USERNAME' | 'KAFKA_SASL_PASSWORD'>>,
): boolean {
  return Boolean(env.KAFKA_SASL_USERNAME) && Boolean(env.KAFKA_SASL_PASSWORD);
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

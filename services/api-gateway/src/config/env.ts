import { z } from 'zod';
import { authEnvSchema, baseEnvSchema, booleanEnv, redisEnvSchema, loadEnv } from '@rasta/config';
import { serviceUrlEnvSchema } from './routes';
import { trustedProxiesSchema } from '../http/trust-proxy';

/**
 * `GATEWAY_TENDER_OPEN_TIMEOUT_MS` (Codex r2 on #250, G1): construction-service's own opening
 * timeout runs from 5 s to 120 s (default 30 s), and around it the opening makes up to five calls
 * to identity-service and audit-service of 5 s each by default (30 + 25 = 55 s). The default
 * covers that; the ceiling leaves room for construction's own ceiling.
 */
export const TENDER_OPEN_DEADLINE_MIN_MS = 5_000;
export const TENDER_OPEN_DEADLINE_MAX_MS = 180_000;
export const TENDER_OPEN_DEADLINE_DEFAULT_MS = 60_000;

/**
 * The revocation list (ADR-060, gateway revocation list addendum). `off` is
 * ADR-060 § 7 as accepted for the MVP: a demotion takes effect within the
 * access-token lifetime plus the clock tolerance. `enforce` refuses a
 * revoked pair within Kafka lag, and fails closed when it cannot tell.
 */
export const REVOCATION_LIST_MODES = ['off', 'enforce'] as const;

/** Where an omitted `GATEWAY_REVOCATION_LIST` means `off`: only these, and only when stated. */
const REVOCATION_LIST_DEFAULT_OFF_ENVIRONMENTS = ['development', 'test'];

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

    /**
     * The upstream deadline of the two routes that open a tender's bids and read every opened
     * bid (`TENDER_OPENING_ROUTES`; Codex r2 on #250, G1); every other route keeps
     * `GATEWAY_UPSTREAM_TIMEOUT_MS`. construction-service decrypts every standing bid there
     * under `CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS` (default 30 s) and asks identity-service and
     * audit-service before and after, so the default 3 s cut off openings that were still
     * running — and might still commit — and counted them against the circuit.
     *
     * **Must stay at least `CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS` plus the calls around the
     * transaction** (by default 30 s, plus 5 s for each of the two identity reads and the evidence
     * read before it and the two identity reads after the commit: 55 s).
     * The two services cannot check each other at startup; `env.spec.ts` holds the defaults
     * together. Out of range, or shorter than the default deadline, refuses to start.
     */
    GATEWAY_TENDER_OPEN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(TENDER_OPEN_DEADLINE_MIN_MS)
      .max(TENDER_OPEN_DEADLINE_MAX_MS)
      .default(TENDER_OPEN_DEADLINE_DEFAULT_MS),
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

    /**
     * Hops allowed to state the client address in `X-Forwarded-For` — the
     * ingress in front of the gateway (L1-03). Addresses, CIDR ranges or
     * `loopback`/`linklocal`/`uniquelocal`; never "all" or a hop count. Empty
     * trusts nobody. See `../http/trust-proxy.ts`.
     */
    GATEWAY_TRUSTED_PROXIES: trustedProxiesSchema,

    /**
     * Required outside development and test: omitting it refuses to start
     * rather than choosing for the operator (`loadGatewayEnv`).
     */
    GATEWAY_REVOCATION_LIST: z.enum(REVOCATION_LIST_MODES),

    /**
     * The longest access-token lifetime the list supports, in seconds: the
     * realm's `accessTokenLifespan` (900 in `rasta-realm.json`; `env.spec.ts`
     * holds `.env.example` to it). A token whose `exp - iat` is longer is
     * refused, because the list would forget a revocation before the token
     * expired. Required with `enforce`.
     */
    GATEWAY_REVOCATION_MAX_TOKEN_LIFETIME_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .optional(),

    /**
     * Clock tolerance for user tokens, in seconds: the verifier accepts a
     * token this long past its `exp`, and the list keeps a revocation that
     * much longer. One value for both, so they cannot drift (addendum § 2).
     */
    GATEWAY_OIDC_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60).default(5),

    /** An enforcing replica not shown caught up for longer than this refuses every pair. */
    GATEWAY_REVOCATION_MAX_STALENESS_SECONDS: z.coerce.number().int().min(5).max(300).default(30),

    /** The list's bound. Reached, a revocation that cannot be stored holds every pair (addendum § 4). */
    GATEWAY_REVOCATION_MAX_ENTRIES: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(10_000_000)
      .default(100_000),
  })
  // A longer deadline for the tender routes only: never one shorter than every other route gets.
  .refine((env) => env.GATEWAY_TENDER_OPEN_TIMEOUT_MS >= env.GATEWAY_UPSTREAM_TIMEOUT_MS, {
    path: ['GATEWAY_TENDER_OPEN_TIMEOUT_MS'],
    message: 'must be at least GATEWAY_UPSTREAM_TIMEOUT_MS',
  })
  .refine(
    (env) =>
      env.GATEWAY_REVOCATION_LIST !== 'enforce' ||
      env.GATEWAY_REVOCATION_MAX_TOKEN_LIFETIME_SECONDS !== undefined,
    {
      path: ['GATEWAY_REVOCATION_MAX_TOKEN_LIFETIME_SECONDS'],
      message: 'is required with GATEWAY_REVOCATION_LIST=enforce',
    },
  )
  // The list is built and tested here; the identity-topic reader that feeds it,
  // and the broker principal it reads as, are EXT-005's second PR. Until then
  // `enforce` would never become ready, so it is refused at boot instead.
  .refine((env) => env.GATEWAY_REVOCATION_LIST !== 'enforce', {
    path: ['GATEWAY_REVOCATION_LIST'],
    message: 'enforce needs the identity-topic reader, which is not in this build yet (EXT-005)',
  });

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

export function loadGatewayEnv(source: NodeJS.ProcessEnv = process.env): GatewayEnv {
  // The raw NODE_ENV, not the schema's default: an unset NODE_ENV is not a
  // statement that this is development.
  const revocationListDefault =
    source.GATEWAY_REVOCATION_LIST === undefined &&
    REVOCATION_LIST_DEFAULT_OFF_ENVIRONMENTS.includes(source.NODE_ENV ?? '')
      ? { GATEWAY_REVOCATION_LIST: 'off' }
      : {};
  return loadEnv(gatewayEnvSchema, {
    ...source,
    ...revocationListDefault,
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

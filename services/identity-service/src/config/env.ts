import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  EnvValidationError,
  fixedEnvMessages,
  kafkaEnvSchema,
  loadEnv,
  outboxPurgeEnvSchema,
  serviceUrlSchema,
} from '@rasta/config';
import { AGGREGATION_WINDOW_SECONDS } from '../security-events/refusal-aggregation';
import { roleSchema, type PlatformRole } from '../identity/dto';
import { DEFAULT_GRANTS, UNGRANTABLE_ROLES, type RoleGrantPolicy } from '../identity/role-grants';
import { identityOperationBudgets } from './operation-budgets';
import {
  DEFAULT_PROVISIONING_SCOPE_POLICY,
  type ProvisioningScopePolicy,
} from '../identity/provisioning-scope';

/** The fixed texts this schema refuses with; `loadEnv` keeps only these verbatim (#385 r2 F2). */
const { fixed, seal } = fixedEnvMessages();

/**
 * A role list's refusals. Fixed: they used to name the entry written (`Unknown role: ${entry}`),
 * which is configuration text and reached the boot log (S-09, #385 r1/r2).
 */
const UNKNOWN_ROLE = fixed('names a role that is not a platform role');
const UNGRANTABLE_ROLE = fixed(
  'names a role that cannot be granted through this API and must not be configured as grantable',
);

/**
 * A comma-separated role list from the environment.
 *
 * Every entry is validated against `PLATFORM_ROLES` at startup, so a typo —
 * `FLEET_MANGER` — fails the deployment rather than silently narrowing
 * somebody's authority to nothing at the first request that needed it. An
 * empty value is legitimate and means *this role grants nothing*; that is a
 * deliberate choice a deployment may make, so it is not confused with unset.
 *
 * `UNGRANTABLE_ROLES` is refused here as well as intersected away in
 * `grantableRoles`. The intersection is what makes the system safe; refusing
 * the value outright is what stops an operator believing they configured
 * something they did not get.
 */
function roleListEnv(
  fallback: readonly PlatformRole[],
  options: { allowUngrantable?: boolean } = {},
) {
  return z
    .string()
    .default(fallback.join(','))
    .transform((value, ctx): readonly PlatformRole[] => {
      const entries = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      const roles: PlatformRole[] = [];
      for (const entry of entries) {
        const parsed = roleSchema.safeParse(entry);
        if (!parsed.success) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: UNKNOWN_ROLE });
          return z.NEVER;
        }
        if (!options.allowUngrantable && UNGRANTABLE_ROLES.includes(parsed.data)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: UNGRANTABLE_ROLE });
          return z.NEVER;
        }
        if (!roles.includes(parsed.data)) roles.push(parsed.data);
      }

      return roles;
    });
}

/**
 * identity-service configuration.
 *
 * Composed from the shared schemas plus the Keycloak admin credentials this
 * service needs to provision accounts. Validated once at startup so a missing
 * value fails the deployment rather than the first request that needs it.
 */
export const identityEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(outboxPurgeEnvSchema)
  .merge(authEnvSchema)
  .extend({
    KEYCLOAK_URL: serviceUrlSchema,
    KEYCLOAK_REALM: z.string().min(1),
    KEYCLOAK_BACKEND_CLIENT_ID: z.string().min(1),
    KEYCLOAK_BACKEND_CLIENT_SECRET: z.string().min(1),

    /**
     * When false, account provisioning is recorded locally and the Keycloak
     * call is skipped. That is for isolated unit and API test environments
     * that have no identity provider. A deployed environment must never
     * disable synchronisation — hence the default of true, and `false` is
     * refused at boot unless `NODE_ENV` is set explicitly to `development` or
     * `test` (`assertNarrowingEnforced`): with it off, a demotion or a
     * revocation commits without ever reaching a token (D-064).
     */
    KEYCLOAK_SYNC_ENABLED: booleanEnv(true),

    /**
     * ADR-060, write-ahead addendum (D-064, D-069) — how long after its
     * deadline a Keycloak write whose answer never came (the deadline passed,
     * the connection broke, a 5xx) may still be applied. An aborted request is
     * not a cancelled one, so for this long an older write could land after a
     * newer one. Every write's fence (`keycloak_write_attempt`) stays live
     * until `deadline + this`: meanwhile a narrowing change of that user is
     * refused (503 `KEYCLOAK_WRITE_SETTLING`); after it, the sweep re-asserts
     * the user and clears the fence.
     *
     * An assumption about the deployment, stated in the ADR's D-069 residual:
     * Keycloak applies an admin write within this long of the sender's
     * deadline, or never. The floor is above the client's own 10 s deadline;
     * the ceiling bounds how long one lost answer can hold demotions of that
     * user back.
     */
    KEYCLOAK_WRITE_SETTLE_SECONDS: z.coerce.number().int().min(15).max(900).default(120),

    CORS_ORIGINS: z.string().default(''),

    /**
     * ADR-053 § 4 — how long a refusal may wait for its `security_event_outbox`
     * row before the `403` is returned without it.
     *
     * Applied twice: as the transaction's `statement_timeout` and as a hard
     * deadline around the whole write, so neither a slow statement nor a slow
     * pool acquisition can hold a refusal longer. Short on purpose — capture is
     * best-effort, and the refusal itself never waits on audit for long. The
     * ceiling keeps a misconfiguration from turning every `403` into a stall.
     */
    SECURITY_EVENT_CAPTURE_TIMEOUT_MS: z.coerce.number().int().min(10).max(5000).default(250),

    /** How often the refusal relay polls `security_event_outbox`. */
    SECURITY_EVENT_FLUSH_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),

    /** Rows one refusal-relay claim may take. */
    SECURITY_EVENT_FLUSH_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),

    /**
     * ADR-053 § 4 — the UTC window matching refusals are counted over (AUD-004
     * Phase C2). One row per tenant, actor, action, resource and error code per
     * window; the relay publishes it only after the window closes on the
     * database clock.
     *
     * Default 60: the "500 probes in one minute" ADR-053 § 4 describes. The
     * window is also the least time before a refusal reaches the audit trail,
     * which is what the one-hour ceiling bounds; the one-second floor is the
     * shortest window the table accepts for an aggregate. Lower it for a test
     * that must observe a closed window, never to switch aggregation off.
     */
    SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(AGGREGATION_WINDOW_SECONDS.MIN)
      .max(AGGREGATION_WINDOW_SECONDS.MAX)
      .default(AGGREGATION_WINDOW_SECONDS.DEFAULT),

    /**
     * audit-service's base URL, for the one question the audit correction
     * command asks it: does the target exist, and in which scope (AUD-003 correction).
     * Required, with no default: a correction must never be validated against
     * whatever happened to be listening on a guessed address.
     */
    AUDIT_SERVICE_URL: serviceUrlSchema,

    /**
     * The whole correction-target lookup, body included. Finite, so a slow
     * audit-service turns into a bounded `504`, never a hung command.
     */
    AUDIT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),

    /**
     * The grant ladder — which roles each acting role may hand out
     * (`identity/role-grants.ts`, `docs/24` Q-60).
     *
     * Configuration rather than constants because CLAUDE.md § 9 puts approval
     * authorities in configuration: the product document does not say whether
     * an administrator may promote a peer to their own role, or who hands out
     * the supplier-organization roles, and a deployment that learns the answer
     * should not need a release to apply it. The defaults follow the scope
     * column of `docs/09` § RBAC and are the narrow reading of it.
     *
     * Widening one of these widens real authority. `SYSTEM_ADMIN` is refused
     * in all three whatever is written here.
     */
    ROLE_GRANTS_BY_SYSTEM_ADMIN: roleListEnv(DEFAULT_GRANTS.SYSTEM_ADMIN),
    ROLE_GRANTS_BY_UNION_ADMIN: roleListEnv(DEFAULT_GRANTS.UNION_ADMIN),
    ROLE_GRANTS_BY_ORGANIZATION_ADMIN: roleListEnv(DEFAULT_GRANTS.ORGANIZATION_ADMIN),

    /**
     * ADR-060 § 5 — the membership expiry sweep (`membership-expiry.scanner.ts`).
     *
     * On by default: switching it off does not let an expired membership grant
     * anything, but its organization stays in the user's token until something
     * else re-projects them. The interval is the latency bound on top of
     * ADR-060 § 7's 905 s, so its ceiling is kept at an hour.
     */
    // Off is refused outside an explicit development or test environment
    // (`assertNarrowingEnforced`): the sweep is the only path that takes a
    // lapsed membership out of Keycloak, and it re-asserts users whose
    // Keycloak write was left unconfirmed (D-064).
    MEMBERSHIP_EXPIRY_SCAN_ENABLED: booleanEnv(true),
    MEMBERSHIP_EXPIRY_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
    MEMBERSHIP_EXPIRY_SCAN_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),

    /**
     * Which roles may provision a user into an organization other than the one
     * they are acting for (`identity/provisioning-scope.ts`, `docs/24` Q-61).
     *
     * Everyone else must name their own active organization. `docs/09` scopes
     * `ORGANIZATION_ADMIN` to its own organization, so its absence here is the
     * table read plainly; `UNION_ADMIN`'s absence is the narrow reading of a
     * question the product document does not answer, and widening it is one
     * environment value rather than a release.
     *
     * Unlike the grant ladder, `SYSTEM_ADMIN` is permitted here — it is the
     * platform-operator role, and it is the one role nobody can be granted
     * through this API at all.
     */
    USER_PROVISIONING_CROSS_ORG_ROLES: roleListEnv(
      DEFAULT_PROVISIONING_SCOPE_POLICY.crossOrgRoles as readonly PlatformRole[],
      { allowUngrantable: true },
    ),
  });

export const IDENTITY_ENV_MESSAGES = seal();

export type IdentityEnv = z.infer<typeof identityEnvSchema>;

export function loadIdentityEnv(source: NodeJS.ProcessEnv = process.env): IdentityEnv {
  // Each service reads its own DATABASE_URL_* variable, so a single .env can
  // describe every service without any of them being able to open another
  // service's database by accident (ADR-005).
  const env = loadEnv(
    identityEnvSchema,
    {
      ...source,
      SERVICE_NAME: source.SERVICE_NAME ?? 'identity-service',
      PORT: source.PORT ?? source.PORT_IDENTITY ?? '3101',
      DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_IDENTITY,
      KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'identity-service',
      KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'identity-service.main',
      CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
    },
    { operationBudgets: identityOperationBudgets, fixedMessages: IDENTITY_ENV_MESSAGES },
  );
  assertNarrowingEnforced(source, env);
  return env;
}

/** Where a narrowing path may be switched off: named explicitly, never by an unset `NODE_ENV`. */
export const NARROWING_OPT_OUT_ENVIRONMENTS = ['development', 'test'] as const;

/**
 * The two switches that would let a narrowing change — a role removed, a
 * membership revoked or lapsed — commit without ever reaching Keycloak, and so
 * a token (ADR-060, write-ahead addendum, D-064):
 *
 * - `KEYCLOAK_SYNC_ENABLED=false`: every Keycloak write is skipped, the
 *   write-ahead included, and the change commits;
 * - `MEMBERSHIP_EXPIRY_SCAN_ENABLED=false`: a lapsed membership is never taken
 *   out of Keycloak, and a user whose write was left unconfirmed is never
 *   re-asserted.
 *
 * Either is honoured only with `NODE_ENV` set explicitly to `development` or
 * `test`, as `KAFKA_ALLOW_PLAINTEXT` is: an unset `NODE_ENV`, which the schema
 * would default to `development`, does not count. Anywhere else the service
 * refuses to start rather than silently skip.
 */
function assertNarrowingEnforced(source: NodeJS.ProcessEnv, env: IdentityEnv): void {
  const given = source.NODE_ENV?.trim();
  if (given && (NARROWING_OPT_OUT_ENVIRONMENTS as readonly string[]).includes(given)) return;
  const message =
    `may be false only with NODE_ENV set explicitly to ${NARROWING_OPT_OUT_ENVIRONMENTS.join(' or ')}: ` +
    'with it off a demotion, a revocation or a lapse can commit without reaching Keycloak (D-064)';
  const issues = [
    ...(env.KEYCLOAK_SYNC_ENABLED ? [] : [{ path: 'KEYCLOAK_SYNC_ENABLED', message }]),
    ...(env.MEMBERSHIP_EXPIRY_SCAN_ENABLED
      ? []
      : [{ path: 'MEMBERSHIP_EXPIRY_SCAN_ENABLED', message }]),
  ];
  if (issues.length > 0) throw new EnvValidationError(issues);
}

export function corsOrigins(env: IdentityEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** The grant ladder as the service holds it, assembled from the three lists. */
export function roleGrantPolicy(env: IdentityEnv): RoleGrantPolicy {
  return {
    bySystemAdmin: env.ROLE_GRANTS_BY_SYSTEM_ADMIN,
    byUnionAdmin: env.ROLE_GRANTS_BY_UNION_ADMIN,
    byOrganizationAdmin: env.ROLE_GRANTS_BY_ORGANIZATION_ADMIN,
  };
}

/** Which roles may provision across organizations, as the service holds it. */
export function provisioningScopePolicy(env: IdentityEnv): ProvisioningScopePolicy {
  return { crossOrgRoles: env.USER_PROVISIONING_CROSS_ORG_ROLES };
}

export const SERVICE_NAME = 'identity-service';
export const IDENTITY_TOPIC = 'rasta.identity.v1';

import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  fixedEnvMessages,
  kafkaEnvSchema,
  loadEnv,
  outboxPurgeEnvSchema,
} from '@rasta/config';
import { organizationOperationBudgets } from './operation-budgets';
import { PLATFORM_ROLES } from '@rasta/nest-common';

/** The fixed texts this schema refuses with; `loadEnv` keeps only these verbatim (#385 r2 F2). */
const { fixed, seal } = fixedEnvMessages();

/**
 * organization-service configuration.
 *
 * No Keycloak admin credentials here: this service never provisions accounts.
 * It verifies tokens, which needs only the public JWKS endpoint.
 */
const UNKNOWN_SETTER_ROLE = fixed('Unknown role in GOVERNANCE_POLICY_SETTER_ROLES');

export const organizationEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(outboxPurgeEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    /**
     * Maximum depth of the organization tree.
     *
     * Country → Province → County → Municipality → Organization → Unit is six.
     * The limit exists to stop a cycle or a bad import producing an unbounded
     * chain that makes every subtree query pathological.
     */
    MAX_HIERARCHY_DEPTH: z.coerce.number().int().min(1).max(20).default(8),

    /**
     * Roles that may set governance policy (`POST /v1/organizations/:id/policies`).
     *
     * Configuration, not code: policy rows decide who approves what, so who
     * may write them is itself an authority question the platform must not
     * settle on its own (AGENTS.md § 1.2, ADR-023). The project owner has
     * settled it: `docs/24` **Q-64** is closed (#104) with SYSTEM_ADMIN and
     * UNION_ADMIN, the default below, as the final decision. It stays
     * configuration so a later decision needs no code change. SYSTEM_ADMIN is
     * honoured regardless, as everywhere else. A role that is not a platform
     * operator is additionally confined to its own subtree — and since
     * `docs/24` Q-80 (provisional, 2026-09-28) that includes UNION_ADMIN: the
     * union sets policy for its own organization and what is beneath it.
     *
     * This list says **who writes policy**. It never makes a role a platform
     * operator: that scope is `GLOBAL_ROLES` in `@rasta/nest-common`, a
     * constant, because it is the trust model rather than a governance
     * setting (ADR-060 § 2).
     */
    GOVERNANCE_POLICY_SETTER_ROLES: z
      .string()
      .default('SYSTEM_ADMIN,UNION_ADMIN')
      .transform((raw) =>
        raw
          .split(',')
          .map((role) => role.trim())
          .filter((role) => role.length > 0),
      )
      .pipe(
        z
          .array(z.enum(PLATFORM_ROLES), {
            errorMap: () => ({ message: UNKNOWN_SETTER_ROLE }),
          })
          .min(1, fixed('GOVERNANCE_POLICY_SETTER_ROLES must name at least one role')),
      ),
  });

export const ORGANIZATION_ENV_MESSAGES = seal();

export type OrganizationEnv = z.infer<typeof organizationEnvSchema>;

export function loadOrganizationEnv(source: NodeJS.ProcessEnv = process.env): OrganizationEnv {
  return loadEnv(
    organizationEnvSchema,
    {
      ...source,
      SERVICE_NAME: source.SERVICE_NAME ?? 'organization-service',
      PORT: source.PORT ?? source.PORT_ORGANIZATION ?? '3102',
      DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_ORGANIZATION,
      KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? 'organization-service',
      KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? 'organization-service.main',
      CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
    },
    { operationBudgets: organizationOperationBudgets, fixedMessages: ORGANIZATION_ENV_MESSAGES },
  );
}

/**
 * `MAX_HIERARCHY_DEPTH` alone, by the service's own schema and default. The demo seed has no use
 * for the rest of the service's configuration, but holds the rows it writes to the depth the
 * running service enforces (Codex r1 on #295). Through `loadEnv`, so it is refused by the same
 * formatter as the service's whole configuration and never with the value written (#385 r2 F2).
 */
export function loadMaxHierarchyDepth(source: NodeJS.ProcessEnv = process.env): number {
  return loadEnv(organizationEnvSchema.pick({ MAX_HIERARCHY_DEPTH: true }), source, {
    fixedMessages: ORGANIZATION_ENV_MESSAGES,
  }).MAX_HIERARCHY_DEPTH;
}

export function corsOrigins(env: OrganizationEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const SERVICE_NAME = 'organization-service';
export const ORGANIZATION_TOPIC = 'rasta.organization.v1';

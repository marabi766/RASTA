import { Counter, registry } from '@rasta/observability';

/**
 * Keycloak projection telemetry (ADR-060 § 5).
 *
 * Labels come from a fixed set; none names a user, an organization or a role.
 * A sustained `failed` rate is a token that disagrees with the database — for
 * a demotion or a revocation, a window in which a removed role still works —
 * so it is the number an operator alerts on.
 */
export const KEYCLOAK_PROJECTION_OUTCOMES = {
  PROJECTED: 'projected',
  FAILED: 'failed',
  NO_ACCOUNT: 'no_account',
  NO_USER: 'no_user',
  DISABLED: 'disabled',
} as const;
export type KeycloakProjectionOutcome =
  (typeof KEYCLOAK_PROJECTION_OUTCOMES)[keyof typeof KEYCLOAK_PROJECTION_OUTCOMES];

/** Which path asked for the projection. */
export const KEYCLOAK_PROJECTION_TRIGGERS = {
  /** Straight after a committed membership change, in the request. */
  REQUEST: 'request',
  /** Re-projection from the identity outbox event, the durable path. */
  EVENT: 'event',
  /** The backfill or reconcile command. */
  COMMAND: 'command',
} as const;
export type KeycloakProjectionTrigger =
  (typeof KEYCLOAK_PROJECTION_TRIGGERS)[keyof typeof KEYCLOAK_PROJECTION_TRIGGERS];

export const keycloakProjectionsTotal = new Counter({
  name: 'rasta_identity_keycloak_projections_total',
  help: 'Projections of membership into Keycloak user attributes, by trigger and outcome',
  labelNames: ['trigger', 'outcome'] as const,
  registers: [registry],
});

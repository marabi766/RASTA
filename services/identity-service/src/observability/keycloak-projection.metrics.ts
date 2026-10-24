import { Counter, Gauge, registry } from '@rasta/observability';

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
  /** The sweep re-projecting a user whose re-assertion mark has passed (D-064). */
  REASSERT: 'reassert',
} as const;
export type KeycloakProjectionTrigger =
  (typeof KEYCLOAK_PROJECTION_TRIGGERS)[keyof typeof KEYCLOAK_PROJECTION_TRIGGERS];

export const keycloakProjectionsTotal = new Counter({
  name: 'rasta_identity_keycloak_projections_total',
  help: 'Projections of membership into Keycloak user attributes, by trigger and outcome',
  labelNames: ['trigger', 'outcome'] as const,
  registers: [registry],
});

/**
 * What one narrowing change's write-ahead did (ADR-060, write-ahead addendum,
 * D-064). `refused` and `unconfirmed` answered the caller 503, nothing
 * committed; `settling` refused it before writing, because an earlier write
 * of the user whose answer was lost may still land. A sustained non-zero rate
 * of those three is demotions an administrator could not make.
 */
export const KEYCLOAK_WRITE_AHEAD_OUTCOMES = {
  WRITTEN: 'written',
  NO_ACCOUNT: 'no_account',
  DISABLED: 'disabled',
  REFUSED: 'refused',
  UNCONFIRMED: 'unconfirmed',
  SETTLING: 'settling',
} as const;
export type KeycloakWriteAheadOutcome =
  (typeof KEYCLOAK_WRITE_AHEAD_OUTCOMES)[keyof typeof KEYCLOAK_WRITE_AHEAD_OUTCOMES];

export const keycloakWriteAheadTotal = new Counter({
  name: 'rasta_identity_keycloak_write_ahead_total',
  help: 'Narrowing changes written to Keycloak before commit, by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Re-assertion marks (D-064): `unconfirmed` — a write whose answer was lost,
 * re-projected once it can no longer land; `rolled_back` — a write that landed
 * in a transaction that did not commit, re-projected at once. `failed` means
 * the mark itself could not be stored: that user is not re-asserted by the
 * sweep, and is the one outcome alerted on at any rate.
 */
export const keycloakReassertMarksTotal = new Counter({
  name: 'rasta_identity_keycloak_reassert_marks_total',
  help: 'Users marked for Keycloak re-assertion, by reason and whether the mark was stored',
  labelNames: ['reason', 'outcome'] as const,
  registers: [registry],
});

/**
 * Lapsed memberships the expiry sweep has not acted on yet, as of its last
 * pass (ADR-060 § 5, D-064). Each one is a membership the database no longer
 * grants that Keycloak may still put in tokens; a backlog that stays above
 * zero is lapses the sweep cannot write.
 */
export const membershipLapseBacklog = new Gauge({
  name: 'rasta_identity_membership_lapse_backlog',
  help: 'Lapsed memberships not yet acted on by the expiry sweep, as of its last pass',
  registers: [registry],
});

/** Lapses the sweep tried and could not act on (Keycloak refused or did not answer). */
export const membershipLapseFailuresTotal = new Counter({
  name: 'rasta_identity_membership_lapse_failures_total',
  help: 'Lapsed memberships the expiry sweep failed to act on, per attempt',
  registers: [registry],
});

import { Counter, Gauge, Histogram, registry } from '@rasta/observability';

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
  /** Keycloak answered 404 for the linked account: nothing to project into (D-069). */
  ACCOUNT_MISSING: 'account_missing',
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
  /** The sweep re-projecting a user with a Keycloak write fence past takeover (D-069). */
  REASSERT: 'reassert',
  /** A late sender's immediate re-projection of the user (D-070 option D). */
  RECOVERY: 'recovery',
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
 * of those three is demotions an administrator could not make. `settling` is
 * per user (KEYCLOAK_WRITE_SETTLING); `refused`/`unconfirmed` are Keycloak's.
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
 * The in-flight fences of Keycloak writes (D-069), by what happened to one:
 * `opened` before a PUT; `released` when it provably was not applied;
 * `release_failed` when that delete did not reach the database (the fence
 * stays until the sweep takes it over — slower, never unsafe);
 * `account_missing` when a due fence became terminal (Keycloak 404).
 */
export const keycloakWriteFenceEventsTotal = new Counter({
  name: 'rasta_identity_keycloak_write_fence_events_total',
  help: 'Keycloak write fences opened, released, failed to release, or made terminal (account missing)',
  labelNames: ['event'] as const,
  registers: [registry],
});

/**
 * What the fence sampler last saw (`KeycloakFenceSampler`, #402 r3 R3-2), as
 * the gauges below read it **at scrape time**. Null before it has a reader.
 */
export interface FenceSampleView {
  /** The latest successful sample's counts; null before the first one. */
  latest: {
    live: number;
    due: number;
    accountMissing: number;
    overdue: number;
    expired: number;
  } | null;
  /** The largest `overdue` and `expired` of every sample in the retention window, the latest included. */
  retained: { overdue: number; expired: number };
  /** Seconds: how old the latest successful sample is, or the largest gap between two in the retention window — whichever is more. */
  ageSeconds: number;
}

let fenceSampleReader: (() => FenceSampleView) | null = null;

/** The sampler that feeds the gauges below; null to detach (its stop). Returns the previous one. */
export function readFenceSamplesFrom(
  reader: (() => FenceSampleView) | null,
): (() => FenceSampleView) | null {
  const previous = fenceSampleReader;
  fenceSampleReader = reader;
  return previous;
}

/**
 * Keycloak write fences (D-069), sampled from the database by the fence
 * sampler on its own timer — never by the sweep, whose passes are serial and
 * may be long, skipped or failed (#402 r3 R3-2):
 *
 * - `live` — writes that may still land; `due` — past takeover, not
 *   re-asserted yet; `account_missing` — terminal, Keycloak has no account
 *   for them (any one is for an operator);
 * - `overdue` (a subset of `live`): writes still unresolved past their deadline
 *   plus half the settle window — the D-070 deployment assumption's signal;
 * - `expired` (a subset of `due`): writes whose outcome was never learned and
 *   whose whole settle window passed, not re-asserted yet — what an `overdue`
 *   fence becomes at takeover, until the sweep repairs it.
 *
 * `overdue` and `expired` are the largest of every sample in the last
 * `FENCE_SAMPLE_RETENTION_MS` — so a sample inside a window reaches at least
 * one scrape — the others the latest sample's. No series before the first
 * successful sample: silence then is not zero
 * (`rasta_identity_keycloak_fence_sample_age_seconds` says why).
 */
export const keycloakWriteFences = new Gauge({
  name: 'rasta_identity_keycloak_write_fences',
  help: 'Keycloak write fences by state (live, due, account_missing, overdue, expired), sampled on their own timer; overdue and expired retained over the retention window',
  labelNames: ['state'] as const,
  registers: [registry],
  collect() {
    const view = fenceSampleReader?.();
    this.reset();
    if (!view?.latest) return;
    this.set({ state: 'live' }, view.latest.live);
    this.set({ state: 'due' }, view.latest.due);
    this.set({ state: 'account_missing' }, view.latest.accountMissing);
    this.set({ state: 'overdue' }, view.retained.overdue);
    this.set({ state: 'expired' }, view.retained.expired);
  },
});

/**
 * How stale the fence gauges are, **computed at scrape** from the instant of
 * the latest successful sample — so it keeps growing while sampling hangs or
 * fails — or the largest gap between two successful samples within the
 * retention window, if that is more, so a gap that ended between two scrapes
 * is still seen. Before the first success, the time since the sampler started.
 * Alerted on above `FENCE_SAMPLE_STALE_SECONDS` (`RastaIdentityKeycloakFenceSamplerStale`).
 */
export const keycloakFenceSampleAge = new Gauge({
  name: 'rasta_identity_keycloak_fence_sample_age_seconds',
  help: 'Age of the latest successful Keycloak fence sample, or the largest gap between two in the retention window, computed at scrape',
  registers: [registry],
  collect() {
    const view = fenceSampleReader?.();
    this.reset();
    if (view) this.set(view.ageSeconds);
  },
});

/** How long each fence sample took, from its timer to its answer, by outcome (`ok`, `failed`). */
export const keycloakFenceSampleDuration = new Histogram({
  name: 'rasta_identity_keycloak_fence_sample_duration_seconds',
  help: 'Duration of each Keycloak fence sample, connection wait included, by outcome',
  labelNames: ['outcome'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

/**
 * Fence sampler ticks by outcome: `ok`, `failed` (an error, or past its
 * budget), `busy` (the previous sample of this sampler still running — its
 * own guard, never the sweep's).
 */
export const keycloakFenceSamplesTotal = new Counter({
  name: 'rasta_identity_keycloak_fence_samples_total',
  help: 'Keycloak fence sampler ticks, by outcome (ok, failed, busy)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Lapsed memberships the expiry sweep has not acted on yet (ADR-060 § 5,
 * D-064), sampled on the fence sampler's slower lapse timer, not by the sweep.
 * Each one is a membership the database no longer grants that Keycloak may
 * still put in tokens; a backlog that stays above zero is lapses the sweep
 * cannot write.
 */
export const membershipLapseBacklog = new Gauge({
  name: 'rasta_identity_membership_lapse_backlog',
  help: 'Lapsed memberships not yet acted on by the expiry sweep, sampled on their own timer',
  registers: [registry],
});

/** Lapses the sweep tried and could not act on (Keycloak refused or did not answer). */
export const membershipLapseFailuresTotal = new Counter({
  name: 'rasta_identity_membership_lapse_failures_total',
  help: 'Lapsed memberships the expiry sweep failed to act on, per attempt',
  registers: [registry],
});

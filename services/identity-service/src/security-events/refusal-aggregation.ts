/**
 * Windowed refusal aggregation — the rules, as pure functions (ADR-053 § 4,
 * AUD-004 Phase C2).
 *
 * The database makes every live decision: which window a refusal falls in is
 * `date_bin` over the database clock, and whether it joins an existing row is
 * the partial unique index `ux_security_event_outbox_open_bucket`. What lives
 * here is the *definition* those statements implement — the aggregation
 * identity the store binds as parameters, the window arithmetic the SQL
 * performs, and the closed outcome set telemetry reports — so each of them is
 * written down once and unit-tested, and the integration suite can hold the
 * SQL to it.
 *
 * No imports: this module is read by configuration, the store and the
 * recorder alike, and depends on none of them.
 */

/** PostgreSQL `INTEGER` — the `occurrence_count` column and `audit_event`'s. */
export const MAX_OCCURRENCE_COUNT = 2_147_483_647;

/**
 * `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS`.
 *
 * The default is the one ADR-053 § 4 states ("500 probes in one minute").
 * The floor is one second: a shorter window aggregates nothing worth a row and
 * the migration reserves sub-second windows for rows written before
 * aggregation existed. The ceiling is one hour — the window is also the delay
 * before a refusal can reach the audit trail, and the table's CHECK constraint
 * enforces the same bound.
 */
export const AGGREGATION_WINDOW_SECONDS = { MIN: 1, MAX: 3600, DEFAULT: 60 } as const;

/** `date_bin`'s origin. Windows align to the Unix epoch, in UTC. */
export const AGGREGATION_WINDOW_ORIGIN = new Date(0);

/** How a successful capture landed. Closed — it is a metric label. */
export const AGGREGATION_OUTCOMES = {
  /** A new row: the first matching refusal in its window, or a successor. */
  CREATED: 'created',
  /** An existing open row counted one more occurrence. */
  INCREMENTED: 'incremented',
  /** An increment that reached the INTEGER ceiling; the next one opens a successor. */
  CEILING_REACHED: 'ceiling_reached',
} as const;
export type AggregationOutcome = (typeof AGGREGATION_OUTCOMES)[keyof typeof AGGREGATION_OUTCOMES];

/** The columns a refusal is aggregated by — structurally, any persisted record. */
export interface AggregationDimensions {
  organizationId: string | null;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  errorCode: string;
}

/**
 * The aggregation identity of one refusal, apart from its window.
 *
 * Every value is trusted and already bounded: the tenant and actor from the
 * verified token, the action, resource type and error code from the fixed
 * refusal site, the resource id from the token. Ip, user agent, correlation id,
 * trace, roles and producer version are deliberately absent — see
 * `docs/24-open-questions.md` Q-44 — so a caller cannot split one probe into
 * many rows by rotating a header, and the key never holds a value the caller
 * chose.
 */
export function aggregationIdentityOf(record: AggregationDimensions): AggregationDimensions {
  return {
    organizationId: record.organizationId,
    actorType: record.actorType,
    actorId: record.actorId,
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    errorCode: record.errorCode,
  };
}

/** Whether two refusals in the same window belong to the same row. */
export function sameAggregationIdentity(
  a: AggregationDimensions,
  b: AggregationDimensions,
): boolean {
  const left = aggregationIdentityOf(a);
  const right = aggregationIdentityOf(b);
  return (Object.keys(left) as (keyof AggregationDimensions)[]).every(
    (key) => left[key] === right[key],
  );
}

/** Throws unless `seconds` is a window the configuration and the CHECK both accept. */
export function assertAggregationWindowSeconds(seconds: number): number {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < AGGREGATION_WINDOW_SECONDS.MIN ||
    seconds > AGGREGATION_WINDOW_SECONDS.MAX
  ) {
    throw new RangeError(
      `refusal aggregation window must be an integer from ${AGGREGATION_WINDOW_SECONDS.MIN} ` +
        `to ${AGGREGATION_WINDOW_SECONDS.MAX} seconds`,
    );
  }
  return seconds;
}

export interface AggregationWindow {
  /** Inclusive. */
  startedAt: Date;
  /** Exclusive: an instant equal to it is in the next window. */
  endsAt: Date;
}

/**
 * The window an instant falls in: `[origin + k·w, origin + (k+1)·w)`.
 *
 * Exactly what the capture statement computes with
 * `date_bin(make_interval(secs => w), ts, TIMESTAMP '1970-01-01')` over the
 * database's millisecond-rounded UTC statement time. Never called on the
 * request path with the application clock — the database's instant is the one
 * that counts.
 */
export function aggregationWindowOf(instant: Date, windowSeconds: number): AggregationWindow {
  const strideMs = assertAggregationWindowSeconds(windowSeconds) * 1000;
  const offsetMs = instant.getTime() - AGGREGATION_WINDOW_ORIGIN.getTime();
  const startMs = AGGREGATION_WINDOW_ORIGIN.getTime() + Math.floor(offsetMs / strideMs) * strideMs;
  return { startedAt: new Date(startMs), endsAt: new Date(startMs + strideMs) };
}

/** Whether a window is closed — and therefore claimable — at `now`. */
export function isAggregationWindowClosed(window: AggregationWindow, now: Date): boolean {
  return window.endsAt.getTime() <= now.getTime();
}

/** What the capture statement returned. */
export interface CapturedOccurrence {
  /** The row the refusal was counted in — a new ULID, or an existing row's. */
  id: string;
  occurrenceCount: number;
  /** True when the statement inserted rather than incremented. */
  created: boolean;
}

export function aggregationOutcomeOf(captured: CapturedOccurrence): AggregationOutcome {
  if (captured.created) return AGGREGATION_OUTCOMES.CREATED;
  return captured.occurrenceCount >= MAX_OCCURRENCE_COUNT
    ? AGGREGATION_OUTCOMES.CEILING_REACHED
    : AGGREGATION_OUTCOMES.INCREMENTED;
}

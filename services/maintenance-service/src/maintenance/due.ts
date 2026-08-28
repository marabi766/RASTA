import { formatHundredths, isPositive, parseHundredths, type Hundredths } from './quantity';

/**
 * When a service schedule comes due, and how far off it is.
 *
 * This module is pure: it takes a schedule, a meter reading and a clock
 * reading, and returns a verdict. Nothing here writes, publishes or reads a
 * stored flag — and that is the point.
 *
 * ## Why due-ness is derived rather than stored
 *
 * The obvious design is a `due` column set by a nightly job. It has a failure
 * mode that is unacceptable for this domain: **if the job does not run, every
 * overdue machine reports as compliant.** Nothing is missing from the screen,
 * no alert fires, and the fleet manager sees a clean list. A maintenance
 * system whose silence cannot be distinguished from good news is worse than no
 * maintenance system, because people trust it.
 *
 * So the answer is computed from the facts every time it is asked for: the
 * rule on the schedule, the anchor of the last service, the machine's current
 * meter, and the current time. A scanner still exists — something has to
 * *announce* a due date passing, since no request arrives to trigger it
 * (ADR-027) — but the scanner only publishes events. It is not the source of
 * truth, and a scanner that has been down for a week changes what has been
 * announced, never what the API reports.
 *
 * ## Whichever comes first
 *
 * A schedule may carry a time interval, an hours interval and a kilometres
 * interval. When more than one is set the schedule is due on whichever is
 * reached first — how a service book reads, and the only interpretation that
 * cannot leave a machine simultaneously overdue on hours and compliant on
 * days. An organization wanting a single measure sets a single interval.
 */

export const DUE_BASES = ['TIME', 'HOURS', 'KILOMETRES'] as const;
export type DueBasis = (typeof DUE_BASES)[number];

/**
 * Three states, not two.
 *
 * `DUE_SOON` is the warning the product asks for — "هشدار پیش از موعد"
 * (docs/17) — and it is a distinct fact from being late: one is a plan, the
 * other is a problem. Collapsing them would make the notification and the
 * escalation the same message.
 */
export const DUE_STATES = ['NOT_DUE', 'DUE_SOON', 'OVERDUE'] as const;
export type DueState = (typeof DUE_STATES)[number];

/** What the caller must tell the evaluator about one schedule. */
export interface ScheduleRule {
  intervalDays: number | null;
  intervalHours: string | null;
  intervalKilometres: string | null;

  leadDays: number | null;
  leadHours: string | null;
  leadKilometres: string | null;

  /**
   * The anchor for the time trigger. Falls back to when the schedule was
   * created: a brand-new schedule that has never been served is measured from
   * the day someone wrote it down, which is the only date available and the
   * one a fleet manager would also use.
   */
  lastServicedAt: Date | null;
  createdAt: Date;

  lastServicedHourMeter: string | null;
  lastServicedOdometer: string | null;
}

/** What the machine has run, from this service's own meter read model. */
export interface MeterReading {
  hourMeter: string | null;
  odometer: string | null;
}

export interface DueTrigger {
  basis: DueBasis;
  state: DueState;
  /** The date it falls due, for a time trigger. */
  dueAt: string | null;
  /** The meter reading it falls due at, for a usage trigger. */
  dueAtMeter: string | null;
  /**
   * How much is left before it falls due — days, hours or kilometres
   * depending on the basis. Negative once overdue, which is how far past.
   */
  remaining: string;
}

export interface DueAssessment {
  /** The worst state across every configured trigger. */
  state: DueState;
  /** The trigger responsible for that state, or the nearest one when none is due. */
  basis: DueBasis | null;
  /** The date the responsible trigger falls due, when it is a time trigger. */
  dueBy: string | null;
  /** The meter the responsible trigger falls due at, when it is a usage trigger. */
  dueAtMeter: string | null;
  /** Every configured trigger, so a screen can show why. */
  triggers: DueTrigger[];
}

const MILLIS_PER_DAY = 86_400_000;

/**
 * Evaluates one schedule.
 *
 * `now` is a parameter rather than a call to the clock, so the caller decides
 * what "now" means. That keeps this testable at boundaries — the second a
 * schedule tips from DUE_SOON to OVERDUE — and it keeps a single time source
 * across a scan that evaluates two hundred schedules, which would otherwise
 * drift across the batch.
 */
export function assessDue(rule: ScheduleRule, meter: MeterReading, now: Date): DueAssessment {
  const triggers: DueTrigger[] = [];

  const time = assessTime(rule, now);
  if (time) triggers.push(time);

  const hours = assessUsage(
    'HOURS',
    rule.intervalHours,
    rule.leadHours,
    rule.lastServicedHourMeter,
    meter.hourMeter,
  );
  if (hours) triggers.push(hours);

  const kilometres = assessUsage(
    'KILOMETRES',
    rule.intervalKilometres,
    rule.leadKilometres,
    rule.lastServicedOdometer,
    meter.odometer,
  );
  if (kilometres) triggers.push(kilometres);

  const responsible = worst(triggers);

  return {
    state: responsible?.state ?? 'NOT_DUE',
    basis: responsible?.basis ?? null,
    dueBy: responsible?.dueAt ?? null,
    dueAtMeter: responsible?.dueAtMeter ?? null,
    triggers,
  };
}

/** True when the schedule warrants a MAINTENANCE_DUE announcement. */
export function isAnnounceable(assessment: DueAssessment): boolean {
  return assessment.state !== 'NOT_DUE';
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

function assessTime(rule: ScheduleRule, now: Date): DueTrigger | null {
  const interval = rule.intervalDays;
  if (interval === null || interval <= 0) return null;

  const anchor = rule.lastServicedAt ?? rule.createdAt;
  const dueAt = new Date(anchor.getTime() + interval * MILLIS_PER_DAY);
  const lead = Math.max(0, rule.leadDays ?? 0);
  const warnFrom = dueAt.getTime() - lead * MILLIS_PER_DAY;

  // Whole days, rounded towards zero, so "0 days left" means today rather than
  // a fraction a screen would have to round anyway.
  const remainingDays = Math.trunc((dueAt.getTime() - now.getTime()) / MILLIS_PER_DAY);

  return {
    basis: 'TIME',
    state:
      now.getTime() > dueAt.getTime()
        ? 'OVERDUE'
        : now.getTime() >= warnFrom
          ? 'DUE_SOON'
          : 'NOT_DUE',
    dueAt: dueAt.toISOString(),
    dueAtMeter: null,
    remaining: String(remainingDays),
  };
}

/**
 * A usage trigger — hours or kilometres.
 *
 * The anchor may be absent, which happens for a schedule created before this
 * service ever saw a reading for the machine. Measuring from zero would report
 * a grader with 4 310 hours on it as overdue on the day its schedule is
 * written, so an absent anchor is treated as the current reading: the interval
 * starts counting from now. The service layer writes the anchor at creation
 * time for exactly this reason; this is the fallback for a row that predates
 * that, or for a machine whose first usage arrives later.
 */
function assessUsage(
  basis: Extract<DueBasis, 'HOURS' | 'KILOMETRES'>,
  intervalRaw: string | null,
  leadRaw: string | null,
  anchorRaw: string | null,
  currentRaw: string | null,
): DueTrigger | null {
  const interval = parseHundredths(intervalRaw);
  if (!isPositive(interval)) return null;

  const current = parseHundredths(currentRaw) ?? 0n;
  const anchor = parseHundredths(anchorRaw) ?? current;
  const lead = clampToZero(parseHundredths(leadRaw) ?? 0n);

  const dueAtMeter = anchor + interval;
  const remaining = dueAtMeter - current;

  return {
    basis,
    state: remaining < 0n ? 'OVERDUE' : remaining <= lead ? 'DUE_SOON' : 'NOT_DUE',
    dueAt: null,
    dueAtMeter: formatHundredths(dueAtMeter),
    remaining: formatHundredths(remaining),
  };
}

function clampToZero(value: Hundredths): Hundredths {
  return value < 0n ? 0n : value;
}

/**
 * The trigger that decides the schedule's state.
 *
 * Ranked by state first — an overdue trigger always wins — and by how little
 * is left within a state, so "due soon" reports the one arriving first rather
 * than whichever happens to be listed first. Comparing `remaining` across
 * bases would be comparing days with kilometres, so the tie-break stays inside
 * a basis: the ordering below is on state alone, and the first trigger of the
 * winning state is taken, which is time, then hours, then kilometres. That
 * order is deliberate — a date is the thing a person plans around.
 */
function worst(triggers: readonly DueTrigger[]): DueTrigger | null {
  if (triggers.length === 0) return null;

  const rank: Record<DueState, number> = { OVERDUE: 2, DUE_SOON: 1, NOT_DUE: 0 };
  let chosen = triggers[0] as DueTrigger;

  for (const trigger of triggers.slice(1)) {
    if (rank[trigger.state] > rank[chosen.state]) chosen = trigger;
  }

  return chosen;
}

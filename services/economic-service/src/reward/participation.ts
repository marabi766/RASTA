/**
 * The participation score (ADR-047 § 1, COM-012).
 *
 * Pure. A rule version and a person's verified facts go in; a score and the
 * breakdown that explains it come out. Nothing here reads a database.
 *
 * ## Not reward points
 *
 * ADR-047 keeps three concepts apart, and this file is the first of them:
 *
 *   - `ParticipationScore` — how one person has taken part lately: a rolling
 *     window over the facts their organization's owners confirmed. It is
 *     **never spent, granted, capped per rule or converted**, and nothing
 *     reads it to move money. It goes down as facts leave the window, and
 *     that is what a rolling index is, not a penalty.
 *   - `RewardPoints` — what reward rules granted (`reward`, `reward_balance`):
 *     permanent, and the only one that may ever turn into a benefit
 *     (docs/24 Q-09, Q-13).
 *   - `RankingSnapshot` — a comparison within a peer group. Not built (Q-30).
 *
 * ## What counts, and why nothing does by default
 *
 * Only a verified domain fact (ADR-047 § 2): a usage record or a completed
 * repair that the reward consumer confirmed with its owner (ADR-061 § 4), whose
 * owner named the person who did it. Logins, clicks and page views are not
 * facts this service ever sees. Which of those facts count, with what weight,
 * how many per window and over what window are the rule's — a versioned row
 * a platform administrator creates — and none is seeded, because the product
 * document gives none of those numbers (docs/24 Q-139). With no rule, there is
 * no score, and the breakdown says so rather than showing a zero.
 *
 * ## Explainable by construction
 *
 * The score is the sum of the breakdown lines and each line is
 * `counted × weight`, where `counted` is the facts of that kind in the window,
 * at most `maxPerWindow` of them — the earliest ones, in the order they
 * happened, so which fact counted is decided by the facts and not by when
 * somebody looked. Nothing is stored that could drift from it.
 *
 * ## No coercive mechanics
 *
 * No streaks, no countdowns, no "only N more to the next level", no
 * comparison with anybody else, and no negative weights in this version: a
 * score that punishes a day off is the pressure ADR-047 and docs/10 § 10.8
 * rule out ("از الگوهای کودکانه یا سرگرمی‌محور پرهیز کند").
 */

/**
 * The facts a participation rule may count: the ones the reward consumer
 * confirms with their owner, and no others (the unit spec holds this to
 * `REWARD_TRIGGER_EVENTS`).
 */
export const PARTICIPATION_FACTS = ['USAGE_RECORDED', 'MAINTENANCE_COMPLETED'] as const;
export type ParticipationFact = (typeof PARTICIPATION_FACTS)[number];

/** The longest window a rule may name, in days: a year, leap day included. */
export const PARTICIPATION_MAX_WINDOW_DAYS = 366;
/** The largest weight one fact may carry. A bound against typos, not a business number. */
export const PARTICIPATION_MAX_WEIGHT = 1000;
/** The largest `maxPerWindow`. A bound against typos, not a business number. */
export const PARTICIPATION_MAX_PER_WINDOW = 100_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ParticipationContribution {
  triggerEvent: ParticipationFact;
  weight: number;
  /** Null: every fact of this kind in the window counts. */
  maxPerWindow: number | null;
}

export interface ParticipationRuleView {
  id: string;
  version: number;
  windowDays: number;
  contributions: readonly ParticipationContribution[];
  label: string | null;
  createdAt: Date;
}

/** One verified fact of one person, as the evaluation row holds it. */
export interface ParticipationFactRow {
  triggerEvent: string;
  sourceReference: string;
  occurredAt: Date;
  /** 1 for the earliest fact of its kind in the window, 2 for the next … */
  ordinal: number;
}

export interface ParticipationLine {
  triggerEvent: ParticipationFact;
  weight: number;
  maxPerWindow: number | null;
  /** Facts of this kind in the window. */
  facts: number;
  /** Of those, the ones that count: `min(facts, maxPerWindow)`. */
  counted: number;
  /** `counted × weight`. */
  contribution: number;
}

export interface ParticipationFactEffect {
  triggerEvent: string;
  sourceReference: string;
  occurredAt: Date;
  counted: boolean;
  /** The weight it added to the score, or 0. */
  effect: number;
}

export type ParticipationBreakdown =
  | {
      status: 'NO_RULE';
      asOf: Date;
    }
  | {
      status: 'SCORED';
      asOf: Date;
      rule: ParticipationRuleView;
      window: { from: Date; to: Date };
      score: number;
      lines: ParticipationLine[];
      recentFacts: ParticipationFactEffect[];
    };

/**
 * The window a rule scores over, ending at `asOf`: `(asOf − windowDays, asOf]`.
 * Exclusive at the start, so a window of one day holds exactly one day.
 */
export function participationWindow(
  rule: Pick<ParticipationRuleView, 'windowDays'>,
  asOf: Date,
): { from: Date; to: Date } {
  return { from: new Date(asOf.getTime() - rule.windowDays * DAY_MS), to: asOf };
}

/**
 * The score and its explanation.
 *
 * `factCounts` is every fact of each kind in the window; `recentFacts` the
 * most recent few, each with its ordinal among its kind, so each can say
 * whether it counted without the caller loading the whole window.
 */
export function scoreParticipation(input: {
  rule: ParticipationRuleView | null;
  asOf: Date;
  factCounts: ReadonlyMap<string, number>;
  recentFacts: readonly ParticipationFactRow[];
}): ParticipationBreakdown {
  const { rule, asOf } = input;
  if (!rule) return { status: 'NO_RULE', asOf };

  const lines = rule.contributions.map((contribution): ParticipationLine => {
    const facts = input.factCounts.get(contribution.triggerEvent) ?? 0;
    const counted =
      contribution.maxPerWindow === null ? facts : Math.min(facts, contribution.maxPerWindow);
    return {
      triggerEvent: contribution.triggerEvent,
      weight: contribution.weight,
      maxPerWindow: contribution.maxPerWindow,
      facts,
      counted,
      contribution: counted * contribution.weight,
    };
  });

  const byEvent = new Map(rule.contributions.map((c) => [c.triggerEvent as string, c]));
  const recentFacts = input.recentFacts.map((fact): ParticipationFactEffect => {
    const contribution = byEvent.get(fact.triggerEvent);
    const counted =
      contribution !== undefined &&
      (contribution.maxPerWindow === null || fact.ordinal <= contribution.maxPerWindow);
    return {
      triggerEvent: fact.triggerEvent,
      sourceReference: fact.sourceReference,
      occurredAt: fact.occurredAt,
      counted,
      effect: counted && contribution ? contribution.weight : 0,
    };
  });

  return {
    status: 'SCORED',
    asOf,
    rule,
    window: participationWindow(rule, asOf),
    score: lines.reduce((sum, line) => sum + line.contribution, 0),
    lines,
    recentFacts,
  };
}

/**
 * A stored rule's contributions, read back defensively.
 *
 * The service validated them on the way in; a row that no longer parses (a
 * hand edit, a schema this code does not know) is refused, never scored as
 * something else.
 */
export function parseContributions(value: unknown): ParticipationContribution[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('participation rule contributions are not a non-empty array');
  }
  return value.map((entry: unknown, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const triggerEvent = item.triggerEvent;
    const weight = item.weight;
    const maxPerWindow = item.maxPerWindow ?? null;
    if (
      typeof triggerEvent !== 'string' ||
      !(PARTICIPATION_FACTS as readonly string[]).includes(triggerEvent) ||
      !Number.isInteger(weight) ||
      (weight as number) < 1 ||
      (maxPerWindow !== null && (!Number.isInteger(maxPerWindow) || (maxPerWindow as number) < 1))
    ) {
      throw new Error(`participation rule contribution ${index} is malformed`);
    }
    return {
      triggerEvent: triggerEvent as ParticipationFact,
      weight: weight as number,
      maxPerWindow: maxPerWindow as number | null,
    };
  });
}

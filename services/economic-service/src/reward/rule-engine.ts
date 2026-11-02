import { exactComparison, NUMERIC_FACT_TYPES } from './exact-comparison';

/**
 * The reward engine (docs/10 § 10.8, ADR-033).
 *
 * Pure. Rules and a trigger go in; a decision comes out. Nothing here reads a
 * database, which is what lets the cap arithmetic and the condition evaluation
 * be tested exhaustively without one.
 *
 * ## What this file may never do
 *
 * Invent a rate. `points` comes from the rule. Rial value comes from the
 * rule's `creditPerPointMinor`, and **when that is null the reward is
 * points-only and posts no journal** — because the share of commission that
 * funds rewards is docs/24 Q-09 and still open, and a default would be an
 * invented commercial term (ADR-023, ADR-033).
 */

export interface RewardRuleView {
  id: string;
  organizationId: string | null;
  triggerEvent: string;
  rewardType: string;
  condition: unknown;
  points: number;
  creditPerPointMinor: bigint | null;
  periodCap: number | null;
  periodType: string | null;
  validFrom: Date;
  validTo: Date | null;
  status: string;
  statusHistory?: readonly { status: string; effectiveAt: Date; id: bigint }[];
}

export interface RewardDecision {
  rule: RewardRuleView;
  points: number;
  creditAmountMinor: bigint;
  monetised: boolean;
  periodKey: string;
}

export type RewardRefusal =
  | { reason: 'no_rule' }
  | { reason: 'condition_unmet'; ruleId: string }
  | { reason: 'cap_reached'; ruleId: string; capped: number };

/**
 * Rules in force for a trigger, at the moment the triggering fact occurred.
 *
 * Same time-versioning rule as commission, for the same reason: a usage record
 * submitted late must earn what it would have earned when the work was done,
 * not what today's configuration says.
 *
 * Unlike commission, **all** matching rules apply rather than the most
 * specific one. Two rules for `USAGE_RECORDED` — one platform-wide, one an
 * organization's own campaign — are two separate incentives, and picking one
 * would silently cancel the other. Commission is different because two rates
 * on one transaction would be two charges for the same service.
 */
export function applicableRules(
  rules: readonly RewardRuleView[],
  organizationId: string,
  triggerEvent: string,
  occurredAt: Date,
): RewardRuleView[] {
  return rules.filter(
    (rule) =>
      statusAt(rule, occurredAt) === 'ACTIVE' &&
      rule.triggerEvent === triggerEvent &&
      (rule.organizationId === null || rule.organizationId === organizationId) &&
      rule.validFrom.getTime() <= occurredAt.getTime() &&
      (rule.validTo === null || rule.validTo.getTime() > occurredAt.getTime()),
  );
}

/** History is ordered by effectiveAt and id, newest first. Missing history fails closed. */
function statusAt(rule: RewardRuleView, at: Date): string | undefined {
  return rule.statusHistory?.find((entry) => entry.effectiveAt <= at)?.status;
}

/**
 * Evaluates a rule's optional condition against the triggering payload.
 *
 * The condition language is deliberately tiny — equality, presence, and
 * numeric comparison over top-level payload fields:
 *
 * ```json
 *   { "field": "hours", "op": "gte", "value": "1" }
 *   { "all": [ { "field": "type", "op": "eq", "value": "PREVENTIVE" } ] }
 * ```
 *
 * Small because a configurable rule language grows into a programming language
 * nobody tests, and because every operator here has to behave identically on
 * every future trigger. Anything richer belongs in code, behind a new trigger
 * name, where it can be reviewed.
 *
 * An unrecognised shape evaluates to **false**, not true. A condition somebody
 * mistyped must withhold a reward rather than grant one to everybody: the
 * failure is then visible as a rule that never fires, instead of as money
 * quietly leaving.
 */
export function conditionMet(condition: unknown, payload: Record<string, unknown>): boolean {
  if (condition === null || condition === undefined) return true;
  if (typeof condition !== 'object') return false;

  const node = condition as Record<string, unknown>;

  if (Array.isArray(node.all)) {
    return node.all.every((child) => conditionMet(child, payload));
  }
  if (Array.isArray(node.any)) {
    return node.any.some((child) => conditionMet(child, payload));
  }

  const field = node.field;
  const op = node.op;
  if (typeof field !== 'string' || typeof op !== 'string') return false;

  const actual = payload[field];

  switch (op) {
    case 'present':
      return actual !== undefined && actual !== null;
    case 'absent':
      return actual === undefined || actual === null;
    case 'eq':
    case 'neq': {
      if (
        actual === null ||
        actual === undefined ||
        node.value === null ||
        node.value === undefined
      ) {
        return false;
      }
      const comparison = exactComparison(actual, node.value, field);
      if (
        NUMERIC_FACT_TYPES[field] !== undefined ||
        typeof actual === 'number' ||
        typeof node.value === 'number'
      ) {
        if (comparison === null) return false;
        return op === 'eq' ? comparison === 0 : comparison !== 0;
      }
      return op === 'eq'
        ? String(actual) === String(node.value)
        : String(actual) !== String(node.value);
    }
    case 'gte':
    case 'gt':
    case 'lte':
    case 'lt': {
      const comparison = exactComparison(actual, node.value, field);
      if (comparison === null) return false;
      if (op === 'gte') return comparison >= 0;
      if (op === 'gt') return comparison > 0;
      if (op === 'lte') return comparison <= 0;
      return comparison < 0;
    }
    default:
      return false;
  }
}

/**
 * The cap window a grant counts against.
 *
 * Keys are retained for audit. Weekly enforcement uses occurrence time,
 * including conservative attribution of legacy grants whose time is unknown.
 *
 * UTC throughout, like every other timestamp on the platform. A cap window
 * that shifted with the viewer's calendar would let the same behaviour be
 * rewarded twice at a day boundary (AGENTS.md § 3).
 */
export function periodKeyFor(periodType: string | null, at: Date): string {
  if (!periodType) return 'ALL';
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');

  switch (periodType) {
    case 'DAY':
      return `${year}-${month}-${String(at.getUTCDate()).padStart(2, '0')}`;
    case 'WEEK':
      return `${isoThursday(at).getUTCFullYear()}-W${String(isoWeek(at)).padStart(2, '0')}`;
    case 'MONTH':
      return `${year}-${month}`;
    default:
      return 'ALL';
  }
}

/** ISO-8601 week number, in UTC. */
function isoThursday(date: Date): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday determines the ISO year, so shift to it before counting.
  const day = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - day + 3);
  return target;
}

function isoWeek(date: Date): number {
  const target = isoThursday(date);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

/** UTC ISO week window and every Gregorian-year key the old writer could have used. */
export function isoWeekWindow(at: Date): { start: Date; end: Date; legacyKeys: string[] } {
  const start = isoThursday(at);
  start.setUTCDate(start.getUTCDate() - 3);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  const keys = new Set<string>();
  for (let day = new Date(start); day < end; day.setUTCDate(day.getUTCDate() + 1)) {
    keys.add(`${day.getUTCFullYear()}-W${String(isoWeek(day)).padStart(2, '0')}`);
  }
  return { start, end, legacyKeys: [...keys] };
}

/**
 * How many points this rule may still grant in this window.
 *
 * `null` means uncapped. A cap already reached returns 0 rather than a
 * negative, so a caller cannot accidentally grant a negative reward by
 * subtracting.
 */
export function remainingCap(rule: RewardRuleView, alreadyGrantedInPeriod: number): number | null {
  if (rule.periodCap === null) return null;
  return Math.max(0, rule.periodCap - alreadyGrantedInPeriod);
}

/**
 * Decides what one rule grants for one triggering fact.
 *
 * A partial grant is deliberate: a rule worth 50 points with 20 left in the
 * window grants 20, not 0 and not 50. Granting nothing would make the cap a
 * cliff that silently discards earned behaviour, and granting the full amount
 * would make the cap decorative — and the cap is an anti-fraud control
 * (docs/10 § 10.9).
 *
 * The rial value is `points × creditPerPointMinor`, computed on the *granted*
 * points, so a capped grant is worth proportionally less rather than being
 * paid at full rate.
 */
export function evaluate(
  rule: RewardRuleView,
  payload: Record<string, unknown>,
  at: Date,
  alreadyGrantedInPeriod: number,
): RewardDecision | RewardRefusal {
  if (!conditionMet(rule.condition, payload)) {
    return { reason: 'condition_unmet', ruleId: rule.id };
  }

  const remaining = remainingCap(rule, alreadyGrantedInPeriod);
  if (remaining !== null && remaining <= 0) {
    return { reason: 'cap_reached', ruleId: rule.id, capped: rule.periodCap ?? 0 };
  }

  const points = remaining === null ? rule.points : Math.min(rule.points, remaining);

  const creditAmountMinor =
    rule.creditPerPointMinor === null ? 0n : BigInt(points) * rule.creditPerPointMinor;

  return {
    rule,
    points,
    creditAmountMinor,
    monetised: creditAmountMinor > 0n,
    periodKey: periodKeyFor(rule.periodType, at),
  };
}

export function isRefusal(result: RewardDecision | RewardRefusal): result is RewardRefusal {
  return 'reason' in result;
}

/**
 * The level a point total reaches.
 *
 * The highest level whose threshold the total meets. Returns null when no
 * level is configured, which is the MVP's state — docs/24 Q-13 has not been
 * answered, so the ladder is empty and no benefit is granted (ADR-033).
 */
export function levelFor<T extends { id: string; minPoints: number; rank: number; status: string }>(
  levels: readonly T[],
  totalPoints: number,
): T | null {
  const reached = levels
    .filter((level) => level.status === 'ACTIVE' && level.minPoints <= totalPoints)
    .sort((a, b) => b.rank - a.rank);
  return reached[0] ?? null;
}

/**
 * Levels and badges (COM-012 criterion 2, ADR-047 § 1).
 *
 * Pure. A recognition rule version and one person's basis value go in; the
 * level they hold and the badges they hold come out. Nothing here reads a
 * database.
 *
 * ## The basis is the version's, not the code's
 *
 * ADR-047 § 1: a professional level may derive from the participation score
 * or from reward points, "but the basis must be explicit in the rule version".
 * So `basis` is a field of every version:
 *
 *   - `REWARD_POINTS_CUMULATIVE` — the person's reward points in the
 *     organization (`reward_balance.total_points`), which only ever grow;
 *   - `PARTICIPATION_SCORE` — the participation score under the participation
 *     rule in force (`participation.ts`), which rises and falls as facts enter
 *     and leave its window.
 *
 * Which of the two the product wants, and every threshold and name, are
 * docs/24 Q-140; none is seeded. A version names its basis once, for its
 * levels and its badges alike, so the two never disagree about what is
 * being measured.
 *
 * ## Held, not awarded
 *
 * A level or badge is held while the basis value meets its threshold, read at
 * the moment of asking; nothing is stored per person, granted, announced or
 * taken away. Under `PARTICIPATION_SCORE` that means a badge can stop being
 * held as the window moves — whether a badge, once reached, should be kept is
 * part of Q-140, and the answer is a new field on the version, not a rewrite.
 *
 * ## No coercive mechanics
 *
 * The person is told what they hold and why (the basis, its value, the
 * version). They are not told what they do not hold: no next level, no
 * distance to it, no locked badges, no streak, no celebration (docs/10
 * § 10.8, "از الگوهای کودکانه یا سرگرمی‌محور پرهیز کند"). And a level grants
 * nothing: benefits are docs/24 Q-13 and Q-31, and a version has no field for
 * them.
 */

export const RECOGNITION_BASES = ['REWARD_POINTS_CUMULATIVE', 'PARTICIPATION_SCORE'] as const;
export type RecognitionBasis = (typeof RECOGNITION_BASES)[number];

/** The most levels one version may name. A bound against typos, not a business number. */
export const RECOGNITION_MAX_LEVELS = 50;
/** The most badges one version may name. A bound against typos, not a business number. */
export const RECOGNITION_MAX_BADGES = 100;
/**
 * The largest threshold: `reward_balance.total_points` is a PostgreSQL
 * INTEGER, and no score can exceed what an integer holds either.
 */
export const RECOGNITION_MAX_THRESHOLD = 2_147_483_647;
/** A badge code: stable, machine-readable, the name being for people. */
export const RECOGNITION_BADGE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface RecognitionLevel {
  /** 1 for the lowest level, 2 for the next … in threshold order. */
  rank: number;
  name: string;
  /** The basis value at which the level is held. */
  threshold: number;
}

export interface RecognitionBadge {
  code: string;
  name: string;
  threshold: number;
}

export interface RecognitionRuleView {
  id: string;
  version: number;
  basis: RecognitionBasis;
  levels: readonly RecognitionLevel[];
  badges: readonly RecognitionBadge[];
  label: string | null;
  createdAt: Date;
}

/** The person's basis value, and what it was read under. */
export type RecognitionBasisValue =
  | { basis: 'REWARD_POINTS_CUMULATIVE'; value: number }
  | {
      basis: 'PARTICIPATION_SCORE';
      /** Null while no participation rule exists: there is no score to measure. */
      value: number | null;
      participationRuleVersion: number | null;
    };

export type Recognition =
  | { status: 'NO_RULE'; asOf: Date }
  | {
      /** The version's basis cannot be measured: no participation rule exists. */
      status: 'NO_BASIS';
      asOf: Date;
      rule: RecognitionRuleView;
      basis: RecognitionBasisValue;
    }
  | {
      status: 'EVALUATED';
      asOf: Date;
      rule: RecognitionRuleView;
      basis: RecognitionBasisValue;
      /** The highest level whose threshold the value meets, or null. */
      level: RecognitionLevel | null;
      /** Every badge whose threshold the value meets, in the version's order. */
      badges: RecognitionBadge[];
    };

/**
 * What the person holds under `rule`, given their basis value.
 *
 * `basis` must be the one the rule names; a mismatch is a programming error,
 * not a person's standing, and throws.
 */
export function recognise(input: {
  rule: RecognitionRuleView | null;
  asOf: Date;
  basis: RecognitionBasisValue | null;
}): Recognition {
  const { rule, asOf, basis } = input;
  if (!rule) return { status: 'NO_RULE', asOf };
  if (!basis || basis.basis !== rule.basis) {
    throw new Error(`recognition rule ${rule.id} is read on ${rule.basis}, not ${basis?.basis}`);
  }
  if (basis.value === null) return { status: 'NO_BASIS', asOf, rule, basis };

  const value = basis.value;
  let level: RecognitionLevel | null = null;
  for (const candidate of rule.levels) {
    if (candidate.threshold <= value && (!level || candidate.rank > level.rank)) level = candidate;
  }
  return {
    status: 'EVALUATED',
    asOf,
    rule,
    basis,
    level,
    badges: rule.badges.filter((badge) => badge.threshold <= value),
  };
}

/**
 * Levels in rank order, ranks 1…n, thresholds strictly rising: one value
 * holds exactly one level or none, and the order is the thresholds'.
 */
export function levelsAreLadder(levels: readonly { threshold: number }[]): boolean {
  return levels.every((level, index) => {
    const below = levels[index - 1];
    return below === undefined || level.threshold > below.threshold;
  });
}

/**
 * A stored version's terms, read back defensively.
 *
 * The service validated them on the way in; a row that no longer parses is
 * refused, never read as some other ladder.
 */
export function parseRecognitionTerms(row: {
  basis: string;
  levels: unknown;
  badges: unknown;
}): Pick<RecognitionRuleView, 'basis' | 'levels' | 'badges'> {
  if (!(RECOGNITION_BASES as readonly string[]).includes(row.basis)) {
    throw new Error(`recognition rule basis ${row.basis} is unknown`);
  }
  if (!Array.isArray(row.levels) || !Array.isArray(row.badges)) {
    throw new Error('recognition rule levels and badges are not arrays');
  }
  if (row.levels.length + row.badges.length === 0) {
    throw new Error('recognition rule names neither a level nor a badge');
  }

  const threshold = (value: unknown) =>
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= RECOGNITION_MAX_THRESHOLD;
  const name = (value: unknown) => typeof value === 'string' && value.trim() !== '';

  const levels = row.levels.map((entry: unknown, index): RecognitionLevel => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (item.rank !== index + 1 || !name(item.name) || !threshold(item.threshold)) {
      throw new Error(`recognition rule level ${index} is malformed`);
    }
    return { rank: index + 1, name: item.name as string, threshold: item.threshold as number };
  });
  if (!levelsAreLadder(levels)) throw new Error('recognition rule level thresholds do not rise');

  const codes = new Set<string>();
  const badges = row.badges.map((entry: unknown, index): RecognitionBadge => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof item.code !== 'string' ||
      !RECOGNITION_BADGE_CODE.test(item.code) ||
      codes.has(item.code) ||
      !name(item.name) ||
      !threshold(item.threshold)
    ) {
      throw new Error(`recognition rule badge ${index} is malformed`);
    }
    codes.add(item.code);
    return { code: item.code, name: item.name as string, threshold: item.threshold as number };
  });

  return { basis: row.basis as RecognitionBasis, levels, badges };
}

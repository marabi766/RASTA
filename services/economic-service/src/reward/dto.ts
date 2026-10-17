import { z } from 'zod';
import { amountMinorSchema, organizationIdSchema } from '@rasta/contracts';
import { RULE_STATUSES } from '../commission/dto';
import {
  PARTICIPATION_FACTS,
  PARTICIPATION_MAX_PER_WINDOW,
  PARTICIPATION_MAX_WEIGHT,
  PARTICIPATION_MAX_WINDOW_DAYS,
} from './participation';
import {
  RECOGNITION_BADGE_CODE,
  RECOGNITION_BASES,
  RECOGNITION_MAX_BADGES,
  RECOGNITION_MAX_LEVELS,
  RECOGNITION_MAX_THRESHOLD,
  levelsAreLadder,
} from './recognition';

/**
 * Reward rule configuration (ADR-033, docs/10 § 10.8).
 *
 * `creditPerPointMinor` is **optional and has no default**. Omitting it makes
 * the rule points-only, which is the honest state while docs/24 Q-09 — what
 * share of commission funds rewards — remains open. A default here would be an
 * invented conversion rate, which ADR-023 forbids.
 */

export const REWARD_TYPES = ['POINTS', 'CASHBACK'] as const;
export const PERIOD_TYPES = ['DAY', 'WEEK', 'MONTH'] as const;

/**
 * Trigger events a rule may be written against.
 *
 * A closed set of the events this service actually consumes. Accepting an
 * arbitrary string would let someone configure a rule for an event that never
 * arrives — a reward programme that silently does nothing, which is worse than
 * one that is refused at configuration time (ADR-032 lists what is consumed
 * and what is deferred).
 */
export const REWARD_TRIGGER_EVENTS = ['USAGE_RECORDED', 'MAINTENANCE_COMPLETED'] as const;

/**
 * The condition language, kept deliberately small.
 *
 * Equality, presence and numeric comparison over top-level payload fields,
 * combined with `all` / `any`. Small because a configurable rule language
 * grows into a programming language nobody tests, and because an unrecognised
 * shape evaluates to **false** — a mistyped condition withholds a reward
 * rather than granting one to everybody.
 */
const conditionLeaf = z
  .object({
    field: z.string().trim().min(1).max(64),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'present', 'absent']),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();

type ConditionNode =
  z.infer<typeof conditionLeaf> | { all: ConditionNode[] } | { any: ConditionNode[] };

const conditionSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    conditionLeaf,
    z.object({ all: z.array(conditionSchema).min(1).max(10) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(10) }).strict(),
  ]),
);

export const createRewardRuleSchema = z
  .object({
    /** Omit for a platform-wide rule. */
    organizationId: organizationIdSchema.optional(),
    triggerEvent: z.enum(REWARD_TRIGGER_EVENTS),
    rewardType: z.enum(REWARD_TYPES).default('POINTS'),
    condition: conditionSchema.optional(),
    /** Positive. A rule granting nothing should be INACTIVE instead. */
    points: z.number().int().positive().max(1_000_000),
    /**
     * Rial of wallet credit per point.
     *
     * Omit — the expected case today — and the rule is points-only and posts
     * no journal (ADR-033). Supplying it turns each grant into a real recorded
     * platform expense.
     */
    creditPerPointMinor: amountMinorSchema.optional(),
    /**
     * Anti-fraud cap: the most points this rule may grant one subject per
     * period (docs/10 § 10.9). Requires `periodType`.
     */
    periodCap: z.number().int().positive().max(10_000_000).optional(),
    periodType: z.enum(PERIOD_TYPES).optional(),
    validFrom: z.string().datetime().optional(),
    validTo: z.string().datetime().optional(),
    status: z.enum(RULE_STATUSES).default('ACTIVE'),
    /** "نمونه — نیازمند تصویب" for demonstration data (ADR-023). */
    label: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((dto) => (dto.periodCap === undefined) === (dto.periodType === undefined), {
    message:
      'periodCap and periodType must be supplied together — a cap without a window is not a cap',
    path: ['periodCap'],
  });

export type CreateRewardRuleDto = z.infer<typeof createRewardRuleSchema>;

/**
 * What may change on an existing reward rule: its end, its status, its label.
 *
 * Not `points`, `creditPerPointMinor` or `periodCap` — the terms a grant is
 * computed from. Edited in place they reached back to occurrences not yet
 * granted. A new term is a new rule; `.strict()` answers any attempt to send
 * one here with a 400 rather than ignoring it.
 */
export const updateRewardRuleSchema = z
  .object({
    status: z.enum(RULE_STATUSES).optional(),
    validTo: z.string().datetime().nullable().optional(),
    label: z.string().trim().max(200).optional(),
  })
  .strict();

export type UpdateRewardRuleDto = z.infer<typeof updateRewardRuleSchema>;

export const listRewardRulesQuerySchema = z
  .object({
    triggerEvent: z.enum(REWARD_TRIGGER_EVENTS).optional(),
  })
  .strict();

export type ListRewardRulesQuery = z.infer<typeof listRewardRulesQuerySchema>;

export const myRewardsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type MyRewardsQuery = z.infer<typeof myRewardsQuerySchema>;

// ---------------------------------------------------------------------------
// Participation (ADR-047 § 1, COM-012)
// ---------------------------------------------------------------------------

const participationContributionSchema = z
  .object({
    triggerEvent: z.enum(PARTICIPATION_FACTS),
    /** What one counted fact adds to the score. Positive: no penalties (Q-139). */
    weight: z.number().int().positive().max(PARTICIPATION_MAX_WEIGHT),
    /** Omit and every fact of this kind in the window counts. */
    maxPerWindow: z.number().int().positive().max(PARTICIPATION_MAX_PER_WINDOW).optional(),
  })
  .strict();

/**
 * A new version of the participation rule.
 *
 * Every number here is the administrator's, recorded with who set it
 * (`PARTICIPATION_RULE_CHANGED`); nothing has a default, because the product
 * document gives none of them (docs/24 Q-139). There is no update: the next
 * version replaces this one from the instant it is created.
 */
export const createParticipationRuleSchema = z
  .object({
    windowDays: z.number().int().positive().max(PARTICIPATION_MAX_WINDOW_DAYS),
    contributions: z
      .array(participationContributionSchema)
      .min(1)
      .max(PARTICIPATION_FACTS.length)
      .refine(
        (items) => new Set(items.map((item) => item.triggerEvent)).size === items.length,
        'each triggerEvent may appear once',
      ),
    /** "نمونه — نیازمند تصویب" for demonstration data (ADR-023). */
    label: z.string().trim().max(200).optional(),
  })
  .strict();

export type CreateParticipationRuleDto = z.infer<typeof createParticipationRuleSchema>;

/**
 * `GET /v1/rewards/me/participation`. Strict: there is no `userId` to name,
 * and naming one is a 400, not a silent read of the caller's own.
 */
export const myParticipationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type MyParticipationQuery = z.infer<typeof myParticipationQuerySchema>;

export interface ParticipationRuleApiView {
  id: string;
  version: number;
  windowDays: number;
  contributions: {
    triggerEvent: string;
    weight: number;
    maxPerWindow: number | null;
  }[];
  label: string | null;
  createdAt: string;
  createdBy: string;
}

/** The caller's participation score, explained, and never spendable. */
export interface ParticipationView {
  organizationId: string;
  userId: string;
  /** Always false: the score is an index, not a balance (ADR-047 § 1). */
  spendable: false;
  /** `NO_RULE` while no participation rule exists (docs/24 Q-139). */
  status: 'NO_RULE' | 'SCORED';
  asOf: string;
  score: number | null;
  rule: Omit<ParticipationRuleApiView, 'createdBy'> | null;
  window: { from: string; to: string } | null;
  breakdown: {
    triggerEvent: string;
    weight: number;
    maxPerWindow: number | null;
    facts: number;
    counted: number;
    contribution: number;
  }[];
  recentFacts: {
    triggerEvent: string;
    sourceReference: string;
    occurredAt: string;
    counted: boolean;
    effect: number;
  }[];
}

// ---------------------------------------------------------------------------
// Levels and badges (COM-012 criterion 2)
// ---------------------------------------------------------------------------

const recognitionName = z.string().trim().min(1).max(80);
const recognitionThreshold = z.number().int().min(0).max(RECOGNITION_MAX_THRESHOLD);

/**
 * A new version of the levels and badges.
 *
 * `basis` says what every threshold in it is measured on, and has no default:
 * ADR-047 § 1 requires it explicit, and which one the product wants is docs/24
 * Q-140, as are every threshold and name. Levels are given lowest first and
 * ranked in that order; their thresholds rise strictly, so a value holds one
 * level at most. There is no field for a benefit (Q-13, Q-31) and no update:
 * the next version replaces this one from the instant it is created.
 */
export const createRecognitionRuleSchema = z
  .object({
    basis: z.enum(RECOGNITION_BASES),
    levels: z
      .array(z.object({ name: recognitionName, threshold: recognitionThreshold }).strict())
      .max(RECOGNITION_MAX_LEVELS)
      .refine(levelsAreLadder, 'level thresholds must rise strictly, lowest level first')
      .refine(
        (items) => new Set(items.map((item) => item.name)).size === items.length,
        'each level name may appear once',
      ),
    badges: z
      .array(
        z
          .object({
            code: z.string().regex(RECOGNITION_BADGE_CODE),
            name: recognitionName,
            threshold: recognitionThreshold,
          })
          .strict(),
      )
      .max(RECOGNITION_MAX_BADGES)
      .refine(
        (items) => new Set(items.map((item) => item.code)).size === items.length,
        'each badge code may appear once',
      ),
    /** "نمونه — نیازمند تصویب" for demonstration data (ADR-023). */
    label: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine(
    (dto) => dto.levels.length + dto.badges.length > 0,
    'a version names at least one level or badge',
  );

export type CreateRecognitionRuleDto = z.infer<typeof createRecognitionRuleSchema>;

/**
 * `GET /v1/rewards/me/recognition`. It takes nothing, strictly: naming a user
 * or an organization is a 400, not a silent read of the caller's own.
 */
export const myRecognitionQuerySchema = z.object({}).strict();

export type MyRecognitionQuery = z.infer<typeof myRecognitionQuerySchema>;

export interface RecognitionRuleApiView {
  id: string;
  version: number;
  basis: string;
  levels: { rank: number; name: string; threshold: number }[];
  badges: { code: string; name: string; threshold: number }[];
  label: string | null;
  createdAt: string;
  createdBy: string;
}

/**
 * The caller's level and badges, and why. Only what is held: never the levels
 * above, the distance to them, or the badges not held.
 */
export interface RecognitionView {
  organizationId: string;
  userId: string;
  /**
   * `NO_RULE` while no version exists (docs/24 Q-140); `NO_BASIS` when the
   * version is read on the participation score and no participation rule
   * exists (Q-139); otherwise `EVALUATED`.
   */
  status: 'NO_RULE' | 'NO_BASIS' | 'EVALUATED';
  asOf: string;
  rule: {
    id: string;
    version: number;
    basis: string;
    label: string | null;
    createdAt: string;
  } | null;
  basis: {
    kind: string;
    value: number | null;
    /** The participation rule version the score was read under; null on reward points. */
    participationRuleVersion: number | null;
  } | null;
  level: { rank: number; name: string; threshold: number } | null;
  badges: { code: string; name: string; threshold: number }[];
}

export interface RewardView {
  id: string;
  organizationId: string;
  userId: string;
  ruleId: string;
  triggerEvent: string;
  sourceReference: string;
  points: number;
  creditAmountMinor: string;
  currency: string;
  monetised: boolean;
  journalId: string | null;
  grantedAt: string;
}

export interface RewardBalanceView {
  organizationId: string;
  userId: string;
  totalPoints: number;
  /** Null while no level ladder is configured — docs/24 Q-13 is open. */
  level: { id: string; name: string; rank: number; minPoints: number } | null;
  lifetimeCreditMinor: string;
  updatedAt: string;
}

import { z } from 'zod';
import { amountMinorSchema, organizationIdSchema } from '@rasta/contracts';
import { RULE_STATUSES } from '../commission/dto';

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

export const updateRewardRuleSchema = z
  .object({
    points: z.number().int().positive().max(1_000_000).optional(),
    /** Null clears it, returning the rule to points-only. */
    creditPerPointMinor: amountMinorSchema.nullable().optional(),
    periodCap: z.number().int().positive().max(10_000_000).nullable().optional(),
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

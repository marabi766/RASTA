import { z } from 'zod';
import { amountMinorSchema, organizationIdSchema } from '@rasta/contracts';
import { TRANSACTION_TYPES } from '../transaction/dto';

/**
 * Commission rule configuration (ADR-023).
 *
 * **The rate is a required integer in basis points.** No default is offered
 * here and none is filled in downstream: the product document says the precise
 * rate "ساختگی و پیشینی نیست" and docs/24 Q-08 is open, so a schema default
 * would be this service inventing the very number it is forbidden to invent.
 *
 * `rateBasisPoints` is an integer for the reason ADR-022 gives: 2.5% must be
 * exactly 250, and a decimal percentage cannot promise that.
 */

export const RULE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export const createCommissionRuleSchema = z
  .object({
    /**
     * Omit for a platform-wide rule.
     *
     * An organization-specific rule takes precedence over a platform-wide one,
     * which is how a negotiated arrangement is expressed without branching the
     * code (docs/10 § 10.7).
     */
    organizationId: organizationIdSchema.optional(),
    transactionType: z.enum(TRANSACTION_TYPES),
    /** 0–10 000. 250 is 2.5%; 10 000 would be the whole transaction. */
    rateBasisPoints: z.number().int().min(0).max(10_000),
    /** Floor and ceiling on the commission itself, not on the transaction. */
    minAmountMinor: amountMinorSchema.optional(),
    maxAmountMinor: amountMinorSchema.optional(),
    /** Defaults to now. Rules are versioned in time (docs/10 § 10.7). */
    validFrom: z.string().datetime().optional(),
    /** Exclusive, so a replacement can start exactly where this one ends. */
    validTo: z.string().datetime().optional(),
    status: z.enum(RULE_STATUSES).default('ACTIVE'),
    /**
     * Provenance, shown wherever the rule is displayed.
     *
     * Demonstration data must be labelled "نمونه — نیازمند تصویب" so that a
     * sample rate can never be mistaken for an approved one (ADR-023).
     */
    label: z.string().trim().max(200).optional(),
  })
  .strict();

export type CreateCommissionRuleDto = z.infer<typeof createCommissionRuleSchema>;

/**
 * What may change on an existing rule: its end, its status, its label.
 *
 * **Not the rate**, and not the floor or ceiling. The rule engine selects a
 * rule by when a transaction occurred and reads its terms when it settles, so
 * an edited rate re-priced unsettled work retroactively. A new rate is a new
 * rule — close this one, create the next — and `.strict()` answers any attempt
 * to send `rateBasisPoints` here with a 400 rather than ignoring it.
 */
export const updateCommissionRuleSchema = z
  .object({
    status: z.enum(RULE_STATUSES).optional(),
    /**
     * Closing a rule is `validTo`, never a delete.
     *
     * A commission already charged references the rule that produced it, and
     * deleting it would make a historical charge unexplainable (docs/10 §
     * 10.7). Only forward: a close in the past, or moving the end of a rule
     * that has already ended, is refused (`nextValidTo`). Nulling it makes a
     * rule that is still in force indefinite again.
     */
    validTo: z.string().datetime().nullable().optional(),
    label: z.string().trim().max(200).optional(),
  })
  .strict();

export type UpdateCommissionRuleDto = z.infer<typeof updateCommissionRuleSchema>;

export const listCommissionRulesQuerySchema = z
  .object({
    transactionType: z.enum(TRANSACTION_TYPES).optional(),
  })
  .strict();

export type ListCommissionRulesQuery = z.infer<typeof listCommissionRulesQuerySchema>;

export const listCommissionsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type ListCommissionsQuery = z.infer<typeof listCommissionsQuerySchema>;

export interface CommissionRuleView {
  id: string;
  organizationId: string | null;
  transactionType: string;
  rateBasisPoints: number;
  minAmountMinor: string | null;
  maxAmountMinor: string | null;
  validFrom: string;
  validTo: string | null;
  status: string;
  label: string | null;
}

export interface CommissionView {
  id: string;
  transactionId: string;
  organizationId: string;
  /** Null when no rule matched: zero commission because unconfigured. */
  ruleId: string | null;
  rateBasisPoints: number;
  grossAmountMinor: string;
  amountMinor: string;
  currency: string;
  appliedAt: string;
}

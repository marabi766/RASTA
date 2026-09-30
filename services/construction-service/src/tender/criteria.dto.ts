import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';

/**
 * Evaluation criteria and their templates (ADR-067 § 1).
 *
 * A criterion is **data**: a code, a label, a weight in basis points, one of the
 * scoring methods the code implements, and a maximum score. Nothing about a
 * weight or a criterion is written in code, and the platform ships no template
 * of its own (AGENTS.md § 8, docs/04 § 4.12).
 *
 * `.strict()` everywhere: `organizationId`, `position`, `createdBy` and the like
 * are decided by the token and by the order of the list, never by the body.
 */

/** The methods the code implements (ADR-067 § 1, Q-88). A new one is code and an ADR. */
export const SCORING_METHODS = ['MANUAL_SCORE', 'PASS_FAIL'] as const;

export const TOTAL_WEIGHT_BP = 10_000;
export const MAX_CRITERIA = 50;

/** The compare-and-set precondition every change carries (ADR-065). */
const expectedVersion = z.number().int().min(1).max(2_147_483_647);

const PROVISIONAL = 'Provisional (docs/24 Q-88, ADR-067 § 1):';

export const criterionInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'A code is 1 to 64 letters, digits, _ . or -')
      .describe('Identifies the criterion within a tender; what scores refer to.'),
    label: z.string().trim().min(1).max(200),
    weightBp: z
      .number()
      .int()
      .min(1)
      .max(TOTAL_WEIGHT_BP)
      .describe(
        `${PROVISIONAL} the weight in basis points of the total; a published tender sums to 10000.`,
      ),
    scoringMethod: z
      .enum(SCORING_METHODS)
      .describe(
        `${PROVISIONAL} MANUAL_SCORE (an evaluator enters 0..maxScore) or PASS_FAIL (0 or 1).`,
      ),
    maxScore: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .describe(`${PROVISIONAL} the whole-number maximum; 1 for PASS_FAIL.`),
  })
  .strict()
  .refine((value) => value.scoringMethod !== 'PASS_FAIL' || value.maxScore === 1, {
    message: 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1',
    path: ['maxScore'],
  });

export type CriterionInput = z.infer<typeof criterionInputSchema>;

/** A list of criteria: unique codes, and no more than the whole (10000 bp). */
export const criteriaListSchema = z
  .array(criterionInputSchema)
  .min(1)
  .max(MAX_CRITERIA)
  .refine((items) => new Set(items.map((item) => item.code)).size === items.length, {
    message: 'Criterion codes must be unique',
  })
  .refine((items) => items.reduce((sum, item) => sum + item.weightBp, 0) <= TOTAL_WEIGHT_BP, {
    message: `The weights sum to more than ${TOTAL_WEIGHT_BP} basis points`,
  });

export const createCriteriaTemplateSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    criteria: criteriaListSchema,
  })
  .strict();

export type CreateCriteriaTemplateDto = z.infer<typeof createCriteriaTemplateSchema>;

export const listCriteriaTemplatesQuerySchema = cursorPaginationSchema
  .extend({ label: z.string().trim().min(1).max(200).optional() })
  .strict();

export type ListCriteriaTemplatesQuery = z.infer<typeof listCriteriaTemplatesQuerySchema>;

/**
 * SetCriteria: a template to copy, or the criteria written out — exactly one.
 * Replaces the tender's whole list. Allowed only while the tender is a DRAFT.
 */
export const setCriteriaSchema = z
  .object({
    expectedVersion,
    templateId: z.string().trim().min(1).max(64).optional(),
    criteria: criteriaListSchema.optional(),
  })
  .strict()
  .refine((value) => (value.templateId === undefined) !== (value.criteria === undefined), {
    message: 'Give either templateId or criteria, not both and not neither',
  });

export type SetCriteriaDto = z.infer<typeof setCriteriaSchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export const criterionViewSchema = z
  .object({
    id: z.string(),
    position: z.number().int(),
    code: z.string(),
    label: z.string(),
    weightBp: z.number().int(),
    scoringMethod: z.enum(SCORING_METHODS),
    maxScore: z.number().int(),
    templateId: z.string().nullable(),
  })
  .strict();

export const criteriaViewSchema = z
  .object({
    tenderId: z.string(),
    items: z.array(criterionViewSchema),
    totalWeightBp: z.number().int(),
    /** Whether the weights sum to exactly 10000: what publishing requires. */
    complete: z.boolean(),
    /** The tender's version after this change; send it as `expectedVersion` next. */
    version: z.number().int(),
  })
  .strict();

export const criteriaTemplateViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    label: z.string(),
    version: z.number().int(),
    criteria: z.array(
      z
        .object({
          code: z.string(),
          label: z.string(),
          weightBp: z.number().int(),
          scoringMethod: z.enum(SCORING_METHODS),
          maxScore: z.number().int(),
        })
        .strict(),
    ),
    totalWeightBp: z.number().int(),
    createdAt: z.string(),
    createdBy: z.string(),
  })
  .strict();

export type CriterionView = z.infer<typeof criterionViewSchema>;
export type CriteriaView = z.infer<typeof criteriaViewSchema>;
export type CriteriaTemplateView = z.infer<typeof criteriaTemplateViewSchema>;

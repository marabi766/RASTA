import { z } from 'zod';
import { MAX_CRITERIA } from './criteria.dto';

/**
 * Evaluating a tender's opened bids (ADR-067 § 2): the owner's evaluators decide whether each
 * bid qualifies, score the qualified ones against the tender's frozen criteria, and then complete
 * the evaluation. Nothing the caller sends decides who, when or under which organization: the
 * evaluator is the token's, the instant the database's, the organization the tender's owner.
 */

/**
 * Why a bid is disqualified: a closed code (it is on the event), and the reason in words, which
 * stays in the database. PROVISIONAL (Q-92): ADR-067 says "a closed reason" without listing it.
 * `INTEGRITY_VIOLATION` is ADR-066 § 3's: a bid whose content does not match its commitment is
 * **not** disqualified automatically, an evaluator decides.
 */
export const DISQUALIFICATION_REASONS = [
  'NOT_ELIGIBLE',
  'NON_RESPONSIVE',
  'INTEGRITY_VIOLATION',
  'OTHER',
] as const;
export type DisqualificationReason = (typeof DISQUALIFICATION_REASONS)[number];

/** Why an evaluator stands down from a bid: a closed code; prose is not kept. PROVISIONAL (Q-92). */
export const RECUSAL_REASONS = ['CONFLICT_OF_INTEREST', 'OTHER'] as const;
export type RecusalReason = (typeof RECUSAL_REASONS)[number];

/** A score is the points × 100 as an integer: no float crosses the API (ADR-067 § 2). */
export const SCORE_SCALE = 100;
/** `criterion.max_score` is at most 1 000 000 (criteria.dto), so a score is at most 100 000 000. */
const MAX_SCORE_SCALED = 1_000_000 * SCORE_SCALE;

const identifier = z.string().min(1).max(64);

export const qualifyBidSchema = z
  .object({
    decision: z.enum(['QUALIFIED', 'DISQUALIFIED']),
    reasonCode: z
      .enum(DISQUALIFICATION_REASONS)
      .optional()
      .describe('Required for DISQUALIFIED, forbidden for QUALIFIED. A closed code.'),
    reasonText: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'Required for DISQUALIFIED, forbidden for QUALIFIED. Kept in the database; never on an event and never shown to the bidder.',
      ),
  })
  .strict()
  .refine(
    (value) =>
      value.decision === 'DISQUALIFIED'
        ? value.reasonCode !== undefined && value.reasonText !== undefined
        : value.reasonCode === undefined && value.reasonText === undefined,
    {
      message:
        'A DISQUALIFIED decision needs reasonCode and reasonText; a QUALIFIED one gives neither',
    },
  );
export type QualifyBidDto = z.infer<typeof qualifyBidSchema>;

export const recuseSchema = z.object({ reasonCode: z.enum(RECUSAL_REASONS) }).strict();
export type RecuseDto = z.infer<typeof recuseSchema>;

export const scoreBidSchema = z
  .object({
    scores: z
      .array(
        z
          .object({
            criterionCode: identifier,
            scoreScaled: z
              .number()
              .int()
              .min(0)
              .max(MAX_SCORE_SCALED)
              .describe(
                'The score × 100, an integer: 0..maxScore × 100 (a PASS_FAIL criterion: 0 or maxScore × 100).',
              ),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CRITERIA)
      .refine((items) => new Set(items.map((item) => item.criterionCode)).size === items.length, {
        message: 'A criterion is scored once per request',
      }),
  })
  .strict();
export type ScoreBidDto = z.infer<typeof scoreBidSchema>;

// -- views -----------------------------------------------------------------------

export const qualificationViewSchema = z
  .object({
    bidId: z.string(),
    tenderId: z.string(),
    decision: z.enum(['QUALIFIED', 'DISQUALIFIED']),
    reasonCode: z.enum(DISQUALIFICATION_REASONS).nullable(),
    decidedAt: z.string(),
    decidedBy: z.string(),
    alreadyDecided: z
      .boolean()
      .describe('True when the same decision had been recorded before; nothing was written.'),
  })
  .strict();
export type QualificationView = z.infer<typeof qualificationViewSchema>;

export const recusalViewSchema = z
  .object({
    bidId: z.string(),
    tenderId: z.string(),
    evaluatorId: z.string().describe('The caller.'),
    reasonCode: z.enum(RECUSAL_REASONS),
    recusedAt: z.string(),
    alreadyRecused: z
      .boolean()
      .describe('True when the caller had already stood down; nothing was written.'),
  })
  .strict();
export type RecusalView = z.infer<typeof recusalViewSchema>;

export const scoreRecordedViewSchema = z
  .object({
    bidId: z.string(),
    tenderId: z.string(),
    evaluationId: z.string(),
    evaluatorId: z.string().describe('The caller.'),
    recorded: z
      .array(
        z
          .object({
            criterionCode: z.string(),
            revision: z.number().int(),
            scoreScaled: z.number().int(),
          })
          .strict(),
      )
      .describe('The cells written: each a new revision, the earlier ones kept.'),
    unchanged: z
      .array(z.string())
      .describe('Criteria whose latest score already was the one sent: nothing was written.'),
    complete: z
      .boolean()
      .describe('Whether the caller has now scored every criterion of the tender.'),
  })
  .strict();
export type ScoreRecordedView = z.infer<typeof scoreRecordedViewSchema>;

export const evaluatedViewSchema = z
  .object({
    tenderId: z.string(),
    status: z.string(),
    evaluatedAt: z.string(),
    evaluatedBy: z.string(),
    qualifiedBidCount: z.number().int(),
    matrixDigest: z
      .string()
      .describe('SHA-256 (hex) of the frozen matrix: decisions, recusals and every cell revision.'),
    alreadyEvaluated: z
      .boolean()
      .describe('True when the evaluation had been completed before; nothing was done.'),
  })
  .strict();
export type EvaluatedView = z.infer<typeof evaluatedViewSchema>;

const cellSchema = z
  .object({
    criterionCode: z.string(),
    scoreScaled: z.number().int(),
    revision: z.number().int(),
    scoredAt: z.string(),
  })
  .strict();

export const matrixViewSchema = z
  .object({
    tenderId: z.string(),
    status: z.string(),
    frozen: z
      .boolean()
      .describe('True once the evaluation is completed: the matrix cannot change.'),
    criteria: z.array(
      z
        .object({
          code: z.string(),
          label: z.string(),
          weightBp: z.number().int(),
          scoringMethod: z.string(),
          maxScore: z.number().int(),
        })
        .strict(),
    ),
    maxTotalScaled: z
      .string()
      .describe(
        'The most one evaluator can give: the sum of weightBp × maxScore × 100 (a bigint, as a string).',
      ),
    minEvaluators: z.number().int(),
    maxEvaluators: z.number().int(),
    ready: z
      .boolean()
      .describe(
        'Whether the evaluation may be completed: at least one QUALIFIED bid, every QUALIFIED bid has enough complete evaluators, and no opened bid is left undecided.',
      ),
    undecidedBidCount: z
      .number()
      .int()
      .describe('Opened bids nobody has yet qualified or disqualified.'),
    blockers: z.array(
      z
        .object({
          bidId: z.string(),
          completeEvaluators: z.number().int(),
          required: z.number().int(),
        })
        .strict(),
    ),
    bids: z.array(
      z
        .object({
          bidId: z.string(),
          bidderOrganizationId: z.string(),
          bidStatus: z.string(),
          qualification: z
            .object({
              decision: z.enum(['QUALIFIED', 'DISQUALIFIED']),
              reasonCode: z.enum(DISQUALIFICATION_REASONS).nullable(),
              reasonText: z.string().nullable(),
              decidedBy: z.string(),
              decidedAt: z.string(),
            })
            .strict()
            .nullable(),
          evaluations: z.array(
            z
              .object({
                evaluatorId: z.string(),
                complete: z.boolean(),
                totalScaled: z
                  .string()
                  .nullable()
                  .describe(
                    'Σ weightBp × scoreScaled over the criteria, once every one is scored (a bigint, as a string).',
                  ),
                cells: z.array(cellSchema).describe('The latest revision of each cell.'),
              })
              .strict(),
          ),
          recusals: z.array(
            z
              .object({
                evaluatorId: z.string(),
                reasonCode: z.enum(RECUSAL_REASONS),
                recusedAt: z.string(),
              })
              .strict(),
          ),
          evaluatorCount: z
            .number()
            .int()
            .describe('Complete evaluations, those who stood down not counted.'),
          totalScaled: z
            .string()
            .nullable()
            .describe(
              'The sum of the complete evaluators’ totals; null unless the bid is QUALIFIED and scored.',
            ),
          rank: z
            .number()
            .int()
            .nullable()
            .describe(
              '1 + the number of bids with a strictly higher mean total; equal bids share a rank (a tie never makes a winner).',
            ),
          tied: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type MatrixView = z.infer<typeof matrixViewSchema>;

/** What a contractor sees of the evaluation of its own bid (ADR-066 § 4, Q-89): status and its own total only. */
export const ownEvaluationViewSchema = z
  .object({
    decision: z.enum(['QUALIFIED', 'DISQUALIFIED']).nullable(),
    reasonCode: z.enum(DISQUALIFICATION_REASONS).nullable(),
    completed: z
      .boolean()
      .describe('Whether the evaluation is completed; scores are shown only then.'),
    totalScaled: z.string().nullable(),
    maxTotalScaled: z.string().nullable(),
    evaluatorCount: z.number().int().nullable(),
  })
  .strict();
export type OwnEvaluationView = z.infer<typeof ownEvaluationViewSchema>;

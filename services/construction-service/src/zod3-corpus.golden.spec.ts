import * as contracts from '@rasta/contracts';
import { decisionSchema } from './approval/dto';
import { constructionEnvSchema } from './config/env';
import { createProgressSchema } from './progress/dto';
import { updateNeedSchema, updateProjectSchema } from './project/dto';
import {
  createCriteriaTemplateSchema,
  criteriaListSchema,
  criterionInputSchema,
  setCriteriaSchema,
} from './tender/criteria.dto';
import { updateTenderSchema } from './tender/dto';
import { scoreBidSchema } from './tender/evaluation.dto';

/**
 * The PR #444 r3 differential corpus (Codex PR-444 r2 F1) for this workspace's
 * schema roots. Each case fails an integer check (a fraction, or ±Infinity
 * where text becomes a number) together with an enclosing refinement, or is a
 * reviewer's or a sibling class's reproduction; zod 3 reported both, zod 4
 * stopped at the integer. The roots are the exported schemas with an
 * integer under a refinement (`~/worker6/session/039/corpus`: `sweep.cjs`
 * inventory, `mkgolden.cjs`).
 *
 * Each `ZOD3` value was recorded by running this file unchanged on main
 * `5c88ae21` (zod 3.25.76), where `legacyParse` does not exist and
 * `outcome` reads zod 3's own issues (`~/worker2/session/t109/scripts/record.sh`);
 * never written by a test run here.
 */

type Issue = { path: readonly PropertyKey[]; code: string; message: string };
type LegacyParse = (schema: unknown, input: unknown) => { refusal?: { issues: readonly Issue[] } };

/** `[path, code, message]` per issue, in order, or `accepted`. */
function outcome(schema: { safeParse(input: unknown): unknown }, input: unknown): unknown {
  const legacyParse = (contracts as unknown as { legacyParse?: LegacyParse }).legacyParse;
  const issues = legacyParse
    ? legacyParse(schema, input).refusal?.issues
    : (schema.safeParse(input) as { error?: { issues: readonly Issue[] } }).error?.issues;
  if (issues === undefined) return 'accepted';
  return issues.map((issue) => [issue.path.map(String).join('.'), issue.code, issue.message]);
}

/** Recorded under zod 3 on main 5c88ae21; never written by a test run. */
const ZOD3: Record<string, unknown> = {
  'decisionSchema m0 enum decision=REJECT + expectedVersion=0.5': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['reason', 'custom', 'A rejection states its reason'],
  ],
  'decisionSchema m0 enum decision=REJECT + expectedVersion=Infinity': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_big', 'Number must be less than or equal to 2147483647'],
    ['reason', 'custom', 'A rejection states its reason'],
  ],
  'constructionEnvSchema m0 CONSTRUCTION_EVALUATION_MAX_EVALUATORS=0.5': [
    ['CONSTRUCTION_EVALUATION_MAX_EVALUATORS', 'invalid_type', 'Expected integer, received float'],
    [
      'CONSTRUCTION_EVALUATION_MAX_EVALUATORS',
      'too_small',
      'Number must be greater than or equal to 1',
    ],
    [
      'CONSTRUCTION_EVALUATION_MIN_EVALUATORS',
      'custom',
      'CONSTRUCTION_EVALUATION_MIN_EVALUATORS may not exceed CONSTRUCTION_EVALUATION_MAX_EVALUATORS: no bid could ever be complete',
    ],
  ],
  'constructionEnvSchema m0 CONSTRUCTION_EVALUATION_MAX_EVALUATORS=Infinity': [
    ['CONSTRUCTION_EVALUATION_MAX_EVALUATORS', 'invalid_type', 'Expected integer, received float'],
    ['CONSTRUCTION_EVALUATION_MAX_EVALUATORS', 'too_big', 'Number must be less than or equal to 9'],
  ],
  'createProgressSchema m0 add assetsUsed + progressBasisPoints=0.5': [
    ['progressBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['assetsUsed', 'custom', 'The same asset may be listed only once'],
  ],
  'createProgressSchema m0 add assetsUsed + progressBasisPoints=Infinity': [
    ['progressBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['progressBasisPoints', 'too_big', 'Number must be less than or equal to 10000'],
    ['assetsUsed', 'custom', 'The same asset may be listed only once'],
  ],
  'updateNeedSchema m0 expectedVersion=0.5': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['', 'custom', 'An update must change at least one field'],
  ],
  'updateNeedSchema m0 expectedVersion=Infinity': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_big', 'Number must be less than or equal to 2147483647'],
    ['', 'custom', 'An update must change at least one field'],
  ],
  'updateProjectSchema m0 expectedVersion=0.5': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['', 'custom', 'An update must change at least one field'],
  ],
  'updateProjectSchema m0 expectedVersion=Infinity': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_big', 'Number must be less than or equal to 2147483647'],
    ['', 'custom', 'An update must change at least one field'],
  ],
  'createCriteriaTemplateSchema m0 dup criteria + criteria.0.weightBp=0.5': [
    ['criteria.0.weightBp', 'invalid_type', 'Expected integer, received float'],
    ['criteria.0.weightBp', 'too_small', 'Number must be greater than or equal to 1'],
    ['criteria', 'custom', 'Criterion codes must be unique'],
  ],
  'createCriteriaTemplateSchema m0 dup criteria + criteria.0.weightBp=Infinity': [
    ['criteria.0.weightBp', 'invalid_type', 'Expected integer, received float'],
    ['criteria.0.weightBp', 'too_big', 'Number must be less than or equal to 10000'],
    ['criteria', 'custom', 'Criterion codes must be unique'],
    ['criteria', 'custom', 'The weights sum to more than 10000 basis points'],
  ],
  'criteriaListSchema m0 dup  + 0.weightBp=0.5': [
    ['0.weightBp', 'invalid_type', 'Expected integer, received float'],
    ['0.weightBp', 'too_small', 'Number must be greater than or equal to 1'],
    ['', 'custom', 'Criterion codes must be unique'],
  ],
  'criteriaListSchema m0 dup  + 0.weightBp=Infinity': [
    ['0.weightBp', 'invalid_type', 'Expected integer, received float'],
    ['0.weightBp', 'too_big', 'Number must be less than or equal to 10000'],
    ['', 'custom', 'Criterion codes must be unique'],
    ['', 'custom', 'The weights sum to more than 10000 basis points'],
  ],
  'criterionInputSchema m0 enum scoringMethod=PASS_FAIL + maxScore=0.5': [
    ['maxScore', 'invalid_type', 'Expected integer, received float'],
    ['maxScore', 'too_small', 'Number must be greater than or equal to 1'],
    ['maxScore', 'custom', 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1'],
  ],
  'criterionInputSchema m0 enum scoringMethod=PASS_FAIL + maxScore=Infinity': [
    ['maxScore', 'invalid_type', 'Expected integer, received float'],
    ['maxScore', 'too_big', 'Number must be less than or equal to 1000000'],
    ['maxScore', 'custom', 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1'],
  ],
  'setCriteriaSchema m0 expectedVersion=0.5': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['', 'custom', 'Give either templateId or criteria, not both and not neither'],
  ],
  'setCriteriaSchema m0 expectedVersion=Infinity': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_big', 'Number must be less than or equal to 2147483647'],
    ['', 'custom', 'Give either templateId or criteria, not both and not neither'],
  ],
  'updateTenderSchema m0 expectedVersion=0.5': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['', 'custom', 'An update must change at least one field'],
  ],
  'updateTenderSchema m0 expectedVersion=Infinity': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_big', 'Number must be less than or equal to 2147483647'],
    ['', 'custom', 'An update must change at least one field'],
  ],
  'scoreBidSchema m0 dup scores + scores.0.scoreScaled=0.5': [
    ['scores.0.scoreScaled', 'invalid_type', 'Expected integer, received float'],
    ['scores', 'custom', 'A criterion is scored once per request'],
  ],
  'scoreBidSchema m0 dup scores + scores.0.scoreScaled=Infinity': [
    ['scores.0.scoreScaled', 'invalid_type', 'Expected integer, received float'],
    ['scores.0.scoreScaled', 'too_big', 'Number must be less than or equal to 100000000'],
    ['scores', 'custom', 'A criterion is scored once per request'],
  ],
  'createProgressSchema review r2: The same asset may be listed only once': [
    ['progressBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['assetsUsed', 'custom', 'The same asset may be listed only once'],
  ],
  'criterionInputSchema review r2: A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1': [
    ['maxScore', 'invalid_type', 'Expected integer, received float'],
    ['maxScore', 'custom', 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'decisionSchema m0 enum decision=REJECT + expectedVersion=0.5',
    decisionSchema,
    { expectedVersion: 0.5, decision: 'REJECT' },
  ],
  [
    'decisionSchema m0 enum decision=REJECT + expectedVersion=Infinity',
    decisionSchema,
    { expectedVersion: Number.POSITIVE_INFINITY, decision: 'REJECT' },
  ],
  [
    'constructionEnvSchema m0 CONSTRUCTION_EVALUATION_MAX_EVALUATORS=0.5',
    constructionEnvSchema,
    {
      SERVICE_NAME: 'Sample',
      PORT: 1,
      DATABASE_URL: 'postgresql://one:two@localhost:5432/one',
      KAFKA_BROKERS: 'Sample',
      KAFKA_CLIENT_ID: 'ORG-SAMPLE',
      OIDC_ISSUER_URL: 'https://example.test',
      OIDC_JWKS_URI: 'https://example.test',
      OIDC_AUDIENCE: 'ORG-SAMPLE',
      INTERNAL_TOKEN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      CONSTRUCTION_EVALUATION_MAX_EVALUATORS: 0.5,
    },
  ],
  [
    'constructionEnvSchema m0 CONSTRUCTION_EVALUATION_MAX_EVALUATORS=Infinity',
    constructionEnvSchema,
    {
      SERVICE_NAME: 'Sample',
      PORT: 1,
      DATABASE_URL: 'postgresql://one:two@localhost:5432/one',
      KAFKA_BROKERS: 'Sample',
      KAFKA_CLIENT_ID: 'ORG-SAMPLE',
      OIDC_ISSUER_URL: 'https://example.test',
      OIDC_JWKS_URI: 'https://example.test',
      OIDC_AUDIENCE: 'ORG-SAMPLE',
      INTERNAL_TOKEN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      CONSTRUCTION_EVALUATION_MAX_EVALUATORS: Number.POSITIVE_INFINITY,
    },
  ],
  [
    'createProgressSchema m0 add assetsUsed + progressBasisPoints=0.5',
    createProgressSchema,
    { progressBasisPoints: 0.5, assetsUsed: ['AST-SAMPLE', 'AST-SAMPLE'] },
  ],
  [
    'createProgressSchema m0 add assetsUsed + progressBasisPoints=Infinity',
    createProgressSchema,
    { progressBasisPoints: Number.POSITIVE_INFINITY, assetsUsed: ['AST-SAMPLE', 'AST-SAMPLE'] },
  ],
  ['updateNeedSchema m0 expectedVersion=0.5', updateNeedSchema, { expectedVersion: 0.5 }],
  [
    'updateNeedSchema m0 expectedVersion=Infinity',
    updateNeedSchema,
    { expectedVersion: Number.POSITIVE_INFINITY },
  ],
  ['updateProjectSchema m0 expectedVersion=0.5', updateProjectSchema, { expectedVersion: 0.5 }],
  [
    'updateProjectSchema m0 expectedVersion=Infinity',
    updateProjectSchema,
    { expectedVersion: Number.POSITIVE_INFINITY },
  ],
  [
    'createCriteriaTemplateSchema m0 dup criteria + criteria.0.weightBp=0.5',
    createCriteriaTemplateSchema,
    {
      label: 'Sample',
      criteria: [
        {
          code: 'Sample',
          label: 'Sample',
          weightBp: 0.5,
          scoringMethod: 'MANUAL_SCORE',
          maxScore: 1,
        },
        {
          code: 'Sample',
          label: 'Sample',
          weightBp: 1,
          scoringMethod: 'MANUAL_SCORE',
          maxScore: 1,
        },
      ],
    },
  ],
  [
    'createCriteriaTemplateSchema m0 dup criteria + criteria.0.weightBp=Infinity',
    createCriteriaTemplateSchema,
    {
      label: 'Sample',
      criteria: [
        {
          code: 'Sample',
          label: 'Sample',
          weightBp: Number.POSITIVE_INFINITY,
          scoringMethod: 'MANUAL_SCORE',
          maxScore: 1,
        },
        {
          code: 'Sample',
          label: 'Sample',
          weightBp: 1,
          scoringMethod: 'MANUAL_SCORE',
          maxScore: 1,
        },
      ],
    },
  ],
  [
    'criteriaListSchema m0 dup  + 0.weightBp=0.5',
    criteriaListSchema,
    [
      {
        code: 'Sample',
        label: 'Sample',
        weightBp: 0.5,
        scoringMethod: 'MANUAL_SCORE',
        maxScore: 1,
      },
      { code: 'Sample', label: 'Sample', weightBp: 1, scoringMethod: 'MANUAL_SCORE', maxScore: 1 },
    ],
  ],
  [
    'criteriaListSchema m0 dup  + 0.weightBp=Infinity',
    criteriaListSchema,
    [
      {
        code: 'Sample',
        label: 'Sample',
        weightBp: Number.POSITIVE_INFINITY,
        scoringMethod: 'MANUAL_SCORE',
        maxScore: 1,
      },
      { code: 'Sample', label: 'Sample', weightBp: 1, scoringMethod: 'MANUAL_SCORE', maxScore: 1 },
    ],
  ],
  [
    'criterionInputSchema m0 enum scoringMethod=PASS_FAIL + maxScore=0.5',
    criterionInputSchema,
    { code: 'Sample', label: 'Sample', weightBp: 1, scoringMethod: 'PASS_FAIL', maxScore: 0.5 },
  ],
  [
    'criterionInputSchema m0 enum scoringMethod=PASS_FAIL + maxScore=Infinity',
    criterionInputSchema,
    {
      code: 'Sample',
      label: 'Sample',
      weightBp: 1,
      scoringMethod: 'PASS_FAIL',
      maxScore: Number.POSITIVE_INFINITY,
    },
  ],
  ['setCriteriaSchema m0 expectedVersion=0.5', setCriteriaSchema, { expectedVersion: 0.5 }],
  [
    'setCriteriaSchema m0 expectedVersion=Infinity',
    setCriteriaSchema,
    { expectedVersion: Number.POSITIVE_INFINITY },
  ],
  ['updateTenderSchema m0 expectedVersion=0.5', updateTenderSchema, { expectedVersion: 0.5 }],
  [
    'updateTenderSchema m0 expectedVersion=Infinity',
    updateTenderSchema,
    { expectedVersion: Number.POSITIVE_INFINITY },
  ],
  [
    'scoreBidSchema m0 dup scores + scores.0.scoreScaled=0.5',
    scoreBidSchema,
    {
      scores: [
        { criterionCode: 'Sample', scoreScaled: 0.5, expectedRevision: 1 },
        { criterionCode: 'Sample', scoreScaled: 1, expectedRevision: 1 },
      ],
    },
  ],
  [
    'scoreBidSchema m0 dup scores + scores.0.scoreScaled=Infinity',
    scoreBidSchema,
    {
      scores: [
        { criterionCode: 'Sample', scoreScaled: Number.POSITIVE_INFINITY, expectedRevision: 1 },
        { criterionCode: 'Sample', scoreScaled: 1, expectedRevision: 1 },
      ],
    },
  ],
  [
    'createProgressSchema review r2: The same asset may be listed only once',
    createProgressSchema,
    {
      progressBasisPoints: 0.5,
      assetsUsed: ['AST_01JB9V5Q6K8M2N4P7R3S5T7V9X', 'AST_01JB9V5Q6K8M2N4P7R3S5T7V9X'],
    },
  ],
  [
    'criterionInputSchema review r2: A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1',
    criterionInputSchema,
    { code: 'Sample', label: 'Sample', weightBp: 1, scoringMethod: 'PASS_FAIL', maxScore: 1.5 },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});

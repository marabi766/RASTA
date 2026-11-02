import * as contracts from '@rasta/contracts';
import { economicEnvSchema } from './config/env';
import { ECONOMIC_EVENT_SCHEMAS, commissionRuleChangedPayloadV1 } from './events/events';
import {
  createParticipationRuleSchema,
  createRecognitionRuleSchema,
  createRewardRuleSchema,
} from './reward/dto';

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
  'economicEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=0.5': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_small', 'Number must be greater than or equal to 1'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'custom', 'URL must be a valid URL'],
    ['ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE', 'invalid_union', 'Invalid input'],
  ],
  'economicEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=Infinity': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_big', 'Number must be less than or equal to 65535'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'custom', 'URL must be a valid URL'],
    ['ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE', 'invalid_union', 'Invalid input'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.COMMISSION_APPLIED m0 null ruleId + rateBasisPoints=0.5': [
    ['rateBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'outcome is NO_ACTIVE_RULE exactly when ruleId is null'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.COMMISSION_APPLIED m0 null ruleId + rateBasisPoints=Infinity': [
    ['rateBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['rateBasisPoints', 'too_big', 'Number must be less than or equal to 10000'],
    ['', 'custom', 'outcome is NO_ACTIVE_RULE exactly when ruleId is null'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.COMMISSION_RULE_CHANGED m0 before.rateBasisPoints=0.5': [
    ['before.rateBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'before is null exactly when the rule was created'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.COMMISSION_RULE_CHANGED m0 before.rateBasisPoints=Infinity': [
    ['before.rateBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['before.rateBasisPoints', 'too_big', 'Number must be less than or equal to 10000'],
    ['', 'custom', 'before is null exactly when the rule was created'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.REWARD_RULE_CHANGED m0 before.points=0.5': [
    ['before.points', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'before is null exactly when the rule was created'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.REWARD_RULE_CHANGED m0 before.points=Infinity': [
    ['before.points', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'before is null exactly when the rule was created'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.PARTICIPATION_RULE_CHANGED m0 before.version=0.5': [
    ['before.version', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'after is the version following before, and the first version follows none'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.PARTICIPATION_RULE_CHANGED m0 before.version=Infinity': [
    ['before.version', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'after is the version following before, and the first version follows none'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.RECOGNITION_RULE_CHANGED m0 before.version=0.5': [
    ['before.version', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'after is the version following before, and the first version follows none'],
  ],
  'ECONOMIC_EVENT_SCHEMAS.RECOGNITION_RULE_CHANGED m0 before.version=Infinity': [
    ['before.version', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'after is the version following before, and the first version follows none'],
  ],
  'commissionRuleChangedPayloadV1 m0 before.rateBasisPoints=0.5': [
    ['before.rateBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'before is null exactly when the rule was created'],
  ],
  'commissionRuleChangedPayloadV1 m0 before.rateBasisPoints=Infinity': [
    ['before.rateBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['before.rateBasisPoints', 'too_big', 'Number must be less than or equal to 10000'],
    ['', 'custom', 'before is null exactly when the rule was created'],
  ],
  'createParticipationRuleSchema m0 dup contributions + expectedCurrentVersion=0.5': [
    ['expectedCurrentVersion', 'invalid_type', 'Expected integer, received float'],
    ['contributions', 'custom', 'each triggerEvent may appear once'],
  ],
  'createParticipationRuleSchema m0 dup contributions + expectedCurrentVersion=Infinity': [
    ['expectedCurrentVersion', 'invalid_type', 'Expected integer, received float'],
    ['contributions', 'custom', 'each triggerEvent may appear once'],
  ],
  'createRecognitionRuleSchema m0 dup levels + expectedCurrentVersion=0.5': [
    ['expectedCurrentVersion', 'invalid_type', 'Expected integer, received float'],
    ['levels', 'custom', 'level thresholds must rise strictly, lowest level first'],
    ['levels', 'custom', 'each level name may appear once'],
  ],
  'createRecognitionRuleSchema m0 dup levels + expectedCurrentVersion=Infinity': [
    ['expectedCurrentVersion', 'invalid_type', 'Expected integer, received float'],
    ['levels', 'custom', 'level thresholds must rise strictly, lowest level first'],
    ['levels', 'custom', 'each level name may appear once'],
  ],
  'createRewardRuleSchema m0 periodCap=0.5': [
    ['periodCap', 'invalid_type', 'Expected integer, received float'],
    [
      'periodCap',
      'custom',
      'periodCap and periodType must be supplied together — a cap without a window is not a cap',
    ],
  ],
  'createRewardRuleSchema m0 periodCap=Infinity': [
    ['periodCap', 'invalid_type', 'Expected integer, received float'],
    ['periodCap', 'too_big', 'Number must be less than or equal to 10000000'],
    [
      'periodCap',
      'custom',
      'periodCap and periodType must be supplied together — a cap without a window is not a cap',
    ],
  ],
  'createRewardRuleSchema review r2: periodCap and periodType must be supplied together — a cap w':
    [
      ['points', 'invalid_type', 'Expected integer, received float'],
      [
        'periodCap',
        'custom',
        'periodCap and periodType must be supplied together — a cap without a window is not a cap',
      ],
    ],
  'createRecognitionRuleSchema review r2: a version names at least one level or badge': [
    ['expectedCurrentVersion', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'a version names at least one level or badge'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'economicEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=0.5',
    economicEnvSchema,
    {
      SERVICE_NAME: 'Sample',
      PORT: 0.5,
      DATABASE_URL: 'postgresql://one:two@localhost:5432/one',
      KAFKA_BROKERS: 'Sample',
      KAFKA_CLIENT_ID: 'ORG-SAMPLE',
      OIDC_ISSUER_URL: 'https://example.test',
      OIDC_JWKS_URI: 'https://example.test',
      OIDC_AUDIENCE: 'ORG-SAMPLE',
      INTERNAL_TOKEN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE: null,
      MAINTENANCE_SERVICE_URL: 'https://example.test',
      FLEET_SERVICE_URL: 'https://example.test',
      CONTRACT_SERVICE_URL: 'https://example.test',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'Sample',
    },
  ],
  [
    'economicEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=Infinity',
    economicEnvSchema,
    {
      SERVICE_NAME: 'Sample',
      PORT: Number.POSITIVE_INFINITY,
      DATABASE_URL: 'postgresql://one:two@localhost:5432/one',
      KAFKA_BROKERS: 'Sample',
      KAFKA_CLIENT_ID: 'ORG-SAMPLE',
      OIDC_ISSUER_URL: 'https://example.test',
      OIDC_JWKS_URI: 'https://example.test',
      OIDC_AUDIENCE: 'ORG-SAMPLE',
      INTERNAL_TOKEN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE: null,
      MAINTENANCE_SERVICE_URL: 'https://example.test',
      FLEET_SERVICE_URL: 'https://example.test',
      CONTRACT_SERVICE_URL: 'https://example.test',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'Sample',
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.COMMISSION_APPLIED m0 null ruleId + rateBasisPoints=0.5',
    ECONOMIC_EVENT_SCHEMAS.COMMISSION_APPLIED,
    {
      commissionId: 'ORG-SAMPLE',
      transactionId: 'ORG-SAMPLE',
      organizationId: 'ORG-SAMPLE',
      ruleId: null,
      businessLine: 'PARTS',
      outcome: 'RULE_APPLIED',
      rateBasisPoints: 0.5,
      grossAmountMinor: '100000000000000000000',
      amountMinor: '100000000000000000000',
      currency: 'Sample',
      appliedAt: 'Sample',
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.COMMISSION_APPLIED m0 null ruleId + rateBasisPoints=Infinity',
    ECONOMIC_EVENT_SCHEMAS.COMMISSION_APPLIED,
    {
      commissionId: 'ORG-SAMPLE',
      transactionId: 'ORG-SAMPLE',
      organizationId: 'ORG-SAMPLE',
      ruleId: null,
      businessLine: 'PARTS',
      outcome: 'RULE_APPLIED',
      rateBasisPoints: Number.POSITIVE_INFINITY,
      grossAmountMinor: '100000000000000000000',
      amountMinor: '100000000000000000000',
      currency: 'Sample',
      appliedAt: 'Sample',
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.COMMISSION_RULE_CHANGED m0 before.rateBasisPoints=0.5',
    ECONOMIC_EVENT_SCHEMAS.COMMISSION_RULE_CHANGED,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        organizationId: 'ORG-SAMPLE',
        businessLine: 'PARTS',
        transactionType: 'Sample',
        rateBasisPoints: 0.5,
        minAmountMinor: '100000000000000000000',
        maxAmountMinor: '100000000000000000000',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
      after: {
        organizationId: 'ORG-SAMPLE',
        businessLine: 'PARTS',
        transactionType: 'Sample',
        rateBasisPoints: 1,
        minAmountMinor: '100000000000000000000',
        maxAmountMinor: '100000000000000000000',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.COMMISSION_RULE_CHANGED m0 before.rateBasisPoints=Infinity',
    ECONOMIC_EVENT_SCHEMAS.COMMISSION_RULE_CHANGED,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        organizationId: 'ORG-SAMPLE',
        businessLine: 'PARTS',
        transactionType: 'Sample',
        rateBasisPoints: Number.POSITIVE_INFINITY,
        minAmountMinor: '100000000000000000000',
        maxAmountMinor: '100000000000000000000',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
      after: {
        organizationId: 'ORG-SAMPLE',
        businessLine: 'PARTS',
        transactionType: 'Sample',
        rateBasisPoints: 1,
        minAmountMinor: '100000000000000000000',
        maxAmountMinor: '100000000000000000000',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.REWARD_RULE_CHANGED m0 before.points=0.5',
    ECONOMIC_EVENT_SCHEMAS.REWARD_RULE_CHANGED,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        organizationId: 'ORG-SAMPLE',
        triggerEvent: 'Sample',
        rewardType: 'Sample',
        condition: {},
        points: 0.5,
        creditPerPointMinor: '100000000000000000000',
        periodCap: 1,
        periodType: 'Sample',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
      after: {
        organizationId: 'ORG-SAMPLE',
        triggerEvent: 'Sample',
        rewardType: 'Sample',
        condition: {},
        points: 1,
        creditPerPointMinor: '100000000000000000000',
        periodCap: 1,
        periodType: 'Sample',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.REWARD_RULE_CHANGED m0 before.points=Infinity',
    ECONOMIC_EVENT_SCHEMAS.REWARD_RULE_CHANGED,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        organizationId: 'ORG-SAMPLE',
        triggerEvent: 'Sample',
        rewardType: 'Sample',
        condition: {},
        points: Number.POSITIVE_INFINITY,
        creditPerPointMinor: '100000000000000000000',
        periodCap: 1,
        periodType: 'Sample',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
      after: {
        organizationId: 'ORG-SAMPLE',
        triggerEvent: 'Sample',
        rewardType: 'Sample',
        condition: {},
        points: 1,
        creditPerPointMinor: '100000000000000000000',
        periodCap: 1,
        periodType: 'Sample',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.PARTICIPATION_RULE_CHANGED m0 before.version=0.5',
    ECONOMIC_EVENT_SCHEMAS.PARTICIPATION_RULE_CHANGED,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        version: 0.5,
        windowDays: 1,
        contributions: [{ triggerEvent: 'Sample', weight: 1, maxPerWindow: 1 }],
        label: 'Sample',
      },
      after: {
        version: 1,
        windowDays: 1,
        contributions: [{ triggerEvent: 'Sample', weight: 1, maxPerWindow: 1 }],
        label: 'Sample',
      },
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.PARTICIPATION_RULE_CHANGED m0 before.version=Infinity',
    ECONOMIC_EVENT_SCHEMAS.PARTICIPATION_RULE_CHANGED,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        version: Number.POSITIVE_INFINITY,
        windowDays: 1,
        contributions: [{ triggerEvent: 'Sample', weight: 1, maxPerWindow: 1 }],
        label: 'Sample',
      },
      after: {
        version: 1,
        windowDays: 1,
        contributions: [{ triggerEvent: 'Sample', weight: 1, maxPerWindow: 1 }],
        label: 'Sample',
      },
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.RECOGNITION_RULE_CHANGED m0 before.version=0.5',
    ECONOMIC_EVENT_SCHEMAS.RECOGNITION_RULE_CHANGED,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        version: 0.5,
        basis: 'REWARD_POINTS_CUMULATIVE',
        levels: [{ rank: 1, name: 'Sample', threshold: 1 }],
        badges: [{ code: 'Sample', name: 'Sample', threshold: 1 }],
        label: 'Sample',
      },
      after: {
        version: 1,
        basis: 'REWARD_POINTS_CUMULATIVE',
        levels: [{ rank: 1, name: 'Sample', threshold: 1 }],
        badges: [{ code: 'Sample', name: 'Sample', threshold: 1 }],
        label: 'Sample',
      },
    },
  ],
  [
    'ECONOMIC_EVENT_SCHEMAS.RECOGNITION_RULE_CHANGED m0 before.version=Infinity',
    ECONOMIC_EVENT_SCHEMAS.RECOGNITION_RULE_CHANGED,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        version: Number.POSITIVE_INFINITY,
        basis: 'REWARD_POINTS_CUMULATIVE',
        levels: [{ rank: 1, name: 'Sample', threshold: 1 }],
        badges: [{ code: 'Sample', name: 'Sample', threshold: 1 }],
        label: 'Sample',
      },
      after: {
        version: 1,
        basis: 'REWARD_POINTS_CUMULATIVE',
        levels: [{ rank: 1, name: 'Sample', threshold: 1 }],
        badges: [{ code: 'Sample', name: 'Sample', threshold: 1 }],
        label: 'Sample',
      },
    },
  ],
  [
    'commissionRuleChangedPayloadV1 m0 before.rateBasisPoints=0.5',
    commissionRuleChangedPayloadV1,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        organizationId: 'ORG-SAMPLE',
        transactionType: 'Sample',
        rateBasisPoints: 0.5,
        minAmountMinor: '100000000000000000000',
        maxAmountMinor: '100000000000000000000',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
      after: {
        organizationId: 'ORG-SAMPLE',
        transactionType: 'Sample',
        rateBasisPoints: 1,
        minAmountMinor: '100000000000000000000',
        maxAmountMinor: '100000000000000000000',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
    },
  ],
  [
    'commissionRuleChangedPayloadV1 m0 before.rateBasisPoints=Infinity',
    commissionRuleChangedPayloadV1,
    {
      ruleId: 'ORG-SAMPLE',
      change: 'CREATED',
      changedBy: 'Sample',
      changedAt: 'Sample',
      before: {
        organizationId: 'ORG-SAMPLE',
        transactionType: 'Sample',
        rateBasisPoints: Number.POSITIVE_INFINITY,
        minAmountMinor: '100000000000000000000',
        maxAmountMinor: '100000000000000000000',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
      after: {
        organizationId: 'ORG-SAMPLE',
        transactionType: 'Sample',
        rateBasisPoints: 1,
        minAmountMinor: '100000000000000000000',
        maxAmountMinor: '100000000000000000000',
        validFrom: 'ORG-SAMPLE',
        validTo: 'ORG-SAMPLE',
        status: 'Sample',
        label: 'Sample',
      },
    },
  ],
  [
    'createParticipationRuleSchema m0 dup contributions + expectedCurrentVersion=0.5',
    createParticipationRuleSchema,
    {
      expectedCurrentVersion: 0.5,
      windowDays: 1,
      contributions: [
        { triggerEvent: 'USAGE_RECORDED', weight: 1 },
        { triggerEvent: 'USAGE_RECORDED', weight: 1 },
      ],
    },
  ],
  [
    'createParticipationRuleSchema m0 dup contributions + expectedCurrentVersion=Infinity',
    createParticipationRuleSchema,
    {
      expectedCurrentVersion: Number.POSITIVE_INFINITY,
      windowDays: 1,
      contributions: [
        { triggerEvent: 'USAGE_RECORDED', weight: 1 },
        { triggerEvent: 'USAGE_RECORDED', weight: 1 },
      ],
    },
  ],
  [
    'createRecognitionRuleSchema m0 dup levels + expectedCurrentVersion=0.5',
    createRecognitionRuleSchema,
    {
      expectedCurrentVersion: 0.5,
      basis: 'REWARD_POINTS_CUMULATIVE',
      levels: [
        { name: 'Sample', threshold: 1 },
        { name: 'Sample', threshold: 1 },
      ],
      badges: [{ code: 'CRIT', name: 'Sample', threshold: 1 }],
    },
  ],
  [
    'createRecognitionRuleSchema m0 dup levels + expectedCurrentVersion=Infinity',
    createRecognitionRuleSchema,
    {
      expectedCurrentVersion: Number.POSITIVE_INFINITY,
      basis: 'REWARD_POINTS_CUMULATIVE',
      levels: [
        { name: 'Sample', threshold: 1 },
        { name: 'Sample', threshold: 1 },
      ],
      badges: [{ code: 'CRIT', name: 'Sample', threshold: 1 }],
    },
  ],
  [
    'createRewardRuleSchema m0 periodCap=0.5',
    createRewardRuleSchema,
    { triggerEvent: 'USAGE_RECORDED', points: 1, periodCap: 0.5 },
  ],
  [
    'createRewardRuleSchema m0 periodCap=Infinity',
    createRewardRuleSchema,
    { triggerEvent: 'USAGE_RECORDED', points: 1, periodCap: Number.POSITIVE_INFINITY },
  ],
  [
    'createRewardRuleSchema review r2: periodCap and periodType must be supplied together — a cap w',
    createRewardRuleSchema,
    {
      triggerEvent: 'USAGE_RECORDED',
      rewardType: 'POINTS',
      points: 0.5,
      status: 'ACTIVE',
      periodType: 'DAY',
    },
  ],
  [
    'createRecognitionRuleSchema review r2: a version names at least one level or badge',
    createRecognitionRuleSchema,
    { expectedCurrentVersion: 0.5, basis: 'REWARD_POINTS_CUMULATIVE', levels: [], badges: [] },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});

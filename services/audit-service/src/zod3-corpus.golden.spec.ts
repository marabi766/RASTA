import * as contracts from '@rasta/contracts';
import { auditEventQuerySchema } from './audit/audit.query.dto';
import { auditChainVerificationSchema } from './audit/audit.verification.view';
import {
  commissionRuleChangedPayloadV1,
  commissionRuleChangedPayloadV2,
} from './audit/commission-rule-change-projection';
import { receiptPayloadSchema } from './audit/tender-evidence';

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
  'auditEventQuerySchema m1 limit=0.5': [
    ['limit', 'invalid_type', 'Expected integer, received float'],
    ['limit', 'too_small', 'Number must be greater than or equal to 1'],
    ['cursor', 'custom', 'The cursor is not valid'],
  ],
  'auditEventQuerySchema m1 limit=Infinity': [
    ['limit', 'invalid_type', 'Expected integer, received float'],
    ['limit', 'too_big', 'Number must be less than or equal to 200'],
    ['cursor', 'custom', 'The cursor is not valid'],
  ],
  'auditChainVerificationSchema m0 canonicalVersion=0.5': [
    ['canonicalVersion', 'invalid_type', 'Expected integer, received float'],
    ['months.0.month', 'invalid_string', 'Invalid'],
    ['months.0.status', 'custom', 'VALID month reports unchained records'],
    ['firstDivergence.month', 'invalid_string', 'Invalid'],
    ['valid', 'custom', '`valid` is true only for status VALID'],
    ['firstDivergence', 'custom', '`firstDivergence` is non-null for exactly the DIVERGENT status'],
    ['status', 'custom', 'VALID window reports unchained records'],
  ],
  'auditChainVerificationSchema m0 canonicalVersion=Infinity': [
    ['canonicalVersion', 'invalid_type', 'Expected integer, received float'],
    ['months.0.month', 'invalid_string', 'Invalid'],
    ['months.0.status', 'custom', 'VALID month reports unchained records'],
    ['firstDivergence.month', 'invalid_string', 'Invalid'],
    ['valid', 'custom', '`valid` is true only for status VALID'],
    ['firstDivergence', 'custom', '`firstDivergence` is non-null for exactly the DIVERGENT status'],
    ['status', 'custom', 'VALID window reports unchained records'],
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
  'commissionRuleChangedPayloadV2 m0 before.rateBasisPoints=0.5': [
    ['before.rateBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'before is null exactly when the rule was created'],
  ],
  'commissionRuleChangedPayloadV2 m0 before.rateBasisPoints=Infinity': [
    ['before.rateBasisPoints', 'invalid_type', 'Expected integer, received float'],
    ['before.rateBasisPoints', 'too_big', 'Number must be less than or equal to 10000'],
    ['', 'custom', 'before is null exactly when the rule was created'],
  ],
  'receiptPayloadSchema m0 revision=0.5': [
    ['revision', 'invalid_type', 'Expected integer, received float'],
    ['contentCommitment', 'invalid_string', 'Invalid'],
    ['ciphertextSha256', 'invalid_string', 'Invalid'],
    ['previousReceipt', 'invalid_string', 'Invalid'],
    ['receipt', 'invalid_string', 'Invalid'],
    ['', 'custom', 'a receipt is not its own predecessor'],
  ],
  'receiptPayloadSchema m0 revision=Infinity': [
    ['revision', 'invalid_type', 'Expected integer, received float'],
    ['contentCommitment', 'invalid_string', 'Invalid'],
    ['ciphertextSha256', 'invalid_string', 'Invalid'],
    ['previousReceipt', 'invalid_string', 'Invalid'],
    ['receipt', 'invalid_string', 'Invalid'],
    ['', 'custom', 'a receipt is not its own predecessor'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'auditEventQuerySchema m1 limit=0.5',
    auditEventQuerySchema,
    {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      organizationId: 'ORG-SAMPLE',
      actorId: 'ORG-SAMPLE',
      actorType: 'SERVICE',
      action: 'Sample',
      resourceType: 'Sample',
      resourceId: 'ORG-SAMPLE',
      correlationId: 'ORG-SAMPLE',
      outcome: 'FAILURE',
      limit: 0.5,
      cursor: 'Sample',
    },
  ],
  [
    'auditEventQuerySchema m1 limit=Infinity',
    auditEventQuerySchema,
    {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      organizationId: 'ORG-SAMPLE',
      actorId: 'ORG-SAMPLE',
      actorType: 'SERVICE',
      action: 'Sample',
      resourceType: 'Sample',
      resourceId: 'ORG-SAMPLE',
      correlationId: 'ORG-SAMPLE',
      outcome: 'FAILURE',
      limit: Number.POSITIVE_INFINITY,
      cursor: 'Sample',
    },
  ],
  [
    'auditChainVerificationSchema m0 canonicalVersion=0.5',
    auditChainVerificationSchema,
    {
      scope: 'ORGANIZATION',
      organizationId: 'ORG-SAMPLE',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      status: 'VALID',
      valid: false,
      canonicalVersion: 0.5,
      recordsInRange: 1,
      recordsVerified: 1,
      unchainedRecords: 1,
      months: [
        {
          month: 'x',
          status: 'VALID',
          recordsInRange: 1,
          recordsVerified: 1,
          unchainedRecords: 1,
          seededFromPredecessor: false,
        },
      ],
      firstDivergence: {
        month: 'x',
        auditEventId: 'ORG-SAMPLE',
        occurredAt: '2026-10-01T00:00:00.000Z',
        sequenceNo: 'Sample',
        reason: 'RECORD_HASH_MISMATCH',
      },
    },
  ],
  [
    'auditChainVerificationSchema m0 canonicalVersion=Infinity',
    auditChainVerificationSchema,
    {
      scope: 'ORGANIZATION',
      organizationId: 'ORG-SAMPLE',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      status: 'VALID',
      valid: false,
      canonicalVersion: Number.POSITIVE_INFINITY,
      recordsInRange: 1,
      recordsVerified: 1,
      unchainedRecords: 1,
      months: [
        {
          month: 'x',
          status: 'VALID',
          recordsInRange: 1,
          recordsVerified: 1,
          unchainedRecords: 1,
          seededFromPredecessor: false,
        },
      ],
      firstDivergence: {
        month: 'x',
        auditEventId: 'ORG-SAMPLE',
        occurredAt: '2026-10-01T00:00:00.000Z',
        sequenceNo: 'Sample',
        reason: 'RECORD_HASH_MISMATCH',
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
    'commissionRuleChangedPayloadV2 m0 before.rateBasisPoints=0.5',
    commissionRuleChangedPayloadV2,
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
    'commissionRuleChangedPayloadV2 m0 before.rateBasisPoints=Infinity',
    commissionRuleChangedPayloadV2,
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
    'receiptPayloadSchema m0 revision=0.5',
    receiptPayloadSchema,
    {
      bidId: 'ORG-SAMPLE',
      tenderId: 'ORG-SAMPLE',
      organizationId: 'ORG-SAMPLE',
      bidderOrganizationId: 'ORG-SAMPLE',
      revision: 0.5,
      receivedAt: '2026-10-01T00:00:00.000Z',
      contentCommitment: 'x',
      ciphertextSha256: 'x',
      previousReceipt: 'x',
      receipt: 'x',
    },
  ],
  [
    'receiptPayloadSchema m0 revision=Infinity',
    receiptPayloadSchema,
    {
      bidId: 'ORG-SAMPLE',
      tenderId: 'ORG-SAMPLE',
      organizationId: 'ORG-SAMPLE',
      bidderOrganizationId: 'ORG-SAMPLE',
      revision: Number.POSITIVE_INFINITY,
      receivedAt: '2026-10-01T00:00:00.000Z',
      contentCommitment: 'x',
      ciphertextSha256: 'x',
      previousReceipt: 'x',
      receipt: 'x',
    },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});

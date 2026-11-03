import { z } from 'zod';
import { legacyParse, type LegacyRefusal } from '@rasta/contracts';

import { issuesOf as commissionIssues } from './commission-rule-change-projection';
import { unprocessable } from './contract-refusal-projection';
import { describeIssues as opsReplayIssues } from './ops-replay.mapper';
import { describeIssues as reconciliationIssues } from './payment-reconciliation-projection';
import { describeIssues as diagnosticIssues } from './refusal-diagnostics';
import { issuesOf as settlementIssues } from './settlement-refusal-projection';

/**
 * PR #444 r4 F5, addendum B: a union refused as a whole now keeps its
 * options' issues beside the refusal (for the form resolver only). This
 * formatter's output for such a refusal is unchanged, byte for byte: the
 * goldens below are what it printed at 670df615, before the branch tree
 * existed, at the root, under a record key and in an array. No option's issue,
 * enum value, literal or input value appears in any of them.
 */

const VALUE = 'SENTINEL-042-value';
const RECORD_NAME = 'SENTINEL-042-record';

function refused(schema: z.ZodType, input: unknown): LegacyRefusal {
  const result = legacyParse(schema, input);
  if (result.success) throw new Error('expected a refusal');
  return result.refusal;
}

/** Every option fails on its type, so zod 3 reported `invalid_union` (with `unionErrors`). */
const option = z.union([
  z.object({ a: z.enum(['OPTION-ALPHA', 'OPTION-BETA']) }),
  z.object({
    b: z.literal('LITERAL-GAMMA'),
    c: z.number({ error: (issue) => `not a number: ${String(issue.input)}` }),
  }),
]);

const unions = (): Record<'record' | 'root' | 'array', LegacyRefusal> => ({
  record: refused(z.object({ tags: z.record(z.string(), option) }), {
    tags: { [RECORD_NAME]: { a: VALUE, b: VALUE, c: VALUE } },
  }),
  root: refused(option, { a: VALUE, b: VALUE, c: VALUE }),
  array: refused(z.object({ items: z.array(option) }), {
    items: [{ a: VALUE, b: VALUE, c: VALUE }],
  }),
});

const OPTION_TEXT = /OPTION-ALPHA|OPTION-BETA|LITERAL-GAMMA|not a number|SENTINEL-042-value/;

const GOLDEN = {
  record: {
    diagnostics: 'tags.? invalid_union [1 undeclared path segment(s) withheld]',
    reconciliation: '(payload) invalid_union',
    opsReplay: 'tags.SENTINEL-042-record invalid_union',
    settlement: 'tags.SENTINEL-042-record:invalid_union',
    commission: 'tags.SENTINEL-042-record:invalid_union',
    contract:
      'TEST_EVENT does not match the contract refusal projection (tags.SENTINEL-042-record:invalid_union)',
  },
  root: {
    diagnostics: '(root) invalid_union',
    reconciliation: '(payload) invalid_union',
    opsReplay: '(root) invalid_union',
    settlement: '(root):invalid_union',
    commission: '(root):invalid_union',
    contract: 'TEST_EVENT does not match the contract refusal projection ((root):invalid_union)',
  },
  array: {
    diagnostics: 'items.0 invalid_union',
    reconciliation: '(payload) invalid_union',
    opsReplay: 'items.0 invalid_union',
    settlement: 'items.0:invalid_union',
    commission: 'items.0:invalid_union',
    contract: 'TEST_EVENT does not match the contract refusal projection (items.0:invalid_union)',
  },
} as const;

describe('audit formatters of a refused union, as at 670df615 (r4 F5, addendum B)', () => {
  it.each(Object.entries(unions()))('%s', (name, refusal) => {
    const actual = {
      diagnostics: diagnosticIssues(refusal, new Set(['tags', 'items', 'a', 'b', 'c'])),
      reconciliation: reconciliationIssues(refusal),
      opsReplay: opsReplayIssues(refusal),
      settlement: settlementIssues(refusal),
      commission: commissionIssues(refusal),
      contract: unprocessable('TEST_EVENT', refusal).message,
    };
    expect(actual).toEqual(GOLDEN[name as keyof typeof GOLDEN]);
    expect(Object.values(actual).join('\n')).not.toMatch(OPTION_TEXT);
  });
});

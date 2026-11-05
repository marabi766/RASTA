import type { z } from 'zod';
import { TRANSACTION_TEXT_BOUNDS, type TextBounds } from '@rasta/contracts';
import {
  cancelTransactionSchema,
  disputeTransactionSchema,
  refundTransactionSchema,
  resolveDisputeSchema,
} from './dto';

/**
 * Contract equality (FU-134): each transaction body that another service fills
 * with its users' text accepts exactly the lengths `TRANSACTION_TEXT_BOUNDS`
 * states — the table marketplace-service validates the same text with when it
 * accepts it. Probed through the real schemas at both edges, so a body whose
 * bounds differ from its table entry — a literal that drifted, or the wrong
 * entry read — fails (a literal equal to the entry passes until either moves).
 */
const BODIES: readonly [string, z.ZodType, string, TextBounds][] = [
  ['refund', refundTransactionSchema, 'reason', TRANSACTION_TEXT_BOUNDS.closingReason],
  ['cancel', cancelTransactionSchema, 'reason', TRANSACTION_TEXT_BOUNDS.closingReason],
  ['dispute', disputeTransactionSchema, 'reason', TRANSACTION_TEXT_BOUNDS.disputeReason],
  [
    'resolve-dispute',
    resolveDisputeSchema,
    'resolution',
    TRANSACTION_TEXT_BOUNDS.disputeResolution,
  ],
];

describe.each(BODIES)('POST /v1/transactions/{id}/%s', (_name, schema, field, bounds) => {
  const parses = (length: number) => schema.safeParse({ [field]: 'x'.repeat(length) }).success;

  it(`${field}: accepts exactly ${bounds.min}..${bounds.max} characters`, () => {
    expect([
      parses(bounds.min - 1),
      parses(bounds.min),
      parses(bounds.max),
      parses(bounds.max + 1),
    ]).toEqual([false, true, true, false]);
  });

  it(`${field}: counts the trimmed text`, () => {
    expect(schema.safeParse({ [field]: ` ${'x'.repeat(bounds.max)}\r\n` }).success).toBe(true);
  });
});

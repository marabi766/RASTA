import { z } from 'zod';
import { isoDateTime, plainText } from '@rasta/contracts';
import { canonicalDeductionRuleName } from './deduction-rule-name';

/** PostgreSQL text cannot store NUL or an unpaired UTF-16 surrogate. */
export function storageText(value: string): boolean {
  return (
    !value.includes('\u0000') &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  );
}
const safeText = z.string().refine(storageText, 'Text must be valid storage text');
const id = z.string().min(1).max(128).refine(storageText, 'Text must be valid storage text');
const name = safeText
  .refine((value) => canonicalDeductionRuleName(value) !== null, 'Invalid deduction rule name')
  .describe(
    'Canonical deduction name: the existing 1 to 200 character Persian/printable ASCII normalization contract.',
  );
const reason = plainText()
  .refine(storageText, 'Invalid reason text')
  .refine(
    (value) => value.trim().length > 0 && [...value].length <= 500,
    'Reason must contain 1 to 500 characters',
  );
export const proposeDeductionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('CREATE'),
      name,
      rateBp: z.number().int().min(1).max(10000),
      base: z.literal('GROSS'),
    })
    .strict(),
  z.object({ kind: z.literal('RETIRE'), deductionRuleId: id, reason }).strict(),
]);
export type ProposeDeductionDto = z.infer<typeof proposeDeductionSchema>;
export const deductionReceiptSchema = z
  .object({
    id,
    organizationId: id,
    kind: z.enum(['CREATE', 'RETIRE']),
    status: z.literal('PENDING_APPROVAL'),
    version: z.literal(1),
    proposedAt: z.string().check(isoDateTime({ offset: false })),
  })
  .strict();
export type DeductionReceipt = z.infer<typeof deductionReceiptSchema>;

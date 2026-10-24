import { inspect } from 'node:util';
import { RastaError, zodPipe } from '@rasta/nest-common';
import type { z } from 'zod';
import { topUpSchema } from '../payment/dto';
import { hashRequestBody, targeted } from '../shared/idempotency';
import { placeHoldSchema } from './dto';

/**
 * A malformed amount is a 400, never a 500 (task 011).
 *
 * The positivity refinements on the top-up and the hold ran after
 * `amountMinorSchema`'s pattern had already failed — zod does that — and called
 * `BigInt` on the raw text: `"1.5"` threw a `SyntaxError` out of the validation
 * pipe, which the filter answered with a 500 and logged with the client's text
 * in its message. Now the refinement converts only a string of digits.
 *
 * Driven through the real `ZodValidationPipe`, as the controller is. Pinned
 * from origin/main before the fix: every accepted amount parses to the same
 * bytes with the same idempotency hash (`targeted(id, body)`, what the
 * controller hashes), and every refusal reports what it did then — except that
 * a value which is not a string of digits no longer also reports "must be
 * positive" (`""`, `"-1"`): its format issue alone is reported.
 */

const MAX = '9223372036854775807';
const PAST_MAX = '9223372036854775808';
const SENTINEL = 'private-invoice-reference-123';

const PATTERN = 'Amount must be a non-negative integer string in minor units';
const STORABLE = 'Amount exceeds the largest storable amount (2^63 - 1 minor units)';

/** The top-up body as `WalletController.topUp` validates it: the key travels as a header. */
const topUpBody = topUpSchema.omit({ idempotencyKey: true }).partial({ instrument: true });

type Outcome = { parsed: unknown; hash: string } | { refused: string; details: unknown };

function outcome(schema: z.ZodTypeAny, input: unknown): Outcome {
  try {
    const parsed = zodPipe(schema).transform(input, { type: 'body' });
    return { parsed, hash: hashRequestBody(targeted('WAL_1', parsed)) };
  } catch (error) {
    // Anything but the platform's validation error — a SyntaxError — fails the test here.
    if (error instanceof RastaError) return { refused: error.code, details: error.details };
    throw error;
  }
}

const refusedWith = (...messages: string[]) => ({
  refused: 'VALIDATION_FAILED',
  details: messages.map((message) => ({
    path: 'amountMinor',
    code: message === PATTERN ? 'invalid_string' : 'custom',
    message,
  })),
});

describe.each([
  {
    name: 'POST /v1/wallets/{id}/top-up',
    schema: topUpBody,
    body: {},
    positive: 'A top-up must be positive',
    hashes: {
      '1': '37e3b4f56e0aedbcd2ebfc11ce8357dfcbd97b6c5868211db2da07432f82d655',
      '01': '643b01344ab26f62213cd8efd7ccf797e0e995830fcc7dd272c2c893efc20777',
      [MAX]: 'e5cb9f0c4ca28789ca2e24d5de26845467fa6d6f2d6be0fef6739e7305e70cfd',
    },
  },
  {
    name: 'placeHoldSchema (declared; no route uses it)',
    schema: placeHoldSchema,
    body: { transactionId: 'TX_1' },
    positive: 'A hold must be positive',
    hashes: {
      '1': '0751ea140d9e3cfe4994e42014608bcb45572bff723d3f604c8720457cd20d00',
      '01': '7304c319810d537886b68f36c6263d14957e85ad39fe0a647abafcb987bc0462',
      [MAX]: '7792484f9cffc2cf00628aa5f5fa5c670586c10b379a59ea75e5be9df25d9d6a',
    },
  },
])('$name: the amount', ({ schema, body, positive, hashes }) => {
  const run = (amountMinor: unknown) => outcome(schema, { ...body, amountMinor });

  it.each([
    ['a fraction', '1.5'],
    ['letters', 'abc'],
    ['an exponent', '1e3'],
    ['a value that is free text', SENTINEL],
  ])('refuses %s with the pattern issue alone — a 400, not a thrown SyntaxError', (_l, value) => {
    expect(run(value)).toEqual(refusedWith(PATTERN));
  });

  it.each([
    ['nothing', '', [PATTERN]],
    ['a leading space', ' 1', [PATTERN]],
    ['a plus sign', '+1', [PATTERN]],
    ['a hexadecimal literal', '0x10', [PATTERN]],
    ['a minus sign', '-1', [PATTERN, STORABLE]],
    ['thirty-one digits', '9'.repeat(31), [PATTERN, STORABLE]],
  ])('refuses %s with its format issues, as before', (_l, value, messages) => {
    expect(run(value)).toEqual(refusedWith(...messages));
  });

  it.each([
    ['zero', '0'],
    ['zero with a leading zero', '00'],
  ])('refuses %s as not positive, as before', (_l, value) => {
    expect(run(value)).toEqual(refusedWith(positive));
  });

  it.each([
    ['one past the largest storable amount', PAST_MAX],
    ['thirty digits', '9'.repeat(30)],
  ])('refuses %s as unstorable, as before', (_l, value) => {
    expect(run(value)).toEqual(refusedWith(STORABLE));
  });

  it.each(Object.entries(hashes))(
    'accepts %s byte-for-byte, with the idempotency hash it had',
    (value, hash) => {
      expect(run(value)).toEqual({ parsed: { ...body, amountMinor: value }, hash });
    },
  );

  it('never repeats the malformed amount in what it reports', () => {
    expect(inspect(run(SENTINEL), { depth: null })).not.toContain(SENTINEL);
  });
});

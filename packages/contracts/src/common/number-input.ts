import { z } from 'zod';

// Decimal transport grammar, without trimming or implicit alternate bases.
const DECIMAL = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const INTEGER = /^[+-]?[0-9]+$/;
const NUMBER_INPUT_INNERS = new WeakMap<object, z.ZodNumber>();

/**
 * Request numbers: JSON numbers or signed decimal text. No whitespace, empty
 * text, radix prefixes or non-finite values. Non-integer fields accept exponent
 * notation, matching JSON numbers and JavaScript String(number). Integer fields
 * refuse exponents and fractional text, including fractions that floating-point conversion
 * would round to an integer. Nonzero text that would underflow to zero is refused;
 * accepted negative zero (text or JSON number) is normalized to positive zero. The inner schema still enforces bounds/finite values.
 * Optional, nullable and default behaviour belongs to the outer wrappers.
 */
export function numberInput<T extends z.ZodNumber>(schema: T) {
  const input = z.preprocess((value, ctx) => {
    if (typeof value === 'number' && value === 0) return 0;
    if (typeof value !== 'string') return value;
    if (schema.isInt ? INTEGER.test(value) : DECIMAL.test(value)) {
      const numeric = Number(value);
      // Exponents remain valid (FU-160), but must not erase a nonzero significand.
      if (numeric !== 0 || !/^[+-]?[0-9.]*[1-9]/.test(value)) return numeric === 0 ? 0 : numeric;
    }
    // A fixed issue preserves enclosing diagnostics in legacyParse without
    // exposing request text (S-09). No malformed value reaches the number schema.
    ctx.addIssue({
      code: 'custom',
      message: schema.isInt
        ? 'Expected an integer in decimal notation'
        : 'Expected a decimal number',
    });
    return z.NEVER;
  }, schema);
  // The transform identity survives .describe() clones. Only this constructor
  // can register it; arbitrary preprocessors cannot claim their output is raw input.
  NUMBER_INPUT_INNERS.set(input.in, schema);
  return input;
}

/** Numeric OpenAPI semantics for this reviewed query/body transport adapter. */
export function numberInputInnerSchema(schema: z.ZodType): z.ZodNumber | undefined {
  if (!(schema instanceof z.ZodPipe)) return undefined;
  const inner = NUMBER_INPUT_INNERS.get(schema.in);
  return inner === schema.out ? inner : undefined;
}

import { z } from 'zod';

// Decimal transport grammar, without trimming or implicit alternate bases.
const DECIMAL = /^[+-]?[0-9]+(?:\.[0-9]+)?$/;
const INTEGER = /^[+-]?[0-9]+$/;
const NUMBER_INPUT_INNERS = new WeakMap<object, z.ZodNumber>();

/**
 * Request numbers: JSON numbers or signed decimal text. No whitespace, empty
 * text, radix prefixes, exponents or non-finite values. Integer fields also
 * refuse fractional text, including fractions that floating-point conversion
 * would round to an integer. The inner schema still enforces bounds/finite values.
 * Optional, nullable and default behaviour belongs to the outer wrappers.
 */
export function numberInput<T extends z.ZodNumber>(schema: T) {
  const input = z.preprocess(
    (value) =>
      typeof value === 'string'
        ? (schema.isInt ? INTEGER.test(value) : DECIMAL.test(value))
          ? Number(value)
          : Number.NaN
        : value,
    schema,
  );
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

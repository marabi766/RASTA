import { z } from 'zod';

/**
 * A number a request may state either as a JSON number or as text — a query
 * parameter is always text, and some bodies send `"30"` for `30`.
 *
 * Only text is converted, with `Number(text)` exactly as `z.coerce.number()`
 * converts it, so every number and every string is accepted or refused as
 * before. Anything else reaches `schema` unchanged and is refused there as
 * `invalid_type` (400 VALIDATION_FAILED).
 *
 * Why not `z.coerce.number()`: it calls `Number(input)` before any type check,
 * on whatever the client sent. `{"toString":null}` makes that throw a
 * TypeError, which leaves the validation pipe as a 500; and `true`, `[30]` and,
 * outside a `.nullable()`, `null` quietly become 1, 30 and 0. The shared ESLint
 * coercion boundary permits only explicitly reviewed environment loader paths
 * and diagnostic tests; this is the request schema's Number conversion helper.
 *
 * The OpenAPI converters unwrap the effect, so `schema` is what is published.
 */
export function numberInput<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (typeof value === 'string' ? Number(value) : value), schema);
}

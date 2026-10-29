import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { amountMinorSchema, legacyDatetimeRegex, type IsoDateTimeOptions } from '@rasta/contracts';

/**
 * One spelling per value, before a request body is validated, hashed or
 * executed (pre-review checklist #16; Codex PR-480 r1, R2).
 *
 * The idempotency hash sorts keys but keeps every string as sent, so a retry
 * that says the same thing differently — `"01000"` for `"1000"`,
 * `…T12:00:00.000Z` for `…T12:00:00Z`, CRLF for LF — was refused as a key
 * reused with another body. Normalized here, before zod, the retry hashes as
 * the first request did and replays it; and the length check, the hash and the
 * service all see the one form.
 *
 * Rules, per kind:
 *   - an amount: digits only, no leading zeros (`"000"` → `"0"`);
 *   - an instant: `Date.prototype.toISOString` — UTC, `Z`, milliseconds —
 *     the precision the column stores and `new Date(…)` executes;
 *   - human text: CRLF and CR → LF;
 *   - a form a schema declares itself ({@link withCanonicalForm}) — the reward
 *     rule's condition puts the operand of each numeric comparison in its
 *     exact decimal form (Codex PR-480 r2, R2).
 *
 * A value is rewritten only when it already passes the field's own pattern
 * and its canonical form does too, so what a schema accepts and refuses is
 * unchanged; anything else is left exactly as sent for validation to answer.
 * Absent, `null` and zero stay distinct: an absent key is not added, `null`
 * is not a string, `"0"` is already canonical.
 *
 * Derived from the schema ({@link canonicalFieldsOf}), so a field added to a
 * DTO is normalized by its type, not by remembering a list. Only the reward
 * rule create uses it so far; the other idempotent commands are task 129.
 */

export type CanonicalKind =
  | { kind: 'amountMinor' }
  | { kind: 'instant'; options: IsoDateTimeOptions }
  | { kind: 'text' }
  | { kind: 'form'; canonicalize: (value: unknown) => unknown };

export type CanonicalFields = Readonly<Record<string, CanonicalKind>>;

const DIGITS = /^\d{1,30}$/;

/** An amount in minor units with its leading zeros removed; anything else untouched. */
export function canonicalAmountMinor(value: unknown): unknown {
  if (typeof value !== 'string' || !DIGITS.test(value)) return value;
  return value.replace(/^0+(?=\d)/, '');
}

/**
 * An instant in its one UTC form; anything else untouched — including a time
 * with no zone, whose instant depends on whoever reads it.
 */
export function canonicalInstant(value: unknown, options: IsoDateTimeOptions = {}): unknown {
  if (typeof value !== 'string') return value;
  const pattern = legacyDatetimeRegex(options);
  if (!pattern.test(value) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  const canonical = instant.toISOString();
  return pattern.test(canonical) ? canonical : value;
}

/** Human text with every line ending LF; anything else untouched. */
export function canonicalText(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : value;
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * A plain decimal string by its exact value — no float: no leading zeros in
 * the whole part, no trailing zeros in the fraction, no `.` with nothing
 * after it, no `+`, and one zero (`"-0.0"` → `"0"`); a negative value keeps
 * its `-`. `"7.50"` → `"7.5"`, `"007"` → `"7"`, `".5"` → `"0.5"`. Two strings
 * with the same canonical form have the same exact value, so `Number()` reads
 * them as the same number. Anything that is not a plain decimal — an
 * exponent, a space, hex, an empty string — is left exactly as sent.
 */
export function canonicalDecimal(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = DECIMAL.exec(value);
  if (!match) return value;
  const [, sign, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return value;
  const integer = whole.replace(/^0+/, '') || '0';
  const decimals = fraction.replace(/0+$/, '');
  const digits = decimals ? `${integer}.${decimals}` : integer;
  return sign === '-' && digits !== '0' ? `-${digits}` : digits;
}

/**
 * `canonicalize(value)` where both the value as sent and its canonical form
 * pass `schema` — the value's own schema — and the value as sent otherwise, so
 * what the schema accepts and refuses is unchanged.
 */
export function canonicalWithin(
  schema: z.ZodType,
  value: unknown,
  canonicalize: (value: unknown) => unknown,
): unknown {
  const canonical = canonicalize(value);
  if (canonical === value) return value;
  return schema.safeParse(value).success && schema.safeParse(canonical).success
    ? canonical
    : value;
}

const DECLARED_FORMS = new WeakMap<z.ZodType, (value: unknown) => unknown>();

/**
 * Declares, on the schema itself, the canonical form of a value no field kind
 * covers — a structured value whose meaning only its own module knows (the
 * reward rule's condition). {@link canonicalFieldsOf} finds it through the
 * same optional, nullable and defaulted wrappers as any other field, so a DTO
 * that reuses the schema is normalized without remembering a list.
 */
export function withCanonicalForm<T extends z.ZodType>(
  schema: T,
  canonicalize: (value: unknown) => unknown,
): T {
  DECLARED_FORMS.set(schema, canonicalize);
  return schema;
}

function canonicalValue(value: unknown, field: CanonicalKind): unknown {
  switch (field.kind) {
    case 'amountMinor':
      return canonicalAmountMinor(value);
    case 'instant':
      return canonicalInstant(value, field.options);
    case 'text':
      return canonicalText(value);
    case 'form':
      return field.canonicalize(value);
  }
}

/**
 * A copy of `body` with each declared top-level field in its canonical form.
 * A body that is not a plain object is returned as it is, for the schema to
 * refuse. The request's own object is never modified.
 */
export function canonicalBody(body: unknown, fields: CanonicalFields): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const [name, field] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(copy, name)) {
      copy[name] = canonicalValue(copy[name], field);
    }
  }
  return copy;
}

/**
 * The fields of an object schema that have a canonical form, read from the
 * schema itself: {@link amountMinorSchema} is an amount, a string with an ISO
 * datetime check is an instant (with that check's zone options), a string
 * with no format or pattern is human text, and a schema that declares its own
 * form ({@link withCanonicalForm}) has that form. Optional, nullable and
 * defaulted wrappers are seen through. Nested objects are not walked: a
 * structured value declares its form.
 */
export function canonicalFieldsOf(schema: z.ZodObject): CanonicalFields {
  const fields: Record<string, CanonicalKind> = {};
  for (const [name, member] of Object.entries(schema.shape)) {
    const kind = kindOf(unwrapped(member as z.ZodType));
    if (kind) fields[name] = kind;
  }
  return fields;
}

const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly']);

function unwrapped(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (WRAPPERS.has(current._zod.def.type)) {
    current = (current._zod.def as unknown as { innerType: z.ZodType }).innerType;
  }
  return current;
}

interface CheckDef {
  check?: string;
  format?: string;
  pattern?: RegExp;
  offset?: boolean;
  local?: boolean;
  precision?: number | null;
}

function kindOf(schema: z.ZodType): CanonicalKind | null {
  const declared = DECLARED_FORMS.get(schema);
  if (declared) return { kind: 'form', canonicalize: declared };
  if (schema === amountMinorSchema) return { kind: 'amountMinor' };
  if (schema._zod.def.type !== 'string') return null;
  const checks = ((schema._zod.def as { checks?: { _zod: { def: CheckDef } }[] }).checks ?? []).map(
    (check) => check._zod.def,
  );
  const datetime = checks.find((check) => check.format === 'datetime');
  if (datetime) {
    return {
      kind: 'instant',
      options: { offset: datetime.offset, local: datetime.local, precision: datetime.precision },
    };
  }
  const constrained = checks.some((check) => check.format !== undefined || check.pattern);
  return constrained ? null : { kind: 'text' };
}

/**
 * A Nest pipe that puts a body's fields in canonical form; listed **before**
 * the zod pipe (`@Body(canonicalPipe(schema), zodPipe(schema))`), so the
 * validation, the idempotency hash and the service see the same value.
 */
export function canonicalPipe(schema: z.ZodObject): PipeTransform {
  const fields = canonicalFieldsOf(schema);
  return { transform: (value: unknown) => canonicalBody(value, fields) };
}

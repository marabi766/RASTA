import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import {
  amountMinorSchema,
  legacyDatetimeRegex,
  legacyParse,
  type IsoDateTimeOptions,
} from '@rasta/contracts';
import { validateRequestInput } from '@rasta/nest-common';

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
 * An instant, and a declared form through {@link canonicalWithin}, is
 * rewritten only when it already passes the field's own pattern and its
 * canonical form does too; anything else is left exactly as sent for
 * validation to answer. A whole body whose canonical form its schema refuses
 * is answered as the previous release answered it ({@link canonicalBodyPipe}).
 * Absent, `null` and zero stay distinct: an absent key is not added, `null`
 * is not a string, `"0"` is already canonical.
 *
 * Derived from the schema ({@link canonicalFieldsOf}), so a field added to a
 * DTO is normalized by its type, not by remembering a list — nested objects
 * and arrays of them included. Every idempotent command's body goes through
 * {@link canonicalBodyPipe} (task 129); the reward rule create, which parses
 * in its handler for its legacy replay, uses {@link canonicalPipe}. A route
 * that takes an `Idempotency-Key` without either is refused by
 * `idempotent-routes.spec.ts`.
 */

export type CanonicalKind =
  | { kind: 'amountMinor' }
  | { kind: 'instant'; options: IsoDateTimeOptions }
  | { kind: 'text' }
  | { kind: 'form'; canonicalize: (value: unknown) => unknown }
  | { kind: 'object'; fields: CanonicalFields }
  | { kind: 'array'; element: CanonicalKind };

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
  return schema.safeParse(value).success && schema.safeParse(canonical).success ? canonical : value;
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

/**
 * A string that names something — a reference, a key, an opaque provider
 * instruction — rather than saying something: its canonical form is itself.
 * A line ending inside one is part of the name, so it is never rewritten
 * (`"A\r\nB"` and `"A\nB"` are two references, and the second would not be
 * found by a lookup for the first). Without it, a string with no format or
 * pattern is human text.
 */
export function identifier<T extends z.ZodType>(schema: T): T {
  return withCanonicalForm(schema, (value) => value);
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
    case 'object':
      return canonicalBody(value, field.fields);
    case 'array': {
      if (!Array.isArray(value)) return value;
      const items = value.map((item: unknown) => canonicalValue(item, field.element));
      return items.some((item, index) => item !== value[index]) ? items : value;
    }
  }
}

/**
 * `body` with each declared field in its canonical form — a copy when any
 * field changed, `body` itself when none did. A body that is not a plain
 * object is returned as it is, for the schema to refuse. The request's own
 * object is never modified.
 */
export function canonicalBody(body: unknown, fields: CanonicalFields): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const source = body as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const [name, field] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
    const canonical = canonicalValue(source[name], field);
    if (canonical === source[name]) continue;
    copy ??= { ...source };
    copy[name] = canonical;
  }
  return copy ?? body;
}

/**
 * The fields of an object schema that have a canonical form, read from the
 * schema itself: {@link amountMinorSchema} is an amount, a string with an ISO
 * datetime check is an instant (with that check's zone options), a string
 * with no format or pattern is human text, a schema that declares its own
 * form ({@link withCanonicalForm}, {@link identifier}) has that form, and an
 * object, or an array of them, has its own fields' forms. Optional, nullable
 * and defaulted wrappers are seen through.
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

type Check = { _zod: { def: CheckDef } };

const checksOf = (schema: z.ZodType): Check[] =>
  (schema._zod.def as { checks?: Check[] }).checks ?? [];

const AMOUNT_CHECKS = checksOf(amountMinorSchema);

/**
 * {@link amountMinorSchema}, or a refinement of it (`amountMinorSchema.refine(
 * …positive…)`): zod 4 makes a refinement a new schema that carries the
 * original's check instances, so identity alone missed the top-up's amount.
 */
function isAmountMinor(schema: z.ZodType): boolean {
  if (schema === amountMinorSchema) return true;
  if (schema._zod.def.type !== 'string') return false;
  const checks = checksOf(schema);
  return AMOUNT_CHECKS.every((check) => checks.includes(check));
}

function kindOf(schema: z.ZodType): CanonicalKind | null {
  const declared = DECLARED_FORMS.get(schema);
  if (declared) return { kind: 'form', canonicalize: declared };
  if (isAmountMinor(schema)) return { kind: 'amountMinor' };
  const type = schema._zod.def.type;
  if (type === 'object') {
    const fields = canonicalFieldsOf(schema as z.ZodObject);
    return Object.keys(fields).length > 0 ? { kind: 'object', fields } : null;
  }
  if (type === 'array') {
    const element = kindOf(unwrapped((schema as z.ZodArray<z.ZodType>).element));
    return element ? { kind: 'array', element } : null;
  }
  if (type !== 'string') return null;
  const checks = checksOf(schema).map((check) => check._zod.def);
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

const CANONICAL_BODY_PIPES = new WeakSet<object>();
const AS_SENT = new WeakMap<object, unknown>();

/**
 * The body pipe of an idempotent command: the body in canonical form, then
 * validated by `schema` — one pipe, so the two can never be listed apart or
 * in the wrong order (`@Body(canonicalBodyPipe(schema))`).
 *
 * **Rollout.** A key stored before canonicalization holds the hash of the body
 * as it was sent. When canonicalization changed something, the body exactly
 * as the previous release would have validated it is kept beside the result
 * ({@link asSentForm}), and the idempotency store accepts that form's hash
 * too: the client's unchanged retry of a pre-change key replays its answer
 * instead of a 409 that could send it to a new key and a second payment.
 * Safe for any record, old or new: the as-sent body matches a stored hash only
 * when it is the very request that was stored, or — already canonical — equal
 * to the canonical body anyway.
 *
 * **A body whose canonical form the schema refuses** (Codex PR-747 r1, F2) —
 * a reason of ten characters with a CRLF, nine after it; two level names that
 * differ only in their line endings, one after it — is the body the previous
 * release accepted, so it is answered exactly as that release answered it:
 * validated, hashed and executed as sent. Its unchanged retry then replays a
 * pre-change key, and a command another service committed before this change
 * (marketplace's dispute and its resolution) still goes through, never a new
 * permanent 400. No other spelling of it can be canonical either — they share
 * its canonical form — so nothing that could replay a canonical record is
 * answered this way. Only a body refused as sent too is refused, with the
 * refusal the previous release gave.
 */
export function canonicalBodyPipe(schema: z.ZodType): PipeTransform {
  const fields = canonicalFieldsOf(objectOf(schema));
  const pipe: PipeTransform = {
    transform: (value: unknown, _metadata: ArgumentMetadata): unknown => {
      const canonical = canonicalBody(value, fields);
      if (canonical === value) return validateRequestInput(schema, value);
      const parsed = legacyParse(schema, canonical);
      if (!parsed.success) return validateRequestInput(schema, value);
      const dto: unknown = parsed.data;
      if (dto !== null && typeof dto === 'object') {
        const asSent = legacyParse(schema, value);
        if (asSent.success) AS_SENT.set(dto, asSent.data);
      }
      return dto;
    },
  };
  CANONICAL_BODY_PIPES.add(pipe);
  return pipe;
}

/** Whether `pipe` came from {@link canonicalBodyPipe} — for the route guard. */
export function isCanonicalBodyPipe(pipe: unknown): boolean {
  return typeof pipe === 'object' && pipe !== null && CANONICAL_BODY_PIPES.has(pipe);
}

/**
 * `request` — what a command hashes: a body from {@link canonicalBodyPipe}, or
 * any wrapper around one (`targeted`, the reconciliation's actor binding) —
 * with every such body in it replaced by its as-sent form; `undefined` when
 * none in it has one.
 *
 * Found by walking the request, not looked up on it (Codex PR-747 r1, F1): a
 * wrapper is a new object, and a lookup on the outermost one lost the form of
 * the body inside, so the unchanged retry of a pre-change key was refused. Any
 * composition of plain objects and arrays that holds the body itself is seen
 * through, however many layers, with no wrapper having to pass the form on.
 */
export function asSentForm(request: unknown): unknown {
  const substituted = withAsSent(request);
  return substituted === request ? undefined : substituted;
}

function withAsSent(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (AS_SENT.has(value)) return AS_SENT.get(value);
  if (Array.isArray(value)) {
    const items = value.map(withAsSent);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const source = value as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const [name, member] of Object.entries(source)) {
    const replaced = withAsSent(member);
    if (replaced === member) continue;
    copy ??= { ...source };
    copy[name] = replaced;
  }
  return copy ?? value;
}

/** The object schema whose fields are normalized: `schema`, or what it refines. */
function objectOf(schema: z.ZodType): z.ZodObject {
  const inner = unwrapped(schema);
  if (inner._zod.def.type !== 'object') {
    throw new Error('canonicalBodyPipe takes an object schema');
  }
  return inner as z.ZodObject;
}

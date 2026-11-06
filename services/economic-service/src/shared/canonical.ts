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
 * One spelling per value, for the idempotency hash — and, for the reward rule
 * create only, before it is validated and executed (pre-review checklist #16;
 * Codex PR-480 r1, R2).
 *
 * The idempotency hash sorts keys but keeps every string as sent, so a retry
 * that says the same thing differently — `"01000"` for `"1000"`,
 * `…T12:00:00.000Z` for `…T12:00:00Z`, CRLF for LF — was refused as a key
 * reused with another body. Its canonical form, hashed beside the body as sent,
 * replays it. For an idempotent command the canonical form is only hashed: the
 * command is validated, executed and stored as sent ({@link canonicalBodyPipe}).
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
 * validation to answer. An idempotent command's body is validated as sent
 * first, with the previous release's limits, executed as sent, and one whose
 * canonical form its schema refuses is hashed only as sent
 * ({@link canonicalBodyPipe}, rollout).
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
const CANONICAL = new WeakMap<object, unknown>();

/**
 * The body pipe of an idempotent command: the body validated by `schema` as
 * sent — what the command executes and stores — and its canonical form kept
 * beside it, for the idempotency hash only (`@Body(canonicalBodyPipe(schema))`).
 *
 * **Executed and stored as sent** (Codex PR-747 r3 F4). A command writes
 * exactly what it wrote before canonicalization: a dispute's reason, a
 * resolution, a level name, an amount's spelling for the service to parse.
 * Text kept with LF had a reader that could not find it: marketplace before
 * #747 compares the dispute and resolution text it sent, exactly, when it
 * recovers a step whose stored answer expired, and refused its own committed
 * effect — the saga stopped with the funds held. Storing the canonical form
 * waits for those readers to be the rollback floor (FU-115).
 *
 * **Rollout, both directions** (Codex PR-747 r1 F2, r2 F3). During a rolling
 * update or an automatic rollback (docs/12 § rollout) a retry can reach either
 * release, so its unchanged retry must replay on both, and neither may refuse
 * what the other accepts:
 *
 *  - **Validation is the previous release's, on the body as sent**: a body it
 *    refused is refused with its refusal, and nothing is accepted it would
 *    refuse — a 1 201-unit CRLF reason, 801 once LF, is still over the 1 000
 *    limit. Limits counted after LF are a later step (docs/06 § 6.8,
 *    "canonical-only").
 *  - The body the handler gets — and hashes, wherever it wraps it — is the one
 *    that release validated, so the idempotency store **writes that hash** as
 *    `request_hash`, the one that release computes and compares. When
 *    canonicalization changed something, the canonical form is kept beside the
 *    body ({@link canonicalForm}) and its hash recorded in `canonical_hash`, so
 *    another spelling replays here.
 *  - A body whose canonical form the schema refuses — a ten-unit CRLF reason,
 *    nine after it; two level names apart only by their line endings — has no
 *    canonical form: hashed only as sent, as that release did, and never a new
 *    permanent 400 for a command another service committed before
 *    (marketplace's dispute and its resolution).
 */
export function canonicalBodyPipe(schema: z.ZodType): PipeTransform {
  const fields = canonicalFieldsOf(objectOf(schema));
  const pipe: PipeTransform = {
    transform: (value: unknown, _metadata: ArgumentMetadata): unknown => {
      const asSent: unknown = validateRequestInput(schema, value);
      const canonical = canonicalBody(value, fields);
      if (canonical === value) return asSent;
      const parsed = legacyParse(schema, canonical);
      if (parsed.success && asSent !== null && typeof asSent === 'object') {
        CANONICAL.set(asSent, parsed.data);
      }
      return asSent;
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
 * with every such body in it replaced by its canonical form; `undefined` when
 * none in it has one. For the idempotency hash only: what is executed is the
 * body as sent.
 *
 * Found by walking the request, not looked up on it (Codex PR-747 r1, F1): a
 * wrapper is a new object, and a lookup on the outermost one lost the body
 * inside. Any composition of plain objects and arrays that holds the body
 * itself is seen through, however many layers. A copy of the body is not the
 * body: it has no canonical form, and is hashed only as it is.
 */
export function canonicalForm(request: unknown): unknown {
  const substituted = withCanonical(request);
  return substituted === request ? undefined : substituted;
}

function withCanonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (CANONICAL.has(value)) return CANONICAL.get(value);
  if (Array.isArray(value)) {
    const items = value.map(withCanonical);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const source = value as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const [name, member] of Object.entries(source)) {
    const replaced = withCanonical(member);
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

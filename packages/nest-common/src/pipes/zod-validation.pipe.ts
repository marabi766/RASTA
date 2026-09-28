import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, defaultErrorMap, type ZodIssue, type ZodTypeAny, type z } from 'zod';
import type { ErrorDetail } from '@rasta/contracts';
import { RastaError } from '../errors/rasta-error';

/**
 * Validates and parses a request payload against a Zod schema.
 *
 * The same schemas back the OpenAPI document and the frontend forms, so a
 * field cannot drift between what the client sends, what the server accepts
 * and what the docs promise.
 *
 * Errors are reported with a field path, so a client can highlight the offending
 * input rather than showing "invalid request" over a twenty-field form. What a
 * detail may carry is set by {@link toErrorDetails}: schema facts, never the
 * client's own input (S-09).
 */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw RastaError.validation(toErrorDetails(error, this.schema, value));
      }
      throw error;
    }
  }
}

/** Convenience for inline use: `@Body(zodPipe(createAssetSchema)) dto: CreateAssetDto`. */
export function zodPipe<T extends ZodTypeAny>(schema: T): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/**
 * A validation failure as the client sees it: `{ path, code, message }` per
 * issue — the shape clients already read — built from **schema facts only**
 * (S-09). The response goes back to the caller and `details` reaches the log
 * with the error, so neither may repeat what the caller sent.
 *
 * Where zod's own output repeats input, and what replaces it:
 *
 *  - `invalid_enum_value` — zod says `…, received '<value>'`. The message is
 *    rebuilt from the schema's options alone: `Invalid enum value. Expected
 *    'A' | 'B'`.
 *  - `unrecognized_keys` — zod lists the client's extra keys. The message is
 *    `Unrecognized key(s) in object (<count>)`.
 *  - **Path segments the client chose** — a `z.record` key, or a key an object
 *    accepts through `.catchall()` — become `*` (`metadata.*`), decided by
 *    walking `schema`; a segment the walk cannot place is treated the same
 *    way. Array indexes and declared field names stay.
 *  - **A message the schema supplied** (a `.refine` message, a custom
 *    `errorMap`, a regex message) can interpolate anything, the input
 *    included. It is kept when it does not contain the offending value —
 *    the value at the issue's path, or any string or number under it of three
 *    characters or more, or an unrecognized key — and otherwise replaced by
 *    the code's fixed message. Schema messages are meant to be static text;
 *    this is the backstop, not the rule.
 *
 * Every other zod default message is built from schema-side fields only
 * (expected and received *type names*, limits, options, the validation kind),
 * so it is used as zod writes it.
 */
export function toErrorDetails(error: ZodError, schema: ZodTypeAny, input: unknown): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: formatPath(safePath(schema, issue.path)),
    message: safeMessage(issue, input),
    code: issue.code,
  }));
}

/**
 * Renders a Zod path the way a client would address it:
 * `['items', 0, 'quantity']` becomes `items[0].quantity`.
 */
export function formatPath(path: readonly (string | number | symbol)[]): string {
  if (path.length === 0) return '(root)';

  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    const key = String(segment);
    return acc.length === 0 ? key : `${acc}.${key}`;
  }, '');
}

/** What a client-chosen path segment is shown as. */
export const REDACTED_SEGMENT = '*';

/** The shortest input text the message backstop looks for; shorter strings match by accident. */
const ECHO_MIN_LENGTH = 3;

/** How much of the input the message backstop reads before giving up and assuming an echo. */
const ECHO_MAX_LEAVES = 200;

function safeMessage(issue: ZodIssue, input: unknown): string {
  const fixed = fixedMessage(issue);
  const zodDefault = defaultErrorMap(issue, { defaultError: '', data: undefined }).message;
  if (issue.message === zodDefault) return fixed;
  return echoesInput(issue, input) ? fixed : issue.message;
}

/** The message for an issue from schema-side facts alone. */
function fixedMessage(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_enum_value':
      return `Invalid enum value. Expected ${issue.options.map(renderOption).join(' | ')}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object (${issue.keys.length})`;
    default:
      return defaultErrorMap(issue, { defaultError: 'Invalid input', data: undefined }).message;
  }
}

function renderOption(option: string | number): string {
  return typeof option === 'string' ? `'${option}'` : String(option);
}

function echoesInput(issue: ZodIssue, input: unknown): boolean {
  const texts = issue.code === 'unrecognized_keys' ? [...issue.keys] : [];
  const leaves = collectLeaves(valueAt(input, issue.path), texts);
  if (!leaves) return true; // too much to check: assume the worst
  return leaves.some((text) => text.length >= ECHO_MIN_LENGTH && issue.message.includes(text));
}

function valueAt(input: unknown, path: readonly (string | number)[]): unknown {
  let current = input;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/** Every string and number under `value` (keys included), or `null` past the bound. */
function collectLeaves(value: unknown, into: string[]): string[] | null {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next === 'string') into.push(next);
    else if (typeof next === 'number' || typeof next === 'bigint') into.push(String(next));
    else if (next !== null && typeof next === 'object') {
      for (const [key, child] of Object.entries(next)) {
        into.push(key);
        stack.push(child);
      }
    }
    if (into.length > ECHO_MAX_LEAVES) return null;
  }
  return into;
}

// ---------------------------------------------------------------------------
// Path: which segments the schema declares
// ---------------------------------------------------------------------------

/** The zod v3 internals the walk reads. */
interface ZodDefLike {
  typeName?: string;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  type?: ZodTypeAny;
  in?: ZodTypeAny;
  getter?: () => ZodTypeAny;
  shape?: () => Record<string, ZodTypeAny>;
  catchall?: ZodTypeAny;
  valueType?: ZodTypeAny;
  items?: ZodTypeAny[];
  rest?: ZodTypeAny | null;
  options?: ZodTypeAny[] | Map<unknown, ZodTypeAny>;
  left?: ZodTypeAny;
  right?: ZodTypeAny;
}

const defOf = (schema: ZodTypeAny): ZodDefLike => schema._def as ZodDefLike;

/** The path with every segment the schema does not declare replaced by `*`. */
export function safePath(
  schema: ZodTypeAny,
  path: readonly (string | number)[],
): (string | number)[] {
  const shown: (string | number)[] = [];
  let current: ZodTypeAny | undefined = schema;
  for (const segment of path) {
    const step: Step = current ? child(current, segment) : { declared: false };
    shown.push(typeof segment === 'number' || step.declared ? segment : REDACTED_SEGMENT);
    current = step.schema;
  }
  return shown;
}

interface Step {
  /** The segment is a name the schema itself wrote (or an array position). */
  declared: boolean;
  schema?: ZodTypeAny;
}

/** Wrappers that change nothing about the path beneath them. */
function unwrap(schema: ZodTypeAny, depth = 0): ZodTypeAny {
  if (depth > 32) return schema;
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      return def.innerType ? unwrap(def.innerType, depth + 1) : schema;
    case 'ZodEffects':
      return def.schema ? unwrap(def.schema, depth + 1) : schema;
    case 'ZodBranded':
    case 'ZodPromise':
      return def.type ? unwrap(def.type, depth + 1) : schema;
    case 'ZodPipeline':
      return def.in ? unwrap(def.in, depth + 1) : schema;
    case 'ZodLazy':
      return def.getter ? unwrap(def.getter(), depth + 1) : schema;
    default:
      return schema;
  }
}

function child(schema: ZodTypeAny, segment: string | number): Step {
  const target = unwrap(schema);
  const def = defOf(target);
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      if (typeof segment === 'string' && Object.prototype.hasOwnProperty.call(shape, segment)) {
        return { declared: true, schema: shape[segment] };
      }
      // A key the schema did not name: the client's, whatever `catchall` says.
      const catchall = def.catchall && defOf(def.catchall).typeName !== 'ZodNever';
      return { declared: false, schema: catchall ? def.catchall : undefined };
    }
    case 'ZodRecord':
      return { declared: false, schema: def.valueType };
    case 'ZodArray':
      return { declared: typeof segment === 'number', schema: def.type };
    case 'ZodTuple':
      return typeof segment === 'number'
        ? { declared: true, schema: def.items?.[segment] ?? def.rest ?? undefined }
        : { declared: false };
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = Array.isArray(def.options)
        ? def.options
        : def.options
          ? [...def.options.values()]
          : [];
      for (const option of options) {
        const step = child(option, segment);
        if (step.declared) return step;
      }
      return { declared: false };
    }
    case 'ZodIntersection': {
      for (const side of [def.left, def.right]) {
        if (!side) continue;
        const step = child(side, segment);
        if (step.declared) return step;
      }
      return { declared: false };
    }
    default:
      return { declared: false };
  }
}

import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type z } from 'zod';
import {
  LEGACY_PARSE,
  legacyDefaultMessage,
  legacyIssues,
  resolveZodPath,
  type ErrorDetail,
  type LegacyIssue,
} from '@rasta/contracts';
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
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    try {
      return this.schema.parse(value, LEGACY_PARSE);
    } catch (error) {
      if (error instanceof ZodError) {
        throw RastaError.validation(toErrorDetails(error, this.schema, value));
      }
      throw error;
    }
  }
}

/** Convenience for inline use: `@Body(zodPipe(createAssetSchema)) dto: CreateAssetDto`. */
export function zodPipe<T extends z.ZodType>(schema: T): ZodValidationPipe<T> {
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
 *    `error`, a regex message) can interpolate anything, the input
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
export function toErrorDetails(error: ZodError, schema: z.ZodType, input: unknown): ErrorDetail[] {
  return legacyIssues(error.issues, schema, input).map((issue) => ({
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

function safeMessage(issue: LegacyIssue, input: unknown): string {
  if (issue.zodDefault) return fixedMessage(issue);
  return echoesInput(issue, input) ? fixedMessage(issue) : issue.message;
}

/** The message for an issue from schema-side facts alone. */
function fixedMessage(issue: LegacyIssue): string {
  switch (issue.code) {
    case 'invalid_enum_value':
      return `Invalid enum value. Expected ${issue.options.map(renderOption).join(' | ')}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object (${issue.keys.length})`;
    default:
      return legacyDefaultMessage(issue);
  }
}

function renderOption(option: string | number): string {
  return typeof option === 'string' ? `'${option}'` : String(option);
}

function echoesInput(issue: LegacyIssue, input: unknown): boolean {
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

/**
 * The path with every segment the schema does not declare replaced by `*`.
 * The walk is the shared one ({@link resolveZodPath}): a key is declared when
 * an object names it; a record's key, or a key an object takes through
 * `.catchall()`, is the client's. An array position is shown wherever it falls.
 */
export function safePath(
  schema: z.ZodType,
  path: readonly (string | number)[],
): (string | number)[] {
  const { segments } = resolveZodPath(schema, path);
  return path.map((segment, at) =>
    typeof segment === 'number' || segments[at] !== undefined ? segment : REDACTED_SEGMENT,
  );
}

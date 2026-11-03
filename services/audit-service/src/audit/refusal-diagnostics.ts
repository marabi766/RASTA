import type { z, ZodTypeAny } from 'zod';
import { legacyParse, requireLegacyRefusal, type LegacyRefusal } from '@rasta/contracts';

/**
 * What a refusal may say about the message it refused (S-09; PR #378 r1 F3).
 *
 * A refusal reaches three places with none of the audit store's access
 * controls: the platform log, the error the shared consumer logs on every
 * attempt, and the `x-dlq-error` header of the dead letter. So it names the
 * event type and version, Zod issue codes, and issue paths made of field names
 * the **schema** declares — never a value, never a Zod message (which can quote
 * the value it received), and never a property name the producer chose: a
 * producer can put an email address in a key as easily as in a value. A path
 * segment the schema does not declare is withheld and counted.
 */

/** An event name as the envelope contract spells one, and bounded. */
const SAFE_EVENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

/** A Zod issue code (`invalid_type`, `too_big`, …), which is code-authored. */
const SAFE_ISSUE_CODE = /^[a-z_]{1,32}$/;

/** An error class name, which is code-authored rather than data-derived. */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** How many issues one diagnostic names; the rest are counted. */
export const MAX_REPORTED_ISSUES = 10;

/** The longest diagnostic, in characters, whatever the issues were. */
export const DIAGNOSTIC_MAX_LENGTH = 400;

/** Stands in for a path segment the schema does not declare. */
export const WITHHELD_SEGMENT = '?';

/**
 * The event's type and version, each printed only if it has the shape the
 * envelope contract gives it — otherwise a fixed placeholder, so a malformed
 * envelope logs nothing it carried.
 */
export function describeEventType(envelope: unknown): string {
  const candidate = (typeof envelope === 'object' && envelope !== null ? envelope : {}) as {
    eventName?: unknown;
    eventVersion?: unknown;
  };
  const name =
    typeof candidate.eventName === 'string' && SAFE_EVENT_NAME.test(candidate.eventName)
      ? candidate.eventName
      : '(unnamed event)';
  const version =
    typeof candidate.eventVersion === 'number' &&
    Number.isSafeInteger(candidate.eventVersion) &&
    candidate.eventVersion > 0 &&
    candidate.eventVersion < 10_000
      ? `v${candidate.eventVersion}`
      : 'v?';
  return `${name} ${version}`;
}

/** An error's class name if it looks like one, otherwise `Error`. Never its message. */
export function describeErrorClass(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_NAME.test(error.name) ? error.name : 'Error';
}

/**
 * Every object key the given schemas declare, at any depth.
 *
 * Read from the schemas rather than listed by hand, so the allow-list cannot
 * fall behind them. A record's keys are the producer's and are never added; a
 * lazy schema is not expanded.
 */
export function declaredFieldNames(...schemas: readonly ZodTypeAny[]): ReadonlySet<string> {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  const pending: unknown[] = [...schemas];

  while (pending.length > 0) {
    const schema = pending.pop() as { _zod?: { def: Record<string, unknown> } } | undefined;
    if (!schema?._zod || seen.has(schema)) continue;
    seen.add(schema);
    const def = schema._zod.def;

    switch (def.type) {
      case 'object': {
        for (const [key, field] of Object.entries(def.shape as Record<string, unknown>)) {
          names.add(key);
          pending.push(field);
        }
        pending.push(def.catchall);
        break;
      }
      case 'array':
        pending.push(def.element);
        break;
      case 'record':
      case 'map':
        pending.push(def.valueType);
        break;
      case 'union':
        pending.push(...(def.options as unknown[]));
        break;
      case 'intersection':
        pending.push(def.left, def.right);
        break;
      case 'tuple':
        pending.push(...(def.items as unknown[]), def.rest);
        break;
      case 'pipe':
        // A transform or preprocess: the schema on either side of the function.
        pending.push(def.in, def.out);
        break;
      case 'lazy':
        break;
      default:
        // optional, nullable, default, prefault, catch, readonly, non-optional
        pending.push(def.innerType);
    }
  }
  return names;
}

/**
 * Where a schema failed and how, without what it failed on: `path code` per
 * issue, paths of declared field names and array indices only, at most
 * {@link MAX_REPORTED_ISSUES} issues and {@link DIAGNOSTIC_MAX_LENGTH}
 * characters.
 */
export function describeIssues(refusal: LegacyRefusal, declared: ReadonlySet<string>): string {
  // zod 3's codes, which these diagnostics have always carried, translated
  // against the schema that refused (GHSA-mrhx-c7xc-m3w5, PR #444 r1 F1).
  const { issues } = requireLegacyRefusal(refusal, 'describeIssues');
  let withheld = 0;
  const described = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.map((segment) => {
      if (typeof segment === 'number') return String(segment);
      if (declared.has(segment)) return segment;
      withheld += 1;
      return WITHHELD_SEGMENT;
    });
    const code = SAFE_ISSUE_CODE.test(issue.code) ? issue.code : 'unknown_code';
    return `${path.length === 0 ? '(root)' : path.join('.')} ${code}`;
  });

  let text = described.join(', ');
  if (issues.length > MAX_REPORTED_ISSUES) text += `, …(${issues.length} total)`;
  if (withheld > 0) text += ` [${withheld} undeclared path segment(s) withheld]`;
  return text.length <= DIAGNOSTIC_MAX_LENGTH
    ? text
    : `${text.slice(0, DIAGNOSTIC_MAX_LENGTH - 1)}…`;
}

/**
 * A payload a mapper refused, carrying the {@link LegacyRefusal} of the parse
 * that refused it. Its own message is fixed text: the refusal is described by
 * {@link describeIssues}, never by printing this error.
 */
export class SchemaRefusedError extends Error {
  constructor(readonly refusal: LegacyRefusal) {
    super('the payload does not match its schema');
    this.name = 'SchemaRefusedError';
  }
}

/**
 * `value` parsed by `schema`, or a {@link SchemaRefusedError} — for a mapper
 * whose caller describes the refusal ({@link schemaRefusalOf}). A bare
 * `.parse()` would throw a `ZodError`, which has no schema to translate its
 * codes against (PR #444 r1 F1).
 */
export function parseOrRefuse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = legacyParse(schema, value);
  if (!parsed.success) throw new SchemaRefusedError(parsed.refusal);
  return parsed.data;
}

/** The refusal a {@link SchemaRefusedError} carries; `null` for anything else, a bare `ZodError` included. */
export function schemaRefusalOf(error: unknown): LegacyRefusal | null {
  return error instanceof SchemaRefusedError ? error.refusal : null;
}

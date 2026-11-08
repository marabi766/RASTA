/**
 * Absence checks over a stored message (an outbox row's `payload`), by walking it.
 *
 * Escapes a whole-text search, a values-only walk and a top-level key list each leave open: a
 * marker appended to a value that is otherwise expected (`"01J… intervalHours=500.00"`), a marker
 * carried as a property NAME (`{"Very identifiable name": true}`) that schema parsing strips
 * before anyone looks, a field nested under an allowed one (`actor.extra = 500`,
 * `actor.interval = { Hours: 500 }`), and a number written another way (`500`, `"500"`, `5e2`
 * for the marker `500.00`). This walks every key and every string/number leaf of the RAW
 * message and can pin its whole shape, recursively.
 *
 * - `shape`: the exact expected structure, at every depth. A key the shape does not name, a
 *   missing required key, a value of another type: each is a problem, so nothing can be added
 *   under `actor` (or anywhere) unseen, and a marker split across nested keys has no place to go.
 * - `exactly` / `wholly`: a leaf pinned to the value the test itself knows, or to a strict
 *   WHOLE-value pattern (ULID, traceparent, semver). A string leaf typed only `'string'` is
 *   unconstrained text, and no tokenizer can be sure to find a number written into text with
 *   punctuation (`intervalHours:500`, `{"x":500}`, `x/5e2`, `lat:35.7/51.4`); a pinned leaf has no
 *   place for appended text. `envelopeShape` therefore REQUIRES a pin for every envelope field.
 * - `anywhere` / `inKeys`: text markers, case-insensitive, in keys and string/number leaves.
 * - `numbers`: sensitive numbers as VALUES (`'500.00'`, `500`). A number leaf, a string that is
 *   wholly a decimal literal, or a decimal word inside a string equals the marker when its exact
 *   decimal value does: `500`, `"500"`, `"500.00"`, `5e2` all equal 500.00. No float arithmetic.
 * - `near`: a number or decimal word within `within` of any given value (a rounded coordinate).
 *
 * Timestamps are exempt from the search ONLY where the shape designates them as `'instant'` (and
 * the value then has the strict instant shape). A short number such as `50.00` occurs inside
 * `…:50.001Z` by chance (#452), and that is why those fields are exempt — a string that merely
 * looks like an instant elsewhere is searched like any other, so it cannot carry a marker.
 *
 * Imports nothing, like `disclosure.ts`.
 */

/** A strict, UTC ISO instant as `Date#toISOString` writes it (and Postgres, up to microseconds). */
export const ISO_INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** What a leaf may be. `'instant'` is a string in `ISO_INSTANT_SHAPE`, exempt from the search. */
export type Leaf = 'string' | 'number' | 'boolean' | 'null' | 'instant';

/** Every element of an array has this shape. */
export class ArrayOf {
  constructor(readonly item: Shape) {}
}

/** The key may be absent; when present it has this shape. */
export class Optional {
  constructor(readonly shape: Shape) {}
}

/** An object has exactly these keys (the `Optional` ones may be absent), each with its shape. */
export interface ObjectShape {
  readonly [key: string]: Shape | Optional;
}

/**
 * A leaf pinned to a value: equal to `expected` (same type, `===`), or, for a pattern, a string
 * the pattern matches from its first character to its last. The anchors are added here, so a
 * pattern cannot be written loosely.
 */
export class Pin {
  readonly expected: string | number | boolean | RegExp;
  constructor(expected: string | number | boolean | RegExp) {
    if (expected instanceof RegExp) {
      if (/[gmy]/.test(expected.flags)) {
        throw new Error(`a pinned pattern takes no g, m or y flag: ${String(expected)}`);
      }
      this.expected = new RegExp(`^(?:${expected.source})$`, expected.flags);
    } else {
      this.expected = expected;
    }
  }
  accepts(value: unknown): boolean {
    return this.expected instanceof RegExp
      ? typeof value === 'string' && this.expected.test(value)
      : value === this.expected;
  }
  describe(): string {
    return this.expected instanceof RegExp
      ? `matching ${String(this.expected)}`
      : `exactly ${JSON.stringify(this.expected)}`;
  }
}

/** A leaf pinned to a value the test knows. */
export const exactly = (value: string | number | boolean): Pin => new Pin(value);
/** A leaf pinned to a strict whole-value pattern; the anchors are added, `m`/`g`/`y` refused. */
export const wholly = (pattern: RegExp): Pin => new Pin(pattern);

/** A ULID as `ulid()` writes it: 26 Crockford base32 characters. */
export const ULID_SHAPE = /[0-9A-HJKMNP-TV-Z]{26}/;
/** A W3C traceparent as the outbox writes it: version 00, 32 + 16 hex, flags 00 or 01. */
export const TRACEPARENT_SHAPE = /00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]/;
/** Plain `major.minor.patch` semver, no prerelease or build text. */
export const SEMVER_SHAPE = /(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/;

/** A leaf kind, a union of leaf kinds, a pin, an array of one shape, or an object of named shapes. */
export type Shape = Leaf | readonly Leaf[] | Pin | ArrayOf | ObjectShape;

export const arrayOf = (item: Shape): ArrayOf => new ArrayOf(item);
export const optional = (shape: Shape): Optional => new Optional(shape);

/**
 * What a spec knows about the envelope it expects: a pin for EVERY envelope field except
 * `occurredAt` (the one designated instant). `null` means the test expects the field absent, and
 * then any value there is an unknown key. `optional(pin)` allows absence but pins a present value.
 * A field the test cannot pin must be written as a strict `wholly(...)` pattern, with the reason.
 */
export interface EnvelopePins {
  readonly eventId: Pin;
  readonly eventName: Pin;
  readonly eventVersion: Pin;
  readonly producer: Pin;
  readonly producerVersion: Pin;
  readonly aggregateType: Pin;
  readonly aggregateId: Pin;
  readonly aggregateVersion: Pin | Optional | null;
  readonly tenantId: Pin | Optional | null;
  readonly correlationId: Pin;
  readonly causationId: Pin | Optional | null;
  readonly traceparent: Pin | Optional | null;
  readonly actor: { readonly type: Pin; readonly id: Pin } | null;
  /** #483: `true` only for an anonymous request origin (no `actor`); `null` when the test expects it absent. */
  readonly anonymous: Pin | Optional | null;
  readonly streamSeq: Pin | Optional | null;
  readonly streamKey: Pin | Optional | null;
}

/**
 * The envelope `eventEnvelopeSchema` describes, as it is stored, with the domain payload's shape
 * given by the caller and every other field pinned (`EnvelopePins`). One place for the envelope's
 * nested shapes (`actor`), so a spec cannot leave one open and no string field is left as bare
 * text; `stored-message.spec.ts` keeps its keys equal to the schema's.
 */
export function envelopeShape(payload: Shape, pins: EnvelopePins): ObjectShape {
  const present = (name: string, pin: Pin | Optional | null): ObjectShape =>
    pin === null ? {} : { [name]: pin };
  return {
    eventId: pins.eventId,
    eventName: pins.eventName,
    eventVersion: pins.eventVersion,
    occurredAt: 'instant',
    producer: pins.producer,
    producerVersion: pins.producerVersion,
    aggregateType: pins.aggregateType,
    aggregateId: pins.aggregateId,
    ...present('aggregateVersion', pins.aggregateVersion),
    ...present('tenantId', pins.tenantId),
    correlationId: pins.correlationId,
    ...present('causationId', pins.causationId),
    ...present('traceparent', pins.traceparent),
    ...(pins.actor === null ? {} : { actor: pins.actor }),
    ...present('anonymous', pins.anonymous),
    ...present('streamSeq', pins.streamSeq),
    ...present('streamKey', pins.streamKey),
    payload,
  };
}

export interface StoredMessageRules {
  /** Searched, case-insensitively, in every key and every string or number leaf. */
  readonly anywhere?: readonly string[];
  /** Searched, case-insensitively, in keys only (a value may legitimately name a field). */
  readonly inKeys?: readonly string[];
  /** Decimal values that must be nowhere, whatever their written form. See the file comment. */
  readonly numbers?: readonly (number | string)[];
  /** No number (or decimal word) within `within` of any of `values`. */
  readonly near?: { readonly values: readonly number[]; readonly within: number };
  /** When given, the message's own top-level keys must all be in it. */
  readonly topLevelKeys?: readonly string[];
  /** The exact structure of the message, at every depth. */
  readonly shape?: Shape;
}

const DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
/** What separates a decimal word from the text around it: space, `=`, `,`, `;` and brackets. */
const WORD_BOUNDARY = /[\s=,;()[\]{}"']+/;

/** `-5e2` and `-500.00` both give `-5e2`: sign, digits without edge zeros, power of ten. */
function canonicalDecimal(text: string): string | null {
  const match = DECIMAL.exec(text);
  if (match === null) return null;
  const [, sign, whole = '', fraction = '', fractionOnly = '', power = '0'] = match;
  const fractionDigits = fraction === '' ? fractionOnly : fraction;
  let digits = (whole + fractionDigits).replace(/^0+/, '');
  if (digits === '') return '0';
  let exponent = BigInt(power) - BigInt(fractionDigits.length);
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent += 1n;
  }
  return `${sign === '-' ? '-' : ''}${digits}e${exponent}`;
}

/** The decimal literals a leaf or key states: the whole text, or a word of it. */
function decimalsIn(value: string | number): { word: string; canonical: string }[] {
  const words = typeof value === 'number' ? [String(value)] : value.split(WORD_BOUNDARY);
  const found: { word: string; canonical: string }[] = [];
  for (const word of words) {
    const canonical = canonicalDecimal(word);
    if (canonical !== null) found.push({ word, canonical });
  }
  return found;
}

function leafKind(value: unknown): Leaf | null {
  if (value === null) return 'null';
  if (typeof value === 'string') return ISO_INSTANT_SHAPE.test(value) ? 'instant' : 'string';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return null;
}

/** Every way the message breaks the rules; empty means clean. Fails closed on an empty walk. */
export function storedMessageProblems(message: unknown, rules: StoredMessageRules): string[] {
  const problems: string[] = [];
  const anywhere = (rules.anywhere ?? []).map((marker) => marker.toLowerCase());
  const inKeys = (rules.inKeys ?? []).map((marker) => marker.toLowerCase());
  const numbers = (rules.numbers ?? []).map((marker) => ({
    marker,
    canonical: canonicalDecimal(String(marker)),
  }));
  for (const { marker, canonical } of numbers) {
    if (canonical === null) problems.push(`numeric marker ${JSON.stringify(marker)} is no decimal`);
  }
  const near = rules.near;
  if (anywhere.length + inKeys.length + numbers.length + (near?.values.length ?? 0) === 0) {
    problems.push('no markers to look for');
  }
  if (typeof message !== 'object' || message === null) {
    return [...problems, 'the stored message is not an object'];
  }
  if (rules.topLevelKeys !== undefined) {
    for (const key of Object.keys(message)) {
      if (!rules.topLevelKeys.includes(key)) problems.push(`top-level key ${JSON.stringify(key)}`);
    }
  }

  const searchText = (text: string, label: string, textMarkers: readonly string[]): void => {
    const lower = text.toLowerCase();
    for (const marker of textMarkers) {
      if (lower.includes(marker)) problems.push(label);
    }
  };
  const searchDecimals = (value: string | number, label: string): void => {
    for (const { word, canonical } of decimalsIn(value)) {
      for (const marker of numbers) {
        if (marker.canonical === canonical) {
          problems.push(`${label} (${JSON.stringify(word)} equals ${String(marker.marker)})`);
        }
      }
      if (near !== undefined) {
        const approx = Number(word);
        for (const centre of near.values) {
          if (Math.abs(approx - centre) <= near.within) {
            problems.push(
              `${label} (${JSON.stringify(word)} is within ${near.within} of ${centre})`,
            );
          }
        }
      }
    }
  };

  let leaves = 0;
  const visit = (value: unknown, shape: Shape | Optional | undefined, path: string): void => {
    const inner = shape instanceof Optional ? shape.shape : shape;
    if (Array.isArray(value)) {
      if (inner !== undefined && !(inner instanceof ArrayOf)) {
        problems.push(`array at ${path} where the shape has none`);
      }
      const item = inner instanceof ArrayOf ? inner.item : undefined;
      value.forEach((element, index) => visit(element, item, `${path}[${index}]`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      const named =
        inner !== undefined &&
        typeof inner === 'object' &&
        !Array.isArray(inner) &&
        !(inner instanceof Pin) &&
        !(inner instanceof ArrayOf)
          ? (inner as ObjectShape)
          : undefined;
      if (inner !== undefined && named === undefined) {
        problems.push(`object at ${path} where the shape has none`);
      }
      const record = value as Record<string, unknown>;
      if (named !== undefined) {
        for (const [key, expected] of Object.entries(named)) {
          if (!Object.hasOwn(record, key) && !(expected instanceof Optional)) {
            problems.push(`missing key ${JSON.stringify(key)} at ${path}`);
          }
        }
      }
      for (const [key, child] of Object.entries(record)) {
        const label = `key ${JSON.stringify(key)} at ${path}`;
        searchText(key, label, [...anywhere, ...inKeys]);
        searchDecimals(key, label);
        const known = named !== undefined && Object.hasOwn(named, key);
        if (named !== undefined && !known) problems.push(`unknown ${label}`);
        visit(child, known ? named[key] : undefined, `${path}.${key}`);
      }
      return;
    }
    leaves += 1;
    const kind = leafKind(value);
    const allowed: readonly unknown[] | undefined =
      inner === undefined || inner instanceof Pin
        ? undefined
        : Array.isArray(inner)
          ? inner
          : [inner];
    if (inner instanceof Pin && !inner.accepts(value)) {
      problems.push(`value ${JSON.stringify(value)} at ${path} is not ${inner.describe()}`);
    }
    if (allowed !== undefined) {
      const fits =
        kind !== null &&
        allowed.some((leaf) => leaf === kind || (leaf === 'string' && kind === 'instant'));
      if (!fits)
        problems.push(`value ${JSON.stringify(value)} at ${path} is not ${JSON.stringify(inner)}`);
    }
    // Exempt ONLY a string the shape designates an instant, and that has the strict shape.
    if (kind === 'instant' && allowed?.includes('instant') === true) return;
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const label = `value ${JSON.stringify(value)} at ${path}`;
    searchText(String(value), label, anywhere);
    searchDecimals(value, label);
  };
  visit(message, rules.shape, '$');
  if (leaves === 0) problems.push('the stored message has no leaves');
  return problems;
}

/** Throws one error listing every offending key and value. */
export function expectStoredMessageWithout(message: unknown, rules: StoredMessageRules): void {
  const problems = storedMessageProblems(message, rules);
  if (problems.length > 0) {
    const error = new Error(`expectStoredMessageWithout:\n  - ${problems.join('\n  - ')}`);
    Error.captureStackTrace(error, expectStoredMessageWithout);
    throw error;
  }
}

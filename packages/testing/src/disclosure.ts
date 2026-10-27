/**
 * Absence assertions with explicit, path-bound metadata exemptions.
 *
 * `expect(JSON.stringify(body)).not.toContain('403')` looks for a secret in a
 * haystack that also carries values the run minted: a correlation ULID, the
 * error envelope's `timestamp`, organization and source ids, digests. Any of
 * them can contain a short secret by chance (`…:12.584Z` holds `12.5`; a ULID
 * holds `403`), so the test fails although nothing was disclosed (#452). This
 * module separates the two:
 *
 * - {@link expectNotDisclosed} verifies whole JSON values at declared paths
 *   against independent expected values (or bounded instants at timestamp
 *   paths). Only those values are excused. Unknown generated values, keys and
 *   all adjacent content stay searched; identity secrets are checked in the
 *   original payload too. Unknown values can still produce incidental matches:
 *   without an independent source, the assertion deliberately fails closed.
 * - {@link absenceHazard} is the rule `disclosure-guard.ts` applies to every
 *   plain `not.toContain` / `not.toMatch` over a string in Jest: a sentinel
 *   that could occur inside a generated value present in the haystack is
 *   refused, whether or not it occurs this run.
 *
 * Imports nothing, so Jest (every service, package and the portal) and
 * Playwright (`tests/e2e`) run the same code. Throws a plain `Error`; no
 * runner's `expect` is needed.
 */

/** Crockford base32, what `ulid()` emits. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DIGITS = '0123456789';
const HEX = '0123456789abcdefABCDEF';

/**
 * The shapes of the values a run mints. Anything matching one of these is a
 * generated value: a bare or prefixed ULID (`TND_01J…`), a UUID, an ISO
 * instant, a hex digest of at least 128 bits.
 */
export const GENERATED_VALUE_SHAPES: Readonly<Record<GeneratedShape, RegExp>> = {
  ulid: /(?<![0-9A-Za-z])[0-7][0-9A-HJKMNP-TV-Z]{25}(?![0-9A-Za-z])/g,
  uuid: /(?<![0-9A-Fa-f])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Fa-f])/g,
  instant: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  digest: /(?<![0-9A-Fa-f])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{32,}(?![0-9A-Fa-f])/g,
};

export type GeneratedShape = 'ulid' | 'uuid' | 'instant' | 'digest';

/** A generated value found in a text: its shape, where it starts, and the value. */
export interface GeneratedValue {
  readonly shape: GeneratedShape;
  readonly index: number;
  readonly value: string;
}

/** Every generated value in `text`, in order of position. */
export function generatedValuesIn(text: string): GeneratedValue[] {
  const found: GeneratedValue[] = [];
  for (const [shape, pattern] of Object.entries(GENERATED_VALUE_SHAPES) as [
    GeneratedShape,
    RegExp,
  ][]) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
      found.push({ shape, index: match.index, value: match[0] });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Whether `text` contains a whole generated value (a ULID, a UUID, a digest — not an instant). */
function holdsIdentity(text: string): boolean {
  return generatedValuesIn(text).some((value) => value.shape !== 'instant');
}

// ---------------------------------------------------------------------------
// The guard's rule
// ---------------------------------------------------------------------------

/**
 * Why `not.toContain(sentinel)` / `not.toMatch(sentinel)` over `haystack`
 * could fail by chance — or `undefined` when it cannot.
 *
 * The haystack is read as a template: every character of a generated value is
 * a class (any Crockford character inside a ULID, any digit inside an instant,
 * any hex digit inside a UUID or digest); every other character is itself.
 * The assertion is hazardous when the sentinel fits the template somewhere
 * with at least one character falling on a class — then some value of the
 * generated part produces the sentinel. Whether this run's values happen to
 * avoid it is beside the point.
 *
 * A sentinel that is itself a generated identity (a whole ULID, UUID or
 * digest, as in `not.toContain(otherTenantId)`) is exempt: it occurs only if
 * that very identity was written, which is what such an assertion checks. A
 * regular expression is read as an alternation of literals; one the rule
 * cannot reduce to literals is hazardous whenever the haystack carries a
 * generated value at all.
 */
export function absenceHazard(haystack: string, sentinel: string | RegExp): string | undefined {
  const generated = generatedValuesIn(haystack);
  if (generated.length === 0) return undefined;

  const alternatives = skeletonOf(sentinel);
  if (alternatives === undefined) {
    return (
      `the regular expression ${String(sentinel)} cannot be reduced to literals, and the text ` +
      `carries ${describe(generated)}`
    );
  }
  const insensitive = sentinel instanceof RegExp && sentinel.flags.includes('i');
  const classes = classesOf(haystack, generated);
  for (const pieces of alternatives) {
    if (holdsIdentity(pieces.map((piece) => piece.text).join(''))) continue;
    for (const piece of pieces) {
      const at = fitsTemplate(haystack, classes, piece, insensitive);
      if (at === undefined) continue;
      const value = generated.find(
        (g) => g.index < at + piece.text.length && at < g.index + g.value.length,
      );
      return (
        `${JSON.stringify(piece.text)} could occur inside the generated ${value?.shape ?? 'value'} ` +
        `${JSON.stringify(value?.value ?? '')}`
      );
    }
  }
  return undefined;
}

function describe(generated: readonly GeneratedValue[]): string {
  const [first] = generated;
  return `${generated.length} generated value(s), e.g. the ${first?.shape} ${JSON.stringify(first?.value)}`;
}

/**
 * What each character of an ISO instant may be in another run: the year is
 * this run's (a sentinel that matches it fails every run, which is no flake);
 * month, day, hour, minute and second keep their ranges (`[01]x`, `[0-3]x`,
 * `[0-2]x`, `[0-5]x`); a fraction digit is any digit; separators and the
 * offset are literal.
 */
const INSTANT_CLASSES: Readonly<Record<number, string>> = {
  5: '01',
  6: DIGITS,
  8: '0123',
  9: DIGITS,
  11: '012',
  12: DIGITS,
  14: '012345',
  15: DIGITS,
  17: '012345',
  18: DIGITS,
};

function instantClass(value: string, i: number): string | null {
  if (i < 19) return INSTANT_CLASSES[i] ?? null;
  // The fraction: digits after the '.' until the zone.
  return value.charAt(19) === '.' && i > 19 && /^\d+$/.test(value.slice(20, i + 1)) ? DIGITS : null;
}

/** Per character of `haystack`: the characters a generated value may hold there, or `null` (literal). */
function classesOf(haystack: string, generated: readonly GeneratedValue[]): (string | null)[] {
  const classes: (string | null)[] = new Array<string | null>(haystack.length).fill(null);
  for (const { shape, index, value } of generated) {
    for (let i = 0; i < value.length; i++) {
      const allowed =
        shape === 'ulid'
          ? i === 0
            ? '01234567'
            : CROCKFORD
          : shape === 'instant'
            ? instantClass(value, i)
            : value.charAt(i) === '-'
              ? null
              : HEX;
      if (allowed !== null) classes[index + i] = allowed;
    }
  }
  return classes;
}

const WORD = /\w/;

/**
 * The first position where `piece` fits the template with at least one class
 * character, if any. A `\b` at an edge of the piece holds the neighbour to
 * it: every class character is a word character.
 */
function fitsTemplate(
  haystack: string,
  classes: readonly (string | null)[],
  piece: Piece,
  insensitive: boolean,
): number | undefined {
  const { text } = piece;
  const same = (a: string, b: string): boolean =>
    insensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  const allowed = (set: string, char: string): boolean =>
    set.includes(char) ||
    (insensitive && (set.includes(char.toUpperCase()) || set.includes(char.toLowerCase())));
  const isWord = (at: number): boolean =>
    at >= 0 && at < haystack.length && (classes[at] != null || WORD.test(haystack.charAt(at)));
  for (let start = 0; start + text.length <= haystack.length; start++) {
    if (piece.boundaryBefore && isWord(start - 1) === WORD.test(text.charAt(0))) continue;
    if (piece.wordlessBefore && isWord(start - 1)) continue;
    if (piece.wordlessAfter && isWord(start + text.length)) continue;
    if (
      piece.boundaryAfter &&
      isWord(start + text.length) === WORD.test(text.charAt(text.length - 1))
    ) {
      continue;
    }
    let generated = false;
    let fits = true;
    for (let i = 0; i < text.length && fits; i++) {
      const set = classes[start + i];
      if (set === null || set === undefined)
        fits = same(haystack.charAt(start + i), text.charAt(i));
      else {
        generated = true;
        fits = allowed(set, text.charAt(i));
      }
    }
    if (fits && generated) return start;
  }
  return undefined;
}

/** A run of characters every match of one alternative contains, with a `\b` at either edge. */
interface Piece {
  readonly text: string;
  readonly boundaryBefore: boolean;
  readonly boundaryAfter: boolean;
  /** A `(?<![\w…])` before the piece: the character before it is no word character. */
  readonly wordlessBefore?: boolean;
  /** A `(?![\w…])` after the piece: the character after it is no word character. */
  readonly wordlessAfter?: boolean;
}

type Token =
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'boundary' }
  | { readonly kind: 'split' }
  | { readonly kind: 'zero' }
  | { readonly kind: 'wordless'; readonly side: 'before' | 'after' }
  | { readonly kind: 'group'; readonly alternatives: Token[][] };

/** Stands for a construct the skeleton cannot over-approximate. */
class Irreducible extends Error {}

/** At most this many literal alternatives are expanded from groups and classes. */
const MAX_ALTERNATIVES = 256;

const isAlphanumeric = (char: string): boolean => /[0-9A-Za-z]/.test(char);

/**
 * A sentinel as the pieces of literal text its matches must contain — an
 * over-approximation, so a hazard is never missed:
 *
 * - a string is one piece;
 * - in a regular expression, `^`, `$`, `\B` and lookarounds only restrict a
 *   match and are dropped; `\b` is kept at the edge of a piece;
 * - a group, or a class of a few listed characters, is expanded into its
 *   alternatives (`(delete|deleteMany)`, `[lr]`);
 * - a construct that matches only non-alphanumeric characters (`\s*`, `\W`,
 *   `[,;]+`, a quantified `-`) splits the text into separate pieces: no
 *   generated character is non-alphanumeric, so such a construct never
 *   reaches into a generated value;
 * - anything else (`.`, `\d`, `\w`, a quantified letter or digit, a negated
 *   or wide class) is irreducible: `undefined`.
 */
function skeletonOf(sentinel: string | RegExp): Piece[][] | undefined {
  if (typeof sentinel === 'string') {
    return [[{ text: sentinel, boundaryBefore: false, boundaryAfter: false }]];
  }
  try {
    const parser = new SkeletonParser(sentinel.source);
    const alternatives = parser.alternation();
    if (!parser.done()) throw new Irreducible();
    return alternatives.flatMap(expand).map(piecesOf);
  } catch (error) {
    if (error instanceof Irreducible) return undefined;
    throw error;
  }
}

function expand(sequence: Token[]): Token[][] {
  let out: Token[][] = [[]];
  for (const token of sequence) {
    if (token.kind !== 'group') {
      out = out.map((prefix) => [...prefix, token]);
      continue;
    }
    const options = token.alternatives.flatMap(expand);
    out = out.flatMap((prefix) => options.map((option) => [...prefix, ...option]));
    if (out.length > MAX_ALTERNATIVES) throw new Irreducible();
  }
  return out;
}

function piecesOf(tokens: Token[]): Piece[] {
  const pieces: Piece[] = [];
  let text = '';
  let before = false;
  let pending = false;
  let wordless = false;
  let pendingWordless = false;
  const close = (after: boolean, wordlessAfter = false): void => {
    if (text.length > 0) {
      pieces.push({
        text,
        boundaryBefore: before,
        boundaryAfter: after,
        wordlessBefore: wordless,
        wordlessAfter,
      });
    }
    text = '';
  };
  for (const token of tokens) {
    if (token.kind === 'char') {
      if (text.length === 0) {
        before = pending;
        wordless = pendingWordless;
      }
      pending = false;
      pendingWordless = false;
      text += token.char;
    } else if (token.kind === 'boundary') {
      close(true);
      pending = true;
    } else if (token.kind === 'split') {
      close(false);
      pending = false;
      pendingWordless = false;
    } else if (token.kind === 'wordless') {
      if (token.side === 'after') close(false, true);
      else {
        close(false);
        pendingWordless = true;
      }
    }
  }
  close(false);
  return pieces;
}

class SkeletonParser {
  private at = 0;

  constructor(private readonly source: string) {}

  done(): boolean {
    return this.at >= this.source.length;
  }

  alternation(): Token[][] {
    const alternatives = [this.sequence()];
    while (this.peek() === '|') {
      this.at++;
      alternatives.push(this.sequence());
    }
    return alternatives;
  }

  private peek(): string {
    return this.source.charAt(this.at);
  }

  private sequence(): Token[] {
    const tokens: Token[] = [];
    while (!this.done() && this.peek() !== '|' && this.peek() !== ')') {
      const atom = this.atom();
      tokens.push(this.quantifier() ? quantified(atom) : atom);
    }
    return tokens;
  }

  private quantifier(): boolean {
    const char = this.peek();
    if (char === '*' || char === '+' || char === '?') {
      this.at++;
    } else if (char === '{' && /^\{\d+(,\d*)?\}/.test(this.source.slice(this.at))) {
      this.at = this.source.indexOf('}', this.at) + 1;
    } else {
      return false;
    }
    if (this.peek() === '?') this.at++;
    return true;
  }

  private atom(): Token {
    const char = this.peek();
    this.at++;
    switch (char) {
      case '\\':
        return this.escape();
      case '^':
      case '$':
        return { kind: 'zero' };
      case '[':
        return this.characterClass();
      case '(':
        return this.group();
      case '.':
      case '*':
      case '+':
      case '?':
      case '{':
        throw new Irreducible();
      default:
        return { kind: 'char', char };
    }
  }

  private escape(): Token {
    const char = this.peek();
    this.at++;
    if (char === 'b') return { kind: 'boundary' };
    if (char === 'B') return { kind: 'zero' };
    if ('sWntrfv'.includes(char)) return { kind: 'split' };
    if (char === '' || isAlphanumeric(char)) throw new Irreducible();
    return { kind: 'char', char };
  }

  private characterClass(): Token {
    if (this.peek() === '^') throw new Irreducible();
    const members: string[] = [];
    let nonAlphanumericOnly = true;
    while (this.peek() !== ']') {
      if (this.done()) throw new Irreducible();
      let char = this.peek();
      this.at++;
      if (char === '\\') {
        const escaped = this.peek();
        this.at++;
        if ('sWntrfv'.includes(escaped)) continue;
        if (escaped === '' || isAlphanumeric(escaped)) throw new Irreducible();
        char = escaped;
      }
      if (this.peek() === '-' && this.source.charAt(this.at + 1) !== ']') {
        const to = this.source.charAt(this.at + 1);
        this.at += 2;
        if (to.charCodeAt(0) - char.charCodeAt(0) > 16) throw new Irreducible();
        for (let code = char.charCodeAt(0); code <= to.charCodeAt(0); code++) {
          members.push(String.fromCharCode(code));
        }
      } else {
        members.push(char);
      }
    }
    this.at++;
    for (const member of members) if (isAlphanumeric(member)) nonAlphanumericOnly = false;
    if (nonAlphanumericOnly) return { kind: 'split' };
    if (members.length > 16) throw new Irreducible();
    return {
      kind: 'group',
      alternatives: members.map((member) => [{ kind: 'char', char: member }]),
    };
  }

  private group(): Token {
    let lookaround = false;
    if (this.peek() === '?') {
      const rest = this.source.slice(this.at);
      if (rest.startsWith('?:')) this.at += 2;
      else if (/^\?(?:<?[=!])/.test(rest)) {
        lookaround = true;
        this.at += rest.startsWith('?<') ? 3 : 2;
      } else if (/^\?<[A-Za-z_]\w*>/.test(rest)) this.at = this.source.indexOf('>', this.at) + 1;
      else throw new Irreducible();
    }
    if (lookaround) {
      // `(?<![\w-])` / `(?!\w)`: the neighbour is no word character, which no generated
      // character is — kept, as `\b` is. Any other lookaround consumes nothing and only
      // restricts a match: dropping it, content and all, can only add matches.
      const opened = this.source.slice(this.at - (this.source.charAt(this.at - 2) === '<' ? 4 : 3));
      const wordless = /^\(\?<?!(?:\\w|\[(?:[^\]\\]|\\.)*\\w(?:[^\]\\]|\\.)*\])\)/.exec(opened);
      this.skipToClose();
      if (wordless)
        return { kind: 'wordless', side: opened.startsWith('(?<') ? 'before' : 'after' };
      return { kind: 'zero' };
    }
    const alternatives = this.alternation();
    if (this.peek() !== ')') throw new Irreducible();
    this.at++;
    return { kind: 'group', alternatives };
  }

  /** Past the `)` that closes the group just opened, over escapes, classes and nested groups. */
  private skipToClose(): void {
    let depth = 1;
    let inClass = false;
    while (depth > 0) {
      if (this.done()) throw new Irreducible();
      const char = this.peek();
      this.at++;
      if (char === '\\') this.at++;
      else if (inClass) inClass = char !== ']';
      else if (char === '[') inClass = true;
      else if (char === '(') depth++;
      else if (char === ')') depth--;
    }
  }
}

/** A quantified atom matches a varying run: only one that is all non-alphanumeric stays reducible. */
function quantified(token: Token): Token {
  const nonAlphanumeric = (t: Token): boolean =>
    t.kind === 'split' ||
    t.kind === 'zero' ||
    t.kind === 'boundary' ||
    t.kind === 'wordless' ||
    (t.kind === 'char' && !isAlphanumeric(t.char)) ||
    (t.kind === 'group' &&
      t.alternatives.every((alternative) => alternative.every(nonAlphanumeric)));
  if (token.kind === 'zero' || token.kind === 'boundary' || token.kind === 'wordless') {
    return { kind: 'zero' };
  }
  if (nonAlphanumeric(token)) return { kind: 'split' };
  throw new Irreducible();
}

// ---------------------------------------------------------------------------
// expectNotDisclosed
// ---------------------------------------------------------------------------

const MATCHER = Symbol('disclosure.matcher');

/** Only independent exact values or bounded instants may exempt a declared JSON value. */
export interface MetadataMatcher {
  readonly [MATCHER]: true;
  check(value: unknown): string[];
}

export type MetadataExpectation = string | number | MetadataMatcher;
type InstantInput = Date | string | number;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const WELL_FORMED_CORRELATION_ID =
  /^(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

function epochOf(value: InstantInput): number {
  return value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value);
}

/** Use only at declared timestamp paths, with a window established independently of the payload. */
export function instant(between: readonly [InstantInput, InstantInput]): MetadataMatcher {
  return {
    [MATCHER]: true,
    check(value) {
      const from = epochOf(between[0]);
      const to = epochOf(between[1]);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
        return ['invalid test window'];
      if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return ['expected an ISO instant'];
      const at = Date.parse(value);
      if (!Number.isFinite(at)) return ['expected a real instant'];
      const iso = new Date(at).toISOString();
      if (iso !== value && iso !== value.replace(/Z$/, '.000Z')) return ['expected a real instant'];
      return at >= from && at <= to ? [] : ['outside the test window'];
    },
  };
}

/** Every candidate must come from request input, headers or an independent row lookup. */
export function oneOf(values: readonly (string | number)[]): MetadataMatcher {
  return {
    [MATCHER]: true,
    check(value) {
      return values.some((expected) => expected === value)
        ? []
        : [`none of the ${values.length} expected values`];
    },
  };
}

export function correlationId(expected: string | undefined): MetadataMatcher {
  return {
    [MATCHER]: true,
    check(value) {
      if (expected === undefined) return ['the response carries no x-correlation-id header'];
      if (!WELL_FORMED_CORRELATION_ID.test(expected))
        return ['expected correlation id is not a ULID or UUID'];
      return value === expected
        ? []
        : [`expected the correlation id ${expected}, got ${JSON.stringify(value)}`];
    },
  };
}

const LOADED_AT = Date.now();
/** Clock window established independently of the response, allowing five seconds of clock skew. */
export function thisRun(): readonly [Date, Date] {
  return [new Date(LOADED_AT - 5_000), new Date(Date.now() + 5_000)];
}

type Headers = Record<string, string | string[] | undefined>;
function header(headers: Headers, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Header identities, exact request path and a bounded clock reading at declared envelope paths. */
export function errorEnvelope(options: {
  readonly headers: Headers;
  readonly path?: string;
  readonly correlationId?: string;
  readonly instantsBetween?: readonly [InstantInput, InstantInput];
}): Record<string, MetadataExpectation> {
  const traceId = header(options.headers, 'x-trace-id');
  return {
    correlationId: correlationId(
      options.correlationId ?? header(options.headers, 'x-correlation-id'),
    ),
    timestamp: instant(options.instantsBetween ?? thisRun()),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
  };
}

export interface DisclosureOptions {
  /** Exact paths; * matches array elements only. Expected values MUST be independent of the
   * payload: request input, response headers, tenant-scoped primary-key/column lookups, or
   * bounded instants at declared timestamp paths. Unknown generated values stay searched. */
  readonly metadata?: Readonly<Record<string, MetadataExpectation>>;
  readonly input?: unknown;
  /** Input-presence exceptions only; these never exempt a disclosure. Explain each at the site. */
  readonly derived?: readonly (string | RegExp)[];
}

/** Substring/RegExp search over all content and unmodified keys, after exact path exemptions.
 * No recursive identity harvesting, shape-only removal, key rewriting or global replacement.
 * Every identity secret (including RegExp matches) is searched in the original payload first.
 * Callers are responsible for establishing metadata independently; otherwise leave it searched.
 */
export function expectNotDisclosed(
  haystack: unknown,
  secrets: readonly (string | RegExp)[],
  options: DisclosureOptions = {},
): void {
  const problems: string[] = [];
  if (secrets.length === 0) problems.push('no secrets to look for');
  if (serialize(haystack) === '') problems.push('payload is absent or not JSON-serializable');
  if (options.input !== undefined) {
    const sent = typeof options.input === 'string' ? options.input : serialize(options.input);
    for (const secret of secrets) {
      if (!options.derived?.includes(secret) && !occurs(sent, secret))
        problems.push(`the secret ${String(secret)} is not in the input`);
    }
  }

  const original = typeof haystack === 'string' ? haystack : serialize(haystack);
  for (const secret of secrets) {
    if (typeof secret === 'string') {
      if (holdsIdentity(secret) && original.includes(secret))
        problems.push(`discloses the identity ${secret}`);
    } else {
      if (holdsIdentity(secret.source) && occurs(original, secret)) {
        problems.push(`discloses the identity ${String(secret)}`);
      }
      const matches = original.matchAll(
        new RegExp(secret.source, secret.flags.replace(/[gy]/g, '') + 'g'),
      );
      for (const match of matches) {
        if (holdsIdentity(match[0])) problems.push(`discloses the identity ${String(secret)}`);
      }
    }
  }

  const content = plain(haystack);
  for (const [path, expected] of Object.entries(options.metadata ?? {})) {
    const slots = resolve(content, path.split('.'));
    if (slots.length === 0) problems.push(`metadata ${path}: absent`);
    for (const slot of slots) {
      const value = slot.holder[slot.key];
      if (typeof value !== 'string' && typeof value !== 'number') {
        problems.push(`metadata ${path}: must be a whole JSON string or number`);
        continue;
      }
      const failures =
        typeof expected === 'object' && expected !== null && MATCHER in expected
          ? expected.check(value)
          : value === expected
            ? []
            : [`expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`];
      problems.push(...failures.map((problem) => `metadata ${path}: ${problem}`));
      // Only a successfully verified whole value at this exact path can be excused.
      if (failures.length === 0) slot.holder[slot.key] = null;
    }
  }

  const text = typeof content === 'string' ? content : serialize(content);
  for (const secret of secrets) {
    if (occurs(text, secret)) problems.push(`discloses ${String(secret)}`);
  }
  if (problems.length > 0) {
    const error = new Error(`expectNotDisclosed:\n  - ${problems.join('\n  - ')}`);
    Error.captureStackTrace(error, expectNotDisclosed);
    throw error;
  }
}

function occurs(text: string, secret: string | RegExp): boolean {
  return typeof secret === 'string'
    ? text.includes(secret)
    : new RegExp(secret.source, secret.flags.replace(/[gy]/g, '')).test(text);
}

function serialize(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? ''
  );
}

/** Preserve every JSON property, including __proto__, without invoking prototype setters. */
function plain(value: unknown): unknown {
  return JSON.parse(serialize(value) || 'null') as unknown;
}

interface Slot {
  readonly holder: Record<string, unknown>;
  readonly key: string;
}
function resolve(value: unknown, segments: readonly string[]): Slot[] {
  const [segment, ...rest] = segments;
  if (segment === undefined || value === null || typeof value !== 'object') return [];
  const holder = value as Record<string, unknown>;
  const keys =
    segment === '*'
      ? Array.isArray(value)
        ? value.map((_item, index) => String(index))
        : []
      : Object.prototype.hasOwnProperty.call(holder, segment)
        ? [segment]
        : [];
  return keys.flatMap((key) =>
    rest.length === 0 ? [{ holder, key }] : resolve(holder[key], rest),
  );
}

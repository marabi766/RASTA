/**
 * Absence assertions that no generated value can fail or pass by accident.
 *
 * `expect(JSON.stringify(body)).not.toContain('403')` looks for a secret in a
 * haystack that also carries values the run minted: a correlation ULID, the
 * error envelope's `timestamp`, organization and source ids, digests. Any of
 * them can contain a short secret by chance (`…:12.584Z` holds `12.5`; a ULID
 * holds `403`), so the test fails although nothing was disclosed (#452). This
 * module separates the two:
 *
 * - {@link expectNotDisclosed} verifies every generated value the caller
 *   declares — at an exact path with its expected identity, as a value the
 *   test holds, or as a clock reading inside the test's own window — removes
 *   it, refuses any generated value it was not told about, and only then looks
 *   for the secrets in what is left.
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

/** A metadata expectation that is not a plain value. */
export interface MetadataMatcher {
  readonly [MATCHER]: true;
  readonly describe: string;
  /** The value stays in what is searched once checked (`searched`), instead of being removed. */
  readonly keep?: true;
  /**
   * Problems with `value`; empty when it is what was expected. `scope` is the list element the
   * path's first `*` stands for (the whole haystack when it has none).
   */
  check(value: unknown, scope?: unknown): string[];
}

/** What a metadata path must hold: exactly this value, or what a matcher accepts. */
export type MetadataExpectation = string | number | boolean | bigint | null | MetadataMatcher;

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

/**
 * An ISO-8601 UTC instant (`2026-10-25T01:39:12.584Z`) or a valid `Date` —
 * optionally inside `[from, to]`. For a clock reading the test cannot know
 * exactly, such as the error envelope's `timestamp`.
 */
export function instant(between?: readonly [InstantInput, InstantInput]): MetadataMatcher {
  return {
    [MATCHER]: true,
    describe: between ? 'an ISO instant inside the test window' : 'an ISO instant',
    check(value) {
      const at =
        value instanceof Date
          ? value.getTime()
          : typeof value === 'string' && ISO_INSTANT.test(value)
            ? Date.parse(value)
            : Number.NaN;
      if (Number.isNaN(at)) return [`expected an ISO instant, got ${JSON.stringify(value)}`];
      // `2026-02-30T…` parses (to March); only a value that round-trips is an instant.
      const iso = new Date(at).toISOString();
      if (typeof value === 'string' && iso !== value && iso !== value.replace(/Z$/, '.000Z')) {
        return [`${JSON.stringify(value)} is not a real instant`];
      }
      if (between && (at < epochOf(between[0]) || at > epochOf(between[1]))) {
        return [`${JSON.stringify(value)} lies outside the test window`];
      }
      return [];
    },
  };
}

/** Exactly one of `values` (each element of a list of rows, say, is one of the rows the test made). */
export function oneOf(values: readonly (string | number | bigint)[]): MetadataMatcher {
  return {
    [MATCHER]: true,
    describe: `one of ${values.length} known values`,
    check(value) {
      const actual = value instanceof Date ? value.toISOString() : value;
      return values.some((expected) => expected === actual)
        ? []
        : [`${JSON.stringify(actual)} is none of the ${values.length} expected values`];
    },
  };
}

/**
 * A key a store minted for this very row or run — an outbox row's id, an access-log row's id
 * (`mintedKey('BAL')` for `BAL_<ULID>`), the correlation of work no request started — which no
 * other record holds, so no identity can be named for it. The one exemption by shape, and a
 * narrow one: the row type's own prefix, if it has one, then 26 Crockford characters, nothing
 * else (an organization, bid or user id must be named in `known`); use it only at the row's own
 * key paths, with every copy held to it by `sameAs`. A whole-identity secret is still looked for
 * in the haystack as it was.
 */
export function mintedKey(prefix?: string): MetadataMatcher {
  const shape = new RegExp(
    `^${prefix === undefined ? '' : `${prefix}_`}[0-7][0-9A-HJKMNP-TV-Z]{25}$`,
  );
  const what = prefix === undefined ? 'a bare ULID' : `${prefix}_ and a ULID`;
  return {
    [MATCHER]: true,
    describe: `${what} minted for this row`,
    check(value) {
      return typeof value === 'string' && shape.test(value)
        ? []
        : [`expected ${what}, got ${JSON.stringify(value)}`];
    },
  };
}

/**
 * A digest the test cannot compute — a bid's content commitment, a receipt it sees for the
 * first time — that stays in what is searched (C: a hash is set aside only as its expected value;
 * otherwise it is searched with the rest). Checked to be a digest, so nothing else rests at the
 * path; the closed-world check leaves it be. Pair it with secrets no digest can hold
 * (`wholeNumber`), or the assertion keeps the chance this module exists to remove.
 */
export function searched(): MetadataMatcher {
  return {
    [MATCHER]: true,
    describe: 'a digest, searched with the content',
    keep: true,
    check(value) {
      return typeof value === 'string' && /^[0-9a-f]{32,}$/i.test(value) && /[a-f]/i.test(value)
        ? []
        : [`expected a digest, got ${JSON.stringify(value)}`];
    },
  };
}

/**
 * A number as a secret no generated value can hold: its digits with no word character or `-` on
 * either side. A ULID, a digest and a UUID segment are runs of word characters, an instant never
 * holds more than four digits in a row, so neither can produce the match — while a disclosure of
 * the number as a JSON value (`"4200000000"`, `:4200000000,`) or in text (`price 4200000000.`)
 * is found. For a haystack whose generated values cannot be declared one by one (events seen on
 * the broker in E2E); `absenceHazard` accepts it.
 */
export function wholeNumber(digits: string): RegExp {
  if (!/^\d+$/.test(digits))
    throw new Error(`wholeNumber: ${JSON.stringify(digits)} is not digits`);
  return new RegExp(`(?<![\\w-])${digits}(?![\\w-])`);
}

/**
 * The same value as another field of the same list element — the path after the first `*` is
 * read from that element (`'*.payload.eventId': sameAs('id')`: each envelope's event id is its
 * outbox row's id). The other field must be present and declared on its own.
 */
export function sameAs(path: string): MetadataMatcher {
  return {
    [MATCHER]: true,
    describe: `the same value as ${path}`,
    check(value, scope) {
      const other = valueAt(scope, path);
      if (other === undefined) return [`${path}, which it must equal, is absent`];
      return other === value
        ? []
        : [
            `expected the value of ${path} (${JSON.stringify(other)}), got ${JSON.stringify(value)}`,
          ];
    },
  };
}

/**
 * The request's correlation id: equal to the id the response carried in its
 * `x-correlation-id` header (or the id the test sent) and a well-formed ULID
 * or UUID — the identity and the shape, never the shape alone.
 */
export function correlationId(expected: string | undefined): MetadataMatcher {
  return {
    [MATCHER]: true,
    describe: 'the request’s correlation id',
    check(value) {
      if (expected === undefined) return ['the response carries no x-correlation-id header'];
      if (!WELL_FORMED_CORRELATION_ID.test(expected)) {
        return [`the expected correlation id ${JSON.stringify(expected)} is not a ULID or UUID`];
      }
      return value === expected
        ? []
        : [`expected the correlation id ${expected}, got ${JSON.stringify(value)}`];
    },
  };
}

/** When this module was loaded: once per test file in Jest, once per worker in Playwright. */
const LOADED_AT = Date.now();

/**
 * The window the calling test file has run in so far, five seconds wider on
 * either side for the database's clock: every instant it stamped or caused
 * lies inside. For `instantsBetween`.
 */
export function thisRun(): readonly [Date, Date] {
  return [new Date(LOADED_AT - 5_000), new Date(Date.now() + 5_000)];
}

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The metadata of the platform's error envelope (`AllExceptionsFilter`):
 * `correlationId` equal to the response's `x-correlation-id`, `timestamp` an
 * ISO instant, `traceId` equal to `x-trace-id` when the response has one, and
 * `path` exactly the request path when the caller names it (a path that holds
 * an id is a generated value; one that does not may stay in the content).
 *
 * `headers` is supertest's `response.headers` or Playwright's
 * `response.headers()`.
 */
export function errorEnvelope(options: {
  readonly headers: Headers;
  readonly path?: string;
  readonly correlationId?: string;
}): Record<string, MetadataExpectation> {
  const traceId = header(options.headers, 'x-trace-id');
  return {
    correlationId: correlationId(
      options.correlationId ?? header(options.headers, 'x-correlation-id'),
    ),
    timestamp: instant(),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
  };
}

export interface DisclosureOptions {
  /**
   * Exact paths into the haystack (`'correlationId'`, `'payload.eventId'`,
   * `'rows.0.createdAt'`; `*` stands for every element of an array, never for
   * an object key), each with the value it must hold. A path that is absent,
   * or holds anything else, fails the assertion; a verified value is removed
   * before the secrets are looked for. Its key stays, and so does every field
   * the caller did not name.
   */
  readonly metadata?: Readonly<Record<string, MetadataExpectation>>;
  /**
   * Generated identities the test holds — the ids it created or read back,
   * fixture ULIDs, instants it recorded. Removed wherever they occur, whole or
   * inside a string (`/v1/tenders/TND_…/bids`). Each must carry a generated
   * value: words and amounts are content and stay.
   */
  readonly known?: readonly (string | Date)[];
  /**
   * The window the test ran in. An instant (with `Z` or an offset) inside it,
   * anywhere in the haystack, is a clock reading of this run and is removed.
   * Read from the clock that stamps the values (the database's, for rows).
   */
  readonly instantsBetween?: readonly [InstantInput, InstantInput];
  /**
   * What the caller sent. Every secret must occur in it, so an assertion can
   * never pass because its sentinel was never there to leak; a secret that is
   * derived rather than sent (a rounded price) is listed in `derived`.
   */
  readonly input?: unknown;
  /** Secrets exempt from the `input` check, each with its reason in the test. */
  readonly derived?: readonly (string | RegExp)[];
}

/** Stands in for a removed value inside a string; no secret contains it. */
const REMOVED = '⁣';

/**
 * Asserts that none of `secrets` occurs in `haystack` — a response body, a
 * row, an event, a list of them, or a text — with every generated value
 * accounted for first:
 *
 * 1. each `metadata` path is checked against its expectation, then removed;
 * 2. each `known` identity and each instant inside `instantsBetween` is
 *    removed wherever it occurs;
 * 3. any generated value still left (a ULID, a UUID, an instant, a digest) is
 *    refused: it would let a secret occur by chance, so it must be declared;
 * 4. each secret is looked for in what remains, serialized as
 *    `JSON.stringify` does it (a bigint as its digits). A secret that is a
 *    whole identity (another tenant's id) is also looked for in the haystack
 *    as it was, metadata included: no declaration can hide it.
 *
 * Strings are found by substring, regular expressions by `test`, with their
 * flags, as `not.toContain` and `not.toMatch` find them.
 */
export function expectNotDisclosed(
  haystack: unknown,
  secrets: readonly (string | RegExp)[],
  options: DisclosureOptions = {},
): void {
  const problems: string[] = [];
  if (secrets.length === 0) problems.push('no secrets to look for');

  // Step 0: the assertion means something only if each secret was there to leak.
  if (options.input !== undefined) {
    const sent = typeof options.input === 'string' ? options.input : serialize(options.input);
    for (const secret of secrets) {
      if (options.derived?.includes(secret)) continue;
      if (!occurs(sent, secret)) problems.push(`the secret ${String(secret)} is not in the input`);
    }
  }

  // Step 4, first half: a whole-identity secret is never hidden by a declaration.
  const original = typeof haystack === 'string' ? haystack : serialize(haystack);
  for (const secret of secrets) {
    if (typeof secret === 'string' && holdsIdentity(secret) && original.includes(secret)) {
      problems.push(`discloses the identity ${secret}`);
    }
  }

  let content: unknown = typeof haystack === 'string' ? haystack : plain(haystack);

  // Step 1.
  const verified: Slot[] = [];
  const kept = new Set<string>();
  for (const [path, expected] of Object.entries(options.metadata ?? {})) {
    if (typeof content === 'string') {
      problems.push(`metadata ${path}: the haystack is a text, it has no paths`);
      continue;
    }
    const slots = resolve(content, path.split('.'));
    if (slots.length === 0) problems.push(`metadata ${path}: absent`);
    for (const slot of slots) {
      const value = slot.holder[slot.key];
      for (const problem of checkExpected(value, expected, slot.scope)) {
        problems.push(`metadata ${slot.path}: ${problem}`);
      }
      if (
        expected !== null &&
        typeof expected === 'object' &&
        MATCHER in expected &&
        expected.keep
      ) {
        kept.add(slot.path);
      } else {
        verified.push(slot);
      }
    }
  }
  // Removed only once every path is checked: a `sameAs` reads what another path declares.
  for (const slot of verified) slot.holder[slot.key] = null;

  // Step 2.
  const known = (options.known ?? []).map((value) =>
    value instanceof Date ? value.toISOString() : value,
  );
  for (const value of known) {
    if (generatedValuesIn(value).length === 0) {
      problems.push(`known ${JSON.stringify(value)} holds no generated value; content stays`);
    }
  }
  const removable = [...known].sort((a, b) => b.length - a.length);
  const [from, to] = options.instantsBetween?.map(epochOf) ?? [];
  const strip = (text: string): string => {
    let out = text;
    for (const value of removable) out = out.split(value).join(REMOVED);
    if (from !== undefined && to !== undefined) {
      out = out.replace(new RegExp(GENERATED_VALUE_SHAPES.instant.source, 'g'), (match) => {
        if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(match)) return match;
        const at = Date.parse(match);
        return at >= from && at <= to ? REMOVED : match;
      });
    }
    return out;
  };
  content = mapStrings(content, strip);

  // Step 3.
  walkStrings(content, '', (text, where) => {
    if (kept.has(where)) return;
    for (const value of generatedValuesIn(text)) {
      problems.push(
        `undeclared generated ${value.shape} ${JSON.stringify(value.value)} at ${where || '(root)'}: ` +
          'declare it (metadata, known or instantsBetween), so it can neither produce nor hide a secret',
      );
    }
  });

  // Step 4.
  const text = typeof content === 'string' ? content : serialize(content);
  for (const secret of secrets) {
    const at = indexOf(text, secret);
    if (at !== undefined) {
      problems.push(`discloses ${String(secret)}: …${text.slice(Math.max(0, at - 40), at + 60)}…`);
    }
  }

  if (problems.length > 0) {
    const error = new Error(`expectNotDisclosed:\n  - ${problems.join('\n  - ')}`);
    // The runner's code frame then points at the assertion in the test, not in here.
    Error.captureStackTrace(error, expectNotDisclosed);
    throw error;
  }
}

function occurs(text: string, secret: string | RegExp): boolean {
  return indexOf(text, secret) !== undefined;
}

function indexOf(text: string, secret: string | RegExp): number | undefined {
  if (typeof secret === 'string') {
    const at = text.indexOf(secret);
    return at === -1 ? undefined : at;
  }
  const match = new RegExp(secret.source, secret.flags.replace(/[gy]/g, '')).exec(text);
  return match === null ? undefined : match.index;
}

function checkExpected(value: unknown, expected: MetadataExpectation, scope?: unknown): string[] {
  if (expected !== null && typeof expected === 'object' && MATCHER in expected) {
    return expected.check(value, scope);
  }
  const actual = value instanceof Date ? value.toISOString() : value;
  return actual === expected
    ? []
    : [
        `expected ${JSON.stringify(serializable(expected))}, got ${JSON.stringify(serializable(actual))}`,
      ];
}

function serializable(value: unknown): unknown {
  return typeof value === 'bigint' ? `${value}n` : value;
}

/** `JSON.stringify`, with a bigint written as its digits — how the suites have always serialized. */
function serialize(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? ''
  );
}

/** A plain copy as JSON sees it: `toJSON` applied (a `Date` becomes its ISO text), bigint kept. */
function plain(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    return plain((value as { toJSON(): unknown }).toJSON());
  }
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : plain(item)));
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined && typeof item !== 'function') copy[key] = plain(item);
    }
    return copy;
  }
  return value;
}

interface Slot {
  readonly holder: Record<string, unknown>;
  readonly key: string;
  readonly path: string;
  readonly scope: unknown;
}

function resolve(
  value: unknown,
  segments: readonly string[],
  at = '',
  scope: unknown = value,
  starred = false,
): Slot[] {
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
  return keys.flatMap((key) => {
    const path = at ? `${at}.${key}` : key;
    // The first `*` binds the scope a `sameAs` reads from: that list element.
    const inner = segment === '*' && !starred ? holder[key] : scope;
    const bound = starred || segment === '*';
    return rest.length === 0
      ? [{ holder, key, path, scope }]
      : resolve(holder[key], rest, path, inner, bound);
  });
}

/** The value at `path` (dotted) inside `value`, or `undefined`. */
function valueAt(value: unknown, path: string): unknown {
  let at: unknown = value;
  for (const segment of path.split('.')) {
    if (
      at === null ||
      typeof at !== 'object' ||
      !Object.prototype.hasOwnProperty.call(at, segment)
    ) {
      return undefined;
    }
    at = (at as Record<string, unknown>)[segment];
  }
  return at;
}

/** `value` with every string — keys included — passed through `map`. */
function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[map(key)] = mapStrings(item, map);
    return copy;
  }
  return value;
}

function walkStrings(
  value: unknown,
  at: string,
  visit: (text: string, where: string) => void,
): void {
  if (typeof value === 'string') return visit(value, at);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, at ? `${at}.${index}` : String(index), visit));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const where = at ? `${at}.${key}` : key;
      visit(key, `${where} (key)`);
      walkStrings(item, where, visit);
    }
  }
}

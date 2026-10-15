import type {
  AttributeValue,
  Attributes,
  Context,
  Link,
  SpanKind,
  TimeInput,
} from '@opentelemetry/api';
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_URL_FULL,
  ATTR_URL_QUERY,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';
import type { Sampler, SamplingResult, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';

/**
 * Span attributes that carry a URL or request target, and so may carry its
 * query string.
 *
 * `url.full` is set by the http client and undici instrumentations (an
 * absolute URL) and by the NestJS instrumentation (the request's
 * `originalUrl`, a path with its query). `http.url` and `http.target` are the
 * pre-1.21 names; the installed instrumentations no longer emit them, but one
 * that still did would leak the same way.
 */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([ATTR_URL_FULL, 'http.url', 'http.target']);

/**
 * Attributes never recorded: `url.query`, which has no query-free form, and
 * the `User-Agent` header (`user_agent.original`, pre-1.21 `http.user_agent`)
 * — a caller's free text up to the 16 KiB header limit, with nothing in it a
 * trace needs (Codex on #261, r4 F1 and L1).
 */
const DROPPED_ATTRIBUTES: ReadonlySet<string> = new Set([
  ATTR_URL_QUERY,
  ATTR_USER_AGENT_ORIGINAL,
  'http.user_agent',
]);

/** What stands in for client data taken out of free text. */
export const REDACTED_TEXT = '[REDACTED]';

/**
 * The longest text {@link redactText} reads, in UTF-16 code units. A longer
 * one is cut to it first — an attribute can hold a request header up to
 * Node's 16 KiB header limit, read before any authentication — so what a text
 * costs is bounded however long it arrives (Codex on #261, r4 F1).
 */
export const REDACT_TEXT_MAX = 4096;

/** What follows a text cut to {@link REDACT_TEXT_MAX}. */
export const TRUNCATED_TEXT = '…[TRUNCATED]';

/** How V8's `JSON.parse` error closes the source it quotes. */
const JSON_SOURCE_END = ' is not valid JSON';

const QUOTE = 0x22; // "
const HASH = 0x23; // #
const AMPERSAND = 0x26; // &
const SLASH = 0x2f; // /
const COLON = 0x3a; // :
const EQUALS = 0x3d; // =
const QUESTION = 0x3f; // ?
const AT_SIGN = 0x40; // @

/**
 * A bearer or basic credential in free text, its token captured:
 * `@rasta/logging`'s `BEARER_TOKEN`, the rule log lines are held to. Anchored
 * on a literal word, and the token class shares nothing with `\s`: linear.
 */
const BEARER_TOKEN = /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]+=*)/gi;

/** A character a query without a path may follow: `cb?TOKEN`. One code point, no repetition. */
const QUERY_PRECEDER = /^[\p{L}\p{N}_.~%-]$/u;

/** Whether a UTF-16 code unit is whitespace: exactly the set `\s` matches. */
export function isWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Whether the code point that ends just before `at` may come before a path-less query. */
function followsQueryPreceder(text: string, at: number): boolean {
  const last = text.charCodeAt(at - 1);
  if (last < 0x80) {
    return (
      (last >= 0x30 && last <= 0x39) || // 0-9
      (last >= 0x41 && last <= 0x5a) || // A-Z
      (last >= 0x61 && last <= 0x7a) || // a-z
      last === 0x5f || // _
      last === 0x2e || // .
      last === 0x7e || // ~
      last === 0x25 || // %
      last === 0x2d // -
    );
  }
  // A code point past U+FFFF at `at - 2` is a surrogate pair ending at `at - 1`.
  const pair = at >= 2 ? (text.codePointAt(at - 2) ?? 0) : 0;
  const point = pair > 0xffff ? pair : last;
  return QUERY_PRECEDER.test(String.fromCodePoint(point));
}

/**
 * Where a query or fragment starts in the run of non-whitespace
 * `text[start, end)`, or -1: the first `?` or `#` with at least one character
 * after it in the run that
 * - has a `/` before it in the run, with no `?` or `#` between them — a URL
 *   (`scheme://…`) or a path (`/cb?…`, `/cb#…`); or, for a query without a
 *   path,
 * - is a `?` right after a letter, digit, `_`, `.`, `~`, `%` or `-`
 *   (`cb?TOKEN`); or
 * - is a `?` with an `=` or `&` after it in the run (`?code=…`) —
 *   `lastPairMark` is where the run's last one is.
 *
 * One pass: each character of the run is looked at once.
 */
function queryStart(text: string, start: number, end: number, lastPairMark: number): number {
  let afterSlash = false;
  for (let at = start; at < end - 1; at++) {
    const code = text.charCodeAt(at);
    if (code === SLASH) {
      afterSlash = true;
    } else if (code === QUESTION || code === HASH) {
      if (afterSlash) return at;
      if (
        code === QUESTION &&
        (lastPairMark > at || (at > start && followsQueryPreceder(text, at)))
      ) {
        return at;
      }
      afterSlash = false;
    }
  }
  return -1;
}

/**
 * A URL's query or fragment inside free text — an error message, a stack
 * trace — replaced from its first `?` or `#` to the next whitespace or the end
 * of the text, whatever lies between: `?[REDACTED]`, `#[REDACTED]`. Nothing
 * inside a query is trusted to end it — an apostrophe, a quote, a bracket, any
 * script (Codex on #261, r3 F1) — so redaction may take more than the query,
 * never less. Where one starts is {@link queryStart}'s rule. A `?` with
 * whitespace or the end right after it — a question, an SQL placeholder — is
 * left alone; a `?` glued to what follows it after a word (`ready?!`) is not,
 * and is redacted with it.
 *
 * A forward scan, run by run, with no regular expression that could backtrack:
 * linear in the text (Codex on #261, r4 F1). In a `cut` text the last run may
 * have lost its `=` or `&` to the cut, so any `?` in it counts as a query's.
 */
export function redactQueries(text: string, cut = false): string {
  return redactRanges(text, queryRanges(text, cut));
}

/**
 * Where {@link redactQueries} replaces: `[from, to)` pairs, in order, from
 * just after each query's `?` or `#` to the end of its run.
 */
function queryRanges(text: string, cut: boolean): number[] {
  const ranges: number[] = [];
  let at = 0;
  while (at < text.length) {
    if (isWhitespace(text.charCodeAt(at))) {
      at++;
      continue;
    }
    const start = at;
    let lastPairMark = -1;
    for (; at < text.length && !isWhitespace(text.charCodeAt(at)); at++) {
      const code = text.charCodeAt(at);
      if (code === EQUALS || code === AMPERSAND) lastPairMark = at;
    }
    if (cut && at === text.length) lastPairMark = at;
    const query = queryStart(text, start, at, lastPairMark);
    if (query !== -1) ranges.push(query + 1, at);
  }
  return ranges;
}

/**
 * Where a credential in a URL's user-info is: `[from, to)` pairs, in order.
 *
 * `@rasta/logging`'s `scrubMessage` takes the password out of
 * `scheme://user:password@` — what a driver's error says of the connection
 * string it could not open — by a pattern that needs the `@`. This is the
 * same rule as a scan, read from each `://` to the first `@`, `/` or
 * whitespace: if that is an `@` with a `:` before it, the password, from just
 * after the first `:` to the `@`, is a credential — with or without a user,
 * whatever the scheme.
 *
 * A cut can take that `@` away (Codex on #261, r5 F1), so in a `cut` text a
 * `://` whose user-info runs on to the cut — no `@`, `/` or whitespace after
 * it — fails closed: all of it, from just after the `://`, is taken.
 *
 * `indexOf` and one read of each character from a `://` to its end: each scan
 * stops at the next `/`, and so before the next `://`. Linear in the text.
 */
function credentialRanges(text: string, cut: boolean): number[] {
  const ranges: number[] = [];
  for (let scheme = text.indexOf('://'); scheme !== -1;) {
    const userInfo = scheme + 3;
    let colon = -1;
    let end = userInfo;
    for (; end < text.length; end++) {
      const code = text.charCodeAt(end);
      if (code === AT_SIGN || code === SLASH || isWhitespace(code)) break;
      if (code === COLON && colon === -1) colon = end;
    }
    if (end === text.length) {
      if (cut && end > userInfo) ranges.push(userInfo, end);
      break;
    }
    if (text.charCodeAt(end) === AT_SIGN && colon !== -1 && end > colon + 1) {
      ranges.push(colon + 1, end);
    }
    // A `/` that ends the scan may open the next `://`'s, from one before it.
    scheme = text.indexOf('://', end - 1);
  }
  return ranges;
}

/**
 * Where each bearer or basic token ({@link BEARER_TOKEN}) is: `[from, to)`
 * pairs, in order. A token the cut runs through is matched up to the cut.
 */
function bearerRanges(text: string): number[] {
  const ranges: number[] = [];
  for (const match of text.matchAll(BEARER_TOKEN)) {
    const to = match.index + match[0].length;
    ranges.push(to - match[1]!.length, to);
  }
  return ranges;
}

/** `text` with each `[from, to)` of `ranges` — in order, apart — replaced by {@link REDACTED_TEXT}. */
function redactRanges(text: string, ranges: readonly number[]): string {
  if (ranges.length === 0) return text;
  let redacted = '';
  let copied = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    redacted += `${text.slice(copied, ranges[i])}${REDACTED_TEXT}`;
    copied = ranges[i + 1]!;
  }
  return `${redacted}${text.slice(copied)}`;
}

/** Two lists of ranges, each in order, as one: in order, overlapping ones joined. */
function unionRanges(a: readonly number[], b: readonly number[]): number[] {
  const union: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    let from: number;
    let to: number;
    if (j >= b.length || (i < a.length && a[i]! <= b[j]!)) {
      from = a[i]!;
      to = a[i + 1]!;
      i += 2;
    } else {
      from = b[j]!;
      to = b[j + 1]!;
      j += 2;
    }
    const last = union.length - 1;
    if (last > 0 && from <= union[last]!) union[last] = Math.max(union[last]!, to);
    else union.push(from, to);
  }
  return union;
}

/**
 * Where the last `"` or `"...` + {@link JSON_SOURCE_END} with its quote after
 * `open` ends, or -1. Occurrences are looked at from the last back, each once.
 */
function jsonSourceEnd(text: string, open: number): number {
  let at = text.lastIndexOf(JSON_SOURCE_END);
  while (at > open) {
    const quote =
      at >= 4 && text.startsWith('"...', at - 4)
        ? at - 4
        : text.charCodeAt(at - 1) === QUOTE
          ? at - 1
          : -1;
    if (quote > open) return at + JSON_SOURCE_END.length;
    // Any earlier occurrence has its quote earlier still.
    if (quote !== -1) return -1;
    at = text.lastIndexOf(JSON_SOURCE_END, at - 1);
  }
  return -1;
}

/**
 * V8's `JSON.parse` error quotes the source it could not read — `Unexpected
 * token 'c', "<body>" is not valid JSON`, or `..."<body>"...` when long — and
 * on an HTTP request that source is the client's body, line terminators and
 * all (`code=x\nrest` is quoted over two lines). So the quote runs from the
 * first `"` in the text (and a `...` right before it) to the last `"` or
 * `"...` + ` is not valid JSON` after it, across any line break, and a body
 * that itself contains the phrase is still taken whole; it becomes
 * `"[REDACTED]" is not valid JSON`.
 *
 * In a `cut` text that closing phrase — or a later one the quote would run to
 * — may be past the cut, so everything from the first `"` is taken:
 * `"[REDACTED]`.
 *
 * `indexOf` and `lastIndexOf` only: linear in the text (Codex on #261, r4 F1).
 */
export function redactJsonSource(text: string, cut = false): string {
  const source = jsonSource(text, cut);
  return source ? `${text.slice(0, source.from)}${source.by}${text.slice(source.to)}` : text;
}

/** What {@link redactJsonSource} replaces, `[from, to)`, and by what. */
function jsonSource(
  text: string,
  cut: boolean,
): { from: number; to: number; by: string } | undefined {
  const open = text.indexOf('"');
  if (open === -1) return undefined;
  const from = open >= 3 && text.startsWith('...', open - 3) ? open - 3 : open;
  if (cut) return { from, to: text.length, by: `"${REDACTED_TEXT}` };
  const to = jsonSourceEnd(text, open);
  return to === -1 ? undefined : { from, to, by: `"${REDACTED_TEXT}"${JSON_SOURCE_END}` };
}

/** The URL, or path, without its query string and fragment. */
export function urlWithoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Every rule {@link redactText} holds a text to, on the whole of it — no cap;
 * `cut` says the text was cut, so each rule fails closed at its end.
 *
 * The quoted JSON source goes first ({@link redactJsonSource}), then each
 * query or fragment in what is left ({@link redactQueries}) — round 4's rules,
 * in round 4's order. The credentials `@rasta/logging` scrubs from a log line
 * — a password in a URL's user-info ({@link credentialRanges}), a bearer or
 * basic token ({@link bearerRanges}) — are found in the text as it came,
 * before either rule could take away what marks them (the `@`, the word
 * `Bearer`), and are replaced where they now stand together with the
 * queries: what any rule takes is taken (Codex on #261, r5 F1).
 */
export function redactAll(text: string, cut = false): string {
  const source = jsonSource(text, cut);
  let credentials = unionRanges(credentialRanges(text, cut), bearerRanges(text));
  let rest = text;
  if (source) {
    rest = `${text.slice(0, source.from)}${source.by}${text.slice(source.to)}`;
    // Where the credentials stand now: before the source as they were, after it
    // moved by what its replacement adds; anything inside it is gone already.
    const moved = source.by.length - (source.to - source.from);
    const outside: number[] = [];
    for (let i = 0; i < credentials.length; i += 2) {
      const from = credentials[i]!;
      const to = credentials[i + 1]!;
      if (from < source.from) outside.push(from, Math.min(to, source.from));
      if (to > source.to) outside.push(Math.max(from, source.to) + moved, to + moved);
    }
    credentials = outside;
  }
  return redactRanges(rest, unionRanges(credentials, queryRanges(rest, cut)));
}

/**
 * A text cut to {@link REDACT_TEXT_MAX} — never between the halves of a
 * surrogate pair — and whether it was.
 */
function capped(text: string): { kept: string; cut: boolean } {
  if (text.length <= REDACT_TEXT_MAX) return { kept: text, cut: false };
  const last = text.charCodeAt(REDACT_TEXT_MAX - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? REDACT_TEXT_MAX - 1 : REDACT_TEXT_MAX;
  return { kept: text.slice(0, end), cut: true };
}

/**
 * Free text with any quoted JSON source ({@link redactJsonSource}), any URL
 * query or fragment after its `?` or `#` ({@link redactQueries}), any password
 * in a URL's user-info, and any bearer or basic credential replaced by
 * {@link REDACTED_TEXT} ({@link redactAll}).
 *
 * A text longer than {@link REDACT_TEXT_MAX} is cut to it first — never
 * between the halves of a surrogate pair — the rules fail closed at the cut,
 * and it ends in {@link TRUNCATED_TEXT}. Each rule is one pass, so a text
 * costs time linear in at most {@link REDACT_TEXT_MAX} characters read. What
 * is written is bounded too, but larger: a replacement can be longer than
 * what it replaces (`?=` becomes `?[REDACTED]`).
 */
export function redactText(text: string): string {
  const { kept, cut } = capped(text);
  return cut ? `${redactAll(kept, true)}${TRUNCATED_TEXT}` : redactAll(kept);
}

/**
 * A URL attribute as it may be exported: cut to {@link REDACT_TEXT_MAX} like
 * any text (Codex on #261, r5 F3), the password in its user-info replaced —
 * failing closed at a cut, as {@link redactAll} does — and then without its
 * query and fragment.
 */
function redactUrl(url: string): string {
  const { kept, cut } = capped(url);
  const credentialFree = redactRanges(kept, credentialRanges(kept, cut));
  const bare = urlWithoutQuery(credentialFree);
  return cut && bare.length === credentialFree.length ? `${bare}${TRUNCATED_TEXT}` : bare;
}

/**
 * The frames of a stack trace: what follows the line, or lines, that end with
 * the error's own `message` — `Name: message` — when they open the stack, and
 * the rest reads `    at …` and holds no `"`. Otherwise undefined.
 *
 * Read on their own, frames lose nothing to the message: with no `"` after
 * it, no quoted source runs from the message into them, and every other rule
 * stops at whitespace — so a message too long, or too quoted, to keep no
 * longer costs the frames (r5 L1). Where the stack is anything else, it is
 * read whole.
 */
export function stackFrames(stack: string, message: string): string | undefined {
  let end: number;
  if (message === '') {
    end = stack.indexOf('\n');
  } else {
    const at = stack.indexOf(message);
    end = at === -1 || stack.lastIndexOf('\n', at - 1) !== -1 ? -1 : at + message.length;
  }
  if (end === -1 || stack.charCodeAt(end) !== 0x0a) return undefined;
  const frames = stack.slice(end + 1);
  return /^\s+at /.test(frames) && !frames.includes('"') ? frames : undefined;
}

/**
 * An exception's stack trace as it may be exported: its frames
 * ({@link stackFrames}) and the lines above them each through
 * {@link redactText}, each under its own cap — or, where the frames cannot be
 * told apart, the whole of it.
 */
export function redactStackTrace(stack: string, message: string): string {
  const frames = stackFrames(stack, message);
  if (frames === undefined) return redactText(stack);
  const header = stack.slice(0, stack.length - frames.length - 1);
  return `${redactText(header)}\n${redactText(frames)}`;
}

function redactValue(value: AttributeValue | undefined): AttributeValue | undefined {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    // An attribute array is homogeneous, and redaction keeps every element's type.
    return value.map((item) =>
      typeof item === 'string' ? redactText(item) : item,
    ) as AttributeValue;
  }
  return value;
}

/**
 * An attribute as it may be exported: a URL attribute loses its query and
 * fragment ({@link redactUrl}), `url.query` and the user agent go — undefined,
 * see {@link DROPPED_ATTRIBUTES} — and every other string is passed through
 * {@link redactText}.
 */
function redactAttribute(
  key: string,
  value: AttributeValue | undefined,
): AttributeValue | undefined {
  if (DROPPED_ATTRIBUTES.has(key)) return undefined;
  if (URL_ATTRIBUTES.has(key) && typeof value === 'string') return redactUrl(value);
  return redactValue(value);
}

/** Rewrites an attribute record in place by {@link redactAttribute}. */
function redactAttributes(attributes: Attributes | undefined): void {
  if (!attributes) return;
  for (const [key, value] of Object.entries(attributes)) {
    const redacted = redactAttribute(key, value);
    if (redacted === undefined) delete attributes[key];
    else attributes[key] = redacted;
  }
}

/**
 * A copy of an attribute record, redacted by {@link redactAttribute} — but an
 * exception's stack trace beside its message, as `recordException` writes
 * them, by {@link redactStackTrace}.
 */
function redactedAttributes(attributes: Attributes): Attributes {
  const copy: Attributes = {};
  const message = attributes[ATTR_EXCEPTION_MESSAGE];
  for (const [key, value] of Object.entries(attributes)) {
    const redacted =
      key === ATTR_EXCEPTION_STACKTRACE && typeof value === 'string' && typeof message === 'string'
        ? redactStackTrace(value, message)
        : redactAttribute(key, value);
    if (redacted !== undefined) copy[key] = redacted;
  }
  return copy;
}

/**
 * Whether `addEvent`'s second argument is the event's attributes rather than
 * its time (a number, a `Date` or an `[seconds, nanos]` pair).
 */
function isAttributes(value: Attributes | TimeInput | undefined): value is Attributes {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Keeps client data that arrives in a URL out of every exported span (S-09,
 * docs/06 § 6.7).
 *
 * A query is client data — a list cursor, a search term, a token in a callback
 * URL — and the trace backend is not a place it may reach. The instrumentations
 * record it on both sides: `url.query` on incoming requests and undici fetches,
 * the query inside `url.full` on outgoing requests and NestJS handler spans.
 * And they record it again in what they say about a failure: an exception
 * event's `exception.message` and `exception.stacktrace`, and the span's status
 * message, repeat whatever the error said — Express's JSON parser, for one,
 * quotes the body it refused.
 *
 * So every string the span carries is sanitized: its attributes, each event's
 * and each link's attributes, and the status message. Span names, event names,
 * `url.path` and `http.route` (the route template) are left as they are; none
 * of them carries the query.
 *
 * Each value is sanitized as it is written, whole: the SDK cuts a value to
 * `attributeValueLengthLimit` as it stores it, and a cut can remove exactly
 * what marks the client data — the closing `" is not valid JSON` of a parser
 * error — so sanitizing the stored span would come too late (Codex on #261, r2
 * F1). `onStart` puts the redaction in front of the span's own writers;
 * `recordException` writes through `addEvent`, `setAttributes` through
 * `setAttribute`, `addLinks` through `addLink`, so these four and `setStatus`
 * are every way in after the start. The attributes and links the span is
 * started with are stored — and cut — before `onStart`, so they are not this
 * processor's: {@link RedactingSampler} sanitizes them first. Every exporting
 * processor runs after this one and sees only the result.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const setAttribute = span.setAttribute.bind(span);
    const addEvent = span.addEvent.bind(span);
    const addLink = span.addLink.bind(span);
    const setStatus = span.setStatus.bind(span);
    span.setAttribute = (key, value) => {
      const redacted = redactAttribute(key, value);
      return redacted === undefined ? span : setAttribute(key, redacted);
    };
    span.addEvent = (name, attributesOrTime, time) =>
      addEvent(
        name,
        isAttributes(attributesOrTime) ? redactedAttributes(attributesOrTime) : attributesOrTime,
        time,
      );
    span.addLink = (link) =>
      addLink(
        link.attributes ? { ...link, attributes: redactedAttributes(link.attributes) } : link,
      );
    span.setStatus = (status) =>
      setStatus(
        typeof status.message === 'string'
          ? { ...status, message: redactText(status.message) }
          : status,
      );
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Sanitizes the attributes and links a span is started with, by the rules
 * {@link RedactingSpanProcessor} holds later writes to, before the SDK stores
 * — and cuts — them (Codex on #261, r3 F2).
 *
 * The instrumentations put request data in a span's start attributes: the
 * http server span's `user_agent.original` and `url.query` (dropped),
 * `server.address` (`Host`, `Forwarded`, `X-Forwarded-Host`),
 * `client.address` (`Forwarded`, `X-Forwarded-For`) and `url.path` (each
 * through {@link redactText}, under its {@link REDACT_TEXT_MAX} cap); the
 * NestJS handler span's `url.full`. This runs for every span, sampled or not,
 * before any authentication, so each rule is linear and each text bounded
 * (Codex on #261, r4 F1).
 *
 * The SDK's tracer cuts those to `attributeValueLengthLimit` as it builds the
 * span, before any span processor sees it — too late to tell a parser error
 * from its cut — but asks the sampler first. It hands the sampler its own
 * copy of the attributes and of each link's, and builds the span from those
 * copies, the sampler's changes included (`@opentelemetry/sdk-trace`
 * `Tracer.startSpan`); a span that is not sampled is not built. So every
 * value here is sanitized whole, in place, and only then cut. The decision
 * itself is the delegate's.
 */
export class RedactingSampler implements Sampler {
  constructor(private readonly delegate: Sampler) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    redactAttributes(attributes);
    for (const link of links) redactAttributes(link.attributes);
    const result = this.delegate.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links,
    );
    // What a delegate adds is merged into the start attributes, so it is held to the same rules.
    return result.attributes
      ? { ...result, attributes: redactedAttributes(result.attributes) }
      : result;
  }

  toString(): string {
    return `RedactingSampler{${this.delegate.toString()}}`;
  }
}

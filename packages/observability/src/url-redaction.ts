import type {
  AttributeValue,
  Attributes,
  Context,
  Link,
  SpanKind,
  TimeInput,
} from '@opentelemetry/api';
import { ATTR_URL_FULL, ATTR_URL_QUERY } from '@opentelemetry/semantic-conventions';
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

/** What stands in for client data taken out of free text. */
export const REDACTED_TEXT = '[REDACTED]';

/**
 * A URL's query or fragment inside free text — an error message, a stack
 * trace: from its first `?` or `#` to the next whitespace or the end of the
 * text, whatever lies between. Nothing inside a query is trusted to end it — an
 * apostrophe, a quote, a bracket, any script (Codex on #261, r3 F1) — so
 * redaction may take more than the query, never less.
 *
 * It starts at a `?` or `#` that has a `/` before it in the same run of
 * non-whitespace — a URL (`scheme://…`) or a path (`/cb?…`, `/cb#…`); and, for a
 * query without a path, at a `?` right after a letter, digit, `_`, `.`, `~`,
 * `%` or `-` (`cb?TOKEN`), or one whose run holds `=` or `&` (`?code=…`). A `?`
 * with whitespace or the end right after it — a question, an SQL placeholder —
 * is left alone; a `?` glued to what follows it after a word (`ready?!`) is
 * not, and is redacted with it.
 */
const QUERY_IN_TEXT = /(?<=\/[^\s?#]*)[?#]\S+|(?<=[\p{L}\p{N}_.~%-])\?\S+|\?(?=\S*[=&])\S+/gu;

/**
 * V8's `JSON.parse` error quotes the source it could not read — `Unexpected
 * token 'c', "<body>" is not valid JSON`, or `..."<body>"...` when long — and
 * on an HTTP request that source is the client's body, line terminators and
 * all (`code=x\nrest` is quoted over two lines). So the quote runs from the
 * first `"` to the last ` is not valid JSON` in the text, across any line
 * break, and a body that itself contains the phrase is still taken whole.
 */
const JSON_SOURCE_IN_TEXT = /(?:\.\.\.)?"[\s\S]*"(?:\.\.\.)? is not valid JSON/g;

/** The URL, or path, without its query string and fragment. */
export function urlWithoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Free text with any quoted JSON source, and any URL query or fragment after
 * its `?` or `#`, replaced by {@link REDACTED_TEXT}.
 */
export function redactText(text: string): string {
  return text
    .replace(JSON_SOURCE_IN_TEXT, `"${REDACTED_TEXT}" is not valid JSON`)
    .replace(QUERY_IN_TEXT, (suffix) => `${suffix.charAt(0)}${REDACTED_TEXT}`);
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
 * fragment, `url.query` goes — undefined, as there is no query-free form of a
 * query — and every other string is passed through {@link redactText}.
 */
function redactAttribute(
  key: string,
  value: AttributeValue | undefined,
): AttributeValue | undefined {
  if (key === ATTR_URL_QUERY) return undefined;
  if (URL_ATTRIBUTES.has(key) && typeof value === 'string') return urlWithoutQuery(value);
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

/** A copy of an attribute record, redacted by {@link redactAttribute}. */
function redactedAttributes(attributes: Attributes): Attributes {
  const copy: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const redacted = redactAttribute(key, value);
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
 * http server span's `user_agent.original`, `server.address` (`Host`,
 * `Forwarded`, `X-Forwarded-Host`), `client.address` (`Forwarded`,
 * `X-Forwarded-For`), `url.path` and `url.query`; the NestJS handler span's
 * `url.full`. The SDK's tracer cuts those to `attributeValueLengthLimit` as
 * it builds the span, before any span processor sees it — too late to tell a
 * parser error from its cut — but asks the sampler first. It hands the
 * sampler its own copy of the attributes and of each link's, and builds the
 * span from those copies, the sampler's changes included
 * (`@opentelemetry/sdk-trace` `Tracer.startSpan`); a span that is not
 * sampled is not built. So every value here is sanitized whole, in place,
 * and only then cut. The decision itself is the delegate's.
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

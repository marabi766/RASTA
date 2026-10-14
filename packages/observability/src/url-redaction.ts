import type { AttributeValue, Attributes } from '@opentelemetry/api';
import { ATTR_URL_FULL, ATTR_URL_QUERY } from '@opentelemetry/semantic-conventions';
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';

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
 * A query inside free text — an error message, a stack trace: `?` and the run
 * after it up to whitespace, a quote or an angle bracket, when that run holds
 * `=` or `&` (`?code=…`) or the `?` closes a path segment (`/cb?TOKEN`). A
 * lone `?` ending a sentence, or one between SQL placeholders, is not a query.
 */
const QUERY_IN_TEXT = /\?(?:[^\s"'`<>]*[=&][^\s"'`<>]*|(?<=[\w/.~%-]\?)[^\s"'`<>]+)/g;

/**
 * V8's `JSON.parse` error quotes the source it could not read — `Unexpected
 * token 'c', "<body>" is not valid JSON`, or `..."<body>"...` when long — and
 * on an HTTP request that source is the client's body. Greedy to the last
 * occurrence on the line, so a body that itself contains the phrase is still
 * taken whole. The exception filter keeps the same text out of the log.
 */
const JSON_SOURCE_IN_TEXT = /(?:\.\.\.)?"[^\n]*"(?:\.\.\.)? is not valid JSON/g;

/** The URL, or path, without its query string and fragment. */
export function urlWithoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** Free text with any URL query and any quoted JSON source replaced by {@link REDACTED_TEXT}. */
export function redactText(text: string): string {
  return text
    .replace(JSON_SOURCE_IN_TEXT, `"${REDACTED_TEXT}" is not valid JSON`)
    .replace(QUERY_IN_TEXT, `?${REDACTED_TEXT}`);
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
 * Rewrites an attribute record in place: a URL attribute loses its query and
 * fragment, `url.query` goes (there is no query-free form of a query), every
 * other string is passed through {@link redactText}.
 */
function redactAttributes(attributes: Attributes | undefined): void {
  if (!attributes) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (key === ATTR_URL_QUERY) {
      delete attributes[key];
    } else if (URL_ATTRIBUTES.has(key) && typeof value === 'string') {
      attributes[key] = urlWithoutQuery(value);
    } else {
      attributes[key] = redactValue(value);
    }
  }
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
 * and each link's attributes, and the status message. The rewrite happens in
 * `onEnding`, while the span is still writable and after every instrumentation
 * has set its attributes and recorded its exceptions, so one place covers
 * incoming and outgoing requests alike, and every exporting processor sees only
 * the result. Span names, event names, `url.path` and `http.route` (the route
 * template) are left as they are; none of them carries the query.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
    redactAttributes(span.attributes);
    for (const event of span.events) redactAttributes(event.attributes);
    for (const link of span.links) redactAttributes(link.attributes);
    // Only an ERROR status carries a message, and an ERROR status may still be
    // replaced; there is no other way to write it.
    const { code, message } = span.status;
    if (message !== undefined) span.setStatus({ code, message: redactText(message) });
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

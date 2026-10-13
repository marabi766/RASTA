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
const URL_ATTRIBUTES = [ATTR_URL_FULL, 'http.url', 'http.target'] as const;

/** The URL, or path, without its query string and fragment. */
export function urlWithoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Keeps the URL query out of every exported span (S-09, docs/06 § 6.7).
 *
 * A query is client data — a list cursor, a search term, a token in a callback
 * URL — and the trace backend is not a place it may reach. The instrumentations
 * record it on both sides: `url.query` on incoming requests and undici fetches,
 * the query inside `url.full` on outgoing requests and NestJS handler spans.
 *
 * The rewrite happens in `onEnding`, while the span is still writable and after
 * every instrumentation has set its attributes, so one place covers incoming
 * and outgoing requests alike. Span names, `url.path` and `http.route` (the
 * route template) are left as they are; none of them carries the query.
 */
export class UrlQueryRedactingSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
    for (const key of URL_ATTRIBUTES) {
      const value = span.attributes[key];
      if (typeof value === 'string') span.setAttribute(key, urlWithoutQuery(value));
    }
    // There is no API to remove an attribute and no query-free form of a
    // query, so the key is dropped from the span's own attribute record.
    delete span.attributes[ATTR_URL_QUERY];
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

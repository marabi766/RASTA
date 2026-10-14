import { scrubMessage } from '@rasta/logging';
import { redactText } from '@rasta/observability';

/** The longest free-text message a log line repeats, in characters. */
export const LOG_TEXT_MAX = 200;

/**
 * Text this service did not write — an error's message — made fit for a log
 * line (S-09): credentials in a connection string or a bearer token scrubbed
 * (`scrubMessage`), a URL's query and the source a JSON parser quotes replaced
 * by `[REDACTED]` (`redactText`, the rule spans are held to — an OAuth
 * library's error names its callback URL, `?code=…` and all), control
 * characters, line and paragraph separators and bidirectional overrides
 * replaced by a space so it cannot forge a second line or disguise itself, and
 * cut to `max` characters (code points, so a surrogate pair is never split)
 * with an ellipsis. Persian passes through.
 *
 * Redacted before it is flattened or cut, so a quoted source that runs over
 * several lines, or past `max`, is still recognised whole.
 *
 * It cannot tell a value from an identifier, so it bounds what a leak can be;
 * keeping values out of messages stays the author's job.
 */
export function safeLogText(text: string, max = LOG_TEXT_MAX): string {
  const flat = scrubMessage(redactText(text))
    .replace(/[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

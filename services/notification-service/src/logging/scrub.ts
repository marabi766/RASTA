/**
 * Address redaction for this service's own log lines (ADR-054 § 10, R-5).
 *
 * `email` is **not** in the platform's `SENSITIVE_KEYS` — only `personalEmail`
 * is — so the shared pino redactor does not cover a recipient address that
 * reaches a log line as free text. Adding `email` to the shared list is a
 * `packages/` change that touches every service and is not made unilaterally
 * here; this is the service-local control the ADR asks for instead, and
 * `log-scrub.spec.ts` is the test it asks for.
 *
 * Applied to every message this service composes before it reaches the
 * logger. It does not need to be perfect — nothing here intentionally logs an
 * address, the identity adapter never even retains one — it needs to make an
 * *accidental* one unrecoverable.
 */

/** Anything shaped like `local@domain.tld`, greedy on the local part. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const REDACTED_ADDRESS = '[address]';

export function scrubAddresses(message: string): string {
  return message.replace(EMAIL_PATTERN, REDACTED_ADDRESS);
}

/** A minimal logger surface, so scrubbing wraps any `@rasta/logging` logger. */
export interface ScrubbedLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export function withAddressScrubbing(logger: {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}): ScrubbedLogger {
  return {
    info: (message) => logger.info(scrubAddresses(message)),
    warn: (message) => logger.warn(scrubAddresses(message)),
    error: (message) => logger.error(scrubAddresses(message)),
    debug: (message) => logger.debug?.(scrubAddresses(message)),
  };
}

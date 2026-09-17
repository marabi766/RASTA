/**
 * Injection tokens.
 *
 * In their own file rather than in `app.module.ts`, because a provider that
 * injects the configuration would otherwise import the module that declares it
 * — a cycle that resolves to `undefined` at runtime rather than failing at
 * compile time.
 */

export const ENV = Symbol('NOTIFICATION_ENV');
export const LOGGER = Symbol('NOTIFICATION_LOGGER');
/** The address-scrubbing logger every domain component writes through (ADR-054 § 10, R-5). */
export const SCRUBBED_LOGGER = Symbol('NOTIFICATION_SCRUBBED_LOGGER');

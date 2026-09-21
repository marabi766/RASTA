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
/**
 * The mail channel behind its port (ADR-054 § 6, `docs/24` Q-37).
 *
 * A token rather than the concrete class, because which adapter is bound is
 * the decision Q-37 will make, and no caller should have to be edited when it
 * does.
 */
export const MAIL_CHANNEL = Symbol('NOTIFICATION_MAIL_CHANNEL');

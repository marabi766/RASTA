/**
 * Injection tokens.
 *
 * In their own file rather than in `app.module.ts`, because a provider that
 * injects the configuration would otherwise import the module that declares it
 * — a cycle that resolves to `undefined` at runtime rather than failing at
 * compile time.
 */

export const ENV = Symbol('AUDIT_ENV');
export const LOGGER = Symbol('AUDIT_LOGGER');

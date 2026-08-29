/**
 * Injection tokens.
 *
 * In their own file rather than in `app.module.ts`, because a controller that
 * injects the configuration would otherwise have to import the module that
 * declares the controller — a cycle that resolves to `undefined` at runtime
 * rather than failing at compile time.
 */

export const ENV = Symbol('MARKETPLACE_ENV');
export const LOGGER = Symbol('MARKETPLACE_LOGGER');

/**
 * Injection tokens.
 *
 * Kept in their own module so app.module and the controllers can share them
 * without importing each other, which would be a circular dependency.
 */
export const GATEWAY_ENV = Symbol('GATEWAY_ENV');
export const GATEWAY_LOGGER = Symbol('GATEWAY_LOGGER');

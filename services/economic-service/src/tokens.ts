/**
 * Injection tokens.
 *
 * In their own file rather than in `app.module.ts`, because a controller that
 * injects the configuration would otherwise have to import the module that
 * declares the controller — a cycle that resolves to `undefined` at runtime
 * rather than failing at compile time.
 */

export const ENV = Symbol('ECONOMIC_ENV');
export const LOGGER = Symbol('ECONOMIC_LOGGER');

/**
 * The payment provider in use.
 *
 * A token rather than a concrete class, because ADR-024 requires the domain to
 * know only the interface. Swapping `MockPaymentProvider` for a real one is a
 * change to one `useClass` in `app.module.ts`.
 */
export const PAYMENT_PROVIDER = Symbol('ECONOMIC_PAYMENT_PROVIDER');

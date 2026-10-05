/**
 * Injection tokens.
 *
 * In their own file rather than in `app.module.ts`, because a controller that
 * injects the configuration would otherwise have to import the module that
 * declares the controller — a cycle that resolves to `undefined` at runtime
 * rather than failing at compile time.
 */

export const ENV = Symbol('CONTRACT_ENV');
export const LOGGER = Symbol('CONTRACT_LOGGER');

/**
 * Where an award is read from (`AwardSource`, ADR-068 § 3): construction-service in
 * production, a stand-in in tests. Fails closed: it answers the award, "no such award",
 * or throws UPSTREAM_UNAVAILABLE — never a guessed amount.
 */
export const AWARD_SOURCE = Symbol('CONTRACT_AWARD_SOURCE');

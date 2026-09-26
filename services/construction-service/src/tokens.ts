/**
 * Injection tokens.
 *
 * In their own file rather than in `app.module.ts`, because a controller that
 * injects the configuration would otherwise have to import the module that
 * declares the controller — a cycle that resolves to `undefined` at runtime
 * rather than failing at compile time.
 *
 * Only two: CON-001 PR 1 has no boundary to another service. It calls no REST
 * API and consumes no event (ADR-063).
 */

export const ENV = Symbol('CONSTRUCTION_ENV');
export const LOGGER = Symbol('CONSTRUCTION_LOGGER');

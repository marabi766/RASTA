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

/**
 * Where a tender's private key is kept (`TenderKeyProvider`, ADR-066 § 2): an
 * interface with one implementation today, so the seam is a token, not a class.
 */
export const TENDER_KEY_PROVIDER = Symbol('CONSTRUCTION_TENDER_KEY_PROVIDER');

/**
 * Where the contractor-standing snapshot is read from (`StandingSnapshotSource`):
 * supplier-service in production, a page list in tests.
 */
export const STANDING_SNAPSHOT_SOURCE = Symbol('CONSTRUCTION_STANDING_SNAPSHOT_SOURCE');

/** Where one contractor's current standing is asked (`StandingOfSource`), authoritatively. */
export const STANDING_OF_SOURCE = Symbol('CONSTRUCTION_STANDING_OF_SOURCE');

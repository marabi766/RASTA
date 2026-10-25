/**
 * Injection tokens.
 *
 * In their own file rather than in `app.module.ts`, because a controller that
 * injects the configuration would otherwise have to import the module that
 * declares the controller — a cycle that resolves to `undefined` at runtime
 * rather than failing at compile time.
 */

export const ENV = Symbol('PROCUREMENT_ENV');
export const LOGGER = Symbol('PROCUREMENT_LOGGER');
/** Where an invitee's standing is read (`SupplierStandingSource`; supplier-service in production). */
export const SUPPLIER_STANDING = Symbol('PROCUREMENT_SUPPLIER_STANDING');
/** What wraps an RFQ's private sealing key (`RfqKeyProvider`; the environment's KEKs in the MVP). */
export const RFQ_KEY_PROVIDER = Symbol('PROCUREMENT_RFQ_KEY_PROVIDER');

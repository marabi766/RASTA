/**
 * Injection tokens.
 *
 * In their own file rather than in `app.module.ts`, because a controller that
 * injects the configuration would otherwise have to import the module that
 * declares the controller — a cycle that resolves to `undefined` at runtime
 * rather than failing at compile time.
 *
 * There are only two, and the absence of a third is worth noting: this service
 * has no boundary to an external system in Phase 1. It does not call
 * document-service, it does not call maintenance-service, and it consumes no
 * events. When the document-service metadata boundary is opened, a
 * `DOCUMENT_METADATA` port belongs here — as a symbol with a named
 * implementation, the way `WorkshopDirectory` names the seam on the other side
 * of this same gap (ADR-029).
 */

export const ENV = Symbol('SUPPLIER_ENV');
export const LOGGER = Symbol('SUPPLIER_LOGGER');

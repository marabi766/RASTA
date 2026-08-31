/**
 * Injection tokens.
 *
 * In their own file rather than in `app.module.ts`, because a controller that
 * injects the configuration would otherwise have to import the module that
 * declares the controller — a cycle that resolves to `undefined` at runtime
 * rather than failing at compile time.
 *
 * `OBJECT_STORAGE` and `MALWARE_SCANNER` are symbols rather than classes on
 * purpose: both name a boundary to something outside this process, and ADR-014
 * and Q-18 each turn on being able to replace the implementation without the
 * domain noticing.
 */

export const ENV = Symbol('DOCUMENT_ENV');
export const LOGGER = Symbol('DOCUMENT_LOGGER');
export const OBJECT_STORAGE = Symbol('DOCUMENT_OBJECT_STORAGE');
export const MALWARE_SCANNER = Symbol('DOCUMENT_MALWARE_SCANNER');

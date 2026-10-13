/**
 * The authorization and idempotency rules every route of this service shares, written once so
 * the OpenAPI description of each route says the same thing (`docs/api/inventory-service.openapi.json`).
 */

export const READ_NOTE =
  'Closed by default (S-02). Read by the organization that owns the warehouse — a role of ' +
  'INVENTORY_READER_ROLES or INVENTORY_OPERATOR_ROLES (both ORGANIZATION_ADMIN by default, ' +
  'Q-103) held in the organization the request acts for. Anything of another organization, and ' +
  'anything that does not exist, is 404, never 403 (S-03). AUDITOR, SYSTEM_ADMIN and service ' +
  'tokens are refused (403).';

export const COMMAND_NOTE =
  'Requires an `Idempotency-Key` (docs/06 § 6.8): without one, or with one outside 8 to 255 ' +
  'characters, 400 VALIDATION_FAILED and nothing is done. The same key with the same body from ' +
  'the same user answers the original response and does nothing again; the same key with ' +
  'another body or user is 409 IDEMPOTENCY_KEY_REUSED; a duplicate that arrives while the first ' +
  'is still being processed waits for its answer and past a few seconds is 409 CONFLICT with ' +
  'Retry-After. The caller must be a signed-in person with a platform user id and a role of ' +
  'INVENTORY_OPERATOR_ROLES (ORGANIZATION_ADMIN by default, Q-103) in the organization the ' +
  'request acts for; AUDITOR, SYSTEM_ADMIN and service tokens are refused (403). Anything of ' +
  'another organization is 404, never 403. Refusals carry their closed reason in ' +
  '`details[].code` (docs/06 § 6.7).';

export const STOCK_COMMAND_NOTE =
  'One transaction (ADR-056 § 3): the stock items the command touches are locked in ascending ' +
  'id order, reservations of theirs past `expiresAt` are released first, then the balance, its ' +
  'append-only movement and the event commit together — or nothing does. A stock item another ' +
  'command holds longer than INVENTORY_LOCK_TIMEOUT_MS is 409 CONFLICT with Retry-After; ' +
  'retry with the same key.';

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

export const SHIPMENT_READ_NOTE =
  'Closed by default (S-02). Read by the two organizations of a shipment (ADR-056 § 5): the ' +
  'owner of its origin warehouse — a role of INVENTORY_READER_ROLES or INVENTORY_OPERATOR_ROLES ' +
  '(Q-103) — and its consignee — a role of INVENTORY_CONSIGNEE_READER_ROLES (Q-113); all three ' +
  'ORGANIZATION_ADMIN by default, held in the organization the request acts for. Any other ' +
  'organization, or a side the caller’s roles do not open, gets 404, never 403 (S-03). No user ' +
  'id is shown. AUDITOR, SYSTEM_ADMIN and service tokens are refused (403).';

export const SHIPMENT_MOVE_NOTE =
  'Only an operator of the origin warehouse’s owner moves a shipment (ADR-056 plan step 10); its ' +
  'consignee reads it and is refused 403 FORBIDDEN here, any other organization gets 404. One ' +
  'transaction: the shipment row is locked, moved by compare-and-set, and its tracking event, its ' +
  'SHIPMENT_* event and the stored response commit together. A shipment another command holds ' +
  'longer than INVENTORY_LOCK_TIMEOUT_MS is 409 CONFLICT with Retry-After; retry with the same key.';

export const STOCK_COMMAND_NOTE =
  'One transaction (ADR-056 § 3): the stock items the command touches are locked in ascending ' +
  'id order, reservations of theirs past `expiresAt` are released first (at most ' +
  'INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE per item), then the balance, its append-only ' +
  'movement and the event commit together — or nothing does. A stock item another command ' +
  'holds longer than INVENTORY_LOCK_TIMEOUT_MS, or a refusal that reservations past ' +
  '`expiresAt` not yet released could still change, is 409 CONFLICT with Retry-After; retry ' +
  'with the same key.';

export const RETURN_SHIPMENT_READ_NOTE =
  'Closed by default (S-02). Read by the two organizations of a return shipment (ADR-048 § 2): ' +
  'the owner of its destination warehouse — a role of INVENTORY_READER_ROLES or ' +
  'INVENTORY_OPERATOR_ROLES (Q-103) — and its sender — a role of INVENTORY_CONSIGNEE_READER_ROLES ' +
  '(Q-113, Q-133); all three ORGANIZATION_ADMIN by default, held in the organization the request ' +
  'acts for. Any other organization, or a side the caller’s roles do not open, gets 404, never 403 ' +
  '(S-03). No user id is shown. AUDITOR, SYSTEM_ADMIN and service tokens are refused (403).';

export const RETURN_SHIPMENT_MOVE_NOTE =
  'Only an operator of the destination warehouse’s owner records a return shipment (Q-133: the ' +
  'order’s supplier); its sender reads it and is refused 403 FORBIDDEN here, any other ' +
  'organization gets 404. This service records physical facts only: whether the return was ' +
  'allowed is marketplace’s, which verifies every RETURN_SHIPMENT_* event against its own request. ' +
  'Nothing here moves stock or money. One transaction: the row is locked, moved by ' +
  'compare-and-set, and its tracking event, its RETURN_SHIPMENT_* event and the stored response ' +
  'commit together. A shipment another command holds longer than INVENTORY_LOCK_TIMEOUT_MS is ' +
  '409 CONFLICT with Retry-After; retry with the same key.';

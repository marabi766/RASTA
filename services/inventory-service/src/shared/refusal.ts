import { ERROR_CODES, type ErrorCode, type ErrorDetail } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';

/**
 * Where a refusal's closed reason travels: the platform's error `details` (docs/06 § 6.7), one
 * entry per reason — `{ path: <area>, code: <reason>, message }` — as contract-service and
 * construction-service send theirs. A client branches on the top-level `code` first and on
 * `details[].code` for why; it never parses `message`.
 *
 * `path` names the area whose rule refused (it is not a field of the request body).
 */
export const REFUSAL_AREAS = {
  stock: 'Stock cannot be moved',
  reservation: 'Reservation cannot be made or ended',
  shipment: 'Shipment cannot be moved',
  returnShipment: 'Return shipment cannot be recorded or moved',
} as const;
export type RefusalArea = keyof typeof REFUSAL_AREAS;

/**
 * The closed reasons of each area, and the status each is answered with: a state that moved under
 * the command is 409, a rule is 422. One table, read by the services (a reason that is not here
 * does not compile) and by the OpenAPI document (each command's 409 and 422 type their `details`
 * from it), so the two cannot disagree.
 */
export const REFUSAL_REASONS = {
  stock: {
    /** An adjustment would leave less on hand than zero, or than is reserved. */
    ON_HAND_WOULD_BE_NEGATIVE: 422,
    /** A balance would pass the largest quantity the database stores (2^31 − 1). */
    QUANTITY_OUT_OF_RANGE: 422,
  },
  reservation: {
    /** A line asks for more than the stock item has available; nothing is reserved. */
    INSUFFICIENT_AVAILABLE_STOCK: 422,
    /** The lines name stock items of more than one warehouse. */
    LINES_SPAN_WAREHOUSES: 422,
    /** `expiresAt` is not in the future, or lies past INVENTORY_RESERVATION_MAX_TTL_SECONDS (Q-102). */
    EXPIRY_OUT_OF_RANGE: 422,
    /** In PR 1 a reservation is held by the warehouse owner only (Q-104). */
    HOLDER_NOT_OWNER: 422,
    /** Released, issued or expired already: a reservation ends once. */
    RESERVATION_NOT_ACTIVE: 409,
  },
  shipment: {
    /** Dispatched or delivered already: a shipment is dispatched once, from CREATED. */
    SHIPMENT_NOT_CREATED: 409,
    /** Not dispatched yet, or delivered already: a shipment is delivered once, from DISPATCHED. */
    SHIPMENT_NOT_DISPATCHED: 409,
  },
  returnShipment: {
    /** This return request already has its return shipment in this owner's books: one consignment (Q-133). */
    RETURN_ALREADY_DISPATCHED: 409,
    /** Received already: a return shipment is received once, from IN_TRANSIT. */
    RETURN_SHIPMENT_NOT_IN_TRANSIT: 409,
    /** The lines of a receipt are not exactly the lines the shipment was dispatched with. */
    RECEIPT_LINES_MISMATCH: 422,
    /** A line arrived in a larger quantity than it was said to be coming in. */
    RECEIVED_EXCEEDS_EXPECTED: 422,
  },
} as const satisfies Record<RefusalArea, Record<string, 409 | 422>>;

export type ReasonOf<A extends RefusalArea> = Extract<keyof (typeof REFUSAL_REASONS)[A], string>;

/**
 * The `details` of a refusal: one entry per closed reason, each with a fixed message that names
 * the area and the code and nothing else (no id, no value, no input). Only a reason of the area's
 * own closed list reaches `details` (S-09); no closed reason, no `details`.
 */
export function refusalDetails(
  area: RefusalArea,
  reasons: readonly string[],
): ErrorDetail[] | undefined {
  const closed = reasons.filter((reason) =>
    Object.prototype.hasOwnProperty.call(REFUSAL_REASONS[area], reason),
  );
  if (closed.length === 0) return undefined;
  return closed.map((code) => ({ path: area, code, message: `${REFUSAL_AREAS[area]}: ${code}` }));
}

/**
 * A refusal with its closed reason. `message` is for people; `context` is for the server's log
 * only (`RastaError.internalContext`, S-09): identifiers, never a key or free text.
 */
export function refusal<A extends RefusalArea>(
  area: A,
  reason: ReasonOf<A>,
  message: string,
  context: Record<string, unknown> = {},
): RastaError {
  const status = (REFUSAL_REASONS[area] as Record<string, 409 | 422>)[reason];
  const code: ErrorCode =
    status === 409 ? ERROR_CODES.INVALID_STATE_TRANSITION : ERROR_CODES.BUSINESS_RULE_VIOLATION;
  return new RastaError(code, message, {
    details: refusalDetails(area, [reason]),
    internalContext: { ...context, refusal: reason },
  });
}

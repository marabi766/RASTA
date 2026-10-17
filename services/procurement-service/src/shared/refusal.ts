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
  submission: 'Demand cannot be submitted',
  withdrawal: 'Demand cannot be withdrawn',
} as const;
export type RefusalArea = keyof typeof REFUSAL_AREAS;

/**
 * The closed reasons of each area, and the status each is answered with: a state that moved under
 * the command is 409, a rule is 422. One table, read by the service (a reason that is not here
 * does not compile) and by the OpenAPI document (each route's 409 and 422 type their `details` from
 * it), so the two cannot disagree.
 */
export const REFUSAL_REASONS = {
  /** Submitting a demand (ADR-070 § 2). */
  submission: {
    /**
     * The demand would take the total of the window it joins past MAX_QUANTITY, the most an RFQ
     * and a purchase order can state. Decided under the window's lock, after the window's end if
     * it had ended; nothing is written.
     */
    AGGREGATION_QUANTITY_LIMIT_EXCEEDED: 422,
    /**
     * The window it would join already holds `PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS` live demands —
     * a technical limit, so that the window's synchronous close fits the transaction budget (Q-119
     * note of 2026-10-17). Decided the same way; nothing is written.
     */
    AGGREGATION_DEMAND_LIMIT_REACHED: 422,
  },
  /** Withdrawing a demand (ADR-070 § 2). */
  withdrawal: {
    /** Only a SUBMITTED demand is withdrawn; WITHDRAWN, REFERRED and LAPSED are final. */
    DEMAND_NOT_SUBMITTED: 422,
    /**
     * The demand's window has ended — its aggregation is no longer OPEN, or the database clock is
     * at or past `closesAt`: the demand set is frozen (the way out is cancelling the READY
     * aggregation, ADR-070 plan PR 2).
     */
    AGGREGATION_WINDOW_ENDED: 422,
  },
} as const satisfies Record<RefusalArea, Record<string, 403 | 409 | 422>>;

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
 * A refusal with its closed reasons. `message` is for people; `context` is for the server's log
 * only (`RastaError.internalContext`, S-09).
 */
export function refusal<A extends RefusalArea>(
  code: ErrorCode,
  message: string,
  area: A,
  reasons: readonly ReasonOf<A>[],
  context: Record<string, unknown> = {},
): RastaError {
  return new RastaError(code, message, {
    details: refusalDetails(area, reasons),
    internalContext: { ...context, refusals: [...reasons] },
  });
}

/** 422 `BUSINESS_RULE_VIOLATION` with its closed reasons. */
export function ruleRefusal<A extends RefusalArea>(
  message: string,
  area: A,
  reasons: readonly ReasonOf<A>[],
  context: Record<string, unknown> = {},
): RastaError {
  return refusal(ERROR_CODES.BUSINESS_RULE_VIOLATION, message, area, reasons, context);
}

import { ERROR_CODES, type ErrorCode, type ErrorDetail } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';

/**
 * Where a refusal's closed reason travels: the platform's error `details` (docs/06 § 6.7), one
 * entry per reason — `{ path: <area>, code: <reason>, message }` — as identity-service's
 * registration approval (`details[0].code`) and asset-service's open work (`details[].code`) send
 * theirs. A client branches on the top-level `code` first and on `details[].code` for why; it never
 * parses `message`, which stays as it was.
 *
 * `path` names the area whose rule refused (it is not a field of the request body), so a client
 * that handles several areas can tell `NOT_OPENED` of an opening from `NOT_OPENED` of an evaluation.
 */
export const REFUSAL_AREAS = {
  publication: 'Tender cannot be published',
  invitation: 'Invitation refused',
  bid: 'Bid refused',
  opening: 'Bids are not opened',
  evaluation: 'Evaluation refused',
  award: 'Award refused',
  approval: 'Approval refused',
  cancellation: 'Cancel refused',
} as const;
export type RefusalArea = keyof typeof REFUSAL_AREAS;

/**
 * What a closed reason looks like: an upper-case code of a closed list. Anything else — an id, a
 * sentence, an empty string — is not a closed reason and never reaches `details` (S-09).
 */
const CLOSED_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The `details` of a refusal: one entry per closed reason, in the order given, each with a fixed
 * message that names the area and the code and nothing else (no id, no value, no input). No closed
 * reason, no `details` — never an empty or partial array.
 */
export function refusalDetails(
  area: RefusalArea,
  reasons: readonly string[],
): ErrorDetail[] | undefined {
  const closed = reasons.filter((reason) => CLOSED_REASON.test(reason));
  if (closed.length === 0) return undefined;
  return closed.map((code) => ({ path: area, code, message: `${REFUSAL_AREAS[area]}: ${code}` }));
}

/**
 * A refusal with its closed reasons. `message` is the caller's, unchanged; `context` is for the
 * server's log only (S-09, `RastaError.internalContext`) and keeps the reasons under `refusals`,
 * where the access log reads them (`refusalCodeOf`).
 */
export function refusal(
  code: ErrorCode,
  message: string,
  area: RefusalArea,
  reasons: readonly string[],
  context: Record<string, unknown> = {},
): RastaError {
  return new RastaError(code, message, {
    details: refusalDetails(area, reasons),
    internalContext: { ...context, refusals: [...reasons] },
  });
}

/** 422 `BUSINESS_RULE_VIOLATION` with its closed reasons. */
export function ruleRefusal(
  message: string,
  area: RefusalArea,
  reasons: readonly string[],
  context: Record<string, unknown> = {},
): RastaError {
  return refusal(ERROR_CODES.BUSINESS_RULE_VIOLATION, message, area, reasons, context);
}

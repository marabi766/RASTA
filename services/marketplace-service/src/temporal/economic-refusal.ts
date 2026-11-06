/**
 * What may be taken as proof that an economic call changed nothing, shared by the
 * activity that marks it and the workflow that reads the mark. No I/O: the
 * workflow bundle loads this file.
 */

/**
 * The only codes that can be such a proof: the request or the money was refused,
 * and economic-service stores an effect and its key's answer in one commit. Only
 * for the step's own refusal on the first attempt (`REFUSED_ON_FIRST_ATTEMPT`): a
 * guard or a route answers before the key is looked up, so on a later attempt the
 * same code says nothing of the attempts before it.
 *
 * Moving a code changes what a live history replays: it needs a new patch.
 * Closed on purpose. Everything else is an unknown outcome: every 5xx, timeout
 * and reset, an unlisted code, and these 4xx, which refuse only this attempt or
 * say nothing of the transaction: `CONFLICT` (the key's request is in flight),
 * `IDEMPOTENCY_KEY_REUSED` and `REPLAY_WINDOW_CLOSED` (the key was used, perhaps
 * to effect), `OPTIMISTIC_LOCK_FAILED`, `RATE_LIMIT_EXCEEDED`, and the 401s of a
 * token this service mints afresh per call.
 */
export const PROVEN_REFUSALS: ReadonlySet<string> = new Set([
  'VALIDATION_FAILED',
  'MALFORMED_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'FORBIDDEN',
  'INSUFFICIENT_ROLE',
  'TENANT_MISMATCH',
  'SERVICE_TENANT_CONTEXT_INVALID',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'INVALID_STATE_TRANSITION',
  'ACTOR_IDENTITY_UNKNOWN',
  'BUSINESS_RULE_VIOLATION',
  'INSUFFICIENT_BALANCE',
  'LEDGER_UNBALANCED',
  'NO_ACTIVE_RULE',
  'BUSINESS_LINE_REQUIRED',
]);

/**
 * How long a hold's doubt must last before a marked refusal can end it: the retention
 * of economic-service's keys (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`), and a quarter of that
 * again as the margin, so that one setting moves both. Null for anything that is not a
 * retention: no age proves anything then.
 */
export function doubtOutlivesKeyMs(retentionHours: unknown): number | null {
  if (typeof retentionHours !== 'number' || !(retentionHours > 0) || retentionHours === Infinity) {
    return null;
  }
  return (retentionHours + retentionHours / 4) * 60 * 60 * 1000;
}

/** In a failure's details: this step's own refusal, by a guard or the send, on its first attempt. */
export const REFUSED_ON_FIRST_ATTEMPT = 'REFUSED_ON_FIRST_ATTEMPT';

/**
 * In a failure's details, in a history recorded before `ObligationFinal` replaced it:
 * the call was in doubt, and the obligation terminal. Nothing marks a failure so now;
 * the workflow still reads it, so that such a history replays its end.
 */
export const OWNER_STATE_IS_FINAL = 'OWNER_STATE_IS_FINAL';

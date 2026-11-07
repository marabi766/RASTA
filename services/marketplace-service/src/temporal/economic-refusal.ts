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
 * token this service mints afresh per call. `HOLD_DEADLINE_PASSED` is not here either:
 * it has a mark and a rule of its own (`sentPastHoldFence`).
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
 * The fence on a hold (D-132), the one source of both periods. `sendWindowMs`: how long
 * after its first send a hold may still be placed. `clockMarginMs`: how far past that
 * deadline the saga waits before it believes a refusal, for the two services' clocks, a
 * transaction already past economic-service's check, and the watch after the exit.
 * Changing either changes what a live history decides: it needs a new patch.
 */
export const HOLD_FENCE = {
  sendWindowMs: 24 * 60 * 60 * 1000,
  clockMarginMs: 60 * 60 * 1000,
} as const;

/** economic-service's answer past that deadline, which it records under the key. */
export const HOLD_DEADLINE_PASSED = 'HOLD_DEADLINE_PASSED';

/** In a failure's details: that answer, to a request that carried a deadline. Any attempt. */
export const REFUSED_PAST_HOLD_DEADLINE = 'REFUSED_PAST_HOLD_DEADLINE';

/**
 * In a failure's details: the order's own row says its sends are closed (`noHoldCanLand`),
 * so this attempt sent nothing and no earlier one can still hold.
 */
export const HOLD_SENDS_CLOSED = 'HOLD_SENDS_CLOSED';

/** The deadline of every request under a hold's key, from the moment of the first. */
export function holdDeadlineFrom(firstSendAt: number): string {
  return new Date(firstSendAt + HOLD_FENCE.sendWindowMs).toISOString();
}

/** Sent past the deadline and its margin. Anything unreadable is not past anything. */
export function sentPastHoldFence(holdNotAfter: string, sentAt: number): boolean {
  return sentAt > Date.parse(holdNotAfter) + HOLD_FENCE.clockMarginMs;
}

/**
 * Retired with its exit (D-132): only a history that recorded that exit still asks, on
 * replay (`placeHold`). How long a hold's doubt had to last before a marked refusal ended
 * it, from a retention marketplace-service could not verify. Null for anything that is
 * not a retention.
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
 * In a failure's details: the call was in doubt, and the obligation terminal. How an
 * authorisation that did not declare `FINAL_ANSWER_CONTRACT` is told so, and what a
 * history recorded before `ObligationFinal` carries; the workflow still reads it.
 */
export const OWNER_STATE_IS_FINAL = 'OWNER_STATE_IS_FINAL';

/**
 * What a workflow passes to a call that may answer `ObligationFinal`, asked from
 * `saga-owed-work-durable-v1` right before scheduling it: the marker commits with the
 * schedule command, so such an answer can only reach a history a build below protocol
 * 6 is refused (`marketplace-saga-drain-check.mjs`). Anything else, or nothing, is a
 * caller that would read the answer as the call's own effect, and gets the refusal.
 */
export const FINAL_ANSWER_CONTRACT = 'obligation-final-v1';

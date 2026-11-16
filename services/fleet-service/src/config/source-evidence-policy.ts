export const ACTIVATION_RETRY_ATTEMPTS = 8;
export const ACTIVATION_RETRY_BACKOFF_MS = 10_000;
/** Short independent history/exhaustion transaction; no seal or parked-row lock. */
export const SOURCE_REFUSAL_HISTORY_TRANSACTION = Object.freeze({
  timeoutMs: 500,
  maxWaitMs: 50,
  statementTimeoutMs: 400,
});

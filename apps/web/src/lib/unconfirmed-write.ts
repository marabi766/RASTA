/**
 * A write that was sent but not confirmed (Codex post-merge review of #106).
 *
 * `writeThroughGateway` answers `UNKNOWN_OUTCOME` when the request may have
 * reached the service and no answer it could be judged by came back: the
 * connection dropped after dispatch, the deadline passed, the gateway's
 * upstream timed out, or a 2xx could not be read. Every write form shows this
 * state, never its "nothing was saved" failure: the service may well have
 * committed, and not every service keeps an idempotency ledger, so a blind
 * retry can apply the change twice.
 *
 * A module of its own so the form-state files — which client components
 * import — can share the type without importing server code.
 */
export interface UnconfirmedWriteState {
  readonly kind: 'UNCONFIRMED';
  readonly correlationId: string;
}

/** What the person is told. No claim either way: we do not know. */
export const UNCONFIRMED_WRITE_MESSAGE =
  'نتوانستیم تأیید کنیم که این درخواست ثبت شد یا نه؛ ممکن است ذخیره شده باشد. ' +
  'پیش از فرستادن دوباره، صفحه را تازه کنید و بررسی کنید که تغییر اعمال شده است یا نه.';

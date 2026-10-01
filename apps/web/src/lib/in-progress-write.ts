/**
 * A write whose submission id another request is still working on (round 1
 * on PR 171): the service answered `409 CONFLICT` with `Retry-After`, the
 * portal's `IN_PROGRESS`. Not an invalid form, and not a failure — the first
 * request may still commit. The form keeps what was typed and its submission
 * id, and offers the same submission again once `Retry-After` has passed: the
 * same id is answered with the first request's own result.
 *
 * A module of its own so the form-state files — which client components
 * import — can share the type without importing server code.
 */
export interface InProgressWriteState<V> {
  readonly kind: 'IN_PROGRESS';
  readonly submissionId: string;
  readonly values: V;
  readonly retryAfterSeconds: number;
  readonly correlationId: string;
}

/** What the person is told: it is being handled; look again shortly. */
export const IN_PROGRESS_WRITE_MESSAGE = 'در حال پردازش است، کمی بعد دوباره ببینید.';

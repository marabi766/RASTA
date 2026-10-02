import { Alert } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';

import type { RequestCommandFormState } from './form-state';

/**
 * What every command form on `/maintenance/[id]` — the request's own
 * (`RequestCommandForms.tsx`) and a repair order's (`RepairOrderForms.tsx`) —
 * carries and says, so the two files cannot drift apart on the parts that decide
 * whether a post is believed.
 */

export interface Identity {
  readonly csrfToken: string;
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  readonly requestId: string;
}

/**
 * The fields a post is authenticated by. `baseline` is present on a form that
 * confirms something it showed (`server/maintenance-commands.ts`,
 * `server/repair-order-commands.ts`): signed for this session, and the only
 * thing the action reads the order or the amount from.
 */
export function Hidden({
  csrfToken,
  submissionId,
  requestId,
  baseline,
}: Identity & { readonly baseline?: string }) {
  return (
    <>
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={submissionId} />
      <input type="hidden" name="requestId" value={requestId} />
      {baseline !== undefined ? (
        <input type="hidden" name={BASELINE_FIELD} value={baseline} />
      ) : null}
    </>
  );
}

/** A retry of the same form carries the same reference. */
export function submissionOf(
  state: { kind: string; submissionId?: string },
  minted: string,
): string {
  return state.kind === 'INVALID' && state.submissionId ? state.submissionId : minted;
}

export function CommandBanner({
  state,
  forbidden,
}: {
  state: RequestCommandFormState<unknown, string>;
  forbidden: string;
}) {
  switch (state.kind) {
    case 'INVALID':
      return state.message ? <Alert tone="warning">{state.message}</Alert> : null;
    case 'REFUSED':
      return (
        <Alert tone="danger">
          {state.reason === 'NO_SESSION'
            ? 'نشست شما پایان یافته است. دوباره وارد شوید و فرم را بفرستید.'
            : state.reason === 'BASELINE'
              ? 'این فرم منقضی شده است یا با صفحهٔ نمایش‌داده‌شده نمی‌خواند. صفحه را تازه کنید و دوباره تلاش کنید.'
              : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
        </Alert>
      );
    case 'FORBIDDEN':
      return (
        <Alert tone="danger">
          {forbidden} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'NOT_FOUND':
      // The platform answers "no such request" and "somebody else's" the same way.
      return <Alert tone="danger">این درخواست پیدا نشد یا در سازمان فعال شما نیست.</Alert>;
    case 'UNCONFIRMED':
      return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
    case 'FAILED':
      return (
        <Alert tone="danger">
          انجام نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'IDLE':
      return null;
  }
}

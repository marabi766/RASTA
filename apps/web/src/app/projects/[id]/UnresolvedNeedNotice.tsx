import { Alert, Button } from '@/ui';
import { CSRF_FIELD } from '@/lib/form-fields';
import { NEED_HELD_IN_PROGRESS_MESSAGE, NEED_UNRESOLVED_TEXT } from '@/lib/project-need-commands';
import type { UnresolvedRequest } from '@/server/unresolved-request';

import { releaseUnresolvedNeed } from './need-actions';
import {
  CONFIRM_DUPLICATE_NEED_FIELD,
  CONFIRM_DUPLICATE_NEED_VALUE,
  RELEASE_NEED_FIELD,
} from './need-form-state';

/**
 * Shown on a project's page for as long as an earlier "add a need" is unresolved
 * (`server/unresolved-request.ts`): sent, possibly committed, never confirmed.
 *
 * The request is not sent again — the endpoint takes a key but no replay deadline
 * (`unresolved-request-policy.ts`, `project-need-create`) — so no add form is drawn
 * beside it. The needs listed on this page, withdrawn ones included, settle it by
 * looking; a page of them is not proof either (it is capped), so the release asks
 * for the checkbox that names the risk of a duplicate.
 */
const CONFIRM_ID = 'confirm-duplicate-need';

export function UnresolvedNeedNotice({
  projectId,
  request,
  csrfToken,
  releaseToken,
}: {
  readonly projectId: string;
  readonly request: UnresolvedRequest;
  readonly csrfToken: string;
  /** Signed name of `request`, bound to this login: the release acts only on that record. */
  readonly releaseToken: string;
}) {
  return (
    <Alert tone="warning">
      <div className="flex flex-col gap-3">
        <p>{NEED_UNRESOLVED_TEXT}</p>
        {request.inFlight ? <p>{NEED_HELD_IN_PROGRESS_MESSAGE}</p> : null}
        <form action={releaseUnresolvedNeed.bind(null, projectId)} className="flex flex-col gap-2">
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <input type="hidden" name={RELEASE_NEED_FIELD} value={releaseToken} />
          <label htmlFor={CONFIRM_ID} className="flex items-start gap-2">
            <input
              id={CONFIRM_ID}
              type="checkbox"
              name={CONFIRM_DUPLICATE_NEED_FIELD}
              value={CONFIRM_DUPLICATE_NEED_VALUE}
              aria-labelledby={`${CONFIRM_ID}-text`}
              required
            />
            <span id={`${CONFIRM_ID}-text`}>
              نیازهای این پروژه را بررسی کردم و می‌پذیرم که افزودن درخواست تازه ممکن است نیاز تکراری
              بسازد.
            </span>
          </label>
          <div>
            <Button type="submit" tone="secondary">
              رها کردن و افزودن درخواست تازه
            </Button>
          </div>
        </form>
      </div>
    </Alert>
  );
}

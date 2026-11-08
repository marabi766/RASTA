import { Alert, Button } from '@/ui';
import { RELEASE_FIELD } from '@/lib/release-messages';
import { CSRF_FIELD } from '@/lib/form-fields';
import { HELD_IN_PROGRESS_MESSAGE } from '@/lib/demand-commands';
import { mayResend, type UnresolvedRequest } from '@/server/unresolved-request';

import { releaseUnresolvedDemand } from './demand-actions';
import { CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE } from './demand-form-state';

/**
 * Shown on `/procurement/demands` for as long as an earlier submission is
 * unresolved (`server/unresolved-request.ts`): sent, possibly registered, never
 * confirmed. It survives reloads, navigation and a validation error, because it
 * is read from the server's record, not from any response.
 *
 * A filtered list never settles it — the new demand may not match the filter —
 * so the link is the **unfiltered** list. The form below carries the same key:
 * the same values again are answered with the first result while the deadline
 * holds. Anything else needs the checkbox, which names the risk of a duplicate.
 */
const CONFIRM_ID = 'confirm-duplicate-demand';

export function UnresolvedDemandNotice({
  request,
  csrfToken,
  releaseToken,
  now,
  listHref,
}: {
  request: UnresolvedRequest;
  csrfToken: string;
  /** Signed name of `request`, bound to this login: the release acts only on that record. */
  releaseToken: string;
  /** The store's time at the read. */
  now: number;
  /** The unfiltered list, in this organization's context. */
  listHref: string;
}) {
  return (
    <Alert tone="warning">
      <div className="flex flex-col gap-3" data-testid="unresolved-demand">
        <p>
          ثبت نیازی که پیش‌تر فرستادید هنوز روشن نشده است؛ ممکن است ثبت شده باشد.{' '}
          <a className="underline" href={listHref}>
            فهرست کامل نیازها (بدون فیلتر)
          </a>{' '}
          را بررسی کنید؛ فهرست فیلترشده نیاز تازه را نشان نمی‌دهد. کد پیگیری: {request.key}
        </p>
        {request.inFlight ? <p>{HELD_IN_PROGRESS_MESSAGE}</p> : null}
        <p>
          {mayResend(request, now)
            ? 'همان درخواست را با همان مقدارها می‌توانید دوباره بفرستید؛ با همان کلید، نیاز دوبار ثبت نمی‌شود. فرم زیر برای همان درخواست است.'
            : 'مهلت فرستادن دوباره همان درخواست گذشته است و فرم زیر چیزی نمی‌فرستد.'}
        </p>
        <form action={releaseUnresolvedDemand} className="flex flex-col gap-2">
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <input type="hidden" name={RELEASE_FIELD} value={releaseToken} />
          <label htmlFor={CONFIRM_ID} className="flex items-start gap-2">
            <input
              id={CONFIRM_ID}
              type="checkbox"
              name={CONFIRM_DUPLICATE_FIELD}
              value={CONFIRM_DUPLICATE_VALUE}
              aria-labelledby={`${CONFIRM_ID}-text`}
              required
            />
            <span id={`${CONFIRM_ID}-text`}>
              فهرست کامل نیازها را بررسی کردم و می‌پذیرم که ثبت درخواست تازه ممکن است نیاز تکراری
              بسازد.
            </span>
          </label>
          <div>
            <Button type="submit" tone="secondary">
              رها کردن و ثبت درخواست تازه
            </Button>
          </div>
        </form>
      </div>
    </Alert>
  );
}

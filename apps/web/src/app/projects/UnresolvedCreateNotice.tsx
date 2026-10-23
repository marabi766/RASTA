import { Alert, Button } from '@/ui';
import { CSRF_FIELD } from '@/lib/form-fields';
import { mayResend, type UnresolvedRequest } from '@/server/unresolved-request';

import { releaseUnresolvedCreate } from './actions';
import { CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE } from './form-state';

/**
 * Shown on `/projects` for as long as an earlier create is unresolved
 * (`server/unresolved-request.ts`): sent, possibly committed, never confirmed.
 *
 * A filtered list never settles it — the new draft may simply not match the
 * filter — so the link goes to the **unfiltered** list. The form below carries
 * the same key; sending the same values again is safe while the deadline holds.
 * Sending something else needs the checkbox: it names the risk of a duplicate.
 */
const CONFIRM_ID = 'confirm-duplicate-create';

export function UnresolvedCreateNotice({
  request,
  csrfToken,
  now,
}: {
  request: UnresolvedRequest;
  csrfToken: string;
  now: number;
}) {
  const resendable = mayResend(request, now);
  return (
    <Alert tone="warning">
      <div className="flex flex-col gap-3">
        <p>
          ثبت پروژه‌ای که پیشتر فرستادید هنوز روشن نشده است؛ ممکن است ساخته شده باشد.{' '}
          <a className="underline" href="/projects">
            فهرست کامل پروژه‌ها (بدون فیلتر)
          </a>{' '}
          را بررسی کنید، چون فهرست فیلترشده پروژه تازه را نشان نمی‌دهد.
        </p>
        <p>
          {resendable
            ? 'همان درخواست را با همان مقدارها می‌توانید دوباره بفرستید؛ با همان کلید، پروژه دوبار ساخته نمی‌شود. فرم زیر برای همان درخواست است.'
            : 'مهلت فرستادن دوباره همان درخواست گذشته است و فرم زیر چیزی نمی‌فرستد.'}
        </p>
        <form action={releaseUnresolvedCreate} className="flex flex-col gap-2">
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
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
              فهرست کامل پروژه‌ها را بررسی کردم و می‌پذیرم که ثبت درخواست تازه ممکن است پروژه تکراری
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

import type { JSX } from 'react';
import { RELEASE_FIELD } from '@/lib/release-messages';
import { Alert, Button } from '@/ui';
import { CSRF_FIELD } from '@/lib/form-fields';
import { CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE } from '@/app/projects/form-state';

/** The existing signed reconciliation flow, shared by asset and driver registration. */
export function UnresolvedRegistrationNotice({
  csrfToken,
  releaseToken,
  href,
  action,
}: {
  csrfToken: string;
  releaseToken: string;
  href: '/assets' | '/drivers';
  action: (form: FormData) => Promise<void>;
}): JSX.Element {
  const id = `confirm-duplicate-${href.slice(1)}`;
  return (
    <Alert tone="warning">
      <p>
        نتیجهٔ درخواست پیشین مشخص نیست؛ ممکن است ثبت شده باشد.{' '}
        <a className="underline" href={href}>
          فهرست کامل را دوباره بررسی کنید.
        </a>{' '}
        فهرست خالی یا فیلترشده و محدودیت دسترسی ثابت نمی‌کند که درخواست انجام نشده است. درخواست در
        حال اجرا رها نمی‌شود؛ پس از پایان آن دوباره بررسی کنید.
      </p>
      <form action={action} className="flex flex-col gap-2">
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
        <input type="hidden" name={RELEASE_FIELD} value={releaseToken} />
        <label htmlFor={id} id={`${id}-label`}>
          <input
            id={id}
            aria-labelledby={`${id}-label`}
            type="checkbox"
            name={CONFIRM_DUPLICATE_FIELD}
            value={CONFIRM_DUPLICATE_VALUE}
            required
          />{' '}
          فهرست را بررسی کردم و می‌پذیرم که ثبت درخواست تازه ممکن است رکورد تکراری بسازد.
        </label>
        <Button type="submit" tone="secondary">
          رها کردن و ثبت درخواست تازه
        </Button>
      </form>
    </Alert>
  );
}

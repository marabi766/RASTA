import type { JSX } from 'react';
import { RELEASE_FIELD } from '@/lib/release-messages';
import { Alert, Button } from '@/ui';
import { CSRF_FIELD } from '@/lib/form-fields';
import { releaseUnresolvedTopUp } from './actions';
import { CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE } from './form-state';

/** Same explicit, signed compare-and-delete reconciliation as the project/demand notices. */
type Props = { walletId: string; csrfToken: string; releaseToken: string };
export function UnresolvedTopUpNotice({ walletId, csrfToken, releaseToken }: Props): JSX.Element {
  const id = 'confirm-duplicate-top-up';
  return (
    <Alert tone="warning">
      <p>
        نتیجهٔ درخواست پیشین مشخص نیست؛ ممکن است موجودی افزایش یافته باشد.{' '}
        <a className="underline" href="/wallet">
          تراکنش‌ها و موجودی را دوباره بررسی کنید.
        </a>{' '}
        فهرست خالی یا فیلترشده ثابت نمی‌کند که درخواست انجام نشده است. درخواست در حال اجرا رها
        نمی‌شود؛ پس از پایان آن دوباره بررسی کنید.
      </p>
      <form action={releaseUnresolvedTopUp.bind(null, walletId)} className="flex flex-col gap-2">
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
          تراکنش‌ها و موجودی را بررسی کردم و می‌پذیرم که درخواست تازه ممکن است موجودی را دوباره
          افزایش دهد.
        </label>
        <Button type="submit" tone="secondary">
          رها کردن و ثبت درخواست تازه
        </Button>
      </form>
    </Alert>
  );
}

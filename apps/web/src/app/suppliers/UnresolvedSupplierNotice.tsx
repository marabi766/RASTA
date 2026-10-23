import { Alert, Button } from '@/ui';
import { CSRF_FIELD } from '@/lib/form-fields';
import { UNCONFIRMED_WRITE_MESSAGE } from '@/lib/unconfirmed-write';
import { RECONCILED_FIELD, RECONCILED_VALUE } from '@/server/supplier-unresolved';
import type { UnresolvedRequest } from '@/server/unresolved-request';

import { reconcileSupplierWrite } from './supplier-actions';

/**
 * Shown on a supplier page (or on `/suppliers`, for the registration) for as
 * long as an earlier write there is unresolved (`server/supplier-unresolved.ts`).
 *
 * supplier-service has no idempotency ledger, so the request cannot be sent
 * again, and no new one is accepted either: the person re-reads the record
 * (the link is this page, drawn afresh) and then confirms. The warning and its
 * correlation id stay through validation errors, navigation and reloads.
 */
const CONFIRM_ID = 'confirm-reconciled-supplier-write';

export function UnresolvedSupplierNotice({
  request,
  supplierId,
  csrfToken,
}: {
  request: UnresolvedRequest;
  /** The supplier the write was about; null for the registration. */
  supplierId: string | null;
  csrfToken: string;
}) {
  return (
    <Alert tone="warning">
      <div className="flex flex-col gap-3" data-testid="unresolved-supplier-write">
        <p>
          {UNCONFIRMED_WRITE_MESSAGE} کد پیگیری: {request.ref ?? request.key}
        </p>
        <p>
          تا زمانی که این درخواست روشن نشود، درخواست تازه‌ای برای این پرونده فرستاده نمی‌شود، چون
          این سرویس کلید تکرار ندارد و ارسال دوباره می‌تواند رکورد دوم بسازد.
        </p>
        <form
          action={reconcileSupplierWrite.bind(null, supplierId)}
          className="flex flex-col gap-2"
        >
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <label htmlFor={CONFIRM_ID} className="flex items-start gap-2">
            <input
              id={CONFIRM_ID}
              type="checkbox"
              name={RECONCILED_FIELD}
              value={RECONCILED_VALUE}
              aria-labelledby={`${CONFIRM_ID}-text`}
              required
            />
            <span id={`${CONFIRM_ID}-text`}>
              پرونده را دوباره خواندم و بررسی کردم که این درخواست اعمال شده است یا نه.
            </span>
          </label>
          <div>
            <Button type="submit" tone="secondary">
              بررسی کردم؛ ارسال تازه مجاز شود
            </Button>
          </div>
        </form>
      </div>
    </Alert>
  );
}

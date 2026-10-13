'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { formatMoney, toPersianDigits } from '@/lib/format';
import {
  EMPTY_PLACE_ORDER_FORM,
  PLACE_ORDER_LIMITS as LIMITS,
  type PlaceOrderFormValues,
} from '@/lib/place-order-fields';
import type { Offer } from '@/server/marketplace';

import { submitPlaceOrder } from './place-order-actions';
import { IDLE_PLACE_ORDER_FORM, type PlaceOrderFormState } from './place-order-form-state';

/**
 * Placing an order for one offer.
 *
 * What it says about money is limited to what is true. The portal is not
 * connected to a bank (`CLAUDE.md`): the platform holds the order's amount from
 * the organization's wallet balance, which is itself simulated — so the copy
 * says "wallet", says "simulated", and never says "pay". It does not say the
 * order is confirmed either: placing it asks the supplier to accept, and the
 * order page shows where it is.
 *
 * The price is not a field. The service prices the order from the offer as it
 * is when the order is placed (and refuses a body that carries a price), so the
 * figure in the option text is what this page last read, not a quote.
 *
 * The offers it is given are the ones this organization may order from —
 * `OffersScreen` leaves out its own. That is a convenience; the service refuses
 * an order from oneself on its own account.
 */

export function PlaceOrderForm({
  offers,
  csrfToken,
  submissionId,
}: {
  offers: readonly Offer[];
  csrfToken: string;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(submitPlaceOrder, IDLE_PLACE_ORDER_FORM);

  const kept = state.kind === 'INVALID' || state.kind === 'NOT_FOUND';
  const values: PlaceOrderFormValues = kept ? state.values : EMPTY_PLACE_ORDER_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const currentSubmissionId = kept ? state.submissionId : submissionId;

  return (
    <form action={action} aria-labelledby="place-order-heading" className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />

      <h3 id="place-order-heading" className="text-base font-medium">
        ثبت سفارش
      </h3>
      <p className="text-sm text-content-muted">
        قیمت هنگام ثبت سفارش از پیشنهاد کنونی تأمین‌کننده محاسبه می‌شود و ممکن است با آنچه در این
        صفحه خوانده‌اید فرق کند؛ مجموع نهایی را در صفحهٔ سفارش می‌بینید. پلتفرم به بانک واقعی وصل
        نیست: وجه سفارش از موجودی کیف پول شبیه‌سازی‌شدهٔ سازمان شما نگه داشته می‌شود و سفارش تا
        پذیرش تأمین‌کننده قطعی نیست.
      </p>

      <FormBanner state={state} />

      <Field label="پیشنهاد" required error={errors.offerId}>
        {(control) => (
          <select
            // Keyed by its default: a select reads `defaultValue` only at mount (docs/16 § ۱۶٫۱).
            key={values.offerId}
            {...control}
            name="offerId"
            defaultValue={values.offerId}
            className={controlClassName}
          >
            <option value="" disabled>
              انتخاب کنید
            </option>
            {offers.map((offer) => (
              <option key={offer.id} value={offer.id}>
                {`${offer.supplierOrganizationId} — ${formatMoney(offer.unitPriceMinor)} — کمینه ${toPersianDigits(String(offer.minimumQuantity))} — موجودی ${toPersianDigits(String(offer.availableQuantity))}`}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="تعداد" required error={errors.quantity}>
        {(control) => (
          <input
            {...control}
            name="quantity"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={values.quantity}
            className={controlClassName}
          />
        )}
      </Field>

      <Field label="یادداشت" hint="اختیاری؛ برای تأمین‌کننده" error={errors.note}>
        {(control) => (
          <textarea
            {...control}
            name="note"
            rows={2}
            defaultValue={values.note}
            maxLength={LIMITS.note.max}
            className={controlClassName}
          />
        )}
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ثبت…' : 'ثبت سفارش'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: PlaceOrderFormState }) {
  if (state.kind === 'INVALID' && state.message) {
    return <Alert tone="warning">{state.message}</Alert>;
  }

  if (state.kind === 'REFUSED') {
    return (
      <Alert tone="danger">
        {state.reason === 'NO_SESSION'
          ? 'نشست شما پایان یافته است. دوباره وارد شوید و فرم را بفرستید.'
          : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
      </Alert>
    );
  }

  if (state.kind === 'FORBIDDEN') {
    return (
      <Alert tone="danger">ثبت سفارش در اختیار شما نیست. کد پیگیری: {state.correlationId}</Alert>
    );
  }

  if (state.kind === 'NOT_FOUND') {
    // Absent and unpublished read the same: the service answers one 404 for both.
    return (
      <Alert tone="warning">
        این پیشنهاد دیگر در دسترس نیست و سفارشی ثبت نشد. صفحه را تازه کنید و پیشنهاد دیگری را
        برگزینید.
      </Alert>
    );
  }

  if (state.kind === 'UNCONFIRMED') {
    return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        سفارش ثبت نشد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}

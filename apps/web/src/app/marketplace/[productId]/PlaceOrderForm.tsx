'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { formatMoney, toPersianDigits } from '@/lib/format';
import { EMPTY_PLACE_ORDER_FORM, type PlaceOrderFormValues } from '@/lib/place-order-fields';
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
  newOrderHref,
}: {
  offers: readonly Offer[];
  csrfToken: string;
  submissionId: string;
  /** This page's own address: following it is a full navigation that mints a new submission id. */
  newOrderHref: string;
}) {
  const [state, action, pending] = useActionState(submitPlaceOrder, IDLE_PLACE_ORDER_FORM);

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedOrder
        state={state}
        action={action}
        pending={pending}
        csrfToken={csrfToken}
        offers={offers}
        newOrderHref={newOrderHref}
      />
    );
  }

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

  return null;
}

/**
 * Sent, maybe placed, not confirmed. The service stores its idempotency answer
 * after the order's transaction, so even a 5xx can follow a committed order —
 * this never says "not placed". The retry re-sends the kept values under the kept
 * submission id (the service replays or completes the first request); starting a
 * new order is a separate, labelled action and the only one that mints a new id.
 */
function UnconfirmedOrder({
  state,
  action,
  pending,
  csrfToken,
  offers,
  newOrderHref,
}: {
  state: Extract<PlaceOrderFormState, { kind: 'UNCONFIRMED' }>;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  offers: readonly Offer[];
  newOrderHref: string;
}) {
  const offer = offers.find((candidate) => candidate.id === state.values.offerId);
  return (
    <form action={action} aria-labelledby="place-order-heading" className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={state.submissionId} />
      <input type="hidden" name="offerId" value={state.values.offerId} />
      <input type="hidden" name="quantity" value={state.values.quantity} />

      <h3 id="place-order-heading" className="text-base font-medium">
        ثبت سفارش
      </h3>
      <Alert tone="warning">
        نتوانستیم تأیید کنیم که سفارش ثبت شد یا نه؛ ممکن است سفارش ثبت شده باشد. پیش از هر کار دیگر،{' '}
        <Link href="/orders" className="underline">
          فهرست سفارش‌های
        </Link>{' '}
        خود را ببینید. کد پیگیری: {state.correlationId}
      </Alert>
      {state.retryRefused ? (
        <Alert tone="warning">
          ارسال دوباره رد شد و نتیجهٔ درخواست نخست همچنان معلوم نیست؛ ممکن است سفارش ثبت شده باشد.
          فهرست سفارش‌ها را ببینید.
        </Alert>
      ) : null}
      <p className="text-sm text-content-muted">
        {offer ? `${offer.supplierOrganizationId} — ` : ''}
        تعداد {toPersianDigits(state.values.quantity)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ارسال…' : 'ارسال دوبارهٔ همین درخواست'}
        </Button>
        {/* A full navigation: the page mints a fresh submission id. */}
        <a href={newOrderHref} className="underline self-center text-sm">
          شروع سفارش تازه
        </a>
      </div>
      <p className="text-sm text-content-muted">
        «ارسال دوباره» همان درخواست را با همان شناسهٔ ارسال می‌فرستد و ممکن است سفارش پیشین را
        برگرداند، اما این تضمین نیست؛ فهرست سفارش‌ها مرجع است. «شروع سفارش تازه» درخواست جدیدی است.
      </p>
    </form>
  );
}

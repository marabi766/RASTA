'use client';

import Link from 'next/link';
import { useActionState, useCallback, useEffect, useState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { ProviderUnknownRefusal } from '@/app/DemoModeNotice';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { formatMoney, toPersianDigits } from '@/lib/format';
import {
  canonicalQuantity,
  EMPTY_PLACE_ORDER_FORM,
  type PlaceOrderFormValues,
} from '@/lib/place-order-fields';
import {
  clearUnresolvedOrder,
  restoreUnresolvedOrder,
  saveUnresolvedOrder,
  type Binding,
  type RestoredOrder,
  type UnresolvedOrder,
} from '@/lib/unresolved-order';
import type { Offer } from '@/server/marketplace';
import {
  isRedirect,
  isSessionRefusal,
  sessionHasEnded,
  SESSION_REFUSAL_MESSAGES,
} from '@/lib/session-refusal';

import { submitPlaceOrder } from './place-order-actions';
import {
  IDLE_PLACE_ORDER_FORM,
  withRetryNote,
  type PlaceOrderFormState,
  type UnconfirmedPlaceOrder,
} from './place-order-form-state';

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

export interface PlaceOrderFormProps {
  readonly offers: readonly Offer[];
  readonly csrfToken: string;
  readonly submissionId: string;
  /** This page's own address: following it is a full navigation that mints a new submission id. */
  readonly newOrderHref: string;
  /** The product this form orders for: an unresolved order is remembered per product. */
  readonly productId: string;
  /** Whose login this page was drawn for (`submissionBinding`); one-way tags, not session values. */
  readonly binding: Binding;
  /** How long a remembered order outlives its login at most: the session's lifetime. */
  readonly sessionMaxAgeSeconds: number;
}

/**
 * Remembers an unresolved order across a reload (F1): the form that mounts
 * looks for one in `sessionStorage` and, if there is one for this person, draws
 * the uncertainty view with its original key. The first paint is the server's
 * (blank), so hydration agrees; the remembered order replaces it right after
 * mount, by remounting the form with that order as its starting state.
 */
export function PlaceOrderForm(props: PlaceOrderFormProps) {
  const { productId, binding, sessionMaxAgeSeconds } = props;
  const [restored, setRestored] = useState<RestoredOrder | null>(null);

  useEffect(() => {
    setRestored(restoreUnresolvedOrder(productId, binding, sessionMaxAgeSeconds));
  }, [productId, binding, sessionMaxAgeSeconds]);

  return (
    <OrderForm
      key={restored ? restored.order.submissionId : 'blank'}
      {...props}
      initial={restored ? unconfirmedFrom(restored) : IDLE_PLACE_ORDER_FORM}
    />
  );
}

function unconfirmedFrom(restored: RestoredOrder): UnconfirmedPlaceOrder {
  const { correlationId, submissionId, values } = restored.order;
  return {
    kind: 'UNCONFIRMED',
    correlationId,
    submissionId,
    values,
    ...(restored.kind === 'VIEW_ONLY' ? { viewOnly: true as const } : {}),
  };
}

/**
 * The submission as the action will validate it — the same offer text, the
 * quantity as a count — or null when the action would refuse it before sending
 * anything (nothing to remember then).
 */
function pendingFrom(form: FormData): Omit<UnresolvedOrder, 'savedAt'> | null {
  const submissionId = form.get(SUBMISSION_FIELD);
  const offerId = form.get('offerId');
  const quantity = form.get('quantity');
  if (typeof submissionId !== 'string' || typeof offerId !== 'string') return null;
  if (typeof quantity !== 'string') return null;

  const canonical = canonicalQuantity(quantity);
  const offer = offerId.trim();
  if (canonical === null || offer === '' || offer.length > 64) return null;
  return { submissionId, values: { offerId: offer, quantity: canonical }, correlationId: null };
}

function OrderForm({
  offers,
  csrfToken,
  submissionId,
  newOrderHref,
  productId,
  binding,
  initial,
}: PlaceOrderFormProps & { initial: PlaceOrderFormState }) {
  const send = useCallback(
    async (previous: PlaceOrderFormState, form: FormData): Promise<PlaceOrderFormState> => {
      const firstSend = previous.kind !== 'UNCONFIRMED';
      // Remember it BEFORE it is sent (F1): from here until an answer, a reload or
      // a lost response must find the same key, not mint another.
      const unsent = firstSend ? pendingFrom(form) : null;
      // If it cannot be remembered it is not sent: a lost response would leave a
      // committed order and a reload that mints another key.
      if (unsent && !saveUnresolvedOrder(productId, unsent, binding)) {
        return { kind: 'STORAGE_UNAVAILABLE' };
      }

      let next: PlaceOrderFormState;
      try {
        next = await submitPlaceOrder(previous, form);
      } catch (error) {
        // The order was placed: the action redirects to it. Nothing is unresolved now.
        if (isRedirect(error)) {
          clearUnresolvedOrder(productId);
          throw error;
        }
        // The call itself failed — a lost response after the order may have
        // committed, or the portal's own gate answering 401 JSON to an action POST
        // whose session has ended, which Next rejects as an "unexpected response".
        // Either way the doubt is still there, and so is the stored entry. Only
        // `/auth/session` answering 401 says the session ended; anything else —
        // its 503 for a refresh unavailable for now among them — keeps the retry
        // (same key, same body).
        const ended = await sessionHasEnded();
        if (!firstSend) {
          return withRetryNote(
            previous as UnconfirmedPlaceOrder,
            ended ? 'sessionEnded' : 'retryUnknown',
          );
        }
        if (unsent) {
          return ended
            ? { kind: 'UNCONFIRMED', ...unsent, sessionEnded: true }
            : { kind: 'UNCONFIRMED', ...unsent };
        }
        throw error;
      }
      if (firstSend) {
        // Answered: with the correlation id if it is still in doubt, else settled.
        if (next.kind === 'UNCONFIRMED') saveUnresolvedOrder(productId, next, binding);
        else if (unsent) clearUnresolvedOrder(productId);
      }
      return next;
    },
    [productId, binding],
  );
  const [state, action, pending] = useActionState(send, initial);

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedOrder
        state={state}
        action={action}
        pending={pending}
        csrfToken={csrfToken}
        offers={offers}
        newOrderHref={newOrderHref}
        onStartNew={() => clearUnresolvedOrder(productId)}
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

  if (state.kind === 'REFUSED' && state.reason === 'PROVIDER_UNKNOWN') {
    return <ProviderUnknownRefusal />;
  }

  if (state.kind === 'REFUSED') {
    return (
      <Alert tone="danger">
        {isSessionRefusal(state.reason)
          ? SESSION_REFUSAL_MESSAGES[state.reason]
          : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
      </Alert>
    );
  }

  if (state.kind === 'STORAGE_UNAVAILABLE') {
    return (
      <Alert tone="danger">
        سفارش ارسال نشد: در این مرورگر نمی‌توان سفارش را به‌طور امن ثبت کرد، چون ذخیره‌سازی مرورگر
        در دسترس نیست (مثلاً حالت خصوصی یا حافظهٔ پر). از مرورگر دیگری استفاده کنید یا فضا را آزاد
        کنید و دوباره تلاش کنید.
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
  onStartNew,
}: {
  state: UnconfirmedPlaceOrder;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  offers: readonly Offer[];
  newOrderHref: string;
  /** Forgets the unresolved order: called by the one action that is allowed to. */
  onStartNew: () => void;
}) {
  const offer = offers.find((candidate) => candidate.id === state.values.offerId);
  // A restored order from another login, or a call the gate refused because the
  // session ended: its id cannot be sent now, and sending it after a re-login is
  // not an option either (the id is bound to the old login).
  const canRetry = !state.viewOnly && !state.sessionEnded;
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
        خود را ببینید.{state.correlationId ? ` کد پیگیری: ${state.correlationId}` : ''}
      </Alert>
      {state.retryRefused ? (
        <Alert tone="warning">
          ارسال دوباره رد شد و نتیجهٔ درخواست نخست همچنان معلوم نیست؛ ممکن است سفارش ثبت شده باشد.
          فهرست سفارش‌ها را ببینید.
        </Alert>
      ) : null}
      {state.retryUnknown ? (
        <Alert tone="warning">
          ارسال دوباره نیز نتیجهٔ روشنی نداشت و وضعیت درخواست نخست همچنان معلوم نیست؛ ممکن است سفارش
          ثبت شده باشد. فهرست سفارش‌ها را ببینید.
        </Alert>
      ) : null}
      {state.sessionEnded ? (
        <Alert tone="danger">
          نشست شما پایان یافته است. دوباره وارد شوید و پیش از ثبت سفارش تازه، فهرست سفارش‌ها را
          ببینید؛ ممکن است سفارش ثبت شده باشد.
        </Alert>
      ) : null}
      {state.viewOnly ? (
        <Alert tone="warning">
          این سفارش در نشست پیشین فرستاده شده بود و از این نشست نمی‌توان آن را دوباره فرستاد. پیش از
          ثبت سفارش تازه، فهرست سفارش‌ها را ببینید.
        </Alert>
      ) : null}
      <p className="text-sm text-content-muted">
        {offer ? `${offer.supplierOrganizationId} — ` : ''}
        تعداد {toPersianDigits(state.values.quantity)}
      </p>
      <div className="flex flex-wrap gap-2">
        {canRetry ? (
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ارسال…' : 'ارسال دوبارهٔ همین درخواست'}
          </Button>
        ) : null}
        {/* A full navigation: the page mints a fresh submission id. Forgets the unresolved order first. */}
        <a
          href={newOrderHref}
          onClick={onStartNew}
          onAuxClick={onStartNew}
          className="underline self-center text-sm"
        >
          شروع سفارش تازه
        </a>
      </div>
      <p className="text-sm text-content-muted">
        {canRetry
          ? '«ارسال دوباره» همان درخواست را با همان شناسهٔ ارسال می‌فرستد و ممکن است سفارش پیشین را برگرداند، اما این تضمین نیست؛ فهرست سفارش‌ها مرجع است. '
          : 'فهرست سفارش‌ها مرجع است. '}
        «شروع سفارش تازه» درخواست جدیدی است.
      </p>
    </form>
  );
}

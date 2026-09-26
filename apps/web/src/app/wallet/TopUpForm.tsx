'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { EMPTY_TOP_UP_FORM } from '@/lib/wallet-fields';

import { submitTopUp } from './actions';
import { IDLE_TOP_UP_FORM, type TopUpFormState } from './form-state';

/**
 * Adding funds — simulated, and said so on the form itself.
 *
 * `CLAUDE.md`: "هرگز ادعای اتصال بانکی نکن." There is no card field, no bank
 * name and no "پرداخت امن" trust badge here, because none of them would be
 * true — `economic-service`'s own `provider()` disclosure (rendered above
 * this form by `WalletScreen`) is what a client is required to surface
 * before showing anything that could be read as a payment flow. This form
 * asks for one thing, an amount, and calls the result what it is: a
 * platform-recorded top-up, not a purchase.
 */
export function TopUpForm({
  walletId,
  csrfToken,
  submissionId,
}: {
  walletId: string;
  csrfToken: string;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(
    submitTopUp.bind(null, walletId),
    IDLE_TOP_UP_FORM,
  );

  const values = state.kind === 'INVALID' ? state.values : EMPTY_TOP_UP_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const currentSubmissionId = state.kind === 'INVALID' ? state.submissionId : submissionId;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />

      <FormBanner state={state} />

      <Field label="مبلغ (ریال)" required error={errors.amountMinor}>
        {(control) => (
          <input
            {...control}
            name="amountMinor"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={values.amountMinor}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ثبت…' : 'افزایش موجودی نمایشی'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: TopUpFormState }) {
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
      <Alert tone="danger">
        اجازهٔ افزایش موجودی به شما داده نشده است. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'UNCONFIRMED') {
    return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        ثبت نشد و موجودی تغییر نکرد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}

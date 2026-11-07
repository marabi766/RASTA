'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { ProviderUnknownRefusal } from '@/app/DemoModeNotice';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { EMPTY_TOP_UP_FORM } from '@/lib/wallet-fields';
import { isSessionRefusal, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';

import { UnresolvedTopUpNotice } from './UnresolvedTopUpNotice';
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
  initialState = IDLE_TOP_UP_FORM,
}: {
  walletId: string;
  csrfToken: string;
  submissionId: string;
  initialState?: TopUpFormState;
}) {
  const [state, action, pending] = useActionState(submitTopUp.bind(null, walletId), initialState);

  const held = state.kind === 'HELD' || state.kind === 'UNCONFIRMED';
  const locked = held || state.kind === 'NOT_CHECKED';
  const values =
    state.kind === 'INVALID' || held ? (state.values ?? EMPTY_TOP_UP_FORM) : EMPTY_TOP_UP_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const currentSubmissionId = state.kind === 'INVALID' || held ? state.submissionId : submissionId;

  const form = (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId ?? ''} />

      <FormBanner state={state} />

      <Field label="مبلغ (ریال)" required error={errors.amountMinor}>
        {(control) => (
          <input
            {...control}
            key={locked ? `held:${currentSubmissionId}:${values.amountMinor}` : 'editing'}
            name="amountMinor"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={values.amountMinor}
            readOnly={locked}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" tone="secondary" disabled={pending || locked}>
          {pending ? 'در حال ثبت…' : 'افزایش موجودی نمایشی'}
        </Button>
      </div>
    </form>
  );
  return (
    <>
      {(state.kind === 'HELD' || state.kind === 'NOT_CHECKED') && state.releaseToken ? (
        <UnresolvedTopUpNotice
          walletId={walletId}
          csrfToken={csrfToken}
          releaseToken={state.releaseToken}
        />
      ) : null}
      {form}
    </>
  );
}

function FormBanner({ state }: { state: TopUpFormState }) {
  if (state.kind === 'HELD' || state.kind === 'NOT_CHECKED') {
    return (
      <Alert tone="warning">
        نتیجهٔ درخواست پیشین مشخص نیست. پیش از افزایش موجودی دوباره، تراکنش‌ها را بررسی کنید.
      </Alert>
    );
  }

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

'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { driverStatusOptions } from '@/lib/labels';
import { EMPTY_CHANGE_STATUS_FORM } from '@/lib/driver-fields';

import { submitChangeStatus } from './actions';
import { IDLE_CHANGE_STATUS_FORM, type ChangeStatusFormState } from './form-state';

/**
 * Changing a driver's status — suspend, deactivate, or reinstate.
 *
 * `status` only offers what `services/fleet-service/src/fleet/driver-lifecycle.ts`
 * actually allows from here — not merely "anything but the current status":
 * `DEACTIVATED` is terminal and permits nothing, so excluding only the
 * current value would still offer an illegal move out of it. This table is
 * presentation only, the same UX role `docs/16 § ۱۶٫۱۱` gives every client
 * check — fleet-service's own `assertDriverTransition` is the enforcement,
 * regardless of what this form offers.
 *
 * `reason` is required, not merely encouraged: AGENTS.md S-06 asks every
 * state change to say who did what and why, and fleet-service enforces the
 * same requirement server-side regardless of what this form does.
 */
const LEGAL_NEXT_STATUSES: Readonly<Record<string, readonly string[]>> = {
  ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
  SUSPENDED: ['ACTIVE', 'DEACTIVATED'],
  DEACTIVATED: [],
};

export function ChangeStatusForm({
  driverId,
  currentStatus,
  csrfToken,
  submissionId,
}: {
  driverId: string;
  currentStatus: string;
  csrfToken: string;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(
    submitChangeStatus.bind(null, driverId),
    IDLE_CHANGE_STATUS_FORM,
  );

  const values = state.kind === 'INVALID' ? state.values : EMPTY_CHANGE_STATUS_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const currentSubmissionId = state.kind === 'INVALID' ? state.submissionId : submissionId;

  const legal = LEGAL_NEXT_STATUSES[currentStatus] ?? [];
  const options = driverStatusOptions.filter((option) => legal.includes(option.value));
  // A driver already DEACTIVATED has no legal next status at all — the
  // lifecycle is terminal — so the form has nothing to offer and says so
  // rather than rendering empty or, worse, illegal controls.
  if (options.length === 0) return null;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />

      <FormBanner state={state} />

      <Field label="وضعیت تازه" required error={errors.status}>
        {(control) => (
          <select
            {...control}
            name="status"
            defaultValue={values.status}
            className={controlClassName}
          >
            <option value="" disabled>
              انتخاب کنید
            </option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="دلیل" required error={errors.reason}>
        {(control) => (
          <textarea
            {...control}
            name="reason"
            rows={2}
            defaultValue={values.reason}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ثبت…' : 'اعمال تغییر وضعیت'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: ChangeStatusFormState }) {
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
        اجازهٔ تغییر وضعیت این راننده به شما داده نشده است. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        اعمال نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}

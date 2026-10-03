'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { assetTypeOptions } from '@/lib/labels';
import {
  EMPTY_REGISTER_ASSET_FORM,
  type RegisterAssetField,
  type RegisterAssetFormValues,
} from '@/lib/asset-form-fields';

import { submitRegisterAsset } from './actions';
import { IDLE_REGISTER_ASSET_FORM, type RegisterAssetFormState } from './form-state';

/**
 * The registration form (ثبت ماشین). A plain `<form>` around a server action,
 * so it works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * It registers the machine and nothing else: a new machine is `REGISTERED`, and
 * entering the fleet is a separate step that needs an insurance policy and an
 * ownership document, neither of which is collected here.
 */

const LABELS: Record<RegisterAssetField, string> = {
  name: 'نام ماشین',
  type: 'نوع ماشین',
  assetTag: 'شمارهٔ دارایی',
  manufacturer: 'سازنده',
  model: 'مدل',
  serialNumber: 'شمارهٔ سریال',
  manufactureYear: 'سال ساخت',
  siteName: 'محل نگهداری',
  addressLine: 'نشانی',
};

function valuesOf(state: RegisterAssetFormState): RegisterAssetFormValues {
  return state.kind === 'INVALID' ? state.values : EMPTY_REGISTER_ASSET_FORM;
}

function errorsOf(state: RegisterAssetFormState): Partial<Record<RegisterAssetField, string>> {
  return state.kind === 'INVALID' ? state.fieldErrors : {};
}

export function RegisterAssetForm({
  csrfToken,
  submissionId,
}: {
  csrfToken: string;
  /**
   * Minted for this render and bound to this session. A retry of the same form
   * carries the same reference; asset-service stores it on the create path
   * since issue 193 (the same key and body answer the original 201 while the key
   * lives), and the unconfirmed state stays the honest answer when a send's
   * outcome is unknown (see `server/submission.ts`).
   */
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(submitRegisterAsset, IDLE_REGISTER_ASSET_FORM);

  const values = valuesOf(state);
  const errors = errorsOf(state);
  const currentSubmissionId = state.kind === 'INVALID' ? state.submissionId : submissionId;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />

      <FormBanner state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.name} required error={errors.name}>
          {(control) => (
            <input
              {...control}
              name="name"
              defaultValue={values.name}
              maxLength={200}
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.type} required error={errors.type}>
          {(control) => (
            <select
              {...control}
              name="type"
              defaultValue={values.type}
              className={controlClassName}
            >
              <option value="" disabled>
                انتخاب کنید
              </option>
              {assetTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.assetTag} error={errors.assetTag} hint="پلاک یا شمارهٔ ناوگان">
          {(control) => (
            <input
              {...control}
              name="assetTag"
              defaultValue={values.assetTag}
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
            />
          )}
        </Field>

        <Field
          label={LABELS.serialNumber}
          error={errors.serialNumber}
          hint="پس از ثبت قابل تغییر نیست"
        >
          {(control) => (
            <input
              {...control}
              name="serialNumber"
              defaultValue={values.serialNumber}
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={LABELS.manufacturer} error={errors.manufacturer}>
          {(control) => (
            <input
              {...control}
              name="manufacturer"
              defaultValue={values.manufacturer}
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.model} error={errors.model}>
          {(control) => (
            <input
              {...control}
              name="model"
              defaultValue={values.model}
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.manufactureYear} error={errors.manufactureYear} hint="۱۳۰۰ تا ۲۱۰۰">
          {(control) => (
            <input
              {...control}
              name="manufactureYear"
              defaultValue={values.manufactureYear}
              inputMode="numeric"
              maxLength={4}
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.siteName} error={errors.siteName}>
          {(control) => (
            <input
              {...control}
              name="siteName"
              defaultValue={values.siteName}
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.addressLine} error={errors.addressLine}>
          {(control) => (
            <input
              {...control}
              name="addressLine"
              defaultValue={values.addressLine}
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ثبت…' : 'ثبت ماشین'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: RegisterAssetFormState }) {
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
        اجازهٔ ثبت ماشین به شما داده نشده است. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'UNCONFIRMED') {
    return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        ثبت انجام نشد و چیزی ذخیره نشد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}

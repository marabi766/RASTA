'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import type { UpdateAssetField, UpdateAssetFormValues } from '@/lib/asset-form-fields';

import { submitUpdateAsset } from './actions';
import { IDLE_UPDATE_ASSET_FORM, type UpdateAssetFormState } from './form-state';

/**
 * Editing a machine (ویرایش مشخصات). Pre-filled from the dossier's own read,
 * so a blank field is a field that was already blank and is sent as a clear.
 *
 * The type and the serial number are not editable and are not shown as if they
 * were: asset-service's update schema has neither. The serial number names one
 * physical machine, so changing it would make this a different asset.
 */

const LABELS: Record<UpdateAssetField, string> = {
  name: 'نام ماشین',
  assetTag: 'شمارهٔ دارایی',
  manufacturer: 'سازنده',
  model: 'مدل',
  manufactureYear: 'سال ساخت',
};

function errorsOf(state: UpdateAssetFormState): Partial<Record<UpdateAssetField, string>> {
  return state.kind === 'INVALID' ? state.fieldErrors : {};
}

export function UpdateAssetForm({
  assetId,
  csrfToken,
  submissionId,
  initialValues,
}: {
  assetId: string;
  csrfToken: string;
  /** Minted for this render; reused on a retry so a retry is not a second edit. */
  submissionId: string;
  /** The machine's current record, as form text. */
  initialValues: UpdateAssetFormValues;
}) {
  const [state, action, pending] = useActionState(
    submitUpdateAsset.bind(null, assetId),
    IDLE_UPDATE_ASSET_FORM,
  );

  const values = state.kind === 'INVALID' ? state.values : initialValues;
  const errors = errorsOf(state);
  const currentSubmissionId = state.kind === 'INVALID' ? state.submissionId : submissionId;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />

      <FormBanner state={state} />

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

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.assetTag} error={errors.assetTag}>
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
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ذخیره…' : 'ذخیرهٔ مشخصات'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: UpdateAssetFormState }) {
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
        اجازهٔ ویرایش این ماشین به شما داده نشده است. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'NOT_FOUND') {
    return (
      <Alert tone="danger">
        این ماشین دیگر در دسترس شما نیست یا وجود ندارد. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'UNCONFIRMED') {
    return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        ذخیره انجام نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید. کد پیگیری:{' '}
        {state.correlationId}
      </Alert>
    );
  }

  return null;
}

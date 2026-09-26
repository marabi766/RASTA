'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import type {
  UpdateOrganizationField,
  UpdateOrganizationFormValues,
} from '@/lib/organization-fields';

import { submitUpdateOrganization } from './actions';
import { IDLE_UPDATE_ORGANIZATION_FORM, type UpdateOrganizationFormState } from './form-state';

/**
 * The organization's own profile. Three fields, because
 * `updateOrganizationSchema` accepts three — `organization-fields.ts` says
 * what is missing and why.
 *
 * The organization id rides as a hidden input rather than being bound into
 * the action: this page renders exactly one organization, but the id comes
 * from the session's active tenant, and a hidden input keeps the form working
 * without JavaScript the same way every other write in this portal does.
 */

const LABELS: Record<UpdateOrganizationField, string> = {
  name: 'نام سازمان',
  shortName: 'نام کوتاه',
  externalCode: 'کد بیرونی',
};

export function OrganizationProfileForm({
  organizationId,
  csrfToken,
  submissionId,
  initialValues,
}: {
  organizationId: string;
  csrfToken: string;
  submissionId: string;
  initialValues: UpdateOrganizationFormValues;
}) {
  const [state, action, pending] = useActionState(
    submitUpdateOrganization,
    IDLE_UPDATE_ORGANIZATION_FORM,
  );

  const values = state.kind === 'INVALID' ? state.values : initialValues;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const currentSubmissionId = state.kind === 'INVALID' ? state.submissionId : submissionId;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />
      <input type="hidden" name="organizationId" value={organizationId} />

      <ProfileBanner state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.name} error={errors.name}>
          {(control) => (
            <input
              {...control}
              name="name"
              defaultValue={values.name}
              required
              maxLength={200}
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.shortName} error={errors.shortName} hint="خالی بگذارید تا پاک شود">
          {(control) => (
            <input
              {...control}
              name="shortName"
              defaultValue={values.shortName}
              maxLength={200}
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <Field label={LABELS.externalCode} error={errors.externalCode} hint="خالی بگذارید تا پاک شود">
        {(control) => (
          <input
            {...control}
            name="externalCode"
            defaultValue={values.externalCode}
            maxLength={64}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ذخیره…' : 'ذخیرهٔ تغییرات'}
        </Button>
      </div>
    </form>
  );
}

function ProfileBanner({ state }: { state: UpdateOrganizationFormState }) {
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
        اجازهٔ ویرایش مشخصات این سازمان به شما داده نشده است. کد پیگیری: {state.correlationId}
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

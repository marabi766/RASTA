'use client';

import { useActionState, type ReactNode } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  DOCUMENT_KINDS,
  EMPTY_ATTACH_DOCUMENT_FORM,
  FILE_FIELD,
  UPLOAD_TOKEN_FIELD,
} from '@/lib/asset-document-fields';
import { documentKindLabel } from '@/lib/labels';

import { IDLE_DOCUMENT_FORM, type DocumentFormState } from './document-form-state';
import { submitAttachDocument } from './document-actions';

/**
 * The attach-document command on a machine's page, as a plain `<form>` around a
 * server action so it works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * It names neither its asset nor its document in a field: the action is bound to
 * the page's asset (`action.bind(null, assetId)`), the signed baseline beside it
 * names the same asset, and the only document an attempt can attach is the one
 * the person's own file produced — or, on a resend, the one this server
 * registered for this very submission and signed (`resume`).
 *
 * `encType` is multipart, set by React for a server action's `FormData`; the file
 * goes to this portal's server and from there to storage — the browser never
 * talks to storage (`server/asset-documents.ts`).
 */

export interface DocumentIdentity {
  /** The page's asset, which the action is bound to. */
  readonly assetId: string;
  readonly csrfToken: string;
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /** The asset, signed for this session (`sealAssetDocumentBaseline`). */
  readonly baseline: string;
}

/** A retry of the same form carries the same reference. */
function submissionOf(state: DocumentFormState, minted: string): string {
  return state.kind === 'INVALID' ? state.submissionId : minted;
}

/** The token of a document this submission already registered, if the last attempt got that far. */
function resumeOf(state: DocumentFormState): string | null {
  switch (state.kind) {
    case 'INVALID':
    case 'FAILED':
    case 'UNCONFIRMED':
      return state.resume;
    default:
      return null;
  }
}

function Banner({ state }: { state: DocumentFormState }) {
  switch (state.kind) {
    case 'INVALID':
      return state.message ? <Alert tone="warning">{state.message}</Alert> : null;
    case 'REFUSED':
      return (
        <Alert tone="danger">
          {state.reason === 'NO_SESSION'
            ? 'نشست شما پایان یافته است. دوباره وارد شوید و فرم را بفرستید.'
            : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
        </Alert>
      );
    case 'FORBIDDEN':
      return (
        <Alert tone="danger">
          اجازهٔ پیوست مدرک به شما داده نشده است. کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'NOT_FOUND':
      // The platform answers "no such machine" and "somebody else's" the same way.
      return (
        <Alert tone="danger">
          این دارایی پیدا نشد یا در سازمان فعال شما نیست. کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'UNCONFIRMED':
      return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
    case 'FAILED':
      return (
        <Alert tone="danger">
          {state.resume
            ? 'فایل بارگذاری شد اما پیوست آن به دارایی انجام نشد. دوباره بفرستید؛ فایل دوباره بارگذاری نمی‌شود.'
            : 'انجام نشد و چیزی پیوست نشد. می‌توانید دوباره بفرستید.'}{' '}
          کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'IDLE':
      return null;
  }
}

/** Stays closed until asked for, and opens again when an attempt came back with something to read. */
function Disclosure({
  summary,
  open,
  children,
}: {
  summary: string;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open ? true : undefined}>
      <summary className="cursor-pointer text-content underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {summary}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}

export function AttachDocumentForm(identity: DocumentIdentity) {
  const [state, action, pending] = useActionState<DocumentFormState, FormData>(
    submitAttachDocument.bind(null, identity.assetId),
    IDLE_DOCUMENT_FORM,
  );

  const values = state.kind === 'INVALID' ? state.values : EMPTY_ATTACH_DOCUMENT_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const resume = resumeOf(state);

  return (
    <Disclosure summary="پیوست مدرک…" open={state.kind !== 'IDLE'}>
      <form
        action={action}
        className="flex flex-col gap-4"
        aria-label="پیوست مدرک"
        // A re-render with a new `resume` must not keep a stale picked file out
        // of the way: the key changes only when a document was registered.
        key={resume ?? 'fresh'}
      >
        <input type="hidden" name={CSRF_FIELD} value={identity.csrfToken} />
        <input
          type="hidden"
          name={SUBMISSION_FIELD}
          value={submissionOf(state, identity.submissionId)}
        />
        <input type="hidden" name={BASELINE_FIELD} value={identity.baseline} />
        {resume ? <input type="hidden" name={UPLOAD_TOKEN_FIELD} value={resume} /> : null}
        <Banner state={state} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نوع مدرک" required error={errors.kind}>
            {(control) => (
              <select
                {...control}
                name="kind"
                // React reads a select's `defaultValue` once, at mount. The form
                // is reset after every action, and a select whose default moved
                // since (blank → the kind just chosen) would reset to the
                // blank it mounted with and lose the choice: the next send would
                // carry no kind. Keying by the default remounts it with the new
                // one; the text inputs follow their `defaultValue` unaided.
                key={values.kind}
                defaultValue={values.kind}
                className={controlClassName}
              >
                <option value="">انتخاب کنید…</option>
                {DOCUMENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {documentKindLabel(kind)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="عنوان" required error={errors.title}>
            {(control) => (
              <input
                {...control}
                name="title"
                type="text"
                defaultValue={values.title}
                maxLength={200}
                autoComplete="off"
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="تاریخ صدور" error={errors.issuedAt} hint="اختیاری.">
            {(control) => (
              <input
                {...control}
                name="issuedAt"
                type="date"
                defaultValue={values.issuedAt}
                className={controlClassName}
              />
            )}
          </Field>
          <Field
            label="تاریخ انقضا"
            error={errors.expiresAt}
            hint="اختیاری؛ مدرک از آغاز این روز منقضی شمرده می‌شود."
          >
            {(control) => (
              <input
                {...control}
                name="expiresAt"
                type="date"
                defaultValue={values.expiresAt}
                className={controlClassName}
              />
            )}
          </Field>
        </div>

        {resume ? (
          <Alert tone="info">
            فایل پیش‌تر بارگذاری و ثبت شده است؛ فرستادن دوباره فقط پیوست آن به دارایی را تکرار
            می‌کند.
          </Alert>
        ) : (
          <Field
            label="فایل"
            required
            error={errors.file}
            hint={
              state.kind === 'IDLE'
                ? 'نوع و حجم مجاز را سامانهٔ اسناد تعیین می‌کند؛ اگر فایل پذیرفته نشود دلیلش همین‌جا نوشته می‌شود.'
                : 'مرورگر فایل را پس از هر تلاش پاک می‌کند؛ آن را دوباره انتخاب کنید.'
            }
          >
            {(control) => (
              <input {...control} name={FILE_FIELD} type="file" className={controlClassName} />
            )}
          </Field>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال بارگذاری…' : 'بارگذاری و پیوست'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

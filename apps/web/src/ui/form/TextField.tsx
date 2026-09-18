'use client';

import type { FieldPath, FieldValues, UseFormReturn } from 'react-hook-form';
import type { ReactNode } from 'react';

import { normalizePersianText } from '@/lib/format';

import { Field, controlClassName } from './Field';

/**
 * A text input bound to a React Hook Form field.
 *
 * It takes the whole `form` rather than a value and a setter, so the field's
 * error comes from the same resolver that validates the submission. A field
 * that carried its own validation would be a second definition of the rule,
 * and the two would drift — which is the exact failure the single-schema rule
 * in docs/16 § 16.1 exists to prevent.
 *
 * On blur the value is normalised: Arabic letter forms become their Persian
 * counterparts and invisible whitespace is collapsed. It happens on blur
 * rather than on every keystroke because rewriting a character under someone's
 * cursor while they are still typing is disorienting, and because the value
 * only has to be correct by the time it is validated or sent.
 *
 * `dir` is left to the document except where a caller says otherwise. A
 * Persian name in a right-to-left document needs nothing; an email address or
 * a plate number reads better as `dir="ltr"`, and the caller is the one who
 * knows which it is.
 */
export function TextField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  type = 'text',
  dir,
  placeholder,
  autoComplete,
  normalize = true,
}: {
  form: UseFormReturn<TValues>;
  name: FieldPath<TValues>;
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  type?: 'text' | 'email' | 'tel' | 'url';
  dir?: 'rtl' | 'ltr';
  placeholder?: string;
  autoComplete?: string;
  /** Turn off for values where Arabic letters are meaningful, such as a quotation. */
  normalize?: boolean;
}) {
  const { onBlur, ...registered } = form.register(name);
  const error = form.formState.errors[name]?.message;

  return (
    <Field
      label={label}
      hint={hint}
      required={required}
      error={typeof error === 'string' ? error : undefined}
    >
      {(control) => (
        <input
          {...control}
          {...registered}
          type={type}
          dir={dir}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className={controlClassName}
          onBlur={async (event) => {
            if (normalize) {
              const normalised = normalizePersianText(event.target.value);
              if (normalised !== event.target.value) {
                form.setValue(name, normalised as never, { shouldDirty: true });
              }
            }
            await onBlur(event);
          }}
        />
      )}
    </Field>
  );
}

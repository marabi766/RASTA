'use client';

import * as LabelPrimitive from '@radix-ui/react-label';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * The parts every field shares: a label, an optional hint, an error message,
 * and the wiring that ties the three to the control.
 *
 * That wiring is the reason this component exists. A label that is not
 * associated with its input is a label a screen reader never reads, and an
 * error message that is not in `aria-describedby` is one a screen-reader user
 * never hears — they hear "invalid entry" with no idea what is wrong. Getting
 * it right needs four ids to agree, which is exactly the kind of thing a human
 * gets wrong once per form and a component gets right every time.
 *
 * Radix's `Label` rather than a bare `<label>` because it also suppresses the
 * text selection a double-click on a label otherwise causes, which on a form
 * full of fields is a small, constant annoyance.
 *
 * `children` is a render prop: the field owns the ids, the caller owns the
 * control, and the ids reach the control without a caller having to repeat
 * them.
 */
export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': boolean | undefined;
  'aria-required': boolean | undefined;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  children,
  className,
}: {
  label: ReactNode;
  /** Guidance shown before anything goes wrong. */
  hint?: ReactNode;
  /** The validation message, when there is one. */
  error?: string;
  required?: boolean;
  children: (props: FieldControlProps) => ReactNode;
  className?: string;
}) {
  const base = useId();
  const controlId = `${base}-control`;
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <LabelPrimitive.Root htmlFor={controlId} className="text-sm font-medium text-content">
        {label}
        {required ? (
          <>
            {/* The asterisk is decoration; `aria-required` on the control is
                what actually conveys the requirement. */}
            <span aria-hidden="true" className="text-danger">
              {' *'}
            </span>
          </>
        ) : null}
      </LabelPrimitive.Root>

      {children({
        id: controlId,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
      })}

      {hint ? (
        <p id={hintId} className="text-xs text-content-subtle">
          {hint}
        </p>
      ) : null}

      {error ? (
        // `role="alert"` so the message is announced when it appears, rather
        // than only when focus happens to land back on the field.
        <p id={errorId} role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The input styling every control in the library shares. */
export const controlClassName =
  'w-full rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content placeholder:text-content-subtle aria-invalid:border-danger';

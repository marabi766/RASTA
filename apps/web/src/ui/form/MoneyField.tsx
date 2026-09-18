'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { FieldPath, FieldValues, UseFormReturn } from 'react-hook-form';

import { IRR, MoneyInputError, formatMoney, parseMoneyInput } from '@/lib/format';
import type { CurrencyFormat } from '@/lib/format/money';

import { Field, controlClassName } from './Field';

/**
 * An amount of money.
 *
 * docs/16 § 16.5 sets the contract, and every part of it is load-bearing:
 *
 *     stored / API   "10000000"          a string of minor units
 *     displayed      ۱۰٬۰۰۰٬۰۰۰ ریال    Persian digits, grouped
 *     typed          either form          normalised to minor units
 *
 * The field keeps two values, and that is the whole design. The form holds the
 * canonical minor-unit string — what will be sent, validated and stored. The
 * input holds what the person is typing. They are only reconciled on blur,
 * because normalising mid-keystroke would move the caret and regroup digits
 * under someone's fingers, and because a half-typed number is not yet a number.
 *
 * `parseMoneyInput` accepts Persian, Arabic-Indic and Latin digits and every
 * grouping mark a keyboard or a paste produces. It never uses `parseFloat` and
 * never produces a `number`: an amount past `Number.MAX_SAFE_INTEGER` is
 * ordinary in rial, and a float would have lost its last digits before the
 * value reached the form.
 *
 * `inputMode="decimal"` rather than `type="number"`: a numeric input rejects
 * the grouping marks and the Persian digits the user is entitled to type, and
 * on a phone it offers a keypad while still accepting them as text.
 */
export function MoneyField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  currency = IRR,
}: {
  form: UseFormReturn<TValues>;
  /** The form field holding the **minor-unit string**, not the display text. */
  name: FieldPath<TValues>;
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  currency?: CurrencyFormat;
}) {
  const storedValue = form.watch(name);
  const [draft, setDraft] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | undefined>(undefined);

  const displayed =
    draft ??
    (typeof storedValue === 'string' && storedValue !== ''
      ? formatMoney(storedValue, currency, { withLabel: false })
      : '');

  const validationError = form.formState.errors[name]?.message;
  const error = parseError ?? (typeof validationError === 'string' ? validationError : undefined);

  function commit(raw: string) {
    setDraft(null);
    if (raw.trim() === '') {
      setParseError(undefined);
      form.setValue(name, '' as never, { shouldDirty: true, shouldValidate: true });
      return;
    }
    try {
      const minor = parseMoneyInput(raw, currency);
      setParseError(undefined);
      form.setValue(name, minor.toString() as never, { shouldDirty: true, shouldValidate: true });
    } catch (cause) {
      if (cause instanceof MoneyInputError) {
        // The typed text is kept on screen. Clearing someone's input because
        // it did not parse is the fastest way to make them retype a long
        // number they had almost right.
        setDraft(raw);
        setParseError(cause.message);
        return;
      }
      throw cause;
    }
  }

  return (
    <Field
      // The currency goes into the label rather than being left to the suffix
      // beside the input. A suffix is decoration a screen reader in forms mode
      // skips, and "۱۲٬۰۰۰٬۰۰۰" with no unit is not an amount.
      label={
        <>
          {label} <span className="font-normal text-content-subtle">({currency.label})</span>
        </>
      }
      hint={hint}
      required={required}
      error={error}
    >
      {(control) => (
        <div className="flex items-center gap-2">
          <input
            {...control}
            name={name}
            inputMode="decimal"
            autoComplete="off"
            value={displayed}
            className={controlClassName}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
          />
          <span aria-hidden="true" className="shrink-0 text-sm text-content-muted">
            {currency.label}
          </span>
        </div>
      )}
    </Field>
  );
}

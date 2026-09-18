'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import type { FieldValues, UseFormProps, UseFormReturn } from 'react-hook-form';
import type { ReactNode } from 'react';
import type { z } from 'zod';

import { cn } from '../cn';

/**
 * A form whose validation comes from a Zod schema.
 *
 * docs/16 § 16.1 states the rule as a constraint: *«Zod Schema از
 * `@rasta/contracts` می‌آید. یک تعریف: هم اعتبارسنجی فرم، هم اعتبارسنجی سرور،
 * هم نوع TypeScript، هم مستند OpenAPI.»* This hook is what makes that
 * mechanical — the schema a caller passes is the same object the service
 * validates against, so a form and an API cannot drift into disagreeing about
 * what a valid request is. If they do, it is a type error rather than a
 * rejected submission the user has to decipher.
 *
 * `mode: 'onTouched'` is the default here on purpose. Validating on every
 * keystroke shows an error before someone has finished typing the first field,
 * and validating only on submit hides every problem until the end; validating
 * when a field is left is the one that matches how people actually fill a
 * form.
 */
export function useSchemaForm<TSchema extends z.ZodType<FieldValues>>(
  schema: TSchema,
  options?: Omit<UseFormProps<z.input<TSchema>>, 'resolver'>,
): UseFormReturn<z.input<TSchema>> {
  return useForm<z.input<TSchema>>({
    mode: 'onTouched',
    ...options,
    // The generics of the resolver and of `useForm` describe the same schema
    // from two directions, and TypeScript cannot see that they meet. The cast
    // is confined to this one line rather than leaking into every call site.
    resolver: zodResolver(schema) as never,
  });
}

/**
 * The form element itself.
 *
 * `noValidate` turns off the browser's own validation. Two validators would
 * disagree — the browser's messages are not localised, not styled, and not
 * derived from the schema — and the one that must win is the schema.
 */
export function Form<TValues extends FieldValues>({
  form,
  onSubmit,
  children,
  actions,
  className,
}: {
  form: UseFormReturn<TValues>;
  onSubmit: (values: TValues) => void | Promise<void>;
  children: ReactNode;
  /** Submit and cancel, kept out of the field flow. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(onSubmit)}
      className={cn('flex flex-col gap-4', className)}
    >
      {children}
      {actions ? <div className="flex flex-wrap items-center gap-2 pt-2">{actions}</div> : null}
    </form>
  );
}

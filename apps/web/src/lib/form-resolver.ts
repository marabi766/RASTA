import { toNestErrors, validateFieldsNatively } from '@hookform/resolvers';
import { appendErrors } from 'react-hook-form';
import type { FieldError, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';
import { legacyParse } from '@rasta/contracts';

import { formIssueMessage } from './form-issues';

/**
 * react-hook-form's resolver for a Zod schema, on the one parse every other
 * boundary uses: `legacyParse` (D-078, PR #444 r4 addendum E). Stock zod
 * decides whether the form is valid and what the values become; only after it
 * refused does the second pass word the issues in zod 3's order, and a pass
 * that cannot falls back to stock zod's refusal — never to acceptance. Each
 * field shows its first issue, as Persian text from {@link formIssueMessage}.
 * `form-issues.spec.ts` refuses any other resolver.
 */
export function legacyFormResolver<TSchema extends z.ZodType<FieldValues, FieldValues>>(
  schema: TSchema,
): Resolver<z.input<TSchema>, unknown, z.output<TSchema>> {
  return (values, _context, options) => {
    const result = legacyParse(schema, values);
    if (result.success) {
      if (options.shouldUseNativeValidation) validateFieldsNatively({}, options);
      return { values: result.data, errors: {} };
    }
    const allCriteria = !options.shouldUseNativeValidation && options.criteriaMode === 'all';
    const errors: Record<string, FieldError> = Object.create(null) as Record<string, FieldError>;
    for (const issue of result.refusal.issues) {
      const name = issue.path.join('.');
      const message = formIssueMessage(issue);
      errors[name] ??= { type: issue.code, message };
      if (allCriteria) {
        const known = errors[name].types?.[issue.code];
        errors[name] = appendErrors(
          name,
          true,
          errors,
          issue.code,
          known ? ([] as string[]).concat(known as string[], message) : message,
        ) as FieldError;
      }
    }
    return { values: {}, errors: toNestErrors(errors, options) };
  };
}

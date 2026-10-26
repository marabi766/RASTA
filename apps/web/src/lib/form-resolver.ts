import { toNestErrors, validateFieldsNatively } from '@hookform/resolvers';
import { appendErrors } from 'react-hook-form';
import type { FieldError, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';
import { legacyParseAsync, type LegacyUnionBranchIssue } from '@rasta/contracts';

import { formIssueMessage } from './form-issues';

/**
 * react-hook-form's resolver for a Zod schema, on the one parse every other
 * boundary uses: `legacyParse`, awaited (`legacyParseAsync`, D-078, PR #444 r4
 * addendum E and r4 F4), so a schema with an async refinement, check,
 * transform or preprocess resolves as it did under `zodResolver`. Stock zod
 * decides whether the form is valid and what the values become; only after it
 * refused does the second pass word the issues in zod 3's order, and a pass
 * that cannot falls back to stock zod's refusal — never to acceptance. Each
 * field shows its first issue, as Persian text from {@link formIssueMessage};
 * a union refused as a whole also routes each option's issues to the option's
 * own fields (r4 F5), as `zodResolver` did with zod's union errors.
 * `form-issues.spec.ts` refuses any other resolver.
 */
export function legacyFormResolver<TSchema extends z.ZodType<FieldValues, FieldValues>>(
  schema: TSchema,
): Resolver<z.input<TSchema>, unknown, z.output<TSchema>> {
  return async (values, _context, options) => {
    const result = await legacyParseAsync(schema, values);
    if (result.success) {
      if (options.shouldUseNativeValidation) validateFieldsNatively({}, options);
      return { values: result.data, errors: {} };
    }
    const allCriteria = !options.shouldUseNativeValidation && options.criteriaMode === 'all';
    const errors: Record<string, FieldError> = Object.create(null) as Record<string, FieldError>;
    // The refusal's issues first, then each union's options, breadth first:
    // a field keeps the first issue that reached it.
    const queue: LegacyUnionBranchIssue[] = result.refusal.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: formIssueMessage(issue),
      branches: result.refusal.unionBranches(issue, formIssueMessage),
    }));
    for (let at = 0; at < queue.length; at += 1) {
      const { path, code, message, branches } = queue[at];
      for (const option of branches ?? []) queue.push(...option);
      const name = path.join('.');
      errors[name] ??= { type: code, message };
      if (allCriteria) {
        const known = errors[name].types?.[code];
        errors[name] = appendErrors(
          name,
          true,
          errors,
          code,
          known ? ([] as string[]).concat(known as string[], message) : message,
        ) as FieldError;
      }
    }
    return { values: {}, errors: toNestErrors(errors, options) };
  };
}

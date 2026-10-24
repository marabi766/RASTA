import type { z } from 'zod';
import { EnvValidationError, type EnvIssue } from './env';
import { envEnumFields } from './env-schema';

/** What a refused environment shows: the issues, the error's message and its stack. */
export interface EnvRefusal {
  readonly issues: readonly EnvIssue[];
  readonly message: string;
  readonly stack: string | undefined;
}

/** One enum setting set to each of two values, and what the service's loader said. */
export interface EnvEnumProbe {
  /** The variable. */
  readonly name: string;
  /** The codes Zod raised under it for the first value — `invalid_enum_value` when the walk is right. */
  readonly codes: readonly string[];
  /** The refusal for each value, in order. */
  readonly refusals: readonly [EnvRefusal, EnvRefusal];
}

/** The `EnvValidationError` `load` throws, as an {@link EnvRefusal}; anything else is rethrown. */
export function envRefusalOf(load: () => unknown): EnvRefusal {
  try {
    load();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    return { issues: error.issues, message: error.message, stack: error.stack };
  }
  throw new Error('expected the environment to be refused');
}

/**
 * For tests (#385 r2 F2): every enum setting of `schema` ({@link envEnumFields}),
 * set in turn to each of two `values` on top of `base`, through the service's
 * own `load`. A spec asserts that both refusals are equal and carry neither
 * value: the refusal does not depend on what was written. A new enum setting
 * is probed without being listed anywhere.
 */
export function envEnumProbes(
  schema: z.ZodTypeAny,
  load: (source: NodeJS.ProcessEnv) => unknown,
  base: NodeJS.ProcessEnv,
  values: readonly [string, string],
): EnvEnumProbe[] {
  return envEnumFields(schema).map(({ name }) => {
    const source = (value: string): NodeJS.ProcessEnv => ({ ...base, [name]: value });
    const parsed = schema.safeParse(source(values[0]));
    const codes = parsed.success
      ? []
      : parsed.error.issues.filter((issue) => issue.path[0] === name).map((issue) => issue.code);
    // One call site for both, so the two stacks can be compared whole.
    const [first, second] = values.map((value) => envRefusalOf(() => load(source(value))));
    return { name, codes, refusals: [first as EnvRefusal, second as EnvRefusal] };
  });
}

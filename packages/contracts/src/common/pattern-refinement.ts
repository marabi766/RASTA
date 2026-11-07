import { z } from 'zod';

const PATTERN_REFINEMENTS = new WeakMap<
  object,
  { pattern: RegExp; predicate: (value: string) => boolean; run: unknown }
>();

/**
 * A pattern check that keeps the legacy `custom` issue and preserves its string input.
 * Only this constructor can register a check; callers cannot register arbitrary callbacks.
 */
export function patternRefinement(pattern: RegExp, message: string): z.core.$ZodCheck<string> {
  // Own the regex: a caller changing the supplied RegExp must not change validation.
  const owned = new RegExp(pattern.source, pattern.flags);
  const predicate = (value: string): boolean => owned.test(value);
  const check = z.refine<string>(predicate, { message });
  PATTERN_REFINEMENTS.set(check, { pattern: owned, predicate, run: check._zod.check });
  return check;
}

/** Read-only converter lookup. Clones share the check; copies and arbitrary checks are untrusted. */
export function publishedRefinementPattern(check: object):
  | Readonly<{
      source: string;
      flags: string;
    }>
  | undefined {
  if (!(check instanceof z.ZodCustom) || check._zod.def.check !== 'custom') return undefined;
  const registered = PATTERN_REFINEMENTS.get(check);
  if (
    !registered ||
    check._zod.check !== registered.run ||
    check._zod.def.fn !== registered.predicate ||
    check._zod.def.when !== undefined
  )
    return undefined;
  return { source: registered.pattern.source, flags: registered.pattern.flags };
}

import { z } from 'zod';

const PATTERN_REFINEMENTS = new WeakMap<
  object,
  { pattern: RegExp; predicate: (value: string) => boolean; unchanged: () => boolean }
>();

/**
 * A pattern check that keeps the legacy `custom` issue and preserves its string input.
 * Only this constructor can register a check; callers cannot register arbitrary callbacks.
 */
export function patternRefinement(pattern: RegExp, message: string): z.core.$ZodCheck<string> {
  if (pattern.global || pattern.sticky) throw new Error('Stateful pattern refinements are refused');
  // Own the regex: a caller changing the supplied RegExp must not change validation.
  const owned = new RegExp(pattern.source, pattern.flags);
  const predicate = (value: string): boolean => owned.test(value);
  // eslint-disable-next-line zod/coercion-boundary -- Reviewed predicate: only RegExp#test on the owned regex above; no conversion, no write to the value.
  const check = z.refine<string>(predicate, { message });
  PATTERN_REFINEMENTS.set(check, { pattern: owned, predicate, unchanged: unchangedCheck(check) });
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
    !registered.unchanged() ||
    check._zod.def.fn !== registered.predicate ||
    check._zod.def.when !== undefined
  )
    return undefined;
  return { source: registered.pattern.source, flags: registered.pattern.flags };
}

/** Snapshot at a reviewed constructor, never a converter-time trust grant. */
export function unchangedCheck(check: z.core.$ZodCheck<never>): () => boolean {
  const internals = check._zod;
  const run = internals.check;
  const definition = internals.def;
  const prototype = Object.getPrototypeOf(definition);
  const entries = Object.entries(Object.getOwnPropertyDescriptors(definition));
  return () =>
    check._zod === internals &&
    Object.getOwnPropertyDescriptor(internals, 'check')?.value === run &&
    Object.getOwnPropertyDescriptor(internals, 'def')?.value === definition &&
    Object.getPrototypeOf(definition) === prototype &&
    Reflect.ownKeys(definition).length === entries.length &&
    entries.every(([key, descriptor]) => {
      const current = Object.getOwnPropertyDescriptor(definition, key);
      return (
        'value' in descriptor &&
        current !== undefined &&
        'value' in current &&
        current.value === descriptor.value
      );
    });
}

/** Only patterns with proven identical Unicode consumer semantics may be published. */
export function publishablePattern(pattern: { source: string; flags: string }): boolean {
  if (pattern.flags === 'u') return true;
  if (pattern.flags !== '' || /[^\x20-\x7e]/.test(pattern.source)) return false;
  // Conservative BMP-only grammar: no wildcard, complement class, property escape,
  // backreference, lookaround or identity escape. Unknown constructs are omitted, never sampled.
  const source = pattern.source.replace(/\\[dwsnrtfv\\^$.*+?()[\]{}|/-]/g, 'a');
  if (/[\\]|\[\^|\(\?(?!:)/.test(source)) return false;
  // Dots inside a positive BMP class are literal, never Unicode wildcards.
  if (source.replace(/\[[^\]]*\]/g, 'a').includes('.')) return false;
  try {
    new RegExp(pattern.source, 'u');
    return true;
  } catch {
    return false;
  }
}

import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join class names, letting a caller's class win over the component's own.
 *
 * Without the merge step, `<Section className="p-4" />` would produce
 * `p-6 p-4` and the winner would be whichever Tailwind emitted last in the
 * stylesheet — not what the caller wrote. `twMerge` resolves the conflict by
 * meaning rather than by order, so a component can carry sensible defaults and
 * still be adjusted at a call site.
 *
 * It does not make hard-coded values acceptable. `design-tokens.spec.ts` still
 * refuses a colour, an arbitrary value or a physical direction utility
 * anywhere in `src`, including at a call site.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

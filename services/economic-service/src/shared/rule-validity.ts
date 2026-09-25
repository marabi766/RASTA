import { RastaError } from '@rasta/nest-common';

/**
 * Where a PATCH may move the end of a commission or reward rule.
 *
 * Rules are selected by when the underlying event **occurred** (docs/10 §
 * 10.7), and read again when it is settled or granted. So every term that
 * decides a charge has to stay what it was for the occurrences it already
 * covers — a rate edited in place re-priced every unsettled transaction that
 * had occurred under the old one. That is why the rate itself is no longer
 * editable at all, and why the window may only change going forward:
 *
 * - **Closing from now on** — `validTo` at or after the present — is the one
 *   legitimate change, and it is what "close the old rule, create a new one"
 *   is made of.
 * - **Closing in the past** would drop the rule for occurrences it already
 *   covered, and they would fall through to another rule or to zero.
 * - **Re-dating or reopening an ended rule** would pull occurrences that were
 *   decided under a different rule back under this one.
 *
 * Nothing here decides *whether* a rule should change; only that a change
 * cannot reach backwards.
 */
export function nextValidTo(
  current: { validFrom: Date; validTo: Date | null },
  requested: string | null,
  now: Date,
): Date | null {
  if (current.validTo !== null && current.validTo <= now) {
    throw RastaError.businessRule(
      'This rule has already ended; its window cannot be moved or reopened. Create a new rule',
    );
  }

  if (requested === null) return null;

  const validTo = new Date(requested);
  if (validTo < now) {
    throw RastaError.businessRule(
      'A rule can be closed from now on, never in the past: that would re-price work it already covered',
    );
  }
  if (validTo <= current.validFrom) {
    throw RastaError.businessRule('validTo must be after validFrom');
  }
  return validTo;
}

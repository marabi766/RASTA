import { tenantKey, type Binding } from '@/lib/unresolved-tenancy';

/**
 * A page's tags for a test (`server/submission.ts` computes the real ones).
 * `owner` is the person acting for one organization, so another `owner` with
 * the same `person` is the same person in another organization; another
 * `person` is another person.
 */
export const PERSON = 'person-tag-1';
export const OTHER_PERSON = 'person-tag-2';

export function bindingOf(
  owner: string,
  session: string,
  person: string = PERSON,
  legacy: readonly string[] = [],
): Binding {
  return { person, owner, session, legacy };
}

/** Where a store keeps `scope` for this page (`lib/unresolved-tenancy.ts`). */
export function keyFor(prefix: string, binding: Binding, scope: string): string {
  return tenantKey(prefix, binding, scope);
}

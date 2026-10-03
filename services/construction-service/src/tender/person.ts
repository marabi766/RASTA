import { getContext } from '@rasta/nest-common';

/**
 * Whether two user ids are one person — **the one place** construction's person-to-person
 * comparisons for the tender flow go through (the awarder against the evaluators, today).
 *
 * `userId` is `rasta_uid ?? sub` (`AuthGuard`), so one person can carry two ids and pass a
 * comparison of ids alone. `@rasta/nest-common`'s `compareActors` (#188, part A) decides this with
 * the verified issuer and subject; this module has the same inputs and the same three answers, so
 * switching to it (part B) is the body of {@link comparePeople} and {@link currentPerson} and
 * nothing at the call sites. Until it lands the rules below are that helper's, restated here:
 *
 *  1. **SAME** when the user ids are equal, or one side's user id is the other side's subject.
 *  2. When both sides carry an issuer and a subject: the same issuer decides on the subjects
 *     (**SAME** or **DISTINCT**); different issuers are **UNKNOWN** — a subject is unique only
 *     within its issuer, and nothing maps one issuer's people onto another's.
 *  3. **UNKNOWN** otherwise: user ids that differ, with nothing more to go on, are not proof of
 *     two people. A caller that must separate duties treats UNKNOWN as the same person.
 */

export interface PersonRef {
  userId: string;
  /** The verified issuer of the token the person acted with; null when the record has none. */
  issuer: string | null;
  /** The identity provider's subject in that issuer; null when the record has none. */
  subject: string | null;
}

export type PersonComparison = 'SAME' | 'DISTINCT' | 'UNKNOWN';

export function comparePeople(a: PersonRef, b: PersonRef): PersonComparison {
  if (
    a.userId === b.userId ||
    (b.subject !== null && a.userId === b.subject) ||
    (a.subject !== null && b.userId === a.subject)
  ) {
    return 'SAME';
  }
  if (a.issuer !== null && a.subject !== null && b.issuer !== null && b.subject !== null) {
    if (a.issuer !== b.issuer) return 'UNKNOWN';
    return a.subject === b.subject ? 'SAME' : 'DISTINCT';
  }
  return 'UNKNOWN';
}

/**
 * The person making this request: their user id, and whatever of the token's verified issuer and
 * subject the context carries. The context has the subject today and the issuer once #188 part A
 * lands (`getContext()` is read through a structural type until then); what it does not carry is
 * `null` — an identity not known is never invented.
 */
export function currentPerson(userId: string): PersonRef {
  const context = getContext() as { subject?: string; issuer?: string };
  const present = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  return { userId, issuer: present(context.issuer), subject: present(context.subject) };
}

/**
 * What a record keeps of a person beside their user id: the issuer and the subject **together**, or
 * neither (the database's both-or-neither check). A half pair proves nothing about who someone is,
 * so it is not kept; the comparison above still uses the half it has, in memory.
 */
export function storedIdentity(person: PersonRef): {
  issuer: string | null;
  subject: string | null;
} {
  return person.issuer !== null && person.subject !== null
    ? { issuer: person.issuer, subject: person.subject }
    : { issuer: null, subject: null };
}

/** A person as an older record names them: by user id alone. */
export function personByUserId(userId: string): PersonRef {
  return { userId, issuer: null, subject: null };
}

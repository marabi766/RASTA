import { ulid } from 'ulid';
import type { DocumentClass } from '../content/policy';

/**
 * Server-owned object keys.
 *
 * ADR-014 is explicit: "کلید شیء از ULID سرور تولید می‌شود، نه از نام فایل
 * کاربر — دفاع Path Traversal". Nothing a client sends contributes a single
 * character to the key, which is what makes traversal impossible by
 * construction rather than by filtering: there is no user input in the path to
 * sanitise, so there is no sanitiser to get wrong.
 *
 * The organization prefix is deliberate and does two things. It makes a key
 * self-describing for an operator reading a bucket listing, and it gives
 * {@link keyBelongsTo} a cheap structural check that a key handed back at
 * finalize belongs to the tenant finalizing it — defence in depth behind the
 * database lookup, not a replacement for it.
 */

/** The prefix under which every object this service owns is written. */
export const KEY_ROOT = 'documents';

export function buildObjectKey(organizationId: string, documentClass: DocumentClass): string {
  // ULID rather than UUID for the same reason the rest of the platform uses
  // it: the leading 48 bits are a millisecond timestamp, so a lexicographic
  // bucket listing comes out in time order without an index. Within a single
  // millisecond the suffix is random and the order among those is arbitrary —
  // which is irrelevant for browsing and is *why* it is safe as a key: the
  // random part is what makes a key unguessable.
  return `${KEY_ROOT}/${organizationId}/${documentClass}/${ulid()}`;
}

/**
 * Whether a key was issued for this organization.
 *
 * Compared against the whole segment rather than with `startsWith`, so
 * `ORG-A` cannot match a key belonging to `ORG-ABC`.
 */
export function keyBelongsTo(objectKey: string, organizationId: string): boolean {
  const segments = objectKey.split('/');
  return segments.length === 4 && segments[0] === KEY_ROOT && segments[1] === organizationId;
}

/**
 * Whether a key is one this service could have produced.
 *
 * Used before a key from a request is trusted enough to look up. A key
 * containing `..`, an absolute path, a backslash or an empty segment is
 * refused outright — not because such a key could reach the filesystem, but
 * because it could only have been constructed by hand, which is the signal
 * worth acting on.
 */
export function isWellFormedKey(objectKey: string): boolean {
  if (objectKey.length === 0 || objectKey.length > 512) return false;
  if (objectKey.includes('..') || objectKey.includes('\\')) return false;
  if (objectKey.startsWith('/') || objectKey.endsWith('/')) return false;

  const segments = objectKey.split('/');
  if (segments.length !== 4) return false;
  if (segments.some((segment) => segment.length === 0)) return false;
  return segments[0] === KEY_ROOT;
}

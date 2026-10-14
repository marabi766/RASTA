import { z } from 'zod';
import { RastaError } from '@rasta/nest-common';

/**
 * Cursor pagination that cannot be used to learn whether a row exists.
 *
 * Every list in this service pages by the id of the last row the caller has
 * already seen. That id used to go to Prisma as `cursor: { id }`, and Prisma
 * resolves the cursor row with a sub-select that the list's own `where` does
 * not reach — nor does the tenant guard, which only rewrites `where`. So the
 * cursor could name any row in the table: another tenant's settlement as the
 * cursor returned the caller's own older rows, an id that exists nowhere
 * returned none, and the difference answered "does settlement X exist" for a
 * caller who gets identical 404s from `GET /v1/settlements/{id}` (Codex review
 * of web PR #249).
 *
 * Now the cursor is looked up **inside the scope of the list being asked
 * for** — the same tenant, the same party filter, the same view — and the page
 * is a keyset read from that row's `(time, id)`. A cursor that is not a row of
 * that list gets one answer, whatever the reason: it does not exist, it
 * belongs to another organization, or it is the caller's own row from the
 * other side of the list (paid vs. received, another account). See
 * {@link invalidCursor}.
 *
 * Keyset on the row's own timestamp is exact here: every column a list in this
 * service orders by is `TIMESTAMP(3)`, the precision a JavaScript `Date`
 * carries, so the boundary read back is the boundary stored.
 */

/** The fixed text of the one refusal for a cursor that is not a row of the list. */
export const INVALID_CURSOR_MESSAGE = 'cursor is not a row of this list';

/**
 * The `cursor` query parameter, with the contract every list in this service
 * keeps. One definition, so the published description cannot drift between
 * lists.
 */
export const cursorQueryParameter = z
  .string()
  .optional()
  .describe(
    'The id of the last row of the previous page of **this** list. A value that is not a row ' +
      'of this list — unknown, owned by another organization, or from the other view of it ' +
      `— is refused with 400 VALIDATION_FAILED, details [{ path: "cursor", message: "${INVALID_CURSOR_MESSAGE}" }], ` +
      'identically in every case.',
  );

/**
 * The refusal for a cursor outside the list's scope.
 *
 * A 400 rather than an empty page: an empty page is also what a valid cursor
 * at the end of the list produces, so it would tell the client nothing about
 * its mistake. The message and the detail are fixed and never echo the value,
 * so the three ways of getting here — absent, foreign, other side — produce
 * byte-identical bodies apart from the correlation id.
 */
export function invalidCursor(): RastaError {
  return RastaError.validation([{ path: 'cursor', message: INVALID_CURSOR_MESSAGE }]);
}

/** Where a page resumes: the ordering key of the last row already seen. */
export interface KeysetBoundary {
  readonly at: Date;
  readonly id: string;
}

/**
 * Resolves `cursor` to the row it names, or refuses it.
 *
 * `find` must look the id up with the **same** scope as the list it pages —
 * that is the whole point — and return the row's ordering key or null.
 */
export async function resolveCursor(
  cursor: string | undefined,
  find: (id: string) => Promise<KeysetBoundary | null>,
): Promise<KeysetBoundary | undefined> {
  if (!cursor) return undefined;
  const boundary = await find(cursor);
  if (!boundary) throw invalidCursor();
  return boundary;
}

/**
 * The rows after `boundary` in `(column DESC, id DESC)` order — the order every
 * list in this service uses. The `id` tie-break makes the order total, so two
 * rows posted in the same millisecond are neither skipped nor repeated.
 */
export function after<K extends string>(
  column: K,
  boundary: KeysetBoundary,
): { OR: [Record<K, { lt: Date }>, Record<K, Date> & { id: { lt: string } }] } {
  return {
    OR: [
      { [column]: { lt: boundary.at } } as Record<K, { lt: Date }>,
      { [column]: boundary.at, id: { lt: boundary.id } } as Record<K, Date> & {
        id: { lt: string };
      },
    ],
  };
}

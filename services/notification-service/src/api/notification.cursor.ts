import { z } from 'zod';

/**
 * The opaque page cursor for `GET /v1/notifications`.
 *
 * ## What it carries, and the one thing it deliberately does not
 *
 * A position — the `(createdAt, id)` of the last row of the previous page —
 * and nothing else. In particular it carries **no scope**: not a user, not an
 * organization, not a filter. That is the control, not an omission. A cursor
 * is a value the client holds and can edit, so a cursor that carried scope
 * would be a scope the caller chooses — defect D-2 in a new costume. Scope is
 * recomputed from the verified token on every request, so a cursor lifted
 * from another person's page can move the caller's position within *their
 * own* inbox and nowhere else. `test/api.int-spec.ts` proves exactly that.
 *
 * That is also why there is no signature: the position is applied inside an
 * already-scoped query, so an unsigned one is not dangerous, and a secret
 * would be a key to rotate protecting a value that is not trusted for
 * anything.
 *
 * ## Opaque, and meant to stay that way
 *
 * base64url over a compact JSON object, so clients page by echoing the value
 * back rather than by constructing timestamps — which is what lets the
 * ordering change later without breaking a client that never knew what was
 * inside. Every malformed cursor, whatever went wrong inside, is one
 * `400 VALIDATION_FAILED` with no detail, so the parameter cannot be used to
 * probe which layer a forgery reached.
 */

const cursorPayload = z
  .object({
    /** `createdAt` of the last row of the previous page, as an ISO instant. */
    c: z.string().datetime({ offset: true }),
    /** `id` of that row — the deterministic tie-breaker. */
    i: z
      .string()
      .min(1)
      .max(64)
      // The column is `VARCHAR(64)` holding a prefixed ULID. Constrained to the
      // alphabet so a decoded cursor cannot smuggle a 10 KB string into a
      // parameter binding.
      .regex(/^[0-9A-Za-z_-]+$/),
  })
  .strict();

export interface NotificationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export class InvalidCursorError extends Error {
  constructor() {
    super('The cursor is not valid');
    this.name = 'InvalidCursorError';
  }
}

export function encodeCursor(cursor: NotificationCursor): string {
  const payload = { c: cursor.createdAt.toISOString(), i: cursor.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): NotificationCursor {
  let parsed: unknown;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(decoded);
  } catch {
    throw new InvalidCursorError();
  }

  const result = cursorPayload.safeParse(parsed);
  if (!result.success) throw new InvalidCursorError();

  const createdAt = new Date(result.data.c);
  if (Number.isNaN(createdAt.getTime())) throw new InvalidCursorError();

  const cursor = { createdAt, id: result.data.i };
  // base64url decoding is lenient — a trailing character or a re-ordered
  // field can still decode to a valid position — so the round trip is the
  // check: a value that does not re-encode to itself was not minted here.
  if (encodeCursor(cursor) !== raw) throw new InvalidCursorError();

  return cursor;
}

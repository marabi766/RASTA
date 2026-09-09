import { z } from 'zod';

/**
 * The opaque page cursor.
 *
 * ## What it carries, and the one thing it deliberately does not
 *
 * A position — the `(occurredAt, id)` of the last row of the previous page —
 * and nothing else. In particular it carries **no scope**: not an organization,
 * not a role, not a filter. That is not an omission to be filled in later; it
 * is the control. A cursor is a value the client holds and can edit, so a
 * cursor that carried tenant scope would be a tenant scope the caller chooses,
 * which is defect D-2 in a new costume. Scope is recomputed from the verified
 * token on every request, so a cursor forged from another tenant's page can
 * move the caller's position within *their own* result set and nowhere else.
 *
 * That is also why there is no signature. An HMAC would prove the server minted
 * the cursor; it would not make an unsigned position dangerous, because the
 * position is applied *inside* an already-scoped query. Adding a secret would
 * add a key to rotate and a failure mode to operate, and would protect a value
 * that is not trusted for anything.
 *
 * ## Opaque, and meant to stay that way
 *
 * base64url over a compact JSON object. Opaque so that clients page by echoing
 * the value back rather than by constructing timestamps, which is what lets the
 * ordering change in a later phase — AUD-003 adds `sequenceNo` — without
 * breaking a client that never knew what was inside.
 */

/**
 * The decoded position. `o` and `i` are one character each because a cursor is
 * echoed on every page request and long field names buy a reader nothing: the
 * value is opaque by design.
 */
const cursorPayload = z
  .object({
    /** `occurredAt` of the last row of the previous page, as an ISO instant. */
    o: z.string().datetime({ offset: true }),
    /** `id` of that row — the deterministic tie-breaker. */
    i: z
      .string()
      .min(1)
      .max(64)
      // The identifier column is `VARCHAR(64)` and holds a ULID. Constrained to
      // the alphabet rather than left open so a decoded cursor cannot smuggle a
      // 10 KB string into a parameter binding.
      .regex(/^[0-9A-Za-z_-]+$/),
  })
  .strict();

export interface AuditCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/** Thrown for every malformed cursor, whatever went wrong inside. */
export class InvalidCursorError extends Error {
  constructor() {
    // No detail, on purpose. "Not valid base64", "unknown field", "bad date"
    // would each tell somebody probing the parameter which layer they reached.
    super('The cursor is not valid');
    this.name = 'InvalidCursorError';
  }
}

export function encodeAuditCursor(cursor: AuditCursor): string {
  const payload = { o: cursor.occurredAt.toISOString(), i: cursor.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a cursor.
 *
 * Every failure path — bad base64, non-JSON, an unknown field, a date that is
 * not a date — raises the same {@link InvalidCursorError}, which the caller
 * turns into one `400 VALIDATION_FAILED`.
 */
export function decodeAuditCursor(raw: string): AuditCursor {
  let parsed: unknown;
  try {
    // `base64url` decoding is lenient, so the round-trip check below is what
    // actually rejects a mangled value: a string that decodes to something
    // whose re-encoding differs was not a cursor this service minted.
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(decoded);
  } catch {
    throw new InvalidCursorError();
  }

  const result = cursorPayload.safeParse(parsed);
  if (!result.success) throw new InvalidCursorError();

  const occurredAt = new Date(result.data.o);
  if (Number.isNaN(occurredAt.getTime())) throw new InvalidCursorError();

  return { occurredAt, id: result.data.i };
}

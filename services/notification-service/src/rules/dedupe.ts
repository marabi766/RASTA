import { createHash } from 'node:crypto';

/**
 * Semantic deduplication — layer 2 of ADR-054 § 3.
 *
 * The consumer-side idempotency key is `eventId`, and it cannot suppress what
 * the insurance expiry sweep produces: roughly 120 *distinct* events per
 * policy per renewal cycle, each a fresh ULID, every six hours for thirty
 * days (`insurance.service.ts`, `runExpirySweep`). Those are not duplicates of
 * one message; they are 120 messages describing one fact. So the key here is
 * built from the fact — the organization, the rule, the thing the notification
 * is *about* — and a coarse time bucket, never from the event.
 */

/**
 * The reminder ladder for an expiry warning, in days remaining (ADR-054 § 3).
 *
 * Five bands, so 120 emissions collapse to at most five notifications: one when
 * the warning window opens, one at two weeks, one week, three days and one
 * day. Configuration of the rule, not code — see `rules.ts`.
 */
export const EXPIRY_BANDS_DAYS: readonly number[] = [30, 14, 7, 3, 1];

/**
 * Maps a `daysRemaining` value onto its band.
 *
 * The band is the **smallest** threshold that is still at or above the value:
 * 25 days is the 30-day reminder, 10 days is the 14-day one, 2 days is the
 * 3-day one. Above the widest band — an operator raised
 * `EXPIRY_WARNING_DAYS` past 30 — the value belongs to the widest band, so a
 * 45-day and a 29-day emission are one reminder rather than a new one per
 * sweep. At or below the narrowest band, including a policy already at zero
 * days, the value is the final reminder.
 *
 * Bands are sorted descending before use, so a caller may list them in any
 * order.
 */
export function bandFor(
  daysRemaining: number,
  bands: readonly number[] = EXPIRY_BANDS_DAYS,
): number {
  if (bands.length === 0) {
    throw new Error('A banded rule needs at least one band');
  }
  const descending = [...bands].sort((a, b) => b - a);
  const widest = descending[0] as number;
  if (daysRemaining >= widest) return widest;

  let chosen = descending[descending.length - 1] as number;
  for (const band of descending) {
    if (daysRemaining <= band) chosen = band;
  }
  return chosen;
}

/** The separator is chosen to be impossible inside any of the parts. */
const KEY_SEPARATOR = '|';

/**
 * `SHA256(organizationId | ruleKey | subjectType | subjectId | bucket)`.
 *
 * Hashed rather than concatenated so the primary key has a fixed width and so
 * a subject id never appears in the key column of a table that is scanned by
 * an operator. Same inputs, same key — that is the whole property.
 */
export function dedupeKeyFor(parts: {
  organizationId: string;
  ruleKey: string;
  subjectType: string;
  subjectId: string;
  bucket: string;
}): string {
  for (const [name, value] of Object.entries(parts)) {
    if (!value || value.includes(KEY_SEPARATOR)) {
      throw new Error(`dedupe key part "${name}" is empty or contains the separator`);
    }
  }
  return createHash('sha256')
    .update(
      [parts.organizationId, parts.ruleKey, parts.subjectType, parts.subjectId, parts.bucket].join(
        KEY_SEPARATOR,
      ),
    )
    .digest('hex');
}

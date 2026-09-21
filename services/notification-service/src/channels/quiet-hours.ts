/**
 * Quiet hours: a window in which an interrupting channel waits (ADR-054 § 5).
 *
 * Three rules, and the ADR states all three:
 *
 *   1. **Quiet hours defer, they never drop.** A delivery due inside the
 *      window is written with `scheduledFor` at the window's end. Nothing is
 *      lost; it arrives later.
 *   2. **They are read in the recipient's snapshot zone**, never the server's.
 *      A window of 22:00–07:00 means those hours where the person sleeps.
 *   3. **`CRITICAL` passes straight through.** *«یک خرابی در ساعت ۲ بامداد
 *      دقیقاً وقتی است که کسی باید بداند.»* A quiet window is a request not to
 *      be bothered by routine things, not a request not to be told the machine
 *      is broken.
 *
 * `IN_APP` is not subject to any of it: an in-app notification interrupts
 * nobody, it waits in an inbox, and deferring one would hide a row that
 * already exists and make the unread count wrong.
 */

export interface QuietWindow {
  /** Minutes from local midnight, inclusive. */
  readonly startMinute: number;
  /** Minutes from local midnight, exclusive. The window wraps when it is lower. */
  readonly endMinute: number;
  /** An IANA zone name. The row defaults it to `Asia/Tehran`. */
  readonly timezone: string;
}

export const MINUTES_PER_DAY = 1440;

/**
 * What time it is, in minutes from midnight, where the recipient is.
 *
 * Derived through `Intl` rather than by adding a stored offset: an offset is
 * a fact about one instant, and storing one turns every later DST transition
 * into a silently wrong answer.
 */
export function localMinuteOfDay(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // `24:00` is how some locales spell midnight at the end of a day.
  return (value('hour') % 24) * 60 + value('minute');
}

/** Whether a local minute falls inside the window, wrap included. */
export function isInsideWindow(minute: number, window: QuietWindow): boolean {
  const { startMinute, endMinute } = window;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

export function isQuietAt(instant: Date, window: QuietWindow): boolean {
  return isInsideWindow(localMinuteOfDay(instant, window.timezone), window);
}

/**
 * The next instant at which the window ends.
 *
 * Minute arithmetic on the local wall clock: how many minutes from now until
 * the clock reads `endMinute`, then that many minutes from now. A zone that
 * shifts its clock between now and then makes the answer off by the shift —
 * which is why **this is an optimisation and not the guarantee**. The worker
 * re-evaluates the window immediately before it sends, so a delivery that
 * comes due an hour early because Europe moved its clocks is deferred again
 * rather than delivered into somebody's night.
 *
 * Seconds are dropped so a deferral lands on a whole minute; a delivery that
 * woke 40 seconds early would otherwise be re-deferred a full day by the
 * check above.
 */
export function nextWindowEnd(now: Date, window: QuietWindow): Date {
  const current = localMinuteOfDay(now, window.timezone);
  const delta = (window.endMinute - current + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const minutes = delta === 0 ? MINUTES_PER_DAY : delta;

  const at = new Date(now.getTime() + minutes * 60_000);
  at.setUTCSeconds(0, 0);
  return at;
}

export interface QuietDecision {
  /** When the delivery may be attempted; null means "now". */
  readonly scheduledFor: Date | null;
  readonly deferred: boolean;
}

/**
 * Whether one delivery waits, and until when.
 *
 * `severity` is taken rather than assumed because the exemption is part of the
 * rule and not an override applied elsewhere: a caller that forgot to check it
 * would silence exactly the notifications that most need to arrive.
 */
export function applyQuietHours(
  now: Date,
  severity: 'INFO' | 'WARNING' | 'CRITICAL',
  window: QuietWindow | null,
): QuietDecision {
  if (!window) return { scheduledFor: null, deferred: false };
  if (severity === 'CRITICAL') return { scheduledFor: null, deferred: false };
  if (!isQuietAt(now, window)) return { scheduledFor: null, deferred: false };
  return { scheduledFor: nextWindowEnd(now, window), deferred: true };
}

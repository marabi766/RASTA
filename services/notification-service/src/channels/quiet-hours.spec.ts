import {
  applyQuietHours,
  isInsideWindow,
  localMinuteOfDay,
  nextWindowEnd,
  type QuietWindow,
} from './quiet-hours';

/**
 * The feature NTF-003 deferred and NTF-004 owes (ADR-054 § 5).
 *
 * Three properties, and each has a way of being wrong that this file exists to
 * catch: a window that wraps midnight is the ordinary case and the arithmetic
 * that forgets it silences somebody all day; the window is read where the
 * person is, not where the server is; and a `CRITICAL` notification ignores
 * the window entirely, because a breakdown at two in the morning is exactly
 * when somebody has to know.
 */

const night: QuietWindow = { startMinute: 22 * 60, endMinute: 7 * 60, timezone: 'Asia/Tehran' };
const afternoon: QuietWindow = {
  startMinute: 13 * 60,
  endMinute: 15 * 60,
  timezone: 'Asia/Tehran',
};

/** An instant at a given Tehran wall-clock time. Tehran is UTC+03:30, no DST. */
function tehran(hour: number, minute = 0): Date {
  const utcMinutes = hour * 60 + minute - (3 * 60 + 30);
  const day = utcMinutes < 0 ? 3 : 4;
  const normalised = ((utcMinutes % 1440) + 1440) % 1440;
  return new Date(Date.UTC(2026, 9, day, Math.floor(normalised / 60), normalised % 60, 0, 0));
}

describe('a window that wraps midnight is the ordinary case', () => {
  it('covers both sides of midnight', () => {
    expect(isInsideWindow(23 * 60, night)).toBe(true);
    expect(isInsideWindow(2 * 60, night)).toBe(true);
    expect(isInsideWindow(6 * 60 + 59, night)).toBe(true);
  });

  it('ends exactly at its end minute, which is not inside it', () => {
    // Half-open, so a window of 22:00–07:00 and one of 07:00–22:00 partition
    // the day instead of both claiming 07:00.
    expect(isInsideWindow(7 * 60, night)).toBe(false);
    expect(isInsideWindow(22 * 60, night)).toBe(true);
  });

  it('handles a window inside one day too', () => {
    expect(isInsideWindow(14 * 60, afternoon)).toBe(true);
    expect(isInsideWindow(12 * 60, afternoon)).toBe(false);
    expect(isInsideWindow(15 * 60, afternoon)).toBe(false);
  });
});

describe('the window is read where the recipient is', () => {
  it('reads the same instant differently in two zones', () => {
    const instant = new Date('2026-10-04T20:00:00.000Z');
    // 20:00 UTC is 23:30 in Tehran — inside a 22:00–07:00 night — and 20:00 in
    // London, which is not.
    expect(localMinuteOfDay(instant, 'Asia/Tehran')).toBe(23 * 60 + 30);
    expect(localMinuteOfDay(instant, 'Europe/London')).toBe(21 * 60);
    expect(isInsideWindow(localMinuteOfDay(instant, 'Asia/Tehran'), night)).toBe(true);
    expect(
      isInsideWindow(localMinuteOfDay(instant, 'Europe/London'), {
        ...night,
        timezone: 'Europe/London',
      }),
    ).toBe(false);
  });
});

describe('quiet hours defer, they never drop', () => {
  it('schedules a routine notification for the end of the window', () => {
    const atMidnight = tehran(0, 30);
    const decision = applyQuietHours(atMidnight, 'WARNING', night);

    expect(decision.deferred).toBe(true);
    expect(decision.scheduledFor).not.toBeNull();
    // 00:30 → 07:00 is six and a half hours.
    const waited = (decision.scheduledFor as Date).getTime() - atMidnight.getTime();
    expect(waited).toBe(6.5 * 60 * 60 * 1000);
    // And the instant it names really is the end of the window.
    expect(localMinuteOfDay(decision.scheduledFor as Date, 'Asia/Tehran')).toBe(7 * 60);
  });

  it('does not defer outside the window', () => {
    expect(applyQuietHours(tehran(10), 'WARNING', night)).toEqual({
      scheduledFor: null,
      deferred: false,
    });
  });

  it('does not defer when the person set no window', () => {
    expect(applyQuietHours(tehran(3), 'WARNING', null).deferred).toBe(false);
  });

  it('lets a CRITICAL notification through the window', () => {
    // ADR-054 § 5, stated as plainly as the document does: «یک خرابی در ساعت ۲
    // بامداد دقیقاً وقتی است که کسی باید بداند.»
    expect(applyQuietHours(tehran(2), 'CRITICAL', night)).toEqual({
      scheduledFor: null,
      deferred: false,
    });
    // And the same instant, one severity down, waits.
    expect(applyQuietHours(tehran(2), 'WARNING', night).deferred).toBe(true);
  });

  it('never schedules a wait of zero, which would busy-loop a worker', () => {
    // Exactly at the end minute the window is already over, so nothing is
    // deferred at all — but if a caller asks for the next end anyway, it is
    // tomorrow's, not this instant.
    const atEnd = tehran(7, 0);
    expect(applyQuietHours(atEnd, 'WARNING', night).deferred).toBe(false);
    expect(nextWindowEnd(atEnd, night).getTime() - atEnd.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('lands on a whole minute, so a delivery does not wake seconds early', () => {
    const at = new Date(tehran(1, 0).getTime() + 40_000);
    expect(nextWindowEnd(at, night).getUTCSeconds()).toBe(0);
    expect(nextWindowEnd(at, night).getUTCMilliseconds()).toBe(0);
  });
});

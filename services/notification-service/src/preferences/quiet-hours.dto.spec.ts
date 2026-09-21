import {
  clockToMinutes,
  minutesToClock,
  quietHoursSchema,
  replaceQuietHoursSchema,
} from './preferences.dto';

/**
 * What the quiet-hours endpoint accepts, and what it refuses at the boundary.
 *
 * The refusals matter more than the acceptances here. A window is a control a
 * person sets once and then trusts, so every way of storing one that cannot be
 * evaluated later — an unknown zone, a degenerate window, a time that is not a
 * time — has to fail where somebody is still looking at a form, not months
 * later as a notification that arrives at the wrong hour.
 */

describe('the clock a person types', () => {
  it('round-trips through minutes from midnight', () => {
    for (const clock of ['00:00', '07:00', '13:45', '22:00', '23:59']) {
      expect(minutesToClock(clockToMinutes(clock))).toBe(clock);
    }
  });

  it('puts midnight at zero and the last minute at 1439', () => {
    expect(clockToMinutes('00:00')).toBe(0);
    expect(clockToMinutes('23:59')).toBe(1439);
  });
});

describe('what the schema refuses', () => {
  it('refuses a window whose bounds are equal', () => {
    // Zero minutes or the whole day, depending on who reads it — and one of
    // those two readings silences a person permanently.
    expect(quietHoursSchema.safeParse({ start: '22:00', end: '22:00' }).success).toBe(false);
  });

  it('refuses anything that is not a 24-hour clock time', () => {
    for (const bad of ['24:00', '7:00', '22:60', '10:0', 'morning', '22:00:00']) {
      expect(quietHoursSchema.safeParse({ start: bad, end: '07:00' }).success).toBe(false);
    }
  });

  it('refuses a time zone this runtime cannot resolve', () => {
    // A zone that cannot be resolved stores a window that can never be
    // evaluated. Checked against the runtime's own database rather than a list
    // kept here, which would go stale.
    expect(
      quietHoursSchema.safeParse({ start: '22:00', end: '07:00', timezone: 'Mars/Olympus' })
        .success,
    ).toBe(false);
    expect(
      quietHoursSchema.safeParse({ start: '22:00', end: '07:00', timezone: 'Europe/London' })
        .success,
    ).toBe(true);
  });

  it('refuses a key it does not know', () => {
    // Strict, like every other DTO here: a misspelled field that is silently
    // dropped is a setting the person believes they made.
    expect(
      quietHoursSchema.safeParse({ start: '22:00', end: '07:00', timeZone: 'Asia/Tehran' }).success,
    ).toBe(false);
  });
});

describe('what the schema accepts', () => {
  it('accepts a window that wraps midnight, which is the ordinary case', () => {
    const parsed = quietHoursSchema.parse({ start: '22:00', end: '07:00' });
    expect(parsed).toEqual({ start: '22:00', end: '07:00', timezone: 'Asia/Tehran' });
  });

  it('accepts null as "no quiet window"', () => {
    expect(replaceQuietHoursSchema.parse({ quietHours: null })).toEqual({ quietHours: null });
  });

  it('defaults the zone to the platform one rather than to the server one', () => {
    // A server in UTC must not give a Tehran user a window read in UTC.
    expect(quietHoursSchema.parse({ start: '01:00', end: '02:00' }).timezone).toBe('Asia/Tehran');
  });
});

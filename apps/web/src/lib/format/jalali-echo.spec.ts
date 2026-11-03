import { localDateToIso } from '@/server/drivers';
import { localDateTimeToIso } from '@/server/usage';

import {
  formatJalaliDateLong,
  formatJalaliDateTime,
  jalaliOfCalendarDay,
  jalaliOfWallClock,
} from './datetime';

/**
 * The Jalali echo beside a native date input (demo run 2026-10-24, defect 7).
 * It must show the day the server will store, never a neighbouring one: it is
 * pinned here to the servers' own readings (`localDateToIso`,
 * `localDateTimeToIso`), including the days around Tehran midnight.
 */

const DAYS = [
  '2026-03-21', // Nowruz 1405
  '2026-09-18',
  '2026-09-22', // 1 Mehr
  '2027-01-01',
  '2026-12-31',
  '2028-02-29', // a leap day
  '2026-03-20',
];

describe('jalaliOfCalendarDay', () => {
  it('names the day in Jalali with a month name and Persian digits', () => {
    expect(jalaliOfCalendarDay('2026-09-18')).toBe('۲۷ شهریور ۱۴۰۵');
    expect(jalaliOfCalendarDay('2026-03-21')).toBe('۱ فروردین ۱۴۰۵');
  });

  it.each(DAYS)('agrees with the day localDateToIso stores for %s', (day) => {
    const stored = localDateToIso(day);
    expect(stored).not.toBeNull();
    expect(jalaliOfCalendarDay(day)).toBe(formatJalaliDateLong(stored as string));
  });

  it.each(['', '2026-9-1', '2026-02-30', '2026-13-01', '2026-04-31', 'abc', '2026-09-18T10:00'])(
    'has no reading for %p (the server refuses it too)',
    (value) => {
      expect(jalaliOfCalendarDay(value)).toBeNull();
      if (value !== '2026-09-18T10:00') expect(localDateToIso(value)).toBeNull();
    },
  );
});

describe('jalaliOfWallClock', () => {
  it('reads a wall clock as Tehran time', () => {
    expect(jalaliOfWallClock('2026-09-19T01:00')).toBe('۱۴۰۵/۰۶/۲۸ ۰۱:۰۰');
  });

  it.each(['2026-09-18T23:59', '2026-09-19T00:00', '2026-03-21T00:30', '2026-09-22T12:00'])(
    'agrees with the instant localDateTimeToIso stores for %s',
    (value) => {
      const stored = localDateTimeToIso(value);
      expect(stored).not.toBeNull();
      expect(jalaliOfWallClock(value)).toBe(formatJalaliDateTime(stored as string));
    },
  );

  it.each(['', '2026-09-19', '2026-02-30T10:00', '2026-09-19T25:00'])(
    'has no reading for %p',
    (value) => {
      expect(jalaliOfWallClock(value)).toBeNull();
    },
  );
});

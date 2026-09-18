import {
  DISPLAY_TIME_ZONE,
  formatGregorianUtc,
  formatJalaliDate,
  formatJalaliDateLong,
  formatJalaliDateTime,
} from './datetime';

/** 2026-09-18 21:30 UTC — which is 2026-09-19 01:00 in Tehran. */
const ACROSS_MIDNIGHT = '2026-09-18T21:30:00Z';

describe('formatJalaliDate', () => {
  it('renders the Jalali date in Persian digits', () => {
    expect(formatJalaliDate('2026-09-18T06:00:00Z')).toBe('۱۴۰۵/۰۶/۲۷');
  });

  it('can stay in Latin digits', () => {
    expect(formatJalaliDate('2026-09-18T06:00:00Z', { persianDigits: false })).toBe('1405/06/27');
  });

  // This is the whole reason the zone is explicit. The same instant is one
  // Jalali day in UTC and the next in Tehran; if the formatter took the
  // runtime's zone, the server and the browser would disagree.
  it('resolves an instant near midnight in the display zone, not the runtime zone', () => {
    expect(formatJalaliDate(ACROSS_MIDNIGHT, { timeZone: 'UTC' })).toBe('۱۴۰۵/۰۶/۲۷');
    expect(formatJalaliDate(ACROSS_MIDNIGHT, { timeZone: DISPLAY_TIME_ZONE })).toBe('۱۴۰۵/۰۶/۲۸');
  });

  it('defaults to the display zone', () => {
    expect(formatJalaliDate(ACROSS_MIDNIGHT)).toBe(
      formatJalaliDate(ACROSS_MIDNIGHT, { timeZone: DISPLAY_TIME_ZONE }),
    );
  });

  it('accepts a Date as readily as a string', () => {
    expect(formatJalaliDate(new Date(ACROSS_MIDNIGHT))).toBe('۱۴۰۵/۰۶/۲۸');
  });

  it('refuses an instant it cannot read', () => {
    expect(() => formatJalaliDate('not a date')).toThrow(RangeError);
    expect(() => formatJalaliDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('formatJalaliDateLong', () => {
  it('names the month, so the order of the numbers cannot be misread', () => {
    expect(formatJalaliDateLong(ACROSS_MIDNIGHT)).toBe('۲۸ شهریور ۱۴۰۵');
  });
});

describe('formatJalaliDateTime', () => {
  it('renders the time of day in the display zone, in 24-hour form', () => {
    expect(formatJalaliDateTime(ACROSS_MIDNIGHT)).toBe('۱۴۰۵/۰۶/۲۸ ۰۱:۰۰');
  });
});

describe('formatGregorianUtc', () => {
  // The other half of the dual display docs/16 § 16.5 asks for in a tooltip:
  // the instant exactly as the API writes it.
  it('gives back the instant the API sent', () => {
    expect(formatGregorianUtc(ACROSS_MIDNIGHT)).toBe('2026-09-18T21:30:00.000Z');
  });
});

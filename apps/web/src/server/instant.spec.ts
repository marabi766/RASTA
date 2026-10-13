/**
 * @jest-environment node
 */
import { formatJalaliDateLong } from '@/lib/format';

import { renderableDate, utcInstant } from './instant';

/**
 * The two validators must never accept what the formatter then refuses: that
 * mismatch is what crashed a page at render instead of showing the fixed
 * malformed-response text.
 */

const GARBAGE = ['UPSTREAM_INVALID_TIMESTAMP', '', ' ', 'null', '2026-13-01T00:00:00Z'];

describe('utcInstant', () => {
  it.each(['2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00Z', '2026-09-20T11:30:00+03:30'])(
    'accepts %s',
    (value) => {
      expect(utcInstant.safeParse(value).success).toBe(true);
    },
  );

  it.each([...GARBAGE, '2026-09-20', '2026-09-20T08:00:00'])('refuses %j', (value) => {
    expect(utcInstant.safeParse(value).success).toBe(false);
  });

  it.each([null, undefined, 0, 1.7e12, {}])('refuses a non-string %p', (value) => {
    expect(utcInstant.safeParse(value).success).toBe(false);
  });
});

describe('renderableDate', () => {
  it.each(['2026-09-20T08:00:00.000Z', '2026-09-20'])('accepts %s', (value) => {
    expect(renderableDate.safeParse(value).success).toBe(true);
  });

  it.each(GARBAGE)('refuses %j', (value) => {
    expect(renderableDate.safeParse(value).success).toBe(false);
  });

  it('accepts only what the formatter can render', () => {
    for (const value of [...GARBAGE, '2026-09-20', '2026-09-20T08:00:00Z']) {
      const accepted = renderableDate.safeParse(value).success;
      let renders = true;
      try {
        formatJalaliDateLong(value);
      } catch {
        renders = false;
      }
      expect(accepted).toBe(renders);
    }
  });
});

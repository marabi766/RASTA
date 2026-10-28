import { z } from 'zod';
import { isoDateTime } from './iso-datetime';
import { parsableUrl } from './parsable-url';
import { legacyParse } from './zod-issues';

/**
 * zod 3's `.url()` and `.datetime()` kept under zod 4 (GHSA-mrhx-c7xc-m3w5).
 * Which strings they accept is pinned by `zod-golden.spec.ts`; this pins the
 * rest: the value comes back as written, and a refusal is the one zod 3 gave.
 */
describe('parsableUrl', () => {
  const url = z.string().check(parsableUrl());

  it.each([' https://example.ir', 'https://exa\tmple.ir/\n', 'gateway:3000'])(
    'returns %j exactly as written (zod 4’s own .url() trims and strips)',
    (value) => {
      expect(url.parse(value)).toBe(value);
    },
  );

  it('refuses what the URL parser refuses, as zod 3’s invalid_string url', () => {
    expect(legacyParse(url, 'not a url').refusal?.issues).toEqual([
      expect.objectContaining({
        code: 'invalid_string',
        validation: 'url',
        message: 'Invalid url',
      }),
    ]);
  });

  it('keeps a schema message', () => {
    const own = z.string().check(parsableUrl({ message: 'نشانی معتبر نیست' }));
    expect(own.safeParse('x').error?.issues[0]?.message).toBe('نشانی معتبر نیست');
  });
});

describe('isoDateTime', () => {
  it('refuses as zod 3’s invalid_string datetime, and keeps a schema message', () => {
    const instant = z.string().check(isoDateTime());
    expect(legacyParse(instant, '2026-10-24 12:00').refusal?.issues).toEqual([
      expect.objectContaining({
        code: 'invalid_string',
        validation: 'datetime',
        message: 'Invalid datetime',
      }),
    ]);
    const own = z.string().check(isoDateTime({ message: 'UTC with Z' }));
    expect(own.safeParse('x').error?.issues[0]?.message).toBe('UTC with Z');
  });
});

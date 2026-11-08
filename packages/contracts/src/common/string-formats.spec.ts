import { z } from 'zod';
import { isoDateTime } from './iso-datetime';
import { parsableUrl, isParsableUrlCheck } from './parsable-url';
import { legacyParse } from './zod-issues';

/**
 * zod 3's `.url()` and `.datetime()` kept under zod 4 (GHSA-mrhx-c7xc-m3w5).
 * Which strings they accept is pinned by `zod-golden.spec.ts`; this pins the
 * rest: the value comes back as written, and a refusal is the one zod 3 gave.
 */
describe('parsableUrl', () => {
  const url = z.string().check(parsableUrl());

  it('grants URL publication only to the reviewed helper, never native or copied checks', () => {
    const check = parsableUrl();
    expect(isParsableUrlCheck(check)).toBe(true);
    expect(isParsableUrlCheck(z.url())).toBe(false);
    expect(isParsableUrlCheck({ ...check })).toBe(false);
  });

  it.each(['runner', 'kind', 'when', 'prototype'])(
    'refuses URL trust after changing %s',
    (field) => {
      const check = parsableUrl();
      if (field === 'runner')
        check._zod.check = (payload) => {
          payload.value = 'https://example.ir';
        };
      if (field === 'kind') Object.assign(check._zod.def, { format: 'email' });
      if (field === 'when') Object.assign(check._zod.def, { when: () => true });
      if (field === 'prototype') Object.setPrototypeOf(check._zod.def, {});
      expect(isParsableUrlCheck(check)).toBe(false);
    },
  );

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
  it.each([
    ['2026-11-02T00:00:00+14:00', true],
    ['2026-11-02T00:00:00-14:00', true],
    ['2026-11-02T00:00:00+14:01', false],
    ['2026-11-02T00:00:00+24:00', false],
    ['2026-11-02T00:00:00+99:99', false],
    ['2026-11-02T00:00:00-00:60', false],
  ])('validates offset and finite parsing of %s', (value, expected) => {
    expect(
      z
        .string()
        .check(isoDateTime({ offset: true }))
        .safeParse(value).success,
    ).toBe(expected);
  });

  it('refuses when the runtime cannot parse a syntactically valid timestamp', () => {
    const parse = jest.spyOn(Date, 'parse').mockReturnValueOnce(NaN);
    expect(z.string().check(isoDateTime()).safeParse('2026-11-02T00:00:00Z').success).toBe(false);
    parse.mockRestore();
  });

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

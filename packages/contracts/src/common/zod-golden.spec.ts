import { z } from 'zod';
import { amountMinorSchema, signedAmountMinorSchema } from './money';
import { organizationIdSchema } from './identifiers';
import { isoDateTime } from './iso-datetime';

/**
 * Golden fixtures for the zod 4 migration (GHSA-mrhx-c7xc-m3w5, PR B): which
 * strings the platform's format validators accept. zod 4 rewrote the email,
 * URL and ISO date/time validators, so a value accepted today could be
 * refused after the bump (or the reverse) with no type error to notice — an
 * email that cannot sign in, a stored URL that no longer round-trips, a signed
 * form whose instant no longer parses.
 *
 * The snapshot beside this file was recorded under **zod 3.25.76** and is the
 * oracle B is measured against. Never re-record it (`-u`) to make a migration
 * pass: a kind that differs gets the zod 3 rule pinned in the code instead.
 */

const accepts = (schema: z.ZodTypeAny, inputs: readonly string[]) =>
  Object.fromEntries(inputs.map((input) => [input, schema.safeParse(input).success]));

describe('zod-3 golden: string formats', () => {
  it('z.string().email()', () => {
    expect(
      accepts(z.string().email(), [
        'a@b.ir',
        'first.last@example.com',
        'first+tag@example.co.ir',
        "o'brien@example.com",
        'under_score@sub.example.org',
        'UPPER@EXAMPLE.COM',
        'digits123@123.ir',
        'a@b',
        'a@b.c',
        'a@-b.ir',
        'a@b-.ir',
        'a@b..ir',
        '.a@b.ir',
        'a.@b.ir',
        'a..b@b.ir',
        'a@b.ir.',
        'a b@b.ir',
        'a@b c.ir',
        'a@@b.ir',
        '@b.ir',
        'a@',
        'a@[127.0.0.1]',
        'a@127.0.0.1',
        'a@b.i',
        'a@b.ir ',
        ' a@b.ir',
        'علی@example.ir',
        'a@مثال.ایران',
        'a@xn--mgbh0fb.xn--mgba3a4f16a',
        `${'a'.repeat(64)}@b.ir`,
        `${'a'.repeat(65)}@b.ir`,
        '',
      ]),
    ).toMatchSnapshot();
  });

  it('z.string().url()', () => {
    expect(
      accepts(z.string().url(), [
        'https://example.ir',
        'https://example.ir/path?q=1#frag',
        'http://localhost:3000',
        'http://127.0.0.1:8080/x',
        'https://[::1]/',
        'https://user:pass@example.ir',
        'ftp://files.example.ir',
        'mailto:a@b.ir',
        'file:///etc/hosts',
        'javascript:alert(1)',
        'data:text/plain,hi',
        'urn:isbn:0451450523',
        's3://bucket/key',
        'https://مثال.ایران/مسیر',
        'https://example.ir/with space',
        'https://',
        'https:/example.ir',
        'example.ir',
        '//example.ir',
        'http://-example.ir',
        'http://example',
        ' https://example.ir',
        '',
      ]),
    ).toMatchSnapshot();
  });

  it('z.string().datetime() — UTC only, any offset, and no offset', () => {
    const inputs = [
      '2026-10-24T12:00:00Z',
      '2026-10-24T12:00:00.1Z',
      '2026-10-24T12:00:00.123Z',
      '2026-10-24T12:00:00.123456789Z',
      '2026-10-24T12:00Z',
      '2026-10-24T12:00:00',
      '2026-10-24T12:00:00+03:30',
      '2026-10-24T12:00:00+0330',
      '2026-10-24T12:00:00+03',
      '2026-10-24T12:00:00-00:00',
      '2026-10-24T12:00:00z',
      '2026-10-24 12:00:00Z',
      '2026-10-24t12:00:00Z',
      '2026-10-24',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-10-24T24:00:00Z',
      '2026-10-24T23:59:60Z',
      '+002026-10-24T12:00:00Z',
      '20261024T120000Z',
      '',
    ];
    expect({
      // zod 4's own .datetime() refuses `12:00Z` and `+0330`; the platform keeps zod 3's rule.
      utc: accepts(z.string().check(isoDateTime()), inputs),
      offset: accepts(z.string().check(isoDateTime({ offset: true })), inputs),
      local: accepts(z.string().check(isoDateTime({ offset: false })), inputs),
    }).toMatchSnapshot();
  });

  it('z.string().date()', () => {
    expect(
      accepts(z.string().date(), [
        '2026-10-24',
        '2024-02-29',
        '2026-02-29',
        '2026-02-30',
        '2026-04-31',
        '2026-13-01',
        '2026-00-10',
        '2026-10-00',
        '2026-1-1',
        '26-10-24',
        '2026/10/24',
        '2026-10-24T00:00:00Z',
        '1404-08-02',
        '',
      ]),
    ).toMatchSnapshot();
  });
});

describe('zod-3 golden: money and identifier strings', () => {
  const amounts = [
    '0',
    '1',
    '00',
    '9223372036854775807',
    '9223372036854775808',
    '-1',
    '-9223372036854775808',
    '-9223372036854775809',
    '1.5',
    '1e3',
    ' 1',
    '+1',
    '١٢٣',
    '۱۲۳',
    '9'.repeat(30),
    '9'.repeat(31),
    '',
  ];

  it('amountMinorSchema and signedAmountMinorSchema', () => {
    expect({
      unsigned: accepts(amountMinorSchema, amounts),
      signed: accepts(signedAmountMinorSchema, amounts),
    }).toMatchSnapshot();
  });

  it('organizationIdSchema (seed and ULID forms)', () => {
    expect(
      accepts(organizationIdSchema, [
        'ORG-DEH-0001',
        'ORG-A',
        `ORG-${'A'.repeat(48)}`,
        `ORG-${'A'.repeat(49)}`,
        'ORG_01J9ZS3X5Y0000000000000000',
        'ORG_01J9ZS3X5Y000000000000000',
        'ORG_01j9zs3x5y0000000000000000',
        'ORG_01J9ZS3X5Y000000000000000I',
        'org-deh-0001',
        'USR-DEH-0001',
        'ORG-deh',
        'ORG-',
        '',
      ]),
    ).toMatchSnapshot();
  });
});

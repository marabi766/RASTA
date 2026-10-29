import { z } from 'zod';
import { amountMinorSchema, isoDateTime } from '@rasta/contracts';
import { zodPipe } from '@rasta/nest-common';
import {
  canonicalAmountMinor,
  canonicalBody,
  canonicalFieldsOf,
  canonicalInstant,
  canonicalPipe,
  canonicalText,
} from './canonical';
import { hashRequestBody } from './idempotency';
import { createRewardRuleSchema } from '../reward/dto';

describe('canonical request values (checklist #16)', () => {
  /** What zod records for `isoDateTime()`: `Z` only, any fraction. */
  const ZULU = { offset: false, local: false, precision: null };

  describe('amounts', () => {
    it.each([
      ['01000', '1000'],
      ['0001', '1'],
      ['000', '0'],
      ['0', '0'],
      ['1000', '1000'],
    ])('%s → %s', (sent, canonical) => {
      expect(canonicalAmountMinor(sent)).toBe(canonical);
    });

    it('leaves what the amount pattern refuses exactly as sent, for validation to answer', () => {
      for (const sent of ['', ' 1', '1.0', '-01', '0x10', '1e3', '0'.repeat(31) + '1']) {
        expect(canonicalAmountMinor(sent)).toBe(sent);
      }
      expect(canonicalAmountMinor(1000)).toBe(1000);
      expect(canonicalAmountMinor(null)).toBeNull();
      expect(canonicalAmountMinor(undefined)).toBeUndefined();
    });
  });

  describe('instants', () => {
    it.each([
      ['2027-01-01T12:00:00Z', '2027-01-01T12:00:00.000Z'],
      ['2027-01-01T12:00:00.000Z', '2027-01-01T12:00:00.000Z'],
      ['2027-01-01T12:00Z', '2027-01-01T12:00:00.000Z'],
      ['2027-01-01T12:00:00.5Z', '2027-01-01T12:00:00.500Z'],
      // The column and `new Date(…)` keep milliseconds: this is what executes.
      ['2027-01-01T12:00:00.123456Z', '2027-01-01T12:00:00.123Z'],
    ])('%s → %s', (sent, canonical) => {
      expect(canonicalInstant(sent)).toBe(canonical);
    });

    it('takes an offset to UTC only where the field accepts offsets', () => {
      expect(canonicalInstant('2027-01-01T15:30:00+03:30', { offset: true })).toBe(
        '2027-01-01T12:00:00.000Z',
      );
      // A Z-only field: left for zod to refuse, not quietly accepted.
      expect(canonicalInstant('2027-01-01T15:30:00+03:30')).toBe('2027-01-01T15:30:00+03:30');
    });

    it('leaves a time with no zone, and anything invalid, exactly as sent', () => {
      expect(canonicalInstant('2027-01-01T12:00:00', { local: true })).toBe('2027-01-01T12:00:00');
      for (const sent of ['2027-02-30T12:00:00Z', 'tomorrow', '', '2027-01-01']) {
        expect(canonicalInstant(sent)).toBe(sent);
      }
      expect(canonicalInstant(null)).toBeNull();
    });

    it('does not rewrite into a form the field’s own precision would refuse', () => {
      expect(canonicalInstant('2027-01-01T12:00:00.12Z', { precision: 2 })).toBe(
        '2027-01-01T12:00:00.12Z',
      );
    });
  });

  describe('text', () => {
    it('makes every line ending LF', () => {
      expect(canonicalText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
      expect(canonicalText(7)).toBe(7);
    });
  });

  describe('the reward rule create', () => {
    it('finds its fields from the schema: the credit, both instants and the label', () => {
      expect(canonicalFieldsOf(createRewardRuleSchema)).toEqual({
        creditPerPointMinor: { kind: 'amountMinor' },
        validFrom: { kind: 'instant', options: ZULU },
        validTo: { kind: 'instant', options: ZULU },
        label: { kind: 'text' },
      });
    });

    const parse = (body: unknown) =>
      zodPipe(createRewardRuleSchema).transform(
        canonicalPipe(createRewardRuleSchema).transform(body, { type: 'body' }),
        { type: 'body' },
      );

    const first = {
      triggerEvent: 'USAGE_RECORDED',
      points: 2,
      creditPerPointMinor: '1000',
      validFrom: '2027-01-01T12:00:00Z',
      validTo: '2027-06-01T00:00:00.000Z',
      label: 'line one\nline two',
    };

    it('hashes an equivalent body as the first one: amount, instant and line endings', () => {
      const retry = {
        label: 'line one\r\nline two',
        validTo: '2027-06-01T00:00Z',
        validFrom: '2027-01-01T12:00:00.000Z',
        creditPerPointMinor: '01000',
        points: 2,
        triggerEvent: 'USAGE_RECORDED',
      };
      expect(hashRequestBody(parse(retry))).toBe(hashRequestBody(parse(first)));
    });

    it.each([
      ['another amount', { creditPerPointMinor: '1001' }],
      ['another instant', { validFrom: '2027-01-01T12:00:00.001Z' }],
      ['other text', { label: 'line one\n\nline two' }],
      ['zero instead of the amount', { creditPerPointMinor: '0' }],
      ['the amount omitted', { creditPerPointMinor: undefined }],
      ['the end omitted', { validTo: undefined }],
    ])('still tells a really different body apart: %s', (_, change) => {
      const other = JSON.parse(JSON.stringify({ ...first, ...change })) as unknown;
      expect(hashRequestBody(parse(other))).not.toBe(hashRequestBody(parse(first)));
    });

    it('keeps omitted, null and zero distinct', () => {
      const body = { triggerEvent: 'USAGE_RECORDED', points: 1 };
      expect(canonicalBody(body, canonicalFieldsOf(createRewardRuleSchema))).toEqual(body);
      expect(
        canonicalBody({ ...body, validTo: null }, { validTo: { kind: 'instant', options: {} } }),
      ).toEqual({ ...body, validTo: null });
      expect(parse({ ...body, creditPerPointMinor: '000' })).toMatchObject({
        creditPerPointMinor: '0',
      });
    });

    it('counts the label’s length after its line endings are LF', () => {
      const lines = 'x\r\n'.repeat(100); // 300 UTF-16 units sent, 200 canonical
      expect(
        parse({ triggerEvent: 'USAGE_RECORDED', points: 1, label: lines.trimEnd() + 'x' }),
      ).toMatchObject({
        label: expect.stringMatching(/^(x\n){99}xx$/),
      });
    });

    it('leaves the request’s own object as it was', () => {
      const sent = { ...first, creditPerPointMinor: '01000' };
      parse(sent);
      expect(sent.creditPerPointMinor).toBe('01000');
    });

    it('leaves a body that is not an object for the schema to refuse', () => {
      expect(canonicalBody(null, { a: { kind: 'text' } })).toBeNull();
      expect(canonicalBody(['01'], { 0: { kind: 'amountMinor' } })).toEqual(['01']);
    });
  });

  it('reads instants, amounts and text through optional, nullable and defaulted wrappers only', () => {
    const schema = z.object({
      at: z
        .string()
        .check(isoDateTime({ offset: true }))
        .nullable()
        .optional(),
      amount: amountMinorSchema.optional(),
      note: z.string().prefault(''),
      code: z.string().regex(/^[A-Z]+$/),
      when: z.string().check(isoDateTime()),
      count: z.number(),
      nested: z.object({ amount: amountMinorSchema }),
    });
    expect(canonicalFieldsOf(schema)).toEqual({
      at: { kind: 'instant', options: { offset: true, local: false, precision: null } },
      amount: { kind: 'amountMinor' },
      note: { kind: 'text' },
      when: { kind: 'instant', options: ZULU },
    });
  });
});

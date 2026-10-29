import { z } from 'zod';
import { amountMinorSchema, isoDateTime } from '@rasta/contracts';
import { zodPipe } from '@rasta/nest-common';
import {
  canonicalAmountMinor,
  canonicalBody,
  canonicalDecimal,
  canonicalFieldsOf,
  canonicalInstant,
  canonicalPipe,
  canonicalText,
  canonicalWithin,
  withCanonicalForm,
} from './canonical';
import { hashRequestBody } from './idempotency';
import { NUMERIC_COMPARISONS, canonicalCondition, createRewardRuleSchema } from '../reward/dto';
import { conditionMet } from '../reward/rule-engine';

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

  describe('decimals (by exact value, no float)', () => {
    it.each([
      ['7.50', '7.5'],
      ['007', '7'],
      ['7.', '7'],
      ['.5', '0.5'],
      ['+7.5', '7.5'],
      ['-07.50', '-7.5'],
      ['-0', '0'],
      ['-0.000', '0'],
      ['000.000', '0'],
      ['0.10', '0.1'],
      ['7.5', '7.5'],
      // Beyond a double's precision: kept exactly, never rounded.
      ['0.12345678901234567890120', '0.1234567890123456789012'],
      ['900719925474099312345.000', '900719925474099312345'],
    ])('%s → %s', (sent, canonical) => {
      expect(canonicalDecimal(sent)).toBe(canonical);
    });

    it('leaves anything that is not a plain decimal exactly as sent', () => {
      for (const sent of [
        '',
        '.',
        '-',
        '+',
        ' 7.5',
        '7.5 ',
        '7.5e0',
        '1e3',
        '0x10',
        'Infinity',
        'NaN',
        '7,5',
        '1.2.3',
        '--1',
        'abc',
      ]) {
        expect(canonicalDecimal(sent)).toBe(sent);
      }
      expect(canonicalDecimal(7.5)).toBe(7.5);
      expect(canonicalDecimal(true)).toBe(true);
      expect(canonicalDecimal(null)).toBeNull();
    });

    it('two spellings with one canonical form are one number to `Number()`', () => {
      for (const [a, b] of [
        ['7.50', '7.5'],
        ['007', '7'],
        ['-0.0', '0'],
        ['.5', '0.5'],
      ]) {
        expect(canonicalDecimal(a)).toBe(canonicalDecimal(b));
        // `-0` and `0` are one value to every comparison the evaluator makes.
        expect(Number(a) === Number(b)).toBe(true);
      }
    });
  });

  describe('a rewrite within the value’s own schema', () => {
    it('rewrites only where the value as sent and its canonical form both pass', () => {
      const short = z.string().max(4);
      expect(canonicalWithin(short, '7.50', canonicalDecimal)).toBe('7.5');
      // The canonical form would pass, the value as sent does not: left for zod to refuse.
      expect(canonicalWithin(short, '07.50', canonicalDecimal)).toBe('07.50');
      // The value passes, its canonical form would not: not rewritten into a refusal.
      const twoDecimals = z.string().regex(/^\d+\.\d{2}$/);
      expect(canonicalWithin(twoDecimals, '7.50', canonicalDecimal)).toBe('7.50');
    });

    it('finds a declared form through the wrappers, like any other field', () => {
      const form = (value: unknown) => value;
      const declared = withCanonicalForm(z.object({ a: z.string() }), form);
      expect(canonicalFieldsOf(z.object({ c: declared.optional().nullable() }))).toEqual({
        c: { kind: 'form', canonicalize: form },
      });
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
        condition: { kind: 'form', canonicalize: canonicalCondition },
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

    describe('the condition’s operands (Codex PR-480 r2, R2)', () => {
      const leaf = (op: string, value: unknown) => ({ field: 'hours', op, value });
      const shapes: [string, (node: unknown) => unknown][] = [
        ['at the top', (node) => node],
        ['under all → any', (node) => ({ all: [{ field: 'x', op: 'present' }, { any: [node] }] })],
        ['under any → all', (node) => ({ any: [{ all: [{ field: 'x', op: 'absent' }, node] }] })],
      ];
      const withCondition = (condition: unknown) => ({
        triggerEvent: 'USAGE_RECORDED',
        points: 1,
        condition,
      });
      const hashOf = (condition: unknown) => hashRequestBody(parse(withCondition(condition)));

      describe.each(shapes)('%s', (_, shape) => {
        it.each([...NUMERIC_COMPARISONS])(
          '%s: hashes "7.50" as "7.5", "007" as "7", and stores the canonical form',
          (op) => {
            expect(hashOf(shape(leaf(op, '7.50')))).toBe(hashOf(shape(leaf(op, '7.5'))));
            expect(hashOf(shape(leaf(op, '007')))).toBe(hashOf(shape(leaf(op, '7'))));
            expect(parse(withCondition(shape(leaf(op, '07.50'))))).toMatchObject({
              condition: shape(leaf(op, '7.5')),
            });
          },
        );

        it.each([...NUMERIC_COMPARISONS])('%s: still tells 7.5 from 7.6', (op) => {
          expect(hashOf(shape(leaf(op, '7.5')))).not.toBe(hashOf(shape(leaf(op, '7.6'))));
          expect(hashOf(shape(leaf(op, '7.50')))).not.toBe(hashOf(shape(leaf(op, '-7.5'))));
        });

        it.each(['eq', 'neq'])('%s: compared as text, so "7.50" and "7.5" stay two rules', (op) => {
          expect(hashOf(shape(leaf(op, '7.50')))).not.toBe(hashOf(shape(leaf(op, '7.5'))));
          expect(parse(withCondition(shape(leaf(op, '007'))))).toMatchObject({
            condition: shape(leaf(op, '007')),
          });
        });
      });

      it('leaves JSON numbers, booleans, non-decimals and malformed nodes as sent', () => {
        for (const value of [7.5, true, ' 7.5', '1e3', '']) {
          expect(canonicalCondition(leaf('gte', value))).toEqual(leaf('gte', value));
        }
        expect(canonicalCondition({ field: 'hours', op: 'gte' })).toEqual({
          field: 'hours',
          op: 'gte',
        });
        for (const node of [null, 'gte', 7, ['7.50'], { all: 'x' }]) {
          expect(canonicalCondition(node)).toEqual(node);
        }
      });

      it('leaves the request’s own condition as it was', () => {
        const sent = { all: [{ any: [leaf('lt', '07.50')] }] };
        canonicalCondition(sent);
        expect(sent).toEqual({ all: [{ any: [leaf('lt', '07.50')] }] });
      });

      it('executes the canonical condition exactly as the condition sent', () => {
        const payloads = ['7.4', '7.5', '7.50', '7.6', '-7.5', '0', '-0', 7.5, 'x', undefined].map(
          (hours) => ({ hours, x: 1 }),
        );
        for (const op of [...NUMERIC_COMPARISONS, 'eq', 'neq']) {
          for (const value of ['7.50', '007.5', '-07.50', '-0.0', '.5', '7.']) {
            for (const [, shape] of shapes) {
              const sent = shape(leaf(op, value));
              const canonical = canonicalCondition(sent);
              for (const payload of payloads) {
                expect(conditionMet(canonical, payload)).toBe(conditionMet(sent, payload));
              }
            }
          }
        }
      });
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

import { z } from 'zod';
import { amountMinorSchema, isoDateTime } from '@rasta/contracts';
import { zodPipe } from '@rasta/nest-common';
import {
  canonicalAmountMinor,
  canonicalBody,
  canonicalBodyPipe,
  canonicalDecimal,
  canonicalFieldsOf,
  canonicalForm,
  canonicalInstant,
  canonicalPipe,
  canonicalText,
  canonicalWithin,
  isCanonicalBodyPipe,
  withCanonicalForm,
} from './canonical';
import { hashRequestBody, targeted } from './idempotency';
import {
  NUMERIC_COMPARISONS,
  canonicalCondition,
  createParticipationRuleSchema,
  createRecognitionRuleSchema,
  createRewardRuleSchema,
} from '../reward/dto';
import {
  cancelTransactionSchema,
  createTransactionSchema,
  disputeTransactionSchema,
  refundTransactionSchema,
  resolveDisputeSchema,
  settleTransactionSchema,
} from '../transaction/dto';
import {
  operatorDecisionSchema,
  proposeResolutionSchema,
  refundPaymentSchema,
  topUpSchema,
} from '../payment/dto';
import { conditionMet } from '../reward/rule-engine';
import { PARTICIPATION_FACTS } from '../reward/participation';

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
        it.each([...NUMERIC_COMPARISONS, 'eq', 'neq'])(
          '%s: hashes "7.50" as "7.5", "007" as "7", and stores the canonical form',
          (op) => {
            expect(hashOf(shape(leaf(op, '7.50')))).toBe(hashOf(shape(leaf(op, '7.5'))));
            expect(hashOf(shape(leaf(op, '007')))).toBe(hashOf(shape(leaf(op, '7'))));
            expect(parse(withCondition(shape(leaf(op, '07.50'))))).toMatchObject({
              condition: shape(leaf(op, '7.5')),
            });
          },
        );

        it.each([...NUMERIC_COMPARISONS, 'eq', 'neq'])('%s: still tells 7.5 from 7.6', (op) => {
          expect(hashOf(shape(leaf(op, '7.5')))).not.toBe(hashOf(shape(leaf(op, '7.6'))));
          expect(hashOf(shape(leaf(op, '7.50')))).not.toBe(hashOf(shape(leaf(op, '-7.5'))));
        });

        it.each(['eq', 'neq'])('%s: textual facts keep literal operands', (op) => {
          const text = (value: string) => ({ field: 'type', op, value });
          expect(hashOf(shape(text('7.50')))).not.toBe(hashOf(shape(text('7.5'))));
          expect(parse(withCondition(shape(text('007'))))).toMatchObject({
            condition: shape(text('007')),
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
      nested: { kind: 'object', fields: { amount: { kind: 'amountMinor' } } },
    });
  });
});

describe('every idempotent command’s body (task 129)', () => {
  const ZULU = { offset: false, local: false, precision: null };
  const pipeOf = (schema: z.ZodType) => (body: unknown) =>
    canonicalBodyPipe(schema).transform(body, { type: 'body' }) as Record<string, unknown>;
  /** What the idempotency hash sees of a body: its canonical form, else the body. */
  const hashedOf = (schema: z.ZodType) => (body: unknown) => {
    const dto = pipeOf(schema)(body);
    return (canonicalForm(dto) ?? dto) as Record<string, unknown>;
  };
  const topUp = topUpSchema.omit({ idempotencyKey: true }).partial({ instrument: true });
  /** What the release before canonicalization did with a body: `zodPipe(schema)`. */
  const previousRelease = (schema: z.ZodType, body: unknown) =>
    zodPipe(schema).transform(body, { type: 'body' }) as Record<string, unknown>;
  const refusalOf = (run: () => unknown): unknown => {
    try {
      run();
      return undefined;
    } catch (error) {
      return { error: String(error), details: (error as { details?: unknown }).details };
    }
  };

  it('finds a refined amount — the top-up’s positive one — not only the schema itself', () => {
    expect(canonicalFieldsOf(topUp)).toEqual({
      amountMinor: { kind: 'amountMinor' },
      instrument: { kind: 'form', canonicalize: expect.any(Function) },
    });
    expect(hashedOf(topUp)({ amountMinor: '01000' })).toEqual({ amountMinor: '1000' });
    // Still refused as it was: zero is not positive, however it is spelt.
    expect(() => pipeOf(topUp)({ amountMinor: '000' })).toThrow();
    // A look-alike pattern is not the amount schema.
    expect(canonicalFieldsOf(z.object({ code: z.string().regex(/^\d{1,30}$/) }))).toEqual({});
  });

  it('finds the transaction’s amount, its instant and its identifiers', () => {
    expect(canonicalFieldsOf(createTransactionSchema)).toEqual({
      grossAmountMinor: { kind: 'amountMinor' },
      occurredAt: { kind: 'instant', options: ZULU },
      sourceType: { kind: 'form', canonicalize: expect.any(Function) },
      sourceReference: { kind: 'form', canonicalize: expect.any(Function) },
      idempotencyKey: { kind: 'form', canonicalize: expect.any(Function) },
    });
  });

  it('leaves an identifier exactly as sent: a line ending in a name is part of the name', () => {
    const body = {
      transactionType: 'LOGISTICS',
      grossAmountMinor: '0700',
      sourceType: 'FREIGHT',
      sourceReference: 'REF\r\n7',
    };
    expect(hashedOf(createTransactionSchema)(body)).toMatchObject({
      grossAmountMinor: '700',
      sourceReference: 'REF\r\n7',
    });
    expect(hashedOf(topUp)({ amountMinor: '1', instrument: 'fail:\r\nX' })).toMatchObject({
      instrument: 'fail:\r\nX',
    });
    expect(hashedOf(settleTransactionSchema)({ transactionId: 'TXN\r\n1' })).toEqual({
      transactionId: 'TXN\r\n1',
    });
  });

  it('walks nested objects and arrays: every level and badge name, never a badge code', () => {
    const body = {
      expectedCurrentVersion: 0,
      basis: 'REWARD_POINTS_CUMULATIVE',
      levels: [
        { name: 'one\r\ntwo', threshold: 0 },
        { name: 'three', threshold: 5 },
      ],
      badges: [{ code: 'SAMPLE_ONE', name: 'four\rfive', threshold: 1 }],
      label: 'six\r\nseven',
    };
    const canonical = hashedOf(createRecognitionRuleSchema)(body);
    expect(canonical).toEqual({
      ...body,
      levels: [
        { name: 'one\ntwo', threshold: 0 },
        { name: 'three', threshold: 5 },
      ],
      badges: [{ code: 'SAMPLE_ONE', name: 'four\nfive', threshold: 1 }],
      label: 'six\nseven',
    });
    // The request's own arrays and objects are left as they were.
    expect(body.levels[0]!.name).toBe('one\r\ntwo');
    // Two names that differ only in line endings are one name once LF; the
    // previous release accepted them as two, so they are kept as sent
    // (Codex PR-747 r1, F2; below).
    const apart = {
      ...body,
      levels: [
        { name: 'a\r\nb', threshold: 0 },
        { name: 'a\nb', threshold: 1 },
      ],
    };
    expect(hashedOf(createRecognitionRuleSchema)(apart)).toEqual(
      previousRelease(createRecognitionRuleSchema, apart),
    );
  });

  it('normalizes the text of every other command', () => {
    for (const [schema, field] of [
      [disputeTransactionSchema, 'reason'],
      [resolveDisputeSchema, 'resolution'],
      [cancelTransactionSchema, 'reason'],
      [refundPaymentSchema, 'reason'],
      [operatorDecisionSchema, 'reason'],
      [createParticipationRuleSchema, 'label'],
    ] as const) {
      expect([field, canonicalFieldsOf(schema)[field]]).toEqual([field, { kind: 'text' }]);
    }
    expect(canonicalFieldsOf(proposeResolutionSchema)).toEqual({ reason: { kind: 'text' } });
  });

  // Executed and stored as sent (Codex PR-747 r3, F4): what a command writes —
  // a dispute's reason, a resolution, a level name — is what the previous
  // release wrote, so a reader that compares it exactly (marketplace before
  // #747, recovering a step after its stored answer expired) still finds it.
  // Every idempotent command's schema, with every kind of field spelt as no
  // canonical form spells it.
  it('hands every command exactly the body the previous release executed', () => {
    const corpus: Array<[z.ZodType, unknown]> = [
      [topUp, { amountMinor: '0001000', instrument: ' fail:\r\nX ' }],
      [
        createTransactionSchema,
        {
          transactionType: 'LOGISTICS',
          grossAmountMinor: '0700',
          occurredAt: '2026-11-05T12:00:00Z',
          sourceType: 'FREIGHT',
          sourceReference: 'REF\r\n7',
          idempotencyKey: 'key-0001\r',
        },
      ],
      [disputeTransactionSchema, { reason: '  line one\r\nline two\r ' }],
      [resolveDisputeSchema, { resolution: 'decided\rfor the supplier', disputeId: 'TXD_1' }],
      [refundTransactionSchema, { reason: 'line one\r\nline two' }],
      [cancelTransactionSchema, { reason: 'line one\r\nline two' }],
      [settleTransactionSchema, { transactionId: 'TXN_1' }],
      [refundPaymentSchema, { reason: 'line one\r\nline two' }],
      [operatorDecisionSchema, { reason: 'line one\r\nline two' }],
      [
        proposeResolutionSchema,
        { providerOutcome: 'DECLINED', evidenceReference: 'TICKET-1', reason: 'a\r\nb c d e f' },
      ],
      [
        createRecognitionRuleSchema,
        {
          expectedCurrentVersion: 0,
          basis: 'REWARD_POINTS_CUMULATIVE',
          levels: [{ name: 'one\r\ntwo', threshold: 0 }],
          badges: [{ code: 'SAMPLE_ONE', name: 'four\rfive', threshold: 1 }],
          label: 'six\r\nseven',
        },
      ],
      [
        createParticipationRuleSchema,
        {
          expectedCurrentVersion: 0,
          windowDays: 30,
          contributions: [{ triggerEvent: PARTICIPATION_FACTS[0], weight: 1 }],
          label: 'six\r\nseven',
        },
      ],
    ];
    let canonicalized = 0;
    for (const [schema, body] of corpus) {
      const before = refusalOf(() => previousRelease(schema, body));
      if (before !== undefined) {
        // Refused alike (below); nothing executed to compare.
        expect({ body, now: refusalOf(() => pipeOf(schema)(body)) }).toEqual({ body, now: before });
        continue;
      }
      const dto = pipeOf(schema)(body);
      expect({ body, executed: dto }).toEqual({ body, executed: previousRelease(schema, body) });
      if (canonicalForm(dto) !== undefined) canonicalized += 1;
    }
    // The corpus is spelt to be canonicalized: most of it has a canonical
    // form the hash sees, and none of that form is what is executed.
    expect(canonicalized).toBe(corpus.length - 1);
  });

  describe('the canonical form, for the idempotency hash only', () => {
    it('is kept only when canonicalization changed something', () => {
      const changed = pipeOf(disputeTransactionSchema)({ reason: 'line one\r\nline two' });
      expect(changed).toEqual({ reason: 'line one\r\nline two' });
      expect(canonicalForm(changed)).toEqual({ reason: 'line one\nline two' });
      const unchanged = pipeOf(disputeTransactionSchema)({ reason: 'line one\nline two' });
      expect(canonicalForm(unchanged)).toBeUndefined();
    });

    it('beside the body exactly as the previous release validated it — trimmed, defaulted', () => {
      const body = { transactionType: 'LOGISTICS', grossAmountMinor: '0700' };
      const dto = pipeOf(createTransactionSchema)(body);
      expect(dto).toEqual(zodPipe(createTransactionSchema).transform(body, { type: 'body' }));
      expect(canonicalForm(dto)).toEqual({ ...dto, grossAmountMinor: '700' });
    });

    it('counts transaction text with LF line endings, and executes it as sent (PR-806 r1, F1)', () => {
      // 1 201 UTF-16 units as sent, over the 1 000 limit; 801 once LF. Its
      // bound is counted on the LF form (`keptTextWithin`, @rasta/contracts):
      // accepted, executed and stored as sent (FU-115), hashed also as LF.
      // This replaces PR-747 r2 F3's "refused as the previous release did"
      // for these four bodies; the rollback edge it guarded is docs/06 § 6.8.
      const reason = `${'a\r\n'.repeat(400)}x`;
      expect(reason).toHaveLength(1201);
      const dto = pipeOf(disputeTransactionSchema)({ reason });
      expect(dto).toEqual({ reason });
      expect(canonicalForm(dto)).toEqual({ reason: expect.stringMatching(/^[^\r]{801}$/) });
      // Over the limit however it is counted: refused, with the as-sent refusal.
      const over = `${'a\r\n'.repeat(500)}x`; // 1 501 as sent, 1 001 once LF
      expect(refusalOf(() => pipeOf(disputeTransactionSchema)({ reason: over }))).toEqual({
        error: expect.any(String),
        details: [expect.objectContaining({ path: 'reason', code: 'too_big' })],
      });
    });

    it('is found inside any wrapper of plain objects and arrays, however deep (PR-747 r1, F1)', () => {
      const dto = pipeOf(operatorDecisionSchema)({ reason: 'line one\r\nline two' });
      const by = { userId: 'USR_1', issuer: 'https://issuer', subject: 'sub-1' };
      // The reconciliation's shape: the target around the actor binding around the body.
      expect(canonicalForm(targeted('PI_1/RES_1', { by, body: dto }))).toEqual({
        id: 'PI_1/RES_1',
        body: { by, body: { reason: 'line one\nline two' } },
      });
      expect(canonicalForm([{ wrapped: [dto] }, 'x'])).toEqual([
        { wrapped: [{ reason: 'line one\nline two' }] },
        'x',
      ]);
      // A wrapper with no body of the pipe in it has no canonical form;
      // neither does a copy of one — a copy is not the body the pipe
      // validated, and is hashed only as it is (fewer replays, never another).
      expect(canonicalForm({ by, body: { reason: 'line one\r\nline two' } })).toBeUndefined();
      expect(canonicalForm({ by, body: { ...dto } })).toBeUndefined();
      // Never walked into: an instance that is not a plain object.
      class Holder {
        constructor(readonly body: unknown) {}
      }
      expect(canonicalForm({ held: new Holder(dto) })).toBeUndefined();
    });

    it('travels with the target id (`targeted`)', () => {
      const dto = pipeOf(disputeTransactionSchema)({ reason: 'line one\r\nline two' });
      expect(canonicalForm(targeted('TXN_1', dto))).toEqual({
        id: 'TXN_1',
        body: { reason: 'line one\nline two' },
      });
      expect(canonicalForm(targeted('TXN_1', { reason: 'plain body' }))).toBeUndefined();
      expect(canonicalForm(targeted('TXN_1'))).toBeUndefined();
    });
  });

  describe('a body whose canonical form the schema refuses (Codex PR-747 r1, F2)', () => {
    // Ten UTF-16 units as sent, the minimum; nine once LF.
    const short = '1234\r\n5678';

    it.each([
      ['a dispute', disputeTransactionSchema, { reason: short }],
      // Trimmed by its schema: the answer is the parsed body, never the raw one.
      ['a padded dispute', disputeTransactionSchema, { reason: `  ${short}  ` }],
      ['a dispute resolution', resolveDisputeSchema, { resolution: short }],
      [
        'a recognition version with two level names apart only by their line endings',
        createRecognitionRuleSchema,
        {
          expectedCurrentVersion: 0,
          basis: 'REWARD_POINTS_CUMULATIVE',
          levels: [
            { name: 'first\r\nsecond', threshold: 0 },
            { name: 'first\nsecond', threshold: 5 },
          ],
          badges: [],
        },
      ],
    ] as const)('%s: answered exactly as the previous release answered it', (_, schema, body) => {
      expect(schema.safeParse(canonicalBody(body, canonicalFieldsOf(schema))).success).toBe(false);
      const dto = pipeOf(schema)(body);
      expect(dto).toEqual(previousRelease(schema, body));
      // Hashed as sent — what the previous release stored — with nothing else
      // to compare: no other spelling of it is canonical either.
      expect(canonicalForm(dto)).toBeUndefined();
      expect(hashRequestBody(targeted('TXN_1', dto))).toBe(
        hashRequestBody(targeted('TXN_1', previousRelease(schema, body))),
      );
    });

    it('a body the previous release refused is refused, with its refusal', () => {
      const body = { reason: '123\r\n456' };
      expect(() => previousRelease(disputeTransactionSchema, body)).toThrow();
      expect(refusalOf(() => pipeOf(disputeTransactionSchema)(body))).toEqual(
        refusalOf(() => previousRelease(disputeTransactionSchema, body)),
      );
    });

    // Both directions (Codex PR-747 r2, F3): a retry can reach either release
    // during a rolling update or a rollback, so neither may refuse what the
    // other accepts. Limits counted after LF wait for canonical-only (docs/06).
    it('refuses exactly what the previous release refused, with its refusal', () => {
      const texts = [
        '',
        short,
        '123\r\n456',
        'abcd\r\n'.repeat(200),
        `${'a\r\n'.repeat(400)}x`,
        'abcd\r'.repeat(200),
        'abcd\r'.repeat(201),
        'a\rb',
        'within\r\nevery limit',
      ];
      const corpus: Array<[z.ZodType, unknown]> = [
        ...texts.map((reason) => [disputeTransactionSchema, { reason }] as [z.ZodType, unknown]),
        ...texts.map(
          (resolution) => [resolveDisputeSchema, { resolution }] as [z.ZodType, unknown],
        ),
        ...texts.map((reason) => [refundTransactionSchema, { reason }] as [z.ZodType, unknown]),
        ...texts.map((reason) => [cancelTransactionSchema, { reason }] as [z.ZodType, unknown]),
        ...texts.map((reason) => [refundPaymentSchema, { reason }] as [z.ZodType, unknown]),
        ...texts.map((reason) => [operatorDecisionSchema, { reason }] as [z.ZodType, unknown]),
        ...texts.map(
          (reason) =>
            [
              proposeResolutionSchema,
              { providerOutcome: 'DECLINED', evidenceReference: 'TICKET-1', reason },
            ] as [z.ZodType, unknown],
        ),
        ...['000', '0001000', '01', '1'].map(
          (amountMinor) => [topUp, { amountMinor }] as [z.ZodType, unknown],
        ),
      ];
      let refused = 0;
      for (const [schema, body] of corpus) {
        const before = refusalOf(() => previousRelease(schema, body));
        if (before !== undefined) refused += 1;
        expect({ body, now: refusalOf(() => pipeOf(schema)(body)) }).toEqual({ body, now: before });
      }
      // The corpus holds both: bodies refused as sent (over and under a limit,
      // in CRLF and CR) and bodies accepted.
      expect(refused).toBeGreaterThanOrEqual(corpus.length / 3);
      expect(refused).toBeLessThan(corpus.length);
    });
  });

  it('marks its pipes, and only its pipes, for the route guard', () => {
    expect(isCanonicalBodyPipe(canonicalBodyPipe(disputeTransactionSchema))).toBe(true);
    expect(isCanonicalBodyPipe(canonicalPipe(createRewardRuleSchema))).toBe(false);
    expect(isCanonicalBodyPipe(zodPipe(disputeTransactionSchema))).toBe(false);
    expect(() => canonicalBodyPipe(z.string())).toThrow('object schema');
  });

  it('returns a body nothing changed as the very same object', () => {
    const body = { reason: 'nothing to change' };
    expect(canonicalBody(body, canonicalFieldsOf(disputeTransactionSchema))).toBe(body);
  });
});

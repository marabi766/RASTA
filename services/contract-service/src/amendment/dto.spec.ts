import {
  amendmentViewSchema,
  listAmendmentsQuerySchema,
  proposeAmendmentSchema,
  signAmendmentSchema,
} from './dto';

const body = { deltaMinor: '1000', reasonCode: 'SCOPE_CHANGE', reasonText: 'Extra pile work' };

describe('proposeAmendmentSchema', () => {
  it('takes the amount as a decimal string and the reason as a code and a text', () => {
    expect(proposeAmendmentSchema.parse(body)).toEqual(body);
  });

  it('is strict: no status, no proposer, no side, no number can be named', () => {
    for (const extra of ['status', 'proposedBy', 'side', 'amendmentNumber', 'organizationId']) {
      expect(proposeAmendmentSchema.safeParse({ ...body, [extra]: 'x' }).success).toBe(false);
    }
  });

  describe('the amount, as a bigint at the edges', () => {
    it.each([
      '1',
      '9007199254740993', // 2^53 + 1: a number would round it
      '9223372036854775807', // 2^63 - 1: the largest a bigint column stores
    ])('accepts %s exactly', (deltaMinor) => {
      expect(proposeAmendmentSchema.parse({ ...body, deltaMinor }).deltaMinor).toBe(deltaMinor);
    });

    it.each([
      '9223372036854775808', // 2^63: past what is stored
      '99999999999999999999999999999',
      '1.5',
      '1e3',
      '0x10',
      ' 1',
      '',
      '+5',
      '--1',
    ])('refuses %p at the boundary (400)', (deltaMinor) => {
      expect(proposeAmendmentSchema.safeParse({ ...body, deltaMinor }).success).toBe(false);
    });

    it.each(['0', '-1', '-9223372036854775808'])(
      'lets %s through the shape, to be refused as a rule (422 AMENDMENT_DELTA_NOT_POSITIVE)',
      (deltaMinor) => {
        expect(proposeAmendmentSchema.safeParse({ ...body, deltaMinor }).success).toBe(true);
      },
    );

    it('refuses a number where a string is required: never a float', () => {
      expect(proposeAmendmentSchema.safeParse({ ...body, deltaMinor: 1000 }).success).toBe(false);
    });
  });

  describe('the reason', () => {
    it.each(['scope', 'S', 'SCOPE CHANGE', '1SCOPE', 'A'.repeat(65)])(
      'refuses the code %p',
      (reasonCode) => {
        expect(proposeAmendmentSchema.safeParse({ ...body, reasonCode }).success).toBe(false);
      },
    );

    it('trims the text, bounds it to 1000 and refuses empty text', () => {
      expect(proposeAmendmentSchema.parse({ ...body, reasonText: '  why  ' }).reasonText).toBe(
        'why',
      );
      expect(proposeAmendmentSchema.safeParse({ ...body, reasonText: '   ' }).success).toBe(false);
      expect(
        proposeAmendmentSchema.safeParse({ ...body, reasonText: 'x'.repeat(1000) }).success,
      ).toBe(true);
      expect(
        proposeAmendmentSchema.safeParse({ ...body, reasonText: 'x'.repeat(1001) }).success,
      ).toBe(false);
    });

    it.each(['‮', '‪', '⁦', '‏', '؜'])(
      'refuses a bidirectional control in the text (%j)',
      (control) => {
        expect(
          proposeAmendmentSchema.safeParse({ ...body, reasonText: `12${control}34` }).success,
        ).toBe(false);
      },
    );

    it('keeps Persian text and the zero-width non-joiner', () => {
      const reasonText = 'افزایش حجم عملیات می‌شود';
      expect(proposeAmendmentSchema.parse({ ...body, reasonText }).reasonText).toBe(reasonText);
    });
  });

  it('takes an optional contract version, a positive integer', () => {
    expect(proposeAmendmentSchema.safeParse({ ...body, expectedVersion: 3 }).success).toBe(true);
    for (const expectedVersion of [0, -1, 1.5, '2']) {
      expect(proposeAmendmentSchema.safeParse({ ...body, expectedVersion }).success).toBe(false);
    }
  });
});

describe('signAmendmentSchema', () => {
  it('takes nothing but an optional version, so nothing decides who signs or for which side', () => {
    expect(signAmendmentSchema.parse({})).toEqual({});
    expect(signAmendmentSchema.parse({ expectedVersion: 2 })).toEqual({ expectedVersion: 2 });
    for (const extra of ['side', 'signedBy', 'organizationId', 'policyId']) {
      expect(signAmendmentSchema.safeParse({ [extra]: 'x' }).success).toBe(false);
    }
  });
});

describe('listAmendmentsQuerySchema', () => {
  it('pages by the last amendment number and bounds the page', () => {
    expect(listAmendmentsQuerySchema.parse({}).limit).toBe(50);
    expect(listAmendmentsQuerySchema.parse({ cursor: '12', limit: '100' })).toEqual({
      cursor: '12',
      limit: 100,
    });
    for (const query of [{ cursor: '0' }, { cursor: 'abc' }, { cursor: '1.5' }, { limit: '101' }]) {
      expect(listAmendmentsQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('amendmentViewSchema', () => {
  it('is strict, and shows no signer', () => {
    expect(Object.keys(amendmentViewSchema.shape)).not.toEqual(
      expect.arrayContaining(['signedBy', 'proposedBy']),
    );
  });
});

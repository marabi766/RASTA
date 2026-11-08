import {
  NEED_COMMANDS,
  NEED_NOTHING_CHANGED_MESSAGE,
  canAddNeed,
  canonicalQuantity,
  needCommandsFrom,
  needStatusLabel,
  normalizeNeedValues,
  parseAddNeedForm,
  parseEditNeedForm,
  parseQuantity,
  parseSubmitNeedForm,
  parseWithdrawNeedForm,
  type NeedField,
} from './project-need-commands';

/**
 * The need forms’ own rules: a quantity is read by value (never a float, never
 * guessed from a thousands separator), an edit sends only what changed and clears
 * an optional field with `null`, an add leaves an empty optional field out.
 */

const VALID = {
  title: 'بتن آماده',
  description: 'بتن با مقاومت بالا',
  quantity: '25',
  unit: 'متر مکعب',
  estimatedCost: '1500000',
};

describe('a quantity', () => {
  it.each([
    ['25', '25'],
    ['25.0', '25'],
    ['25.50', '25.5'],
    ['007.5', '7.5'],
    ['0.5', '0.5'],
    ['۲۵٫۵۰', '25.5'],
    ['٢٥', '25'],
    ['5.', '5'],
    ['  7  ', '7'],
    ['1.23450', '1.2345'],
    ['', ''],
  ])('%j is the one text %j', (typed, canonical) => {
    expect(canonicalQuantity(typed)).toBe(canonical);
  });

  it.each(['abc', '1,000', '1٬000', '-1', '.5', '1.2.3', '1e3', '١٢،٥'])(
    'is not rewritten when it is not a decimal number: %j',
    (typed) => {
      expect(canonicalQuantity(typed)).toBe(typed.trim());
      expect(parseQuantity(typed).ok).toBe(false);
    },
  );

  it('is read without a float: fourteen integer digits and four fractional ones keep every digit', () => {
    const exact = '99999999999999.9999';
    expect(parseQuantity(exact)).toEqual({ ok: true, quantity: exact });
    expect(parseQuantity('100000000000000')).toMatchObject({ ok: false });
    expect(parseQuantity('1.50000')).toMatchObject({ ok: true, quantity: '1.5' });
    expect(parseQuantity('1.00001')).toMatchObject({ ok: false });
    expect(parseQuantity('1.00011')).toMatchObject({ ok: false });
  });

  it('is absent when empty, and refused when it is not greater than zero', () => {
    expect(parseQuantity('')).toEqual({ ok: true, quantity: null });
    expect(parseQuantity('   ')).toEqual({ ok: true, quantity: null });
    for (const zero of ['0', '0.0', '000', '0.0000']) expect(parseQuantity(zero).ok).toBe(false);
  });
});

describe('adding a need', () => {
  it('sends the required fields, and the optional ones only when typed', () => {
    expect(parseAddNeedForm(normalizeNeedValues(VALID))).toEqual({
      ok: true,
      body: {
        title: 'بتن آماده',
        description: 'بتن با مقاومت بالا',
        quantity: '25',
        unit: 'متر مکعب',
        estimatedCostMinor: '1500000',
      },
    });
    expect(
      parseAddNeedForm(
        normalizeNeedValues({ ...VALID, quantity: '', unit: '', estimatedCost: '' }),
      ),
    ).toEqual({ ok: true, body: { title: 'بتن آماده', description: 'بتن با مقاومت بالا' } });
  });

  it('refuses each field with its own message, and says them all at once', () => {
    const parsed = parseAddNeedForm(
      normalizeNeedValues({
        title: 'ا',
        description: '   ',
        quantity: '1,000',
        unit: 'ع'.repeat(51),
        estimatedCost: '-5',
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.fieldErrors).sort()).toEqual([
      'description',
      'estimatedCost',
      'quantity',
      'title',
      'unit',
    ]);
  });

  it('counts the description with one kind of line ending', () => {
    const lf = `${'ا'.repeat(999)}\n${'ب'.repeat(1000)}`;
    expect(
      parseAddNeedForm(normalizeNeedValues({ ...VALID, description: lf.replace('\n', '\r\n') })),
    ).toMatchObject({ ok: true, body: { description: lf } });
    expect(parseAddNeedForm(normalizeNeedValues({ ...VALID, description: `${lf}ب` })).ok).toBe(
      false,
    );
  });

  it('reads Persian digits and letters the way the rest of the portal does', () => {
    const parsed = parseAddNeedForm(
      normalizeNeedValues({ ...VALID, title: 'بتن كاري', estimatedCost: '۱٬۵۰۰٬۰۰۰' }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      body: { title: 'بتن کاری', estimatedCostMinor: '1500000' },
    });
  });
});

describe('editing a need', () => {
  const all = (): ReadonlySet<NeedField> =>
    new Set(['title', 'description', 'quantity', 'unit', 'estimatedCost']);
  const without = (...fields: NeedField[]): ReadonlySet<NeedField> => {
    const set = new Set(all());
    for (const field of fields) set.delete(field);
    return set;
  };

  it('sends nothing, and says so, when nothing changed', () => {
    expect(parseEditNeedForm(normalizeNeedValues(VALID), all())).toEqual({
      ok: false,
      fieldErrors: { title: NEED_NOTHING_CHANGED_MESSAGE },
    });
  });

  it('sends only the fields that changed', () => {
    expect(
      parseEditNeedForm(
        normalizeNeedValues({ ...VALID, title: 'بتن شمالی', quantity: '30' }),
        without('title', 'quantity'),
      ),
    ).toEqual({ ok: true, body: { title: 'بتن شمالی', quantity: '30' } });
  });

  it('clears an optional field with null, and not a required one', () => {
    expect(
      parseEditNeedForm(
        normalizeNeedValues({ ...VALID, quantity: '', unit: '', estimatedCost: '' }),
        without('quantity', 'unit', 'estimatedCost'),
      ),
    ).toEqual({
      ok: true,
      body: { quantity: null, unit: null, estimatedCostMinor: null },
    });
    const emptied = parseEditNeedForm(
      normalizeNeedValues({ ...VALID, title: '', description: '' }),
      without('title', 'description'),
    );
    expect(emptied.ok).toBe(false);
  });

  it('does not re-check a field the person did not touch', () => {
    expect(
      parseEditNeedForm(
        normalizeNeedValues({ ...VALID, title: 'ا', description: 'شرح تازه' }),
        without('description'),
      ),
    ).toEqual({ ok: true, body: { description: 'شرح تازه' } });
  });

  it('keeps the other fields’ messages out of an unchanged field', () => {
    const parsed = parseEditNeedForm(
      normalizeNeedValues({ ...VALID, quantity: 'abc', unit: 'ع'.repeat(51) }),
      without('quantity'),
    );
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(Object.keys(parsed.fieldErrors)).toEqual(['quantity']);
  });
});

describe('withdrawing and submitting', () => {
  it('a withdrawal states its reason: eight characters at least, five hundred at most', () => {
    expect(parseWithdrawNeedForm({ reason: 'ع'.repeat(7) }).ok).toBe(false);
    expect(parseWithdrawNeedForm({ reason: 'ع'.repeat(8) })).toEqual({
      ok: true,
      body: { reason: 'ع'.repeat(8) },
    });
    expect(parseWithdrawNeedForm({ reason: 'ع'.repeat(501) }).ok).toBe(false);
    expect(parseWithdrawNeedForm({ reason: '' })).toMatchObject({
      ok: false,
      fieldErrors: { reason: expect.stringContaining('بنویسید') },
    });
  });

  it('a submission sends nothing but the version', () => {
    expect(parseSubmitNeedForm()).toEqual({ ok: true, body: {} });
  });
});

describe('which command a status offers', () => {
  it('offers nothing in a status this portal has no word for', () => {
    expect(needCommandsFrom('DRAFT', 'ARCHIVED')).toEqual([]);
    expect(needCommandsFrom('ARCHIVED', 'DRAFT')).toEqual([]);
    expect(canAddNeed('ARCHIVED')).toBe(false);
    expect(needStatusLabel('ARCHIVED')).toBe('ARCHIVED');
    expect(needStatusLabel('DRAFT')).toBe('پیش‌نویس');
  });

  it('never offers the add on a need (it is the form under the list)', () => {
    for (const project of ['DRAFT', 'CHANGES_REQUESTED']) {
      for (const need of ['DRAFT', 'SUBMITTED', 'WITHDRAWN']) {
        expect(needCommandsFrom(project, need)).not.toContain('add');
      }
    }
    expect(NEED_COMMANDS).toEqual(['add', 'edit', 'submit', 'withdraw']);
  });
});

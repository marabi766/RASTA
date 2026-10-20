import {
  INPUT_MESSAGES,
  calendarDay,
  commandFormValues,
  isCommandInput,
  parseCommandInput,
  shareBasisPoints,
  shareText,
  valuesOfInput,
} from './contract-command-input';

/**
 * Reading the contract command forms as the DTOs read them — one reader for
 * the form (which remembers the body before sending) and the action (which
 * sends it), so the two cannot differ.
 */

describe('a cancellation', () => {
  it('a reason code and an optional note, trimmed', () => {
    expect(parseCommandInput('CANCEL', { reasonCode: 'OTHER', note: '  یادداشت  ' })).toEqual({
      ok: true,
      input: { reasonCode: 'OTHER', note: 'یادداشت' },
    });
    expect(parseCommandInput('CANCEL', { reasonCode: 'OTHER', note: '   ' })).toEqual({
      ok: true,
      input: { reasonCode: 'OTHER' },
    });
  });

  it('refuses no reason, a note too long, and a bidi control', () => {
    expect(parseCommandInput('CANCEL', { reasonCode: '' })).toEqual({
      ok: false,
      fieldErrors: { reasonCode: INPUT_MESSAGES.reasonCode },
      message: null,
    });
    const long = parseCommandInput('CANCEL', { reasonCode: 'OTHER', note: 'ا'.repeat(1001) });
    expect(long.ok ? null : long.fieldErrors.note).toBe(INPUT_MESSAGES.note);
    const bidi = parseCommandInput('CANCEL', { reasonCode: 'OTHER', note: 'متن‮وارونه' });
    expect(bidi.ok ? null : bidi.fieldErrors.note).toBe(INPUT_MESSAGES.characters);
  });
});

describe('an amendment', () => {
  it('a positive whole amount in rials typed in any digits, a reason and its text', () => {
    expect(
      parseCommandInput('PROPOSE_AMENDMENT', {
        deltaMinor: '۲٬۰۰۰٬۰۰۰',
        reasonCode: 'SCOPE_CHANGE',
        reasonText: ' افزایش كار ',
      }),
    ).toEqual({
      ok: true,
      // Arabic kaf normalised to keheh, as every free text in this portal.
      input: { deltaMinor: '2000000', reasonCode: 'SCOPE_CHANGE', reasonText: 'افزایش کار' },
    });
  });

  it('refuses zero, a negative or a fractional amount, and an empty reason', () => {
    for (const deltaMinor of ['0', '-5', '12.5', 'ده', '']) {
      const parsed = parseCommandInput('PROPOSE_AMENDMENT', {
        deltaMinor,
        reasonCode: 'OTHER',
        reasonText: 'متن',
      });
      expect(parsed.ok ? null : parsed.fieldErrors.deltaMinor).toBe(INPUT_MESSAGES.deltaMinor);
    }
    const empty = parseCommandInput('PROPOSE_AMENDMENT', {
      deltaMinor: '1',
      reasonCode: 'OTHER',
      reasonText: '',
    });
    expect(empty.ok ? null : empty.fieldErrors.reasonText).toBe(INPUT_MESSAGES.reasonText);
  });
});

describe('a milestone', () => {
  it('a title, a calendar day and a share in basis points — blank is none', () => {
    expect(
      parseCommandInput('PLAN_MILESTONE', {
        title: 'فاز یک',
        plannedDate: '2026-12-20',
        plannedShareBp: '۲۵٫۵',
      }),
    ).toEqual({
      ok: true,
      input: { title: 'فاز یک', plannedDate: '2026-12-20', plannedShareBp: 2550 },
    });
    expect(
      parseCommandInput('CHANGE_MILESTONE', {
        title: 'فاز یک',
        plannedDate: '2026-12-20',
        plannedShareBp: '',
      }),
    ).toEqual({
      ok: true,
      input: { title: 'فاز یک', plannedDate: '2026-12-20', plannedShareBp: null },
    });
  });

  it('a day that exists, years 1000 to 9999, as the DTO’s calendarDate', () => {
    expect(calendarDay('2026-02-28')).toBe('2026-02-28');
    expect(calendarDay('2026-02-29')).toBeNull();
    expect(calendarDay('0999-01-01')).toBeNull();
    expect(calendarDay('2026-1-1')).toBeNull();
    expect(calendarDay('۲۰۲۶-۱۲-۲۰')).toBe('2026-12-20');
  });

  it('a share of more than zero, up to 100%, two decimals at most', () => {
    expect(shareBasisPoints('100')).toBe(10_000);
    expect(shareBasisPoints('0.01')).toBe(1);
    expect(shareBasisPoints('12.5')).toBe(1250);
    for (const refused of ['0', '100.01', '101', '1.234', '-1', 'نیم']) {
      expect(shareBasisPoints(refused)).toBeUndefined();
    }
    expect(shareText(2550)).toBe('25.5');
    expect(shareText(10_000)).toBe('100');
    expect(shareText(5)).toBe('0.05');
  });

  it('refuses an empty title, a missing day and a share out of range, each on its field', () => {
    expect(
      parseCommandInput('PLAN_MILESTONE', { title: '', plannedDate: '', plannedShareBp: '200' }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        title: INPUT_MESSAGES.title,
        plannedDate: INPUT_MESSAGES.plannedDate,
        plannedShareBp: INPUT_MESSAGES.plannedShareBp,
      },
      message: null,
    });
  });
});

describe('one reader for the form and the action', () => {
  it('reads only the fields the command draws', () => {
    const form = new FormData();
    form.set('reasonCode', 'OTHER');
    form.set('title', 'not a cancellation field');
    expect(commandFormValues(form, 'CANCEL')).toEqual({ reasonCode: 'OTHER', note: '' });
    expect(commandFormValues(form, 'SIGN')).toEqual({});
  });

  it('a body sent, read back as the form re-sends it, is the same body', () => {
    const cases = [
      ['CANCEL', { reasonCode: 'OTHER', note: 'یادداشت' }],
      [
        'PROPOSE_AMENDMENT',
        { deltaMinor: '2000000', reasonCode: 'SCOPE_CHANGE', reasonText: 'متن' },
      ],
      ['CHANGE_MILESTONE', { title: 'فاز', plannedDate: '2026-12-20', plannedShareBp: 2550 }],
    ] as const;
    for (const [command, input] of cases) {
      expect(parseCommandInput(command, valuesOfInput(command, input))).toEqual({
        ok: true,
        input,
      });
      expect(isCommandInput(command, input)).toBe(true);
    }
  });

  it('a stored body is accepted only as the command could have sent it', () => {
    expect(isCommandInput('SIGN', null)).toBe(true);
    expect(isCommandInput('SIGN', { reasonCode: 'OTHER' })).toBe(false);
    expect(isCommandInput('CANCEL', null)).toBe(false);
    expect(isCommandInput('CANCEL', { reasonCode: 'OTHER', extra: 'x' })).toBe(false);
    expect(isCommandInput('CANCEL', { reasonCode: 'lower' })).toBe(false);
    expect(
      isCommandInput('PLAN_MILESTONE', {
        title: 'فاز',
        plannedDate: '2026-12-20',
        plannedShareBp: 0,
      }),
    ).toBe(false);
    expect(
      isCommandInput('PROPOSE_AMENDMENT', {
        deltaMinor: '0',
        reasonCode: 'OTHER',
        reasonText: 'x',
      }),
    ).toBe(false);
  });
});

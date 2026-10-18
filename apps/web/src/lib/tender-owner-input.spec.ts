import {
  JUSTIFICATION_FIELD,
  REASON_CODE_FIELD,
  REASON_TEXT_FIELD,
  scoreField,
} from './tender-evaluation-fields';
import { REASON_FIELD } from './tender-owner-fields';
import {
  OWNER_INPUT_MESSAGES,
  REJECT_REASON_MESSAGE,
  ownerFields,
  ownerValuesOf,
  parseOwnerForm,
  parseRejectReason,
  scoreMessage,
  type ScoringCell,
} from './tender-owner-input';

/** A rejection's reason, as `statedReason` reads it: trimmed, 8 to 500 characters. */

it('takes a reason of 8 to 500 characters, trimmed', () => {
  expect(parseRejectReason('  معیارها کامل نیست  ')).toEqual({
    ok: true,
    reason: 'معیارها کامل نیست',
  });
  expect(parseRejectReason('x'.repeat(500))).toEqual({ ok: true, reason: 'x'.repeat(500) });
});

it('refuses a reason too short, blank or too long', () => {
  for (const raw of ['کوتاه', '        ', 'x'.repeat(501)]) {
    expect(parseRejectReason(raw)).toEqual({ ok: false, message: REJECT_REASON_MESSAGE });
  }
});

describe('the evaluation’s and the award’s forms, as their DTOs read them', () => {
  const scoring: ScoringCell[] = [
    { criterionCode: 'technical', maxScore: 10, passFail: false, expectedRevision: 2 },
    { criterionCode: 'compliance', maxScore: 1, passFail: true, expectedRevision: 0 },
  ];

  it('a disqualification needs a closed reason and its words, trimmed', () => {
    expect(
      parseOwnerForm(
        'DISQUALIFY',
        { [REASON_CODE_FIELD]: 'NON_RESPONSIVE', [REASON_TEXT_FIELD]: '  مدارک ناقص  ' },
        {},
      ),
    ).toMatchObject({
      ok: true,
      input: { disqualification: { reasonCode: 'NON_RESPONSIVE', reasonText: 'مدارک ناقص' } },
    });
    expect(
      parseOwnerForm('DISQUALIFY', { [REASON_CODE_FIELD]: 'MADE_UP', [REASON_TEXT_FIELD]: '' }, {}),
    ).toEqual({
      ok: false,
      values: { [REASON_CODE_FIELD]: 'MADE_UP', [REASON_TEXT_FIELD]: '' },
      fieldErrors: {
        [REASON_CODE_FIELD]: OWNER_INPUT_MESSAGES.reasonCode,
        [REASON_TEXT_FIELD]: OWNER_INPUT_MESSAGES.reasonText,
      },
    });
  });

  it('a score is read in either digits and either decimal mark, as the points × 100; a blank one is not sent', () => {
    expect(
      parseOwnerForm(
        'SCORE',
        { [scoreField('technical')]: '۸٫۵', [scoreField('compliance')]: '' },
        { scoring },
      ),
    ).toMatchObject({
      ok: true,
      input: { scores: [{ criterionCode: 'technical', scoreScaled: 850, expectedRevision: 2 }] },
    });
    expect(
      parseOwnerForm(
        'SCORE',
        { [scoreField('technical')]: '10', [scoreField('compliance')]: '1' },
        { scoring },
      ),
    ).toMatchObject({
      ok: true,
      input: {
        scores: [
          { criterionCode: 'technical', scoreScaled: 1000 },
          { criterionCode: 'compliance', scoreScaled: 100, expectedRevision: 0 },
        ],
      },
    });
  });

  it('a score out of its range, with three decimals, or between pass and fail is refused on its field', () => {
    for (const [field, raw] of [
      ['technical', '10.5'],
      ['technical', '8.555'],
      ['technical', '-1'],
      ['technical', 'هشت'],
      ['compliance', '0.5'],
    ] as const) {
      const parsed = parseOwnerForm('SCORE', { [scoreField(field)]: raw }, { scoring });
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.fieldErrors[scoreField(field)]).toBe(
        scoreMessage(scoring.find((cell) => cell.criterionCode === field)!),
      );
    }
    expect(parseOwnerForm('SCORE', {}, { scoring })).toMatchObject({
      ok: false,
      fieldErrors: { [scoreField('technical')]: OWNER_INPUT_MESSAGES.scores },
    });
  });

  it('a justification is needed for anything but the single first rank, and never more than 2000 characters', () => {
    expect(parseOwnerForm('AWARD', { [JUSTIFICATION_FIELD]: '  ' }, {})).toMatchObject({
      ok: true,
      input: { justification: null },
    });
    expect(
      parseOwnerForm('AWARD', { [JUSTIFICATION_FIELD]: '' }, { justificationRequired: true }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { [JUSTIFICATION_FIELD]: OWNER_INPUT_MESSAGES.justification },
    });
    expect(parseOwnerForm('AWARD', { [JUSTIFICATION_FIELD]: 'x'.repeat(2001) }, {})).toMatchObject({
      ok: false,
    });
    // Executing an approved request: the request's justification, not the form's.
    expect(parseOwnerForm('AWARD', {}, { executes: true })).toEqual({
      ok: true,
      input: {},
      values: null,
    });
    expect(ownerFields('AWARD', { executes: true })).toEqual([]);
  });

  it('only a command’s own fields are read off a form', () => {
    const form = new FormData();
    form.set(REASON_FIELD, 'یک دلیل کافی و روشن');
    form.set(scoreField('technical'), '7');
    form.set('unrelated', 'x');
    expect(ownerValuesOf('REJECT_AWARD', form, {})).toEqual({
      [REASON_FIELD]: 'یک دلیل کافی و روشن',
    });
    expect(ownerValuesOf('SCORE', form, { scoring })).toEqual({
      [scoreField('technical')]: '7',
      [scoreField('compliance')]: '',
    });
    expect(ownerValuesOf('EVALUATE', form, {})).toEqual({});
    expect(parseOwnerForm('QUALIFY', {}, {})).toEqual({ ok: true, input: {}, values: null });
  });
});

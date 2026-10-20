import { NOTE_FIELD, PRICE_FIELD, answerField, criterionField } from './bid-fields';
import { BID_INPUT_MESSAGES, bidFormValues, parseBid } from './bid-input';

/**
 * Reading a bid's form as `bidContentSchema` reads it — and nothing more: the
 * content is sealed as sent, so it is trimmed and never rewritten.
 */

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const ROWS = {
  [criterionField(0)]: 'technical',
  [criterionField(1)]: 'compliance',
};

describe('reading the form', () => {
  it('reads the price, the note and each criterion row with its code', () => {
    expect(
      bidFormValues(
        form({
          ...ROWS,
          [PRICE_FIELD]: '۴٬۲۰۰٬۰۰۰٬۰۰۰',
          [answerField(0)]: 'روش اجرا',
          [answerField(1)]: '',
          [NOTE_FIELD]: 'یادداشت',
        }),
      ),
    ).toEqual({
      priceMinor: '۴٬۲۰۰٬۰۰۰٬۰۰۰',
      note: 'یادداشت',
      answers: [
        { criterionCode: 'technical', response: 'روش اجرا' },
        { criterionCode: 'compliance', response: '' },
      ],
    });
  });
});

describe('parsing', () => {
  const values = (overrides: Partial<ReturnType<typeof bidFormValues>> = {}) => ({
    priceMinor: '4200000000',
    note: '',
    answers: [
      { criterionCode: 'technical', response: '  روش اجرا  ' },
      { criterionCode: 'compliance', response: '   ' },
    ],
    ...overrides,
  });

  it('sends the price as a decimal string, leaves a blank answer out and trims, never rewrites', () => {
    const parsed = parseBid(values({ priceMinor: '۴٬۲۰۰٬۰۰۰٬۰۰۰', note: ' ي ك ' }));
    expect(parsed).toEqual({
      ok: true,
      content: {
        priceMinor: '4200000000',
        answers: [{ criterionCode: 'technical', response: 'روش اجرا' }],
        // Arabic letters stay as typed: the sealed text is what was sent.
        note: 'ي ك',
      },
      rows: [0],
    });
  });

  it('takes a zero price, as the DTO does, and no answer at all', () => {
    expect(parseBid(values({ priceMinor: '0', answers: [] }))).toEqual({
      ok: true,
      content: { priceMinor: '0', answers: [] },
      rows: [],
    });
  });

  it('refuses a fraction, a negative, a word, a blank and a price past BIGINT', () => {
    for (const price of ['1.5', '-1', 'ده', '', '9223372036854775808']) {
      expect(parseBid(values({ priceMinor: price }))).toEqual({
        ok: false,
        fieldErrors: { [PRICE_FIELD]: BID_INPUT_MESSAGES.price },
      });
    }
    expect(parseBid(values({ priceMinor: '9223372036854775807' })).ok).toBe(true);
  });

  it('refuses an answer or a note past its bound, on its own field', () => {
    const long = parseBid(
      values({
        answers: [{ criterionCode: 'technical', response: 'x'.repeat(2001) }],
        note: 'y'.repeat(4001),
      }),
    );
    expect(long).toEqual({
      ok: false,
      fieldErrors: {
        [answerField(0)]: BID_INPUT_MESSAGES.answer,
        [NOTE_FIELD]: BID_INPUT_MESSAGES.note,
      },
    });
  });

  it('refuses an answer whose criterion cannot be read, or answers one criterion twice', () => {
    const parsed = parseBid(
      values({
        answers: [
          { criterionCode: '', response: 'a' },
          { criterionCode: 'technical', response: 'b' },
          { criterionCode: 'technical', response: 'c' },
        ],
      }),
    );
    expect(parsed).toEqual({
      ok: false,
      fieldErrors: {
        [answerField(0)]: BID_INPUT_MESSAGES.criterion,
        [answerField(2)]: BID_INPUT_MESSAGES.criterion,
      },
    });
  });
});

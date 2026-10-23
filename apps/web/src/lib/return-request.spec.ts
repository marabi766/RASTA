import { REASON_FIELD, quantityField } from './return-fields';
import {
  RETURN_REQUEST_MESSAGES,
  exceedsMessage,
  parseReturnRequest,
  returnRequestFormValues,
  valuesOfBody,
} from './return-request';

/**
 * The return-request form, read the same way by the browser (before it
 * remembers the submission) and the action (before it sends it): exactly the
 * body `createReturnSchema` takes.
 */

const REASON = 'سه کیسه از شن رسیده خیس بود.';
const LINES = [
  { orderLineId: 'OLN_A', available: 4 },
  { orderLineId: 'OLN_B', available: 0 },
];

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

it('reads the reason and each line in the order drawn, Persian digits included', () => {
  const values = returnRequestFormValues(
    form({
      [REASON_FIELD]: REASON,
      [quantityField('OLN_A')]: '۳',
      [quantityField('OLN_B')]: '',
      unrelated: 'x',
    }),
  );
  expect(parseReturnRequest(values, LINES)).toEqual({
    ok: true,
    body: { reason: REASON, lines: [{ orderLineId: 'OLN_A', quantity: 3 }] },
  });
});

it('leaves out a blank or zero line, and needs at least one', () => {
  const values = returnRequestFormValues(
    form({ [REASON_FIELD]: REASON, [quantityField('OLN_A')]: '0' }),
  );
  expect(parseReturnRequest(values, LINES)).toEqual({
    ok: false,
    fieldErrors: {},
    message: RETURN_REQUEST_MESSAGES.noLine,
  });
});

it('refuses a reason too short, too long, or carrying a bidi control', () => {
  const quantity = { [quantityField('OLN_A')]: '1' };
  for (const [reason, message] of [
    ['کوتاه', RETURN_REQUEST_MESSAGES.reasonShort],
    ['ب'.repeat(1001), RETURN_REQUEST_MESSAGES.reasonLong],
    [`${REASON}‮`, RETURN_REQUEST_MESSAGES.characters],
  ] as const) {
    const parsed = parseReturnRequest(
      returnRequestFormValues(form({ [REASON_FIELD]: reason, ...quantity })),
      LINES,
    );
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { [REASON_FIELD]: message } });
  }
});

it('refuses a quantity that is not a whole positive number, or more than the line allows', () => {
  const parsed = parseReturnRequest(
    returnRequestFormValues(
      form({
        [REASON_FIELD]: REASON,
        [quantityField('OLN_A')]: '5',
        [quantityField('OLN_B')]: '1',
      }),
    ),
    LINES,
  );
  expect(parsed).toEqual({
    ok: false,
    fieldErrors: {
      [quantityField('OLN_A')]: exceedsMessage(4),
      [quantityField('OLN_B')]: exceedsMessage(0),
    },
    message: null,
  });
  expect(
    parseReturnRequest(
      returnRequestFormValues(form({ [REASON_FIELD]: REASON, [quantityField('OLN_A')]: '1.5' })),
      LINES,
    ),
  ).toMatchObject({ fieldErrors: { [quantityField('OLN_A')]: RETURN_REQUEST_MESSAGES.quantity } });
});

it('refuses a line that is not the order’s, when the lines are known', () => {
  const values = returnRequestFormValues(
    form({ [REASON_FIELD]: REASON, [quantityField('OLN_OTHER')]: '1' }),
  );
  expect(parseReturnRequest(values, LINES)).toMatchObject({
    ok: false,
    message: RETURN_REQUEST_MESSAGES.unknownLine,
  });
  // The action does not know them: the service checks, under the order's lock.
  expect(parseReturnRequest(values, null)).toMatchObject({ ok: true });
});

it('a kept body reads back as exactly the same request', () => {
  const body = { reason: REASON, lines: [{ orderLineId: 'OLN_A', quantity: 3 }] };
  const values = valuesOfBody(body);
  expect(parseReturnRequest(values, null)).toEqual({ ok: true, body });
});

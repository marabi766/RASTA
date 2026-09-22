/**
 * @jest-environment node
 */
import {
  EMPTY_USAGE_FORM,
  localDateTimeToIso,
  parseUsageForm,
  usageFormValues,
  USAGE_FIELD_MAPPING,
  type UsageFormValues,
} from './usage';

/**
 * Reading the usage form.
 *
 * Two of these are the reason this module exists rather than being a thin
 * pass-through: a quantity typed on a Persian keyboard has to survive, and a
 * wall-clock time has to leave as the right UTC instant. Both are invisible
 * failures — a wrong number is rejected with a confusing message, a wrong
 * instant is accepted and silently files the work on another day.
 */

const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';

function values(overrides: Partial<UsageFormValues> = {}): UsageFormValues {
  return {
    ...EMPTY_USAGE_FORM,
    assetId: 'AST_01JASSET000000000000000000',
    periodStart: '2026-09-21T08:00',
    periodEnd: '2026-09-21T16:30',
    hours: '8.5',
    ...overrides,
  };
}

describe('reading the fields', () => {
  it('reads every field as a string and treats an absent one as empty', () => {
    const form = new FormData();
    form.set('assetId', 'AST_1');
    form.set('hours', '3');
    expect(usageFormValues(form)).toEqual({ ...EMPTY_USAGE_FORM, assetId: 'AST_1', hours: '3' });
  });

  it('ignores a field posted as a file rather than reading it as text', () => {
    const form = new FormData();
    form.set('notes', new Blob(['x']));
    expect(usageFormValues(form).notes).toBe('');
  });
});

describe('local time becomes a UTC instant', () => {
  it('reads the input as Tehran wall-clock time', () => {
    // 08:00 in Tehran on 21 September is 04:30 UTC (+03:30).
    expect(localDateTimeToIso('2026-09-21T08:00')).toBe('2026-09-21T04:30:00.000Z');
  });

  it('accepts Persian digits, which is what a Persian keyboard produces', () => {
    expect(localDateTimeToIso('۲۰۲۶-۰۹-۲۱T۰۸:۰۰')).toBe('2026-09-21T04:30:00.000Z');
  });

  it('refuses a date the calendar does not have rather than rolling it forward', () => {
    // `new Date(2026, 8, 31)` is the 1st of October. Accepting it would file
    // the work on a day the person did not choose.
    expect(localDateTimeToIso('2026-09-31T08:00')).toBeNull();
    expect(localDateTimeToIso('2026-02-30T08:00')).toBeNull();
  });

  it('refuses anything that is not the shape the input produces', () => {
    expect(localDateTimeToIso('')).toBeNull();
    expect(localDateTimeToIso('2026-09-21')).toBeNull();
    expect(localDateTimeToIso('yesterday')).toBeNull();
  });
});

describe('parsing a submission', () => {
  it('builds the request fleet-service accepts, with the submission id as the client reference', () => {
    const parsed = parseUsageForm(values(), SUBMISSION);
    expect(parsed).toMatchObject({
      ok: true,
      request: {
        assetId: 'AST_01JASSET000000000000000000',
        periodStart: '2026-09-21T04:30:00.000Z',
        periodEnd: '2026-09-21T13:00:00.000Z',
        hours: '8.5',
        source: 'MANUAL',
        clientReference: SUBMISSION,
      },
    });
  });

  it('normalises Persian digits and the Persian decimal separator', () => {
    const parsed = parseUsageForm(values({ hours: '۸٫۵', kilometres: '۱۲۰' }), SUBMISSION);
    expect(parsed).toMatchObject({ ok: true, request: { hours: '8.5', kilometres: '120' } });
  });

  it('omits an empty optional rather than sending zero', () => {
    // Zero hours is a claim that the machine ran and did nothing; blank is
    // "not recorded", and the two must not be confused in a maintenance
    // schedule that counts hours.
    const parsed = parseUsageForm(values({ kilometres: '', hourMeter: '' }), SUBMISSION);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.kilometres).toBeUndefined();
      expect(parsed.request.hourMeter).toBeUndefined();
      expect('kilometres' in parsed.request).toBe(true);
    }
  });

  it('requires at least one of hours or kilometres, on the hours field', () => {
    const parsed = parseUsageForm(values({ hours: '', kilometres: '' }), SUBMISSION);
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { hours: 'دست‌کم یکی از ساعت کارکرد یا کیلومتر را وارد کنید' },
    });
  });

  it('requires the period to end after it starts, on the end field', () => {
    const parsed = parseUsageForm(
      values({ periodStart: '2026-09-21T16:30', periodEnd: '2026-09-21T08:00' }),
      SUBMISSION,
    );
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { periodEnd: 'پایان بازه باید پس از شروع آن باشد' },
    });
  });

  it('refuses a quantity with too many decimals, in Persian', () => {
    const parsed = parseUsageForm(values({ hours: '8.555' }), SUBMISSION);
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { hours: 'عددی نامنفی با حداکثر دو رقم اعشار وارد کنید' },
    });
  });

  it('refuses a negative quantity', () => {
    expect(parseUsageForm(values({ hours: '-3' }), SUBMISSION).ok).toBe(false);
  });

  it('refuses an asset id that is not one', () => {
    const parsed = parseUsageForm(values({ assetId: 'not-an-asset' }), SUBMISSION);
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { assetId: 'شناسهٔ ماشین معتبر نیست' },
    });
  });

  it('reports one message per field, not a list', () => {
    const parsed = parseUsageForm(
      values({ assetId: '', hours: 'abc', kilometres: 'def' }),
      SUBMISSION,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      for (const message of Object.values(parsed.fieldErrors)) {
        expect(typeof message).toBe('string');
      }
    }
  });
});

describe('the mapping back from the service', () => {
  it('names a path for every field the form posts', () => {
    // A service detail about a field with no mapping would become a banner
    // instead of an error under the input that caused it.
    for (const field of Object.keys(EMPTY_USAGE_FORM)) {
      expect(USAGE_FIELD_MAPPING.paths[field]).toBe(field);
    }
  });

  it('translates the sentences fleet-service actually emits today', () => {
    // Taken from `recordUsageSchema` and `UsageService.record`. If one of
    // them changes, this test is where the mismatch shows up rather than on
    // somebody's screen.
    expect(
      USAGE_FIELD_MAPPING.messages?.['Record at least one of hours or kilometres'],
    ).toBeDefined();
    expect(USAGE_FIELD_MAPPING.messages?.['periodEnd must be after periodStart']).toBeDefined();
    expect(
      USAGE_FIELD_MAPPING.messages?.['Usage cannot be recorded for a period in the future.'],
    ).toBeDefined();
  });
});

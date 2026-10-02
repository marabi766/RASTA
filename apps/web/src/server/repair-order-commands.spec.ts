/**
 * @jest-environment node
 */
import {
  EMPTY_CANCEL_REPAIR_FORM,
  EMPTY_COMPLETE_REPAIR_FORM,
  EMPTY_RECORD_COST_FORM,
  EMPTY_RECORD_LABOUR_FORM,
  EMPTY_RECORD_PART_FORM,
  EMPTY_START_REPAIR_FORM,
  repairCommandsFor,
} from '@/lib/repair-order-fields';

import { signPayload } from './signed-payload';
import {
  REPAIR_TOTAL_CHANGED_MESSAGE,
  cancelRepair,
  completeRepair,
  isRepairOrderId,
  openRepairOrderBaseline,
  parseCancelRepairForm,
  parseCompleteRepairForm,
  parseRecordCostForm,
  parseRecordLabourForm,
  parseRecordPartForm,
  parseStartRepairForm,
  recordCost,
  recordLabour,
  recordPart,
  sealRepairOrderBaseline,
  startRepair,
} from './repair-order-commands';
import type { WebSession } from './session';

/**
 * The six repair-order commands: what a person may type and in what words a
 * mistake is reported, what is sent and where, every sentence the service says
 * for these endpoints in Persian, and the baseline that names the order.
 *
 * The form's rules are a courtesy that saves a round trip; the service is the
 * enforcement (`repair-order-commands.contract.spec.ts` pins the two together).
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

const REQUEST = 'MNT_01J00000000000000000000000';
const ORDER = 'RPO_01J00000000000000000000000';

const part = (over: Partial<typeof EMPTY_RECORD_PART_FORM> = {}) => ({
  ...EMPTY_RECORD_PART_FORM,
  partName: 'فیلتر روغن',
  quantity: '2',
  unitCostMinor: '350000',
  ...over,
});
const labour = (over: Partial<typeof EMPTY_RECORD_LABOUR_FORM> = {}) => ({
  ...EMPTY_RECORD_LABOUR_FORM,
  description: 'تعویض شیلنگ',
  hours: '1.5',
  hourlyRateMinor: '800000',
  ...over,
});
const cost = (over: Partial<typeof EMPTY_RECORD_COST_FORM> = {}) => ({
  ...EMPTY_RECORD_COST_FORM,
  amountMinor: '500000',
  description: 'ایاب و ذهاب',
  ...over,
});

describe('which commands an order leaves open', () => {
  it.each([
    ['OPEN', ['start', 'cancel', 'part', 'labour', 'cost']],
    ['IN_PROGRESS', ['complete', 'cancel', 'part', 'labour', 'cost']],
    ['COMPLETED', []],
    ['CANCELLED', []],
    ['SOMETHING_NEW', []],
  ])('for an order that is %s', (status, commands) => {
    expect(repairCommandsFor(status)).toEqual(commands);
  });

  it('offers a form only for an id shaped like a repair order’s', () => {
    expect(isRepairOrderId(ORDER)).toBe(true);
    expect(isRepairOrderId(REQUEST)).toBe(false);
    expect(isRepairOrderId('RPO/../x')).toBe(false);
  });
});

describe('start', () => {
  it('sends nothing when nothing was typed: the service stamps the moment', () => {
    expect(parseStartRepairForm(EMPTY_START_REPAIR_FORM)).toEqual({ ok: true, body: {} });
  });

  it('sends the summary, normalised, and holds it to the service’s bounds', () => {
    expect(parseStartRepairForm({ workSummary: 'تعویض  كمک فنر' })).toEqual({
      ok: true,
      body: { workSummary: 'تعویض کمک فنر' },
    });
    expect(parseStartRepairForm({ workSummary: 'x' })).toMatchObject({
      ok: false,
      fieldErrors: { workSummary: expect.any(String) },
    });
    expect(parseStartRepairForm({ workSummary: 'a'.repeat(1001) })).toMatchObject({ ok: false });
    expect(parseStartRepairForm({ workSummary: 'a<b>' })).toMatchObject({ ok: false });
  });
});

describe('complete', () => {
  it('requires what was done, of 2 to 2000 characters', () => {
    expect(parseCompleteRepairForm(EMPTY_COMPLETE_REPAIR_FORM)).toMatchObject({
      ok: false,
      fieldErrors: { workPerformed: expect.any(String) },
    });
    expect(parseCompleteRepairForm({ workPerformed: 'a'.repeat(2001) })).toMatchObject({
      ok: false,
    });
    expect(parseCompleteRepairForm({ workPerformed: 'شیلنگ تعویض شد' })).toEqual({
      ok: true,
      body: { workPerformed: 'شیلنگ تعویض شد' },
    });
  });

  it('has no total or time to type: they come from the baseline and the service', () => {
    const parsed = parseCompleteRepairForm({ workPerformed: 'انجام شد' });
    expect(parsed.ok && Object.keys(parsed.body)).toEqual(['workPerformed']);
  });
});

describe('cancel', () => {
  it('requires a reason of 3 to 500 characters in the service’s character class', () => {
    expect(parseCancelRepairForm(EMPTY_CANCEL_REPAIR_FORM)).toMatchObject({ ok: false });
    expect(parseCancelRepairForm({ reason: 'ab' })).toMatchObject({ ok: false });
    expect(parseCancelRepairForm({ reason: 'a'.repeat(501) })).toMatchObject({ ok: false });
    expect(parseCancelRepairForm({ reason: 'a=b' })).toMatchObject({ ok: false });
    expect(parseCancelRepairForm({ reason: 'تعمیرگاه نپذیرفت' })).toEqual({
      ok: true,
      body: { reason: 'تعمیرگاه نپذیرفت' },
    });
  });
});

describe('recording a part', () => {
  it('sends what was typed, with amounts as minor-unit strings and the default source', () => {
    expect(parseRecordPartForm(part())).toEqual({
      ok: true,
      body: {
        partName: 'فیلتر روغن',
        partReference: undefined,
        quantity: '2',
        unit: 'عدد',
        unitCostMinor: '350000',
        source: 'WORKSHOP_SUPPLIED',
        sourceReference: undefined,
      },
    });
  });

  it('reads Persian digits and marks the way they were typed, never through a float', () => {
    const parsed = parseRecordPartForm(
      part({ quantity: '۲٫۵', unitCostMinor: '۱٬۲۵۰٬۰۰۰', partReference: ' F-12 ' }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      body: { quantity: '2.5', unitCostMinor: '1250000', partReference: 'F-12' },
    });
  });

  it('keeps an amount past Number.MAX_SAFE_INTEGER exactly', () => {
    const parsed = parseRecordPartForm(part({ unitCostMinor: '9007199254740993' }));
    expect(parsed.ok && parsed.body.unitCostMinor).toBe('9007199254740993');
  });

  it('allows a free part (a unit cost of zero) but not a negative one', () => {
    expect(parseRecordPartForm(part({ unitCostMinor: '0' }))).toMatchObject({ ok: true });
    expect(parseRecordPartForm(part({ unitCostMinor: '-5' }))).toMatchObject({
      ok: false,
      fieldErrors: { unitCostMinor: expect.any(String) },
    });
  });

  it.each([
    ['empty', ''],
    ['zero', '0'],
    ['zero with decimals', '0.000'],
    ['four decimals', '1.2345'],
    ['letters', 'دو'],
    ['a sign', '-1'],
    ['ten integer digits', '1234567890'],
  ])('refuses a quantity that is %s, at the field', (_label, quantity) => {
    expect(parseRecordPartForm(part({ quantity }))).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
  });

  it('refuses a missing name, unit and unit cost, and a source that is not on the list', () => {
    const parsed = parseRecordPartForm(
      part({ partName: '', unit: '', unitCostMinor: '', source: 'GIFT' }),
    );
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: {
        partName: expect.any(String),
        unit: expect.any(String),
        unitCostMinor: expect.any(String),
        source: expect.any(String),
      },
    });
  });

  it('holds the free text to the service’s character class and the references to 128', () => {
    expect(parseRecordPartForm(part({ partName: 'a<b>' }))).toMatchObject({ ok: false });
    expect(parseRecordPartForm(part({ partReference: 'x'.repeat(129) }))).toMatchObject({
      ok: false,
    });
    expect(parseRecordPartForm(part({ sourceReference: 'x'.repeat(129) }))).toMatchObject({
      ok: false,
    });
  });
});

describe('recording labour', () => {
  it('sends the hours and the rate as strings, and the technician when given', () => {
    expect(parseRecordLabourForm(labour({ technician: 'استاد رضا' }))).toEqual({
      ok: true,
      body: {
        description: 'تعویض شیلنگ',
        technician: 'استاد رضا',
        hours: '1.5',
        hourlyRateMinor: '800000',
      },
    });
  });

  it('reads Persian digits for hours and rate', () => {
    expect(
      parseRecordLabourForm(labour({ hours: '۲٫۲۵', hourlyRateMinor: '۸۰۰٬۰۰۰' })),
    ).toMatchObject({
      ok: true,
      body: { hours: '2.25', hourlyRateMinor: '800000' },
    });
  });

  it.each([
    ['zero', '0'],
    ['three decimals', '1.255'],
    ['seven integer digits', '1234567'],
    ['empty', ''],
  ])('refuses hours that are %s', (_label, hours) => {
    expect(parseRecordLabourForm(labour({ hours }))).toMatchObject({
      ok: false,
      fieldErrors: { hours: expect.any(String) },
    });
  });

  it('refuses a missing description and rate, and a one-letter technician', () => {
    expect(
      parseRecordLabourForm(labour({ description: '', hourlyRateMinor: '', technician: 'x' })),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        description: expect.any(String),
        hourlyRateMinor: expect.any(String),
        technician: expect.any(String),
      },
    });
  });
});

describe('recording any other cost', () => {
  it('sends the category, the amount as minor units, and the description', () => {
    expect(parseRecordCostForm(cost({ category: 'EXTERNAL_REPAIR' }))).toEqual({
      ok: true,
      body: { category: 'EXTERNAL_REPAIR', amountMinor: '500000', description: 'ایاب و ذهاب' },
    });
  });

  it('offers no way to post a PART or LABOUR line directly: those exist only as the work they came from', () => {
    for (const category of ['PART', 'LABOUR', 'FUEL', '']) {
      expect(parseRecordCostForm(cost({ category }))).toMatchObject({
        ok: false,
        fieldErrors: { category: expect.any(String) },
      });
    }
  });

  it('refuses a cost of zero, which records nothing, and a negative one', () => {
    for (const amountMinor of ['0', '۰', '-1', '', 'abc']) {
      expect(parseRecordCostForm(cost({ amountMinor }))).toMatchObject({
        ok: false,
        fieldErrors: { amountMinor: expect.any(String) },
      });
    }
  });

  it('refuses an amount longer than the 30 digits the platform reads', () => {
    expect(parseRecordCostForm(cost({ amountMinor: '1'.repeat(31) }))).toMatchObject({ ok: false });
  });
});

describe('the largest amount the ledger holds', () => {
  const MAX = '9223372036854775807';
  const PAST = '9223372036854775808';

  it('is accepted, to the last digit, in every amount a form takes', () => {
    expect(parseRecordCostForm(cost({ amountMinor: MAX }))).toMatchObject({
      ok: true,
      body: { amountMinor: MAX },
    });
    expect(parseRecordPartForm(part({ unitCostMinor: MAX }))).toMatchObject({
      ok: true,
      body: { unitCostMinor: MAX },
    });
    expect(parseRecordLabourForm(labour({ hourlyRateMinor: MAX }))).toMatchObject({
      ok: true,
      body: { hourlyRateMinor: MAX },
    });
  });

  it('is refused one unit past, at the field, in every amount a form takes', () => {
    expect(parseRecordCostForm(cost({ amountMinor: PAST }))).toMatchObject({
      ok: false,
      fieldErrors: { amountMinor: expect.any(String) },
    });
    expect(parseRecordPartForm(part({ unitCostMinor: PAST }))).toMatchObject({
      ok: false,
      fieldErrors: { unitCostMinor: expect.any(String) },
    });
    expect(parseRecordLabourForm(labour({ hourlyRateMinor: PAST }))).toMatchObject({
      ok: false,
      fieldErrors: { hourlyRateMinor: expect.any(String) },
    });
  });

  it('is judged on the amount as typed, in Persian digits and with grouping too', () => {
    expect(parseRecordCostForm(cost({ amountMinor: '۹٬۲۲۳٬۳۷۲٬۰۳۶٬۸۵۴٬۷۷۵٬۸۰۷' }))).toMatchObject({
      ok: true,
      body: { amountMinor: MAX },
    });
    expect(parseRecordCostForm(cost({ amountMinor: '۹٬۲۲۳٬۳۷۲٬۰۳۶٬۸۵۴٬۷۷۵٬۸۰۸' }))).toMatchObject({
      ok: false,
    });
  });
});

describe('writing', () => {
  interface Recorded {
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: unknown;
  }

  function recording(status: number, body: unknown) {
    const calls: Recorded[] = [];
    const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1' },
      });
    }) as typeof fetch;
    return { impl, calls };
  }

  it.each([
    [
      'starts',
      'start',
      200,
      (impl: typeof fetch) => startRepair(SESSION, ORDER, {}, 'sub_abc', impl),
    ],
    [
      'completes',
      'complete',
      200,
      (impl: typeof fetch) =>
        completeRepair(
          SESSION,
          ORDER,
          { workPerformed: 'انجام شد', expectedTotalCostMinor: '750000' },
          'sub_abc',
          impl,
        ),
    ],
    [
      'withdraws',
      'cancel',
      200,
      (impl: typeof fetch) => cancelRepair(SESSION, ORDER, { reason: 'نپذیرفت' }, 'sub_abc', impl),
    ],
    [
      'records a part',
      'parts',
      201,
      (impl: typeof fetch) => {
        const parsed = parseRecordPartForm(part());
        if (!parsed.ok) throw new Error('fixture');
        return recordPart(SESSION, ORDER, parsed.body, 'sub_abc', impl);
      },
    ],
    [
      'records labour',
      'labour',
      201,
      (impl: typeof fetch) => {
        const parsed = parseRecordLabourForm(labour());
        if (!parsed.ok) throw new Error('fixture');
        return recordLabour(SESSION, ORDER, parsed.body, 'sub_abc', impl);
      },
    ],
    [
      'records a cost',
      'costs',
      201,
      (impl: typeof fetch) => {
        const parsed = parseRecordCostForm(cost());
        if (!parsed.ok) throw new Error('fixture');
        return recordCost(SESSION, ORDER, parsed.body, 'sub_abc', impl);
      },
    ],
  ])(
    '%s with a POST to the order’s own path, keeping only the id',
    async (_n, verb, status, call) => {
      const { impl, calls } = recording(status, { id: 'X_1', recordedBy: 'USR_SECRET' });

      const result = await call(impl);

      expect(result.kind === 'CREATED' && result.data).toEqual({ id: 'X_1' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`http://gateway.test:3000/v1/repair-orders/${ORDER}/${verb}`);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers['idempotency-key']).toBe('sub_abc');
      expect(calls[0].headers['authorization']).toBe('Bearer access-token-value');
    },
  );

  it('sends the completion’s total in the body, as the service reads it', async () => {
    const { impl, calls } = recording(200, { id: 'X_1' });
    await completeRepair(
      SESSION,
      ORDER,
      { workPerformed: 'انجام شد', expectedTotalCostMinor: '750000' },
      's',
      impl,
    );
    expect(calls[0].body).toEqual({ workPerformed: 'انجام شد', expectedTotalCostMinor: '750000' });
  });

  it('percent-encodes the order id: a slash must not address another endpoint', async () => {
    const { impl, calls } = recording(200, { id: 'X_1' });
    await startRepair(SESSION, 'RPO/../x', {}, 's', impl);
    expect(calls[0].url).toBe('http://gateway.test:3000/v1/repair-orders/RPO%2F..%2Fx/start');
  });

  describe.each([
    [
      'starting an order already started',
      'This repair order is already IN_PROGRESS',
      'این ارجاع همین حالا آغاز شده است. صفحه را تازه کنید.',
    ],
    [
      'completing one already completed',
      'This repair order is already COMPLETED',
      'این ارجاع همین حالا تکمیل شده و نهایی است؛ دیگر تغییر نمی‌کند.',
    ],
    [
      'withdrawing one already withdrawn',
      'This repair order is already CANCELLED',
      'این ارجاع همین حالا لغو شده است. اگر کار هنوز لازم است، آن را به تعمیرگاه دیگری ارجاع دهید.',
    ],
    [
      'completing one that never started',
      'A repair order cannot move from OPEN to COMPLETED',
      'تعمیر هنوز آغاز نشده است؛ نخست آن را آغاز کنید.',
    ],
    [
      'withdrawing a completed one',
      'A completed repair order is final; its cost has already been reported',
      'این ارجاع تکمیل شده و نهایی است؛ هزینهٔ آن گزارش شده و دیگر تغییر نمی‌کند.',
    ],
    [
      'starting a withdrawn one',
      'A cancelled repair order is final; refer the request to another workshop',
      'این ارجاع لغو شده است؛ کار را به تعمیرگاه دیگری ارجاع دهید.',
    ],
    [
      'a start that lost a race',
      'This repair order was started or cancelled by another request',
      'همین حالا کس دیگری این ارجاع را آغاز یا لغو کرد. صفحه را تازه کنید.',
    ],
    [
      'a completion that lost a race',
      'This repair order was completed or cancelled by another request',
      'همین حالا کس دیگری این ارجاع را تکمیل یا لغو کرد. صفحه را تازه کنید.',
    ],
    [
      'a withdrawal that lost a race',
      'This repair order was changed by another request',
      'همین حالا کس دیگری این ارجاع را تغییر داد. صفحه را تازه کنید.',
    ],
    [
      'completing under a request somebody else changed',
      'This request was changed by another request',
      'همین حالا کس دیگری این درخواست را تغییر داد. صفحه را تازه کنید.',
    ],
    [
      'completing under a cancelled request',
      'A cancelled maintenance request is final; raise a new one',
      'این درخواست لغو شده و نهایی است؛ درخواست تازه‌ای ثبت کنید.',
    ],
    [
      'recording a cost on a completed order',
      'Cost cannot be added to a completed repair order.',
      'این ارجاع تکمیل شده است و دیگر هزینه‌ای به آن افزوده نمی‌شود.',
    ],
    [
      'recording a cost on a withdrawn order',
      'Cost cannot be added to a cancelled repair order.',
      'این ارجاع لغو شده است و دیگر هزینه‌ای به آن افزوده نمی‌شود.',
    ],
    [
      'a quantity that cannot be priced',
      'That quantity cannot be priced.',
      'با این تعداد نمی‌توان بها را حساب کرد؛ تعداد یا بهای واحد را کوچک‌تر کنید.',
    ],
    [
      'hours that cannot be priced',
      'Those hours cannot be priced.',
      'با این ساعت نمی‌توان بها را حساب کرد؛ ساعت یا نرخ را کوچک‌تر کنید.',
    ],
    [
      'a machine that changed hands',
      'The machine has been transferred to another organization; this work cannot go ahead.',
      'این ماشین به سازمان دیگری منتقل شده است و کار نمی‌تواند پیش برود.',
    ],
    [
      'an amount past the ledger’s bound',
      'That amount is larger than the maximum this system can hold.',
      'این مبلغ از بیشینهٔ مبلغی که سامانه نگه می‌دارد بزرگ‌تر است.',
    ],
    [
      'a line whose total passes the bound',
      'That line is larger than the maximum this system can hold; reduce the quantity or the price.',
      'جمع این ردیف از بیشینهٔ مبلغ سامانه بزرگ‌تر می‌شود؛ تعداد یا بها را کمتر کنید.',
    ],
    [
      'a stored total that would pass the bound',
      'The total would be larger than the maximum this system can hold; nothing was recorded.',
      'با این ردیف، جمع هزینه از بیشینهٔ مبلغ سامانه بزرگ‌تر می‌شود؛ چیزی ثبت نشد.',
    ],
    [
      'a total that moved before the completion',
      'The cost has changed since it was shown to you; review it again before completing.',
      REPAIR_TOTAL_CHANGED_MESSAGE,
    ],
  ])('%s', (_name, sentence, persian) => {
    const code = /cannot be priced|Cost cannot|cost has changed|maximum this system/.test(sentence)
      ? 'BUSINESS_RULE_VIOLATION'
      : 'INVALID_STATE_TRANSITION';

    it.each([
      ['start', (impl: typeof fetch) => startRepair(SESSION, ORDER, {}, 's', impl)],
      [
        'complete',
        (impl: typeof fetch) =>
          completeRepair(
            SESSION,
            ORDER,
            { workPerformed: 'x', expectedTotalCostMinor: '1' },
            's',
            impl,
          ),
      ],
      ['cancel', (impl: typeof fetch) => cancelRepair(SESSION, ORDER, { reason: 'سه' }, 's', impl)],
      [
        'cost',
        (impl: typeof fetch) =>
          recordCost(
            SESSION,
            ORDER,
            { category: 'SERVICE', amountMinor: '1', description: 'xx' },
            's',
            impl,
          ),
      ],
    ])('is said in Persian by %s, not in the service’s English', async (_verb, call) => {
      const result = await call(
        recording(code === 'INVALID_STATE_TRANSITION' ? 409 : 422, { code, message: sentence })
          .impl,
      );

      expect(result).toMatchObject({ kind: 'INVALID', message: persian });
      expect(result.kind === 'INVALID' && result.message).not.toMatch(/[A-Za-z]{4,}/);
    });
  });

  describe('a sentence the portal does not know', () => {
    const call = (impl: typeof fetch) => startRepair(SESSION, ORDER, {}, 's', impl);

    it('is said by the platform code: a transition the service words one more way', async () => {
      const result = await call(
        recording(409, { code: 'INVALID_STATE_TRANSITION', message: 'A brand new sentence' }).impl,
      );
      expect(result).toMatchObject({
        kind: 'INVALID',
        message:
          'وضعیت فعلی این ارجاع اجازهٔ این کار را نمی‌دهد. صفحه را تازه کنید و وضعیت را ببینید.',
      });
    });

    it('is said by the platform code: a business rule added after this was written', async () => {
      const result = await call(
        recording(422, { code: 'BUSINESS_RULE_VIOLATION', message: 'A brand new rule' }).impl,
      );
      expect(result).toMatchObject({
        kind: 'INVALID',
        message: 'این کار با قواعد این ارجاع سازگار نیست. صفحه را تازه کنید.',
      });
    });

    it('shows a sentence under a code with no fallback as it arrived, never hidden', async () => {
      const result = await call(
        recording(409, { code: 'SOME_NEW_CODE', message: 'A repair order cannot be frobbed' }).impl,
      );
      expect(result).toMatchObject({
        kind: 'INVALID',
        message: 'A repair order cannot be frobbed',
      });
    });
  });

  it('puts a field problem from the service on the field it names', async () => {
    const parsed = parseRecordLabourForm(labour());
    if (!parsed.ok) throw new Error('fixture');
    const result = await recordLabour(
      SESSION,
      ORDER,
      parsed.body,
      's',
      recording(400, {
        code: 'VALIDATION_FAILED',
        message: 'Invalid request',
        details: [{ path: 'hours', message: 'Labour hours must be greater than zero' }],
      }).impl,
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { hours: 'ساعت کار باید بیشتر از صفر باشد' },
    });
  });

  it('reports 403 as FORBIDDEN and 404 as the platform’s non-disclosure', async () => {
    expect(
      await startRepair(SESSION, ORDER, {}, 's', recording(403, { code: 'FORBIDDEN' }).impl),
    ).toMatchObject({ kind: 'FORBIDDEN' });
    expect(
      await startRepair(SESSION, ORDER, {}, 's', recording(404, { code: 'NOT_FOUND' }).impl),
    ).toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('never claims nothing happened when the gateway timed out after forwarding', async () => {
    const result = await startRepair(
      SESSION,
      ORDER,
      {},
      's',
      recording(504, { code: 'GATEWAY_TIMEOUT' }).impl,
    );
    expect(result).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });
});

describe('the baseline that names the order', () => {
  const seal = (over: Partial<Parameters<typeof sealRepairOrderBaseline>[1]> = {}) =>
    sealRepairOrderBaseline(SESSION, {
      requestId: REQUEST,
      repairOrderId: ORDER,
      command: 'complete',
      totalCostMinor: '750000',
      ...over,
    });

  it('opens for the command and the request it was signed for, and carries the order and the total', () => {
    expect(openRepairOrderBaseline(SESSION, seal(), REQUEST, 'complete')).toEqual({
      requestId: REQUEST,
      repairOrderId: ORDER,
      command: 'complete',
      totalCostMinor: '750000',
    });
  });

  it('does not open for another command: the token beside "withdraw" cannot complete the order', () => {
    expect(
      openRepairOrderBaseline(SESSION, seal({ command: 'cancel' }), REQUEST, 'complete'),
    ).toBeNull();
    for (const other of ['start', 'cancel', 'part', 'labour', 'cost'] as const) {
      expect(openRepairOrderBaseline(SESSION, seal(), REQUEST, other)).toBeNull();
    }
  });

  it('does not open for another request than the one it was drawn under', () => {
    expect(
      openRepairOrderBaseline(SESSION, seal(), 'MNT_01J00000000000000000000099', 'complete'),
    ).toBeNull();
  });

  it('does not open for somebody else, for an earlier login, or once altered', () => {
    const token = seal();
    expect(
      openRepairOrderBaseline({ ...SESSION, subject: 'someone-else' }, token, REQUEST, 'complete'),
    ).toBeNull();
    expect(
      openRepairOrderBaseline(
        { ...SESSION, csrfToken: 'the-token-before-re-login' },
        token,
        REQUEST,
        'complete',
      ),
    ).toBeNull();

    const mac = token.split('.')[1];
    const altered = `${Buffer.from(
      JSON.stringify({
        requestId: REQUEST,
        repairOrderId: 'RPO_01J00000000000000000000099',
        command: 'complete',
        totalCostMinor: '750000',
        exp: 4_102_444_800,
      }),
    ).toString('base64url')}.${mac}`;
    expect(openRepairOrderBaseline(SESSION, altered, REQUEST, 'complete')).toBeNull();
    for (const junk of ['', 'not-a-token', null, undefined, 42]) {
      expect(openRepairOrderBaseline(SESSION, junk, REQUEST, 'complete')).toBeNull();
    }
  });

  it('does not open once expired', () => {
    const token = seal();
    jest.useFakeTimers({ now: Date.now() + 5 * 60 * 60 * 1000 });
    try {
      expect(openRepairOrderBaseline(SESSION, token, REQUEST, 'complete')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not open a token signed for another purpose: the purpose is part of the key', () => {
    const wrong = signPayload(
      SESSION,
      'maintenance-approval-baseline',
      { requestId: REQUEST, totalCostMinor: '750000' },
      600,
    );
    expect(openRepairOrderBaseline(SESSION, wrong, REQUEST, 'complete')).toBeNull();
  });
});

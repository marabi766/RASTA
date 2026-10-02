/**
 * @jest-environment node
 */
import {
  APPROVAL_TOTAL_CHANGED_MESSAGE,
  APPROVE_REQUEST_FIELD_MAPPING,
  ASSIGN_WORKSHOP_FIELD_MAPPING,
  approveRequest,
  approveRequestFormValues,
  assignWorkshop,
  assignWorkshopFormValues,
  canManageMaintenance,
  cancelRequest,
  cancelRequestFormValues,
  commandRequestId,
  MAINTENANCE_DISPLAY_TEXT,
  parseApproveRequestForm,
  parseAssignWorkshopForm,
  parseCancelRequestForm,
} from './maintenance-commands';
import { EMPTY_ASSIGN_WORKSHOP_FORM, EMPTY_CANCEL_REQUEST_FORM } from '@/lib/maintenance-fields';
import type { WebSession } from './session';

/**
 * Referring a request to a workshop, approving its cost, cancelling it.
 *
 * Same shape as `maintenance-commands.spec.ts`: the form's rules are a courtesy
 * that saves a round trip, the service is the enforcement, and every sentence
 * the service emits for these three endpoints has a Persian rendering here.
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

const ENV = {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};

beforeEach(() => {
  Object.assign(process.env, ENV);
});

const REQUEST = 'MNT_01J00000000000000000000000';
const WORKSHOP = 'ORG_01J00000000000000000000001';

describe('who is offered the commands', () => {
  it.each(['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN'])(
    'offers them to %s, the roles assign, approve and cancel admit',
    (role) => {
      expect(canManageMaintenance([role])).toBe(true);
    },
  );

  it.each(['OPERATOR', 'DRIVER', 'AUDITOR', 'PROCUREMENT_USER'])(
    'does not offer them to %s, who may report a fault and nothing more',
    (role) => {
      expect(canManageMaintenance([role])).toBe(false);
    },
  );

  it('offers them to somebody who holds any one of the roles, and to nobody with none', () => {
    expect(canManageMaintenance(['OPERATOR', 'FLEET_MANAGER'])).toBe(true);
    expect(canManageMaintenance([])).toBe(false);
  });
});

describe('the request a command is about', () => {
  const form = (value: string | null) => {
    const data = new FormData();
    if (value !== null) data.set('requestId', value);
    return data;
  };

  it('is taken from the form when it is shaped like a request id', () => {
    expect(commandRequestId(form(REQUEST))).toBe(REQUEST);
    expect(commandRequestId(form('MNT-SEED-0001'))).toBe('MNT-SEED-0001');
    expect(commandRequestId(form(`  ${REQUEST}  `))).toBe(REQUEST);
  });

  it.each([null, '', 'x', 'AST_01J00000000000000000000000', 'MNT/../x', `${REQUEST}/approve`])(
    'is refused for %j: it cannot name a request, so nothing is sent for it',
    (value) => {
      expect(commandRequestId(form(value))).toBeNull();
    },
  );
});

describe('referring to a workshop', () => {
  const values = (overrides: Partial<typeof EMPTY_ASSIGN_WORKSHOP_FORM> = {}) => ({
    ...EMPTY_ASSIGN_WORKSHOP_FORM,
    workshopOrganizationId: WORKSHOP,
    ...overrides,
  });

  it('reads every field as a string and treats an absent one as empty', () => {
    const form = new FormData();
    form.set('workshopName', 'x');
    expect(assignWorkshopFormValues(form)).toEqual({
      ...EMPTY_ASSIGN_WORKSHOP_FORM,
      workshopName: 'x',
    });
  });

  it('sends only the organization when nothing else was typed', () => {
    const parsed = parseAssignWorkshopForm(values());
    expect(parsed.ok && JSON.parse(JSON.stringify(parsed.body))).toEqual({
      workshopOrganizationId: WORKSHOP,
    });
  });

  it('sends the name and the summary when given, with Persian letters normalised', () => {
    const arabicKaf = String.fromCodePoint(0x643);
    const parsed = parseAssignWorkshopForm(
      values({ workshopName: `تعمیرگاه ${arabicKaf}وثر`, workSummary: '  تعویض   پمپ  ' }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      body: { workshopName: 'تعمیرگاه کوثر', workSummary: 'تعویض پمپ' },
    });
  });

  it('requires an organization id shaped like one, and says so at the field', () => {
    expect(parseAssignWorkshopForm(values({ workshopOrganizationId: '' }))).toMatchObject({
      ok: false,
      fieldErrors: { workshopOrganizationId: 'شناسهٔ سازمان تعمیرگاه را وارد کنید' },
    });
    for (const bad of ['x', 'AST_01J00000000000000000000000', `${WORKSHOP}/x`]) {
      expect(parseAssignWorkshopForm(values({ workshopOrganizationId: bad }))).toMatchObject({
        ok: false,
        fieldErrors: { workshopOrganizationId: 'شناسهٔ سازمان معتبر نیست' },
      });
    }
  });

  it('holds the free text to the service’s lengths and character class', () => {
    expect(parseAssignWorkshopForm(values({ workshopName: 'ل' })).ok).toBe(false);
    expect(parseAssignWorkshopForm(values({ workshopName: 'ل'.repeat(201) })).ok).toBe(false);
    expect(parseAssignWorkshopForm(values({ workSummary: 'ل'.repeat(1001) })).ok).toBe(false);
    expect(parseAssignWorkshopForm(values({ workshopName: 'a<b>' }))).toMatchObject({
      ok: false,
      fieldErrors: { workshopName: expect.stringContaining('مجاز') },
    });
  });

  it('has no assignedAt to send: the service stamps the moment', () => {
    const parsed = parseAssignWorkshopForm(values());
    expect(parsed.ok && Object.keys(parsed.body)).not.toContain('assignedAt');
  });

  it('names a path for every field and says the service’s sentences in Persian', () => {
    for (const field of Object.keys(EMPTY_ASSIGN_WORKSHOP_FORM)) {
      expect(ASSIGN_WORKSHOP_FIELD_MAPPING.paths[field]).toBe(field);
    }
    const messages = ASSIGN_WORKSHOP_FIELD_MAPPING.messages ?? {};
    for (const sentence of [
      'This request is already with a workshop. Cancel that referral before making another.',
      'That workshop may not take on this work.',
      'This machine is being transferred to another organization; raise the work after the transfer.',
    ]) {
      expect(messages[sentence]).toBeTruthy();
    }
  });
});

describe('approving the cost', () => {
  const values = (overrides: Record<string, string> = {}) => ({
    expectedTotalCostMinor: '12500000',
    notes: '',
    ...overrides,
  });

  it('reads the echoed total and the note', () => {
    const form = new FormData();
    form.set('expectedTotalCostMinor', '5');
    form.set('notes', 'ok');
    expect(approveRequestFormValues(form)).toEqual({ expectedTotalCostMinor: '5', notes: 'ok' });
  });

  it('always echoes the total it showed, as the digits it was given', () => {
    const parsed = parseApproveRequestForm(values());
    expect(parsed.ok && JSON.parse(JSON.stringify(parsed.body))).toEqual({
      expectedTotalCostMinor: '12500000',
    });
  });

  it('sends the note when there is one', () => {
    expect(parseApproveRequestForm(values({ notes: ' هزینه تأیید شد ' }))).toMatchObject({
      ok: true,
      body: { expectedTotalCostMinor: '12500000', notes: 'هزینه تأیید شد' },
    });
  });

  it('accepts zero, which is a total a request can have', () => {
    expect(parseApproveRequestForm(values({ expectedTotalCostMinor: '0' })).ok).toBe(true);
  });

  it.each(['', ' ', '-1', '1.5', '1e3', '12 500', '۱۲۵۰۰', 'x', '1'.repeat(31)])(
    'refuses %j as a total: money crosses as Latin digits in minor units, never as anything else',
    (value) => {
      expect(parseApproveRequestForm(values({ expectedTotalCostMinor: value }))).toMatchObject({
        ok: false,
        fieldErrors: { expectedTotalCostMinor: expect.stringContaining('معتبر نیست') },
      });
    },
  );

  it('holds the note to the service’s length and character class', () => {
    expect(parseApproveRequestForm(values({ notes: 'ل'.repeat(1001) })).ok).toBe(false);
    expect(parseApproveRequestForm(values({ notes: 'a<b>' })).ok).toBe(false);
  });

  it('says the service’s sentences in Persian, the moved total in the one the action looks for', () => {
    const messages = APPROVE_REQUEST_FIELD_MAPPING.messages ?? {};
    expect(
      messages['The cost has changed since it was shown to you; review it again before approving.'],
    ).toBe(APPROVAL_TOTAL_CHANGED_MESSAGE);
    expect(
      messages[
        'An approved maintenance request is final; it authorises settlement and cannot be reopened'
      ],
    ).toBeTruthy();
    expect(
      messages['This request was already approved or cancelled by another request'],
    ).toBeTruthy();
  });
});

describe('cancelling', () => {
  const values = (reason: string) => ({ ...EMPTY_CANCEL_REQUEST_FORM, reason });

  it('reads the reason', () => {
    const form = new FormData();
    form.set('reason', 'x');
    expect(cancelRequestFormValues(form)).toEqual({ reason: 'x' });
  });

  it('sends the reason, normalised', () => {
    expect(parseCancelRequestForm(values('  ماشین   فروخته شد '))).toEqual({
      ok: true,
      body: { reason: 'ماشین فروخته شد' },
    });
  });

  it('requires a reason of at least 3 characters and at most 500', () => {
    expect(parseCancelRequestForm(values(''))).toMatchObject({
      ok: false,
      fieldErrors: { reason: 'دلیل لغو دست‌کم ۳ نویسه باشد' },
    });
    expect(parseCancelRequestForm(values('ab')).ok).toBe(false);
    expect(parseCancelRequestForm(values('abc')).ok).toBe(true);
    expect(parseCancelRequestForm(values('ل'.repeat(500))).ok).toBe(true);
    expect(parseCancelRequestForm(values('ل'.repeat(501))).ok).toBe(false);
  });

  it('holds the reason to the service’s character class', () => {
    expect(parseCancelRequestForm(values('a<script>'))).toMatchObject({
      ok: false,
      fieldErrors: { reason: expect.stringContaining('مجاز') },
    });
  });
});

describe('the character class', () => {
  it.each(['لودر کوماتسو', 'Komatsu WA320', 'گریدر ۱۴۰۲', 'می‌خواهم', 'کلید (اصلی) «برق»'])(
    'accepts %j',
    (text) => {
      expect(MAINTENANCE_DISPLAY_TEXT.test(text)).toBe(true);
    },
  );

  it.each(['a<b>', 'a=b', 'a&b', '50%', 'خودرو 🚜', '日本語', ''])('refuses %j', (text) => {
    expect(MAINTENANCE_DISPLAY_TEXT.test(text)).toBe(false);
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
      'assigns',
      'assign',
      201,
      (impl: typeof fetch) =>
        assignWorkshop(SESSION, REQUEST, { workshopOrganizationId: WORKSHOP }, 'sub_abc', impl),
    ],
    [
      'approves',
      'approve',
      200,
      (impl: typeof fetch) =>
        approveRequest(SESSION, REQUEST, { expectedTotalCostMinor: '5' }, 'sub_abc', impl),
    ],
    [
      'cancels',
      'cancel',
      200,
      (impl: typeof fetch) =>
        cancelRequest(SESSION, REQUEST, { reason: 'فروخته شد' }, 'sub_abc', impl),
    ],
  ])(
    '%s with a POST to the request’s own path, keeping only the id',
    async (_n, verb, status, call) => {
      const { impl, calls } = recording(status, { id: 'X_1', reportedBy: 'USR_SECRET' });

      const result = await call(impl);

      expect(result).toMatchObject({ kind: 'CREATED', data: { id: 'X_1' } });
      expect(result.kind === 'CREATED' && result.data).toEqual({ id: 'X_1' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        `http://gateway.test:3000/v1/maintenance-requests/${REQUEST}/${verb}`,
      );
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers['idempotency-key']).toBe('sub_abc');
      expect(calls[0].headers['authorization']).toBe('Bearer access-token-value');
    },
  );

  it('percent-encodes the request id: a slash must not address another endpoint', async () => {
    const { impl, calls } = recording(200, { id: 'X_1' });

    await cancelRequest(SESSION, 'MNT/../x', { reason: 'فروخته شد' }, 'sub_abc', impl);

    expect(calls[0].url).toBe(
      'http://gateway.test:3000/v1/maintenance-requests/MNT%2F..%2Fx/cancel',
    );
  });

  it('sends the echoed total in the body, as the service reads it', async () => {
    const { impl, calls } = recording(200, { id: 'X_1' });

    await approveRequest(
      SESSION,
      REQUEST,
      { expectedTotalCostMinor: '12500000', notes: 'تأیید' },
      'sub_abc',
      impl,
    );

    expect(calls[0].body).toEqual({ expectedTotalCostMinor: '12500000', notes: 'تأیید' });
  });

  it('says a moved total in Persian, in the sentence the action recognises', async () => {
    const { impl } = recording(422, {
      code: 'BUSINESS_RULE_VIOLATION',
      message: 'The cost has changed since it was shown to you; review it again before approving.',
    });

    const result = await approveRequest(
      SESSION,
      REQUEST,
      { expectedTotalCostMinor: '5' },
      'sub_abc',
      impl,
    );

    expect(result).toMatchObject({ kind: 'INVALID', message: APPROVAL_TOTAL_CHANGED_MESSAGE });
  });

  describe.each([
    [
      'approving a request that is already approved',
      409,
      'INVALID_STATE_TRANSITION',
      'This maintenance request is already APPROVED',
      'این درخواست همین حالا تأیید شده و نهایی است؛ دیگر تغییر نمی‌کند.',
    ],
    [
      'cancelling a request that is already cancelled',
      409,
      'INVALID_STATE_TRANSITION',
      'This maintenance request is already CANCELLED',
      'این درخواست همین حالا لغو شده و نهایی است؛ درخواست تازه‌ای ثبت کنید.',
    ],
    [
      'cancelling an approved request',
      409,
      'INVALID_STATE_TRANSITION',
      'An approved maintenance request is final; it authorises settlement and cannot be reopened',
      'این درخواست تأیید شده و نهایی است؛ دیگر تغییر نمی‌کند.',
    ],
    [
      'approving a cancelled request',
      409,
      'INVALID_STATE_TRANSITION',
      'A cancelled maintenance request is final; raise a new one',
      'این درخواست لغو شده و نهایی است؛ درخواست تازه‌ای ثبت کنید.',
    ],
  ])('%s', (_name, status, code, sentence, persian) => {
    it.each([
      [
        'approve',
        (impl: typeof fetch) =>
          approveRequest(SESSION, REQUEST, { expectedTotalCostMinor: '5' }, 's', impl),
      ],
      [
        'cancel',
        (impl: typeof fetch) => cancelRequest(SESSION, REQUEST, { reason: 'فروخته شد' }, 's', impl),
      ],
    ])('is said in Persian by %s, not in the service’s English', async (_verb, call) => {
      const result = await call(recording(status, { code, message: sentence }).impl);

      expect(result).toMatchObject({ kind: 'INVALID', message: persian });
      expect(result.kind === 'INVALID' && result.message).not.toMatch(/[A-Za-z]{4,}/);
    });
  });

  describe('a sentence the portal does not know', () => {
    const STATE_FALLBACK =
      'وضعیت فعلی درخواست اجازهٔ این کار را نمی‌دهد. صفحه را تازه کنید و وضعیت را ببینید.';
    const RULE_FALLBACK = 'این کار با قواعد این درخواست سازگار نیست. صفحه را تازه کنید.';

    it.each([
      ['a transition', 409, 'INVALID_STATE_TRANSITION', STATE_FALLBACK],
      ['a business rule', 422, 'BUSINESS_RULE_VIOLATION', RULE_FALLBACK],
    ])('is said in Persian from its code, for %s', async (_n, status, code, persian) => {
      const sentence = 'A maintenance request cannot move from OPEN to APPROVED';
      for (const call of [
        (impl: typeof fetch) =>
          approveRequest(SESSION, REQUEST, { expectedTotalCostMinor: '5' }, 's', impl),
        (impl: typeof fetch) => cancelRequest(SESSION, REQUEST, { reason: 'فروخته شد' }, 's', impl),
        (impl: typeof fetch) =>
          assignWorkshop(SESSION, REQUEST, { workshopOrganizationId: WORKSHOP }, 's', impl),
      ]) {
        const result = await call(recording(status, { code, message: sentence }).impl);
        expect(result).toMatchObject({ kind: 'INVALID', message: persian });
        expect(JSON.stringify(result)).not.toContain(sentence);
      }
    });

    it('still prefers a sentence it knows over the fallback for its code', async () => {
      const { impl } = recording(409, {
        code: 'INVALID_STATE_TRANSITION',
        message:
          'This request is already with a workshop. Cancel that referral before making another.',
      });
      const result = await assignWorkshop(
        SESSION,
        REQUEST,
        { workshopOrganizationId: WORKSHOP },
        's',
        impl,
      );
      expect(result).toMatchObject({
        kind: 'INVALID',
        message: expect.stringContaining('نزد یک تعمیرگاه'),
      });
    });

    it('shows a sentence under a code with no fallback as it arrived, never hidden', async () => {
      const { impl } = recording(409, {
        code: 'SOME_NEW_CODE',
        message: 'A completed request cannot be referred to a workshop',
      });
      const result = await assignWorkshop(
        SESSION,
        REQUEST,
        { workshopOrganizationId: WORKSHOP },
        's',
        impl,
      );
      expect(result).toMatchObject({
        kind: 'INVALID',
        message: 'A completed request cannot be referred to a workshop',
      });
    });
  });

  it('reports 403 as FORBIDDEN and 404 as the platform’s non-disclosure', async () => {
    const forbidden = await cancelRequest(
      SESSION,
      REQUEST,
      { reason: 'فروخته شد' },
      'sub_abc',
      recording(403, { code: 'FORBIDDEN', message: 'no' }).impl,
    );
    const missing = await cancelRequest(
      SESSION,
      REQUEST,
      { reason: 'فروخته شد' },
      'sub_abc',
      recording(404, { code: 'NOT_FOUND', message: 'MaintenanceRequest not found' }).impl,
    );

    expect(forbidden).toMatchObject({ kind: 'FORBIDDEN' });
    expect(missing).toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('never claims nothing happened when the gateway timed out after forwarding', async () => {
    const { impl } = recording(504, { code: 'UPSTREAM_TIMEOUT', message: 'slow' });

    expect(
      await approveRequest(SESSION, REQUEST, { expectedTotalCostMinor: '5' }, 'sub_abc', impl),
    ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });
});

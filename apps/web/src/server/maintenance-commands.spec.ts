/**
 * @jest-environment node
 */
import {
  canReportMaintenance,
  parseReportRequestForm,
  reportMaintenanceRequest,
  reportRequestFormValues,
  REPORT_REQUEST_FIELD_MAPPING,
} from './maintenance-commands';
import { EMPTY_REPORT_REQUEST_FORM } from '@/lib/maintenance-fields';
import type { WebSession } from './session';

/**
 * Parsing and writing a maintenance request.
 *
 * Mirrors `drivers.spec.ts` (PR #106): this module designs nothing new, so its
 * tests do not either — what is specific here is the service's two severity
 * rules, and that every sentence maintenance-service emits for this endpoint
 * has a Persian rendering.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'operator',
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

const ASSET = 'AST_01J00000000000000000000000';

function values(overrides: Partial<typeof EMPTY_REPORT_REQUEST_FORM> = {}) {
  return {
    ...EMPTY_REPORT_REQUEST_FORM,
    assetId: ASSET,
    title: 'نشتی روغن هیدرولیک',
    severity: 'HIGH',
    ...overrides,
  };
}

describe('who is offered the report form', () => {
  it.each(['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN', 'OPERATOR', 'DRIVER'])(
    'offers it to %s, the roles POST /v1/maintenance-requests admits',
    (role) => {
      expect(canReportMaintenance([role])).toBe(true);
    },
  );

  it.each([[[]], [['AUDITOR']], [['SUPPLIER']], [['PROCUREMENT_USER']]])(
    'does not offer it to %p',
    (roles) => {
      expect(canReportMaintenance(roles)).toBe(false);
    },
  );

  it('offers it when any one held role qualifies', () => {
    expect(canReportMaintenance(['AUDITOR', 'OPERATOR'])).toBe(true);
  });
});

describe('reading the posted form', () => {
  it('reads every field as a string and treats an absent one as empty', () => {
    const form = new FormData();
    form.set('assetId', ASSET);
    form.set('title', 'x');
    expect(reportRequestFormValues(form)).toEqual({
      assetId: ASSET,
      type: '',
      title: 'x',
      description: '',
      severity: '',
      outOfServiceAt: '',
      dueDate: '',
    });
  });

  it('reads a file posted under a field name as empty, not as a string', () => {
    const form = new FormData();
    form.set('title', new File(['x'], 'x.txt'));
    expect(reportRequestFormValues(form).title).toBe('');
  });
});

describe('parsing a report', () => {
  it('accepts a breakdown with a severity', () => {
    const parsed = parseReportRequestForm(values());
    expect(parsed).toEqual({
      ok: true,
      request: {
        assetId: ASSET,
        type: 'CORRECTIVE',
        title: 'نشتی روغن هیدرولیک',
        severity: 'HIGH',
      },
    });
  });

  it('accepts planned work with no severity', () => {
    const parsed = parseReportRequestForm(values({ type: 'PREVENTIVE', severity: '' }));
    expect(parsed).toMatchObject({ ok: true, request: { type: 'PREVENTIVE' } });
    if (parsed.ok) expect(parsed.request.severity).toBeUndefined();
  });

  it('requires a machine id, and one that is an asset id', () => {
    expect(parseReportRequestForm(values({ assetId: '' }))).toMatchObject({
      ok: false,
      fieldErrors: { assetId: 'شناسهٔ ماشین را وارد کنید' },
    });
    expect(
      parseReportRequestForm(values({ assetId: 'USR_01J00000000000000000000000' })),
    ).toMatchObject({ ok: false, fieldErrors: { assetId: 'شناسهٔ ماشین معتبر نیست' } });
  });

  it('refuses a type that is neither', () => {
    expect(parseReportRequestForm(values({ type: '' }))).toMatchObject({
      ok: false,
      fieldErrors: { type: 'نوع کار را انتخاب کنید' },
    });
    expect(parseReportRequestForm(values({ type: 'EMERGENCY' })).ok).toBe(false);
  });

  it('bounds the title', () => {
    expect(parseReportRequestForm(values({ title: 'ا' }))).toMatchObject({
      ok: false,
      fieldErrors: { title: 'عنوان دست‌کم ۲ نویسه باشد' },
    });
    expect(parseReportRequestForm(values({ title: 'ا'.repeat(201) }))).toMatchObject({
      ok: false,
      fieldErrors: { title: 'عنوان حداکثر ۲۰۰ نویسه است' },
    });
    expect(parseReportRequestForm(values({ title: 'ا'.repeat(200) })).ok).toBe(true);
  });

  it('normalises Arabic letters in free text to their Persian forms', () => {
    const parsed = parseReportRequestForm(values({ title: 'كليد برق' }));
    expect(parsed).toMatchObject({ ok: true, request: { title: 'کلید برق' } });
  });

  it('omits an empty description and bounds a long one', () => {
    const omitted = parseReportRequestForm(values());
    expect(omitted.ok && omitted.request.description).toBeUndefined();
    expect(parseReportRequestForm(values({ description: 'ا'.repeat(2001) }))).toMatchObject({
      ok: false,
      fieldErrors: { description: 'شرح حداکثر ۲۰۰۰ نویسه است' },
    });
  });

  it("names the service's first rule: a breakdown must state a severity", () => {
    expect(parseReportRequestForm(values({ type: 'CORRECTIVE', severity: '' }))).toMatchObject({
      ok: false,
      fieldErrors: { severity: 'برای خرابی، شدت را مشخص کنید' },
    });
  });

  it("names the service's second rule: planned work has no severity", () => {
    expect(parseReportRequestForm(values({ type: 'PREVENTIVE', severity: 'LOW' }))).toMatchObject({
      ok: false,
      fieldErrors: { severity: 'شدت فقط برای خرابی است؛ برای کار برنامه‌ای خالی بگذارید' },
    });
  });

  it('refuses a severity outside the vocabulary', () => {
    expect(parseReportRequestForm(values({ severity: 'EXTREME' }))).toMatchObject({
      ok: false,
      fieldErrors: { severity: 'شدت را از فهرست انتخاب کنید' },
    });
  });

  it('reads dates as Tehran midnight, not UTC midnight', () => {
    // Midnight in Tehran on 1 January is still 31 December in UTC; reading it
    // as UTC would move the day the person picked back by one.
    const parsed = parseReportRequestForm(
      values({ outOfServiceAt: '2027-01-01', dueDate: '2027-01-10' }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      request: {
        outOfServiceAt: '2026-12-31T20:30:00.000Z',
        dueDate: '2027-01-09T20:30:00.000Z',
      },
    });
  });

  it('refuses a date that is not one', () => {
    expect(parseReportRequestForm(values({ dueDate: '2027-13-45' }))).toMatchObject({
      ok: false,
      fieldErrors: { dueDate: 'تاریخ معتبر نیست' },
    });
  });

  it('reports the first problem on each field and every field that has one', () => {
    const parsed = parseReportRequestForm(
      values({ assetId: '', title: '', severity: '', type: 'CORRECTIVE' }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.fieldErrors).sort()).toEqual(['assetId', 'severity', 'title']);
  });

  it('never sends a field the service did not define (the body is strict)', () => {
    const parsed = parseReportRequestForm(values({ description: 'شرح' }));
    // The wire body, not the in-memory object: an omitted optional is an
    // `undefined` key on the object and absent from the JSON.
    const sent = parsed.ok ? Object.keys(JSON.parse(JSON.stringify(parsed.request))).sort() : null;
    expect(sent).toEqual(['assetId', 'description', 'severity', 'title', 'type']);
  });
});

describe('the field mapping', () => {
  it('names a path for every field the form posts', () => {
    for (const field of Object.keys(EMPTY_REPORT_REQUEST_FORM)) {
      expect(REPORT_REQUEST_FIELD_MAPPING.paths[field]).toBe(field);
    }
  });

  it.each([
    'A corrective request records a failure, so it must state a severity',
    'Severity describes a failure and does not apply to planned maintenance',
    'This machine already has an open request of that kind. Add to it, or close it first.',
    'Maintenance cannot be reported for a future moment.',
    'The machine has been transferred to another organization; this work cannot go ahead.',
    'This machine is being transferred to another organization; raise the work after the transfer.',
  ])('translates the sentence maintenance-service emits: %s', (sentence) => {
    expect(REPORT_REQUEST_FIELD_MAPPING.messages?.[sentence]).toBeTruthy();
  });
});

describe('writing a report', () => {
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

  const REQUEST = {
    assetId: ASSET,
    type: 'CORRECTIVE' as const,
    title: 'نشتی روغن',
    severity: 'HIGH' as const,
  };

  it('posts the body to the gateway with the submission id in the Idempotency-Key header', async () => {
    const { impl, calls } = recording(201, { id: 'MRQ_1', title: 'ignored' });

    const result = await reportMaintenanceRequest(SESSION, REQUEST, 'sub_abc', impl);

    expect(result).toMatchObject({ kind: 'CREATED', data: { id: 'MRQ_1' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://gateway.test:3000/v1/maintenance-requests');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['idempotency-key']).toBe('sub_abc');
    expect(calls[0].headers['authorization']).toBe('Bearer access-token-value');
    expect(calls[0].body).toEqual(REQUEST);
  });

  it('keeps only the id of what came back', async () => {
    const { impl, calls } = recording(201, { id: 'MRQ_1', reportedBy: 'USR_SECRET', extra: 1 });

    const result = await reportMaintenanceRequest(SESSION, REQUEST, 'sub_abc', impl);

    // The correlation id is the one this portal minted and sent, so a person
    // quoting it to support names a request the platform can follow.
    expect(result).toEqual({
      kind: 'CREATED',
      data: { id: 'MRQ_1' },
      correlationId: calls[0].headers['x-correlation-id'],
    });
    expect(calls[0].headers['x-correlation-id']).toBeTruthy();
  });

  it('puts a 400 detail back on the field that caused it', async () => {
    const { impl } = recording(400, {
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      details: [{ path: 'title', message: 'too short' }],
    });

    const result = await reportMaintenanceRequest(SESSION, REQUEST, 'sub_abc', impl);

    expect(result).toMatchObject({ kind: 'INVALID', fieldErrors: { title: 'too short' } });
  });

  it('says the duplicate-report refusal in Persian, as a message for the form', async () => {
    const { impl } = recording(422, {
      code: 'BUSINESS_RULE_VIOLATION',
      message:
        'This machine already has an open request of that kind. Add to it, or close it first.',
    });

    const result = await reportMaintenanceRequest(SESSION, REQUEST, 'sub_abc', impl);

    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: {},
      message:
        'این ماشین همین حالا یک درخواست باز از همین نوع دارد. به همان اضافه کنید یا نخست آن را ببندید.',
    });
  });

  it('shows a sentence it does not know as it arrived, never hidden', async () => {
    const { impl } = recording(422, {
      code: 'BUSINESS_RULE_VIOLATION',
      message: 'A rule this portal has never heard of',
    });

    const result = await reportMaintenanceRequest(SESSION, REQUEST, 'sub_abc', impl);

    expect(result).toMatchObject({
      kind: 'INVALID',
      message: 'A rule this portal has never heard of',
    });
  });

  it("reports a 403 as FORBIDDEN and a 404 as the platform's non-disclosure", async () => {
    const forbidden = await reportMaintenanceRequest(
      SESSION,
      REQUEST,
      'sub_abc',
      recording(403, { code: 'FORBIDDEN', message: 'no' }).impl,
    );
    const missing = await reportMaintenanceRequest(
      SESSION,
      REQUEST,
      'sub_abc',
      recording(404, { code: 'NOT_FOUND', message: 'Asset not found' }).impl,
    );

    expect(forbidden).toMatchObject({ kind: 'FORBIDDEN' });
    expect(missing).toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('never claims nothing was saved when the gateway timed out after forwarding', async () => {
    const { impl } = recording(504, { code: 'UPSTREAM_TIMEOUT', message: 'slow' });

    const result = await reportMaintenanceRequest(SESSION, REQUEST, 'sub_abc', impl);

    expect(result).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it('treats a 2xx it cannot read as unconfirmed rather than as success', async () => {
    const { impl } = recording(201, { unexpected: true });

    const result = await reportMaintenanceRequest(SESSION, REQUEST, 'sub_abc', impl);

    expect(result).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });
});

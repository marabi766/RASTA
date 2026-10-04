/**
 * @jest-environment node
 */
import {
  END_NOT_AFTER_START_MESSAGE,
  POLICY_ALREADY_RECORDED_MESSAGE,
  POLICY_EXPIRED_MESSAGE,
  RECORD_KEY_REUSED_MESSAGE,
  canRecordAssetCompliance,
  fetchInspections,
  fetchInsurancePolicies,
  parseRecordInspectionForm,
  parseRecordPolicyForm,
  recordInspection,
  recordInspectionFormValues,
  recordInsurancePolicy,
  recordPolicyFormValues,
  validityWindowOf,
} from './asset-records';
import type { WebSession } from './session';
import { localDateFromIso } from './drivers';
import { EMPTY_RECORD_INSPECTION_FORM, EMPTY_RECORD_POLICY_FORM } from '@/lib/asset-record-fields';

/**
 * The two record commands: who is offered the forms, what a person may type and
 * in what words a mistake is reported, the dates (a typed day is never moved by
 * one), what is sent, to which path, under which key, and every sentence the
 * service says for these endpoints in Persian.
 *
 * The form's rules are a courtesy that saves a round trip; the service is the
 * enforcement (`asset-records.contract.spec.ts` pins the two together).
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

const ASSET = 'AST_01J00000000000000000000000';

const POLICY_FORM = {
  ...EMPTY_RECORD_POLICY_FORM,
  policyNumber: 'POL-1405-77',
  insurerName: 'بیمه ایران',
  coverage: 'COMPREHENSIVE',
  validFrom: '2026-10-01',
  validTo: '2027-10-01',
};

const INSPECTION_FORM = {
  ...EMPTY_RECORD_INSPECTION_FORM,
  certificateNo: 'INSP-4471',
  inspectedAt: '2026-09-20',
  validTo: '2027-09-20',
  result: 'PASSED',
};

describe('who is offered the forms', () => {
  it.each([
    [['ORGANIZATION_ADMIN'], true],
    [['FLEET_MANAGER'], true],
    [['UNION_ADMIN'], true],
    [['OPERATOR'], false],
    [['DRIVER', 'OPERATOR'], false],
    [[], false],
  ])('%j: %s', (roles, expected) => {
    expect(canRecordAssetCompliance(roles)).toBe(expected);
  });
});

describe('where a record’s validity stands, on the server’s clock', () => {
  const from = '2026-10-01T00:00:00.000Z';
  const to = '2027-10-01T00:00:00.000Z';

  it.each([
    ['before it begins', '2026-09-30T23:59:59.999Z', 'FUTURE'],
    ['at the very start', from, 'CURRENT'],
    ['in the middle', '2027-01-01T00:00:00.000Z', 'CURRENT'],
    ['one millisecond before the end', '2027-09-30T23:59:59.999Z', 'CURRENT'],
    ['at the end instant: the window is half-open, as the service reads it', to, 'EXPIRED'],
    ['after the end', '2028-01-01T00:00:00.000Z', 'EXPIRED'],
  ])('%s', (_when, now, expected) => {
    expect(validityWindowOf(from, to, new Date(now))).toBe(expected);
  });

  it('never calls a record whose dates cannot be read current', () => {
    expect(validityWindowOf('not a date', to, new Date(from))).toBe('EXPIRED');
    expect(validityWindowOf(from, '', new Date(from))).toBe('EXPIRED');
    expect(validityWindowOf(from, to, new Date(Number.NaN))).toBe('EXPIRED');
  });

  it('does not read the machine’s clock: the same inputs give the same answer a year apart', () => {
    jest.useFakeTimers({ now: new Date('2020-01-01T00:00:00Z') });
    try {
      const early = validityWindowOf(from, to, new Date('2027-01-01T00:00:00Z'));
      jest.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      expect(validityWindowOf(from, to, new Date('2027-01-01T00:00:00Z'))).toBe(early);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the policy form', () => {
  it('reads every field of the form, and a missing one as blank', () => {
    const form = new FormData();
    form.set('policyNumber', 'X');
    expect(recordPolicyFormValues(form)).toEqual({
      ...EMPTY_RECORD_POLICY_FORM,
      policyNumber: 'X',
    });
  });

  it('turns what was typed into the body the service takes', () => {
    expect(
      parseRecordPolicyForm({
        ...POLICY_FORM,
        policyNumber: '  POL-1405-77  ',
        premium: '۱۲۰٬۰۰۰٬۰۰۰',
        insuredValue: '5,000,000,000',
      }),
    ).toEqual({
      ok: true,
      body: {
        policyNumber: 'POL-1405-77',
        insurerName: 'بیمه ایران',
        coverage: 'COMPREHENSIVE',
        premiumMinor: '120000000',
        insuredValueMinor: '5000000000',
        validFrom: '2026-09-30T20:30:00.000Z',
        validTo: '2027-09-30T20:30:00.000Z',
      },
    });
  });

  it('leaves blank amounts out of the body', () => {
    const parsed = parseRecordPolicyForm(POLICY_FORM);
    expect(parsed.ok && Object.keys(parsed.body).sort()).toEqual([
      'coverage',
      'insurerName',
      'policyNumber',
      'validFrom',
      'validTo',
    ]);
  });

  it('sends a typed day as the Tehran midnight of that day, which reads back as the same day', () => {
    const parsed = parseRecordPolicyForm({
      ...POLICY_FORM,
      validFrom: '2026-12-31',
      validTo: '2027-03-20',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(localDateFromIso(parsed.body.validFrom)).toBe('2026-12-31');
    expect(localDateFromIso(parsed.body.validTo)).toBe('2027-03-20');
    // The instant is the evening before in UTC, which is why a naive slice would shift the day.
    expect(parsed.body.validFrom.slice(0, 10)).toBe('2026-12-30');
  });

  it('accepts a date typed in Persian digits', () => {
    const parsed = parseRecordPolicyForm({ ...POLICY_FORM, validTo: '۲۰۲۷-۱۰-۰۱' });
    expect(parsed.ok && parsed.body.validTo).toBe('2027-09-30T20:30:00.000Z');
  });

  it('puts "end not after start" on the end date, in Persian', () => {
    expect(parseRecordPolicyForm({ ...POLICY_FORM, validTo: '2026-10-01' })).toEqual({
      ok: false,
      fieldErrors: { validTo: END_NOT_AFTER_START_MESSAGE },
    });
  });

  it('reports every mistake at once, one sentence per field, none of them English', () => {
    const parsed = parseRecordPolicyForm(EMPTY_RECORD_POLICY_FORM);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.fieldErrors).sort()).toEqual([
      'coverage',
      'insurerName',
      'policyNumber',
      'validFrom',
      'validTo',
    ]);
    for (const message of Object.values(parsed.fieldErrors)) {
      expect(message).not.toMatch(/[A-Za-z]{4,}/);
    }
  });

  it('refuses invisible direction controls in the policy number, as for every identifier', () => {
    for (const mark of ['‮', '؜', '‏']) {
      expect(parseRecordPolicyForm({ ...POLICY_FORM, policyNumber: `AB${mark}C-1` })).toMatchObject(
        {
          ok: false,
          fieldErrors: { policyNumber: expect.any(String) },
        },
      );
    }
  });

  it('refuses text the service’s display-text class refuses', () => {
    expect(parseRecordPolicyForm({ ...POLICY_FORM, insurerName: 'بیمه <script>' })).toMatchObject({
      ok: false,
      fieldErrors: { insurerName: expect.any(String) },
    });
  });

  it('refuses an amount past the ledger’s bound and keeps the largest one it takes', () => {
    expect(parseRecordPolicyForm({ ...POLICY_FORM, premium: '9223372036854775808' })).toMatchObject(
      { ok: false, fieldErrors: { premium: expect.any(String) } },
    );
    const ok = parseRecordPolicyForm({ ...POLICY_FORM, premium: '9223372036854775807' });
    expect(ok.ok && ok.body.premiumMinor).toBe('9223372036854775807');
  });
});

describe('the inspection form', () => {
  it('reads every field of the form, and a missing one as blank', () => {
    const form = new FormData();
    form.set('certificateNo', 'X');
    expect(recordInspectionFormValues(form)).toEqual({
      ...EMPTY_RECORD_INSPECTION_FORM,
      certificateNo: 'X',
    });
  });

  it('turns what was typed into the body the service takes', () => {
    expect(
      parseRecordInspectionForm({
        ...INSPECTION_FORM,
        centerName: ' مرکز معاینه فنی شمال ',
        notes: '  لنت ترمز نزدیک به تعویض  ',
        result: 'CONDITIONAL',
      }),
    ).toEqual({
      ok: true,
      body: {
        certificateNo: 'INSP-4471',
        centerName: 'مرکز معاینه فنی شمال',
        inspectedAt: '2026-09-19T20:30:00.000Z',
        validTo: '2027-09-19T20:30:00.000Z',
        result: 'CONDITIONAL',
        notes: 'لنت ترمز نزدیک به تعویض',
      },
    });
  });

  it('leaves a blank centre and blank notes out of the body', () => {
    const parsed = parseRecordInspectionForm({ ...INSPECTION_FORM, centerName: ' ', notes: ' ' });
    expect(parsed.ok && Object.keys(parsed.body).sort()).toEqual([
      'certificateNo',
      'inspectedAt',
      'result',
      'validTo',
    ]);
  });

  it('puts "end not after the inspection" on the end date', () => {
    expect(parseRecordInspectionForm({ ...INSPECTION_FORM, validTo: '2026-09-20' })).toMatchObject({
      ok: false,
      fieldErrors: { validTo: expect.any(String) },
    });
  });

  it.each(['PASSED', 'CONDITIONAL', 'FAILED'])('takes the result %s', (result) => {
    expect(parseRecordInspectionForm({ ...INSPECTION_FORM, result }).ok).toBe(true);
  });

  it('refuses a result the service has not got', () => {
    expect(parseRecordInspectionForm({ ...INSPECTION_FORM, result: 'OK' })).toMatchObject({
      ok: false,
      fieldErrors: { result: expect.any(String) },
    });
  });
});

describe('sending', () => {
  interface Recorded {
    url: string;
    method: string | undefined;
    headers: Record<string, string>;
    body: unknown;
  }

  function recording(status: number, body: unknown, headers: Record<string, string> = {}) {
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
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1', ...headers },
      });
    }) as typeof fetch;
    return { impl, calls };
  }

  const POLICY_BODY = {
    policyNumber: 'POL-1',
    insurerName: 'بیمه ایران',
    coverage: 'THIRD_PARTY' as const,
    validFrom: '2026-09-30T20:30:00.000Z',
    validTo: '2027-09-30T20:30:00.000Z',
  };
  const INSPECTION_BODY = {
    certificateNo: 'INSP-1',
    inspectedAt: '2026-09-19T20:30:00.000Z',
    validTo: '2027-09-19T20:30:00.000Z',
    result: 'PASSED' as const,
  };
  const CREATED = { id: 'INS_01J', policyNumber: 'POL-1' };

  it.each([
    [
      'a policy',
      'insurance-policies',
      (impl: typeof fetch) => recordInsurancePolicy(SESSION, ASSET, POLICY_BODY, 'sub_abc', impl),
      POLICY_BODY,
    ],
    [
      'an inspection',
      'inspections',
      (impl: typeof fetch) => recordInspection(SESSION, ASSET, INSPECTION_BODY, 'sub_abc', impl),
      INSPECTION_BODY,
    ],
  ])(
    '%s: a POST to its own path, under the submission id as the key, with the token',
    async (_what, path, call, body) => {
      const { impl, calls } = recording(201, CREATED);

      expect(await call(impl)).toMatchObject({ kind: 'CREATED', data: { id: 'INS_01J' } });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        url: `http://gateway.test:3000/v1/assets/${ASSET}/${path}`,
        method: 'POST',
        body,
      });
      expect(calls[0]!.headers['idempotency-key']).toBe('sub_abc');
      expect(calls[0]!.headers.authorization).toBe('Bearer access-token-value');
    },
  );

  it('sends the same key and body for the same submission every time, which is what makes a replay a replay', async () => {
    const { impl, calls } = recording(201, CREATED);
    await recordInsurancePolicy(SESSION, ASSET, POLICY_BODY, 'sub_same', impl);
    await recordInsurancePolicy(SESSION, ASSET, POLICY_BODY, 'sub_same', impl);
    expect(calls[1]!.headers['idempotency-key']).toBe(calls[0]!.headers['idempotency-key']);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
  });

  it('encodes the asset id into the path, so an id with a slash cannot address another endpoint', async () => {
    const { impl, calls } = recording(201, CREATED);
    await recordInsurancePolicy(SESSION, '../../drivers/x', POLICY_BODY, 's', impl);
    expect(calls[0]!.url).toBe(
      'http://gateway.test:3000/v1/assets/..%2F..%2Fdrivers%2Fx/insurance-policies',
    );
  });

  it('treats an answer that does not look like the record as unconfirmed, never as "nothing happened"', async () => {
    expect(
      await recordInspection(
        SESSION,
        ASSET,
        INSPECTION_BODY,
        's',
        recording(201, { nope: 1 }).impl,
      ),
    ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it('says in progress when the first request under this key is still being processed', async () => {
    const result = await recordInsurancePolicy(
      SESSION,
      ASSET,
      POLICY_BODY,
      's',
      recording(409, { code: 'CONFLICT', message: 'in flight' }, { 'retry-after': '1' }).impl,
    );
    expect(result).toMatchObject({ kind: 'IN_PROGRESS', retryAfterSeconds: 1 });
  });

  describe('what the service says, in Persian', () => {
    it.each([
      [
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request body',
        RECORD_KEY_REUSED_MESSAGE,
      ],
      [409, 'ALREADY_EXISTS', 'InsurancePolicy already exists', POLICY_ALREADY_RECORDED_MESSAGE],
      [
        422,
        'BUSINESS_RULE_VIOLATION',
        'This policy has already expired. Record the current policy instead.',
        POLICY_EXPIRED_MESSAGE,
      ],
    ] as const)('%s %s', async (status, code, sentence, persian) => {
      for (const call of [
        (impl: typeof fetch) => recordInsurancePolicy(SESSION, ASSET, POLICY_BODY, 's', impl),
        (impl: typeof fetch) => recordInspection(SESSION, ASSET, INSPECTION_BODY, 's', impl),
      ]) {
        const result = await call(recording(status, { code, message: sentence }).impl);
        expect(result).toMatchObject({ kind: 'INVALID', message: persian });
        expect(result.kind === 'INVALID' && result.message).not.toMatch(/[A-Za-z]{4,}/);
      }
    });

    it('says an unknown code by its own sentence, visibly foreign rather than hidden', async () => {
      const result = await recordInsurancePolicy(
        SESSION,
        ASSET,
        POLICY_BODY,
        's',
        recording(422, { code: 'BUSINESS_RULE_VIOLATION', message: 'Some new rule' }).impl,
      );
      expect(result).toMatchObject({ kind: 'INVALID', message: 'Some new rule' });
    });

    it('places a field-level problem on the form’s own field name', async () => {
      const result = await recordInsurancePolicy(
        SESSION,
        ASSET,
        POLICY_BODY,
        's',
        recording(400, {
          code: 'VALIDATION_FAILED',
          message: 'bad',
          details: [
            { path: 'premiumMinor', message: 'Invalid' },
            { path: 'insuredValueMinor', message: 'Invalid' },
          ],
        }).impl,
      );
      expect(result).toMatchObject({
        kind: 'INVALID',
        fieldErrors: { premium: 'Invalid', insuredValue: 'Invalid' },
      });
    });

    it.each([
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
    ])('says %s as %s', async (status, kind) => {
      expect(
        await recordInspection(
          SESSION,
          ASSET,
          INSPECTION_BODY,
          's',
          recording(status, { code: 'X', message: 'y' }).impl,
        ),
      ).toMatchObject({ kind });
    });

    it('answers 404 for another organization’s asset exactly as for a missing one', async () => {
      const a = await recordInsurancePolicy(
        SESSION,
        ASSET,
        POLICY_BODY,
        's',
        recording(404, { code: 'RESOURCE_NOT_FOUND', message: 'Asset not found' }).impl,
      );
      const b = await recordInsurancePolicy(
        SESSION,
        'AST_MISSING',
        POLICY_BODY,
        's',
        recording(404, { code: 'RESOURCE_NOT_FOUND', message: 'Asset not found' }).impl,
      );
      // The correlation id is the portal's own, minted per request.
      expect({ ...a, correlationId: '' }).toEqual({ ...b, correlationId: '' });
    });
  });
});

describe('reading', () => {
  function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    return run().finally(() => {
      globalThis.fetch = original;
    });
  }

  function answering(body: unknown, status = 200) {
    const urls: string[] = [];
    const impl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { impl, urls };
  }

  const POLICY = {
    id: 'INS_1',
    assetId: ASSET,
    organizationId: 'ORG_1',
    policyNumber: 'POL-1',
    insurerName: 'بیمه ایران',
    coverage: 'THIRD_PARTY',
    premiumMinor: '120000000',
    insuredValueMinor: null,
    validFrom: '2026-09-30T20:30:00.000Z',
    validTo: '2027-09-30T20:30:00.000Z',
    status: 'ACTIVE',
    daysUntilExpiry: 362,
    documentId: 'DOC_SECRET',
  };

  const INSPECTION = {
    id: 'INSP_1',
    certificateNo: 'INSP-1',
    centerName: null,
    inspectedAt: '2026-09-19T20:30:00.000Z',
    validTo: '2027-09-19T20:30:00.000Z',
    result: 'PASSED',
    notes: null,
    daysUntilExpiry: 351,
  };

  it('reads the policies of this asset and keeps only what a screen renders', async () => {
    const { impl, urls } = answering([POLICY]);
    const result = await withFetch(impl, () => fetchInsurancePolicies(SESSION, ASSET));

    expect(urls).toEqual([`http://gateway.test:3000/v1/assets/${ASSET}/insurance-policies`]);
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data).toHaveLength(1);
    expect(JSON.stringify(result.data)).not.toMatch(/DOC_SECRET|organizationId|assetId/);
  });

  it('reads the inspections of this asset', async () => {
    const { impl, urls } = answering([INSPECTION]);
    const result = await withFetch(impl, () => fetchInspections(SESSION, ASSET));
    expect(urls).toEqual([`http://gateway.test:3000/v1/assets/${ASSET}/inspections`]);
    expect(result).toMatchObject({ kind: 'OK', data: [{ certificateNo: 'INSP-1' }] });
  });

  it('encodes the asset id into the path', async () => {
    const { impl, urls } = answering([]);
    await withFetch(impl, () => fetchInspections(SESSION, '../x'));
    expect(urls[0]).toBe('http://gateway.test:3000/v1/assets/..%2Fx/inspections');
  });

  it('an empty list is an answer, not a failure', async () => {
    expect(
      await withFetch(answering([]).impl, () => fetchInsurancePolicies(SESSION, ASSET)),
    ).toEqual({
      kind: 'OK',
      data: [],
    });
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ])('says %s as %s', async (status, kind) => {
    expect(
      await withFetch(answering({ code: 'X', message: 'y' }, status).impl, () =>
        fetchInsurancePolicies(SESSION, ASSET),
      ),
    ).toMatchObject({ kind });
  });

  it('says an answer that is not a list is malformed rather than rendering it', async () => {
    expect(
      await withFetch(answering({ items: [] }).impl, () => fetchInspections(SESSION, ASSET)),
    ).toMatchObject({ kind: 'MALFORMED' });
  });
});

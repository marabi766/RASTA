/**
 * @jest-environment node
 */
import {
  ASSET_EDIT_CONFLICT_MESSAGE,
  canManageAssets,
  changedUpdateFields,
  openAssetBaseline,
  parseRegisterAssetForm,
  parseUpdateAssetForm,
  registerAsset,
  registerAssetFormValues,
  REGISTER_ASSET_FIELD_MAPPING,
  sealAssetBaseline,
  updateAsset,
  updateAssetFormValues,
  UPDATE_ASSET_FIELD_MAPPING,
} from './asset-commands';
import { EMPTY_REGISTER_ASSET_FORM, EMPTY_UPDATE_ASSET_FORM } from '@/lib/asset-form-fields';
import type { WebSession } from './session';

/**
 * Parsing and writing an asset registration and an asset edit.
 *
 * Mirrors `drivers.spec.ts` and `maintenance-commands.spec.ts`: this module
 * designs nothing new, so its tests do not either. What is specific here is
 * the year in either digit set, the optional `location` object, the blank that
 * means "absent" on register and "clear" on edit, and the two sentences
 * asset-service emits.
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

/** U+202E RIGHT-TO-LEFT OVERRIDE, built from its code point (invisible in source). */
const RLO = String.fromCodePoint(0x202e);

describe('who is offered the forms', () => {
  it.each(['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN'])(
    'offers them to %s, the roles POST /v1/assets admits',
    (role) => {
      expect(canManageAssets([role])).toBe(true);
    },
  );

  it.each([[[]], [['OPERATOR']], [['DRIVER']], [['AUDITOR']], [['PROCUREMENT_USER']]])(
    'does not offer them to %p',
    (roles) => {
      expect(canManageAssets(roles)).toBe(false);
    },
  );

  it('offers them when any one held role qualifies', () => {
    expect(canManageAssets(['OPERATOR', 'FLEET_MANAGER'])).toBe(true);
  });
});

describe('registering a machine', () => {
  const values = (overrides: Partial<typeof EMPTY_REGISTER_ASSET_FORM> = {}) => ({
    ...EMPTY_REGISTER_ASSET_FORM,
    name: 'لودر کوماتسو',
    type: 'LOADER',
    ...overrides,
  });

  it('reads every field as a string and treats an absent one as empty', () => {
    const form = new FormData();
    form.set('name', 'x');
    form.set('type', 'LOADER');
    expect(registerAssetFormValues(form)).toEqual({
      ...EMPTY_REGISTER_ASSET_FORM,
      name: 'x',
      type: 'LOADER',
    });
  });

  it('accepts a name and a type and sends nothing else', () => {
    const parsed = parseRegisterAssetForm(values());
    expect(parsed.ok).toBe(true);
    // The wire body, not the object: an omitted optional is an `undefined` key
    // on the object and absent from the JSON.
    expect(parsed.ok && JSON.parse(JSON.stringify(parsed.request))).toEqual({
      name: 'لودر کوماتسو',
      type: 'LOADER',
    });
  });

  it('sends every field it is given', () => {
    const parsed = parseRegisterAssetForm(
      values({
        assetTag: '12 ع 345',
        manufacturer: 'کوماتسو',
        model: 'WA320',
        serialNumber: 'SN-0001',
        manufactureYear: '2019',
        siteName: 'انبار مرکزی',
        addressLine: 'بلوار امام',
      }),
    );
    expect(parsed.ok && JSON.parse(JSON.stringify(parsed.request))).toEqual({
      name: 'لودر کوماتسو',
      type: 'LOADER',
      assetTag: '12 ع 345',
      manufacturer: 'کوماتسو',
      model: 'WA320',
      serialNumber: 'SN-0001',
      manufactureYear: 2019,
      location: { siteName: 'انبار مرکزی', addressLine: 'بلوار امام' },
    });
  });

  it('sends a location only when one of its two fields is given, and only what was given', () => {
    const neither = parseRegisterAssetForm(values());
    expect(neither.ok && 'location' in neither.request).toBe(false);

    const onlySite = parseRegisterAssetForm(values({ siteName: 'انبار' }));
    expect(onlySite.ok && JSON.parse(JSON.stringify(onlySite.request)).location).toEqual({
      siteName: 'انبار',
    });

    const onlyAddress = parseRegisterAssetForm(values({ addressLine: 'بلوار' }));
    expect(onlyAddress.ok && JSON.parse(JSON.stringify(onlyAddress.request)).location).toEqual({
      addressLine: 'بلوار',
    });
  });

  it('requires a name of at least two characters and at most 200', () => {
    expect(parseRegisterAssetForm(values({ name: '' }))).toMatchObject({
      ok: false,
      fieldErrors: { name: 'نام دست‌کم ۲ نویسه باشد' },
    });
    expect(parseRegisterAssetForm(values({ name: 'ل' })).ok).toBe(false);
    expect(parseRegisterAssetForm(values({ name: 'ل'.repeat(201) }))).toMatchObject({
      ok: false,
      fieldErrors: { name: 'نام حداکثر ۲۰۰ نویسه است' },
    });
    expect(parseRegisterAssetForm(values({ name: 'ل'.repeat(200) })).ok).toBe(true);
  });

  it('normalises Arabic letters in free text to their Persian forms', () => {
    const parsed = parseRegisterAssetForm(values({ name: 'لودر كوماتسو' }));
    expect(parsed).toMatchObject({ ok: true, request: { name: 'لودر کوماتسو' } });
  });

  it('refuses the characters the service refuses, in Persian, at the field', () => {
    for (const field of ['name', 'manufacturer', 'siteName'] as const) {
      const parsed = parseRegisterAssetForm(values({ [field]: 'مدل <script>' }));
      expect(parsed).toMatchObject({
        ok: false,
        fieldErrors: { [field]: expect.stringContaining('نویسهٔ غیرمجاز') },
      });
    }
  });

  it('holds the model to the service’s own rule — trimmed, 1 to 120 — and no character class', () => {
    // asset-service's `model` is `plainText().min(1).max(120)`: unlike `name`
    // and `manufacturer` it has no display-text class, so a model the service
    // stores happily is one this form must not refuse. Its one character rule,
    // the bidi controls, is the next test.
    for (const model of ['WA320-3', 'مدل «ویژه» #۱', 'a<b>', 'X_1 & Y=2', '日本語']) {
      expect(parseRegisterAssetForm(values({ model }))).toMatchObject({
        ok: true,
        request: { model },
      });
    }
    expect(parseRegisterAssetForm(values({ model: `  ${'م'.repeat(120)}  ` }))).toMatchObject({
      ok: true,
      request: { model: 'م'.repeat(120) },
    });
    expect(parseRegisterAssetForm(values({ model: 'م'.repeat(121) }))).toMatchObject({
      ok: false,
      fieldErrors: { model: 'مدل حداکثر ۱۲۰ نویسه است' },
    });
  });

  it('refuses a model carrying an invisible direction control, as the service does', () => {
    for (const codePoint of [0x202e, 0x061c, 0x200f, 0x2069]) {
      expect(
        parseRegisterAssetForm(values({ model: `WA${String.fromCodePoint(codePoint)}320` })),
      ).toMatchObject({
        ok: false,
        fieldErrors: { model: 'این فیلد نویسهٔ جهت‌دهی نامرئی نمی‌پذیرد' },
      });
    }
    expect(parseRegisterAssetForm(values({ model: 'چرخ\u200cدار' }))).toMatchObject({
      ok: true,
      request: { model: 'چرخ\u200cدار' },
    });
  });

  it('sends the model as typed: only trimmed, its letters not rewritten', () => {
    const arabicKaf = String.fromCodePoint(0x643);
    const parsed = parseRegisterAssetForm(values({ model: ` ${arabicKaf}س ` }));
    expect(parsed).toMatchObject({ ok: true, request: { model: `${arabicKaf}س` } });
  });

  it('leaves a blank model out', () => {
    const parsed = parseRegisterAssetForm(values({ model: '   ' }));
    // `undefined` is dropped by JSON, which is what "left out" means on the wire.
    expect(parsed.ok && JSON.parse(JSON.stringify(parsed.request))).not.toHaveProperty('model');
  });

  it('requires one of the known types', () => {
    expect(parseRegisterAssetForm(values({ type: '' }))).toMatchObject({
      ok: false,
      fieldErrors: { type: 'نوع ماشین را انتخاب کنید' },
    });
    expect(parseRegisterAssetForm(values({ type: 'SPACESHIP' })).ok).toBe(false);
  });

  it('refuses a bidi control character hidden in an identifier', () => {
    expect(parseRegisterAssetForm(values({ assetTag: `AB${RLO}12` })).ok).toBe(false);
    expect(parseRegisterAssetForm(values({ serialNumber: `SN${RLO}123` })).ok).toBe(false);
  });

  it('bounds the identifiers', () => {
    expect(parseRegisterAssetForm(values({ assetTag: 'A'.repeat(65) }))).toMatchObject({
      ok: false,
      fieldErrors: { assetTag: 'شمارهٔ دارایی حداکثر ۶۴ نویسه است' },
    });
    expect(parseRegisterAssetForm(values({ serialNumber: 'AB' }))).toMatchObject({
      ok: false,
      fieldErrors: { serialNumber: 'شمارهٔ سریال دست‌کم ۳ نویسه باشد' },
    });
    expect(parseRegisterAssetForm(values({ serialNumber: 'A'.repeat(121) })).ok).toBe(false);
  });

  it('hands the service what was typed in an identifier, for it to canonicalise', () => {
    // asset-service folds Persian digits and Arabic letter variants itself.
    const parsed = parseRegisterAssetForm(values({ assetTag: ' ۱۲ ع ۳۴۵ ' }));
    expect(parsed).toMatchObject({ ok: true, request: { assetTag: '۱۲ ع ۳۴۵' } });
  });

  describe('the year', () => {
    it.each([
      ['2019', 2019],
      ['۱۴۰۲', 1402],
      ['١٤٠٢', 1402],
      [' 1402 ', 1402],
      ['1300', 1300],
      ['2100', 2100],
    ])('reads %j as the number %d, whichever digits it was typed in', (raw, expected) => {
      const parsed = parseRegisterAssetForm(values({ manufactureYear: raw }));
      expect(parsed).toMatchObject({ ok: true, request: { manufactureYear: expected } });
    });

    it('converts no calendar: a Jalali and a Gregorian year are each sent as typed', () => {
      const jalali = parseRegisterAssetForm(values({ manufactureYear: '1402' }));
      const gregorian = parseRegisterAssetForm(values({ manufactureYear: '2023' }));
      expect(jalali.ok && jalali.request.manufactureYear).toBe(1402);
      expect(gregorian.ok && gregorian.request.manufactureYear).toBe(2023);
    });

    it.each(['1299', '2101', '99', '12345', '۱۴۰', 'abcd', '14.5', '-1402', '۱۴۰۲x'])(
      'refuses %j',
      (raw) => {
        expect(parseRegisterAssetForm(values({ manufactureYear: raw }))).toMatchObject({
          ok: false,
          fieldErrors: { manufactureYear: expect.stringContaining('سال ساخت') },
        });
      },
    );

    it('omits a blank year rather than sending zero', () => {
      const parsed = parseRegisterAssetForm(values({ manufactureYear: '' }));
      expect(parsed.ok && 'manufactureYear' in JSON.parse(JSON.stringify(parsed.request))).toBe(
        false,
      );
    });
  });

  it('reports the first problem on each field and every field that has one', () => {
    const parsed = parseRegisterAssetForm(values({ name: '', type: '', manufactureYear: '9' }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.fieldErrors).sort()).toEqual(['manufactureYear', 'name', 'type']);
  });

  it('names a path for every field, including the two that travel inside `location`', () => {
    for (const field of Object.keys(EMPTY_REGISTER_ASSET_FORM)) {
      expect(Object.values(REGISTER_ASSET_FIELD_MAPPING.paths)).toContain(field);
    }
    expect(REGISTER_ASSET_FIELD_MAPPING.paths['location.siteName']).toBe('siteName');
    expect(REGISTER_ASSET_FIELD_MAPPING.paths['location.addressLine']).toBe('addressLine');
  });
});

describe('the numbers inside a message', () => {
  it('are in Persian digits: Latin digits belong to data and never to presentation', () => {
    const tooLong = 'ل'.repeat(201);
    const parsed = parseRegisterAssetForm({
      ...EMPTY_REGISTER_ASSET_FORM,
      name: tooLong,
      type: '',
      assetTag: 'A'.repeat(65),
      serialNumber: 'AB',
      manufacturer: tooLong,
      model: tooLong,
      manufactureYear: '99',
      siteName: tooLong,
      addressLine: 'ن'.repeat(501),
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const messages = Object.values(parsed.fieldErrors);
    expect(messages.length).toBeGreaterThanOrEqual(8);
    for (const message of messages) expect(message).not.toMatch(/[0-9]/);
  });
});

describe('editing a machine', () => {
  const RENDERED = {
    name: 'لودر کوماتسو',
    assetTag: 'AB-12',
    manufacturer: 'کوماتسو',
    model: 'WA320',
    manufactureYear: '1401',
  };
  const values = (overrides: Partial<typeof EMPTY_UPDATE_ASSET_FORM> = {}) => ({
    ...RENDERED,
    ...overrides,
  });

  it('reads every field as a string and treats an absent one as empty', () => {
    const form = new FormData();
    form.set('name', 'x');
    expect(updateAssetFormValues(form)).toEqual({ ...EMPTY_UPDATE_ASSET_FORM, name: 'x' });
  });

  describe('which fields changed', () => {
    it('is none when the form comes back as it was drawn', () => {
      expect(changedUpdateFields(values(), RENDERED)).toEqual([]);
    });

    it('names exactly the fields whose text differs', () => {
      expect(changedUpdateFields(values({ assetTag: 'AB-13', model: '' }), RENDERED)).toEqual([
        'assetTag',
        'model',
      ]);
    });

    it('compares as text, so a field the person did not touch is never "changed" by normalisation', () => {
      // The stored name has an Arabic yeh; the form was drawn with it and comes
      // back with it. Normalising before comparing would call it changed and
      // send a rewrite nobody asked for.
      const arabicYeh = String.fromCodePoint(0x64a);
      const stored = { ...RENDERED, name: `عل${arabicYeh}` };
      expect(changedUpdateFields(stored, stored)).toEqual([]);
    });
  });

  describe('sending only what changed', () => {
    it('sends nothing for a field that did not change', () => {
      const parsed = parseUpdateAssetForm(values({ assetTag: 'AB-13' }), ['assetTag']);
      expect(parsed).toEqual({ ok: true, request: { assetTag: 'AB-13' } });
    });

    it('sends a blanked field as null — the service’s clear — and a filled one as its value', () => {
      const parsed = parseUpdateAssetForm(values({ manufacturer: '', manufactureYear: '۱۴۰۲' }), [
        'manufacturer',
        'manufactureYear',
      ]);
      expect(parsed).toEqual({
        ok: true,
        request: { manufacturer: null, manufactureYear: 1402 },
      });
    });

    it('does not validate a field that is not being changed', () => {
      // A stored value that predates a rule must not block an unrelated edit:
      // the manufacturer is `a<b` in the record, the person changes the tag.
      const stored = values({ manufacturer: 'a<b', assetTag: 'AB-13' });
      expect(parseUpdateAssetForm(stored, ['assetTag'])).toEqual({
        ok: true,
        request: { assetTag: 'AB-13' },
      });
    });

    it('validates a field that is being changed, in Persian, at the field', () => {
      expect(parseUpdateAssetForm(values({ manufacturer: 'a<b' }), ['manufacturer'])).toMatchObject(
        {
          ok: false,
          fieldErrors: { manufacturer: expect.stringContaining('نویسهٔ غیرمجاز') },
        },
      );
      expect(parseUpdateAssetForm(values({ assetTag: `A${RLO}1` }), ['assetTag']).ok).toBe(false);
      expect(parseUpdateAssetForm(values({ manufactureYear: '1' }), ['manufactureYear']).ok).toBe(
        false,
      );
    });

    it('cannot clear the name', () => {
      expect(parseUpdateAssetForm(values({ name: '' }), ['name'])).toMatchObject({
        ok: false,
        fieldErrors: { name: 'نام دست‌کم ۲ نویسه باشد' },
      });
    });

    it('applies the service’s model rule to a changed model: no character class', () => {
      expect(parseUpdateAssetForm(values({ model: 'a<b>' }), ['model'])).toEqual({
        ok: true,
        request: { model: 'a<b>' },
      });
    });

    it('has no type and no serial number to send', () => {
      const parsed = parseUpdateAssetForm(values({ name: 'نام تازه' }), ['name']);
      const keys = parsed.ok ? Object.keys(parsed.request) : [];
      expect(keys).not.toContain('type');
      expect(keys).not.toContain('serialNumber');
    });
  });

  it('names a path for every field', () => {
    for (const field of Object.keys(EMPTY_UPDATE_ASSET_FORM)) {
      expect(UPDATE_ASSET_FIELD_MAPPING.paths[field]).toBe(field);
    }
  });

  it('says the service’s version conflict in Persian', () => {
    expect(
      UPDATE_ASSET_FIELD_MAPPING.messages?.[
        'Asset was modified by another request; reload and retry'
      ],
    ).toBe(ASSET_EDIT_CONFLICT_MESSAGE);
  });

  describe('the baseline the form carries', () => {
    const ENV_SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
    beforeEach(() => {
      process.env.WEB_SESSION_SECRET = ENV_SECRET;
    });

    it('opens for the session and the machine it was sealed for, and returns what it holds', () => {
      const token = sealAssetBaseline(SESSION, 'AST_1', 7, RENDERED);
      expect(openAssetBaseline(SESSION, token, 'AST_1')).toEqual({ version: 7, values: RENDERED });
    });

    it('does not open for another machine', () => {
      const token = sealAssetBaseline(SESSION, 'AST_1', 7, RENDERED);
      expect(openAssetBaseline(SESSION, token, 'AST_2')).toBeNull();
    });

    it('does not open for another person or an earlier login', () => {
      const token = sealAssetBaseline(SESSION, 'AST_1', 7, RENDERED);
      expect(openAssetBaseline({ ...SESSION, subject: 'USR_2' }, token, 'AST_1')).toBeNull();
      expect(openAssetBaseline({ ...SESSION, csrfToken: 'next-login' }, token, 'AST_1')).toBeNull();
    });

    it('does not open a token somebody edited, so what counts as "unchanged" is not theirs to say', () => {
      const [, mac] = sealAssetBaseline(SESSION, 'AST_1', 7, RENDERED).split('.');
      const forged = Buffer.from(
        JSON.stringify({
          assetId: 'AST_1',
          version: 7,
          values: { ...RENDERED, assetTag: 'SOMETHING-ELSE' },
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      expect(openAssetBaseline(SESSION, `${forged}.${mac}`, 'AST_1')).toBeNull();
    });

    it('does not open a flash passed off as a baseline', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { mintFlash } = require('./flash') as typeof import('./flash');
      expect(
        openAssetBaseline(SESSION, mintFlash(SESSION, 'AST_1', 'created'), 'AST_1'),
      ).toBeNull();
    });

    it.each([undefined, null, '', 'x', 7])('does not open %j', (value) => {
      expect(openAssetBaseline(SESSION, value, 'AST_1')).toBeNull();
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
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { impl, calls };
  }

  const REGISTER = { name: 'لودر', type: 'LOADER' as const };
  const UPDATE = { assetTag: null, name: 'لودر' };

  it('registers with a POST, the submission id in the Idempotency-Key header, and keeps only the id', async () => {
    const { impl, calls } = recording(201, { id: 'AST_1', serialNumber: 'SN-SECRET', extra: 1 });

    const result = await registerAsset(SESSION, REGISTER, 'sub_abc', impl);

    expect(result).toMatchObject({ kind: 'CREATED', data: { id: 'AST_1' } });
    expect(result.kind === 'CREATED' && result.data).toEqual({ id: 'AST_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://gateway.test:3000/v1/assets');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['idempotency-key']).toBe('sub_abc');
    expect(calls[0].headers['authorization']).toBe('Bearer access-token-value');
    expect(calls[0].body).toEqual(REGISTER);
  });

  it('edits with a PATCH to the percent-encoded id', async () => {
    const { impl, calls } = recording(200, { id: 'AST_1' });

    const result = await updateAsset(SESSION, 'AST/1 x', UPDATE, 4, 'sub_abc', impl);

    expect(result).toMatchObject({ kind: 'CREATED', data: { id: 'AST_1' } });
    expect(calls[0].url).toBe('http://gateway.test:3000/v1/assets/AST%2F1%20x');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].headers['idempotency-key']).toBe('sub_abc');
    // Only what changed, and the version it was changed from.
    expect(calls[0].body).toEqual({ ...UPDATE, expectedVersion: 4 });
  });

  it('puts a 400 detail on the field, including one inside `location`', async () => {
    const { impl } = recording(400, {
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      details: [
        { path: 'name', message: 'Contains unsupported characters' },
        { path: 'location.siteName', message: 'String must contain at most 200 character(s)' },
      ],
    });

    const result = await registerAsset(SESSION, REGISTER, 'sub_abc', impl);

    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: {
        name: expect.stringContaining('نویسهٔ غیرمجاز'),
        siteName: 'String must contain at most 200 character(s)',
      },
    });
  });

  it('says the duplicate refusal in Persian, without naming who holds the machine', async () => {
    const { impl } = recording(409, { code: 'ALREADY_EXISTS', message: 'Asset already exists' });

    const result = await registerAsset(SESSION, REGISTER, 'sub_abc', impl);

    expect(result).toMatchObject({
      kind: 'INVALID',
      message: 'ماشینی با این شمارهٔ سریال یا شمارهٔ دارایی پیش‌تر ثبت شده است',
    });
  });

  it('shows a sentence it does not know as it arrived, never hidden', async () => {
    const { impl } = recording(422, { code: 'BUSINESS_RULE_VIOLATION', message: 'A new rule' });

    const result = await updateAsset(SESSION, 'AST_1', UPDATE, 4, 'sub_abc', impl);

    expect(result).toMatchObject({ kind: 'INVALID', message: 'A new rule' });
  });

  it('says the version conflict in Persian: the machine changed after the form was drawn', async () => {
    const { impl } = recording(409, {
      code: 'OPTIMISTIC_LOCK_FAILED',
      message: 'Asset was modified by another request; reload and retry',
    });

    const result = await updateAsset(SESSION, 'AST_1', UPDATE, 4, 'sub_abc', impl);

    expect(result).toMatchObject({ kind: 'INVALID', message: ASSET_EDIT_CONFLICT_MESSAGE });
  });

  it("reports 403 as FORBIDDEN and 404 as the platform's non-disclosure", async () => {
    const forbidden = await updateAsset(
      SESSION,
      'AST_1',
      UPDATE,
      4,
      'sub_abc',
      recording(403, { code: 'FORBIDDEN', message: 'no' }).impl,
    );
    const missing = await updateAsset(
      SESSION,
      'AST_1',
      UPDATE,
      4,
      'sub_abc',
      recording(404, { code: 'NOT_FOUND', message: 'Asset not found' }).impl,
    );

    expect(forbidden).toMatchObject({ kind: 'FORBIDDEN' });
    expect(missing).toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('never claims nothing was saved when the gateway timed out after forwarding', async () => {
    const { impl } = recording(504, { code: 'UPSTREAM_TIMEOUT', message: 'slow' });

    expect(await registerAsset(SESSION, REGISTER, 'sub_abc', impl)).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
  });

  it('treats a 2xx it cannot read as unconfirmed rather than as success', async () => {
    const { impl } = recording(201, { unexpected: true });

    expect(await registerAsset(SESSION, REGISTER, 'sub_abc', impl)).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
  });
});

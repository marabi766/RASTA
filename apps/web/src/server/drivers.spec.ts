/**
 * @jest-environment node
 */
import {
  canManageDrivers,
  changeStatusFormValues,
  createDriverFormValues,
  CREATE_DRIVER_FIELD_MAPPING,
  fetchDriver,
  fetchDrivers,
  localDateFromIso,
  parseChangeStatusForm,
  parseCreateDriverForm,
  parseUpdateDriverForm,
  updateDriverFormValues,
  UPDATE_DRIVER_FIELD_MAPPING,
} from './drivers';
import { EMPTY_CREATE_DRIVER_FORM, EMPTY_UPDATE_DRIVER_FORM } from '@/lib/driver-fields';
import type { WebSession } from './session';

/**
 * Reading and parsing drivers.
 *
 * Mirrors `assets.spec.ts`/`maintenance.spec.ts` (PR #67, #73) for the reads
 * and `usage.spec.ts` for the write parsing — this module designs nothing
 * new, so its tests do not either.
 */

/**
 * U+202E RIGHT-TO-LEFT OVERRIDE, built from its code point rather than
 * written as a literal — the character is invisible, so a literal in source
 * would be exactly the kind of thing no diff or reviewer could see (same
 * reasoning as `format/codepoints.ts`).
 */
const RLO = String.fromCodePoint(0x202e);

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

const DRIVER = {
  id: 'DRV_1',
  organizationId: 'ORG_1',
  userId: 'USR_9',
  employeeNo: 'EMP-1',
  licenceNumber: 'LIC-1',
  licenceClass: 'B',
  licenceValidTo: '2027-01-01T00:00:00.000Z',
  status: 'ACTIVE',
  statusReason: null,
  notes: null,
  createdBy: 'USR_2',
  updatedBy: 'USR_2',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('reading a stored licence expiry back onto the edit form (L5-01)', () => {
  it('round-trips through Tehran midnight without moving the date back a day', () => {
    // The exact instant `localDateToIso` produces for `2027-01-01` in Tehran.
    // `.slice(0, 10)` on this string reads `2026-12-31` — the UTC calendar
    // day — which is the bug this function exists to not have.
    expect(localDateFromIso('2026-12-31T20:30:00.000Z')).toBe('2027-01-01');
  });

  it('agrees with a plain UTC slice whenever the instant is already Tehran midnight', () => {
    expect(localDateFromIso('2027-01-01T00:00:00.000Z')).toBe('2027-01-01');
  });
});

describe('who may manage drivers', () => {
  it('grants it to the roles fleet-service actually accepts on a write', () => {
    expect(canManageDrivers(['ORGANIZATION_ADMIN'])).toBe(true);
    expect(canManageDrivers(['FLEET_MANAGER'])).toBe(true);
    expect(canManageDrivers(['UNION_ADMIN'])).toBe(true);
    // One qualifying role among several is enough.
    expect(canManageDrivers(['DRIVER', 'FLEET_MANAGER'])).toBe(true);
  });

  it('refuses a driver or operator, who may only read', () => {
    expect(canManageDrivers(['DRIVER'])).toBe(false);
    expect(canManageDrivers(['OPERATOR'])).toBe(false);
    expect(canManageDrivers([])).toBe(false);
  });
});

describe('the list', () => {
  it('asks the gateway, with only the filters the caller set', async () => {
    const { impl, urls } = answering({ items: [DRIVER], nextCursor: null, hasMore: false });

    await withFetch(impl, async () => {
      await fetchDrivers(SESSION, { status: 'ACTIVE', q: 'EMP-1' });
    });

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/v1/drivers');
    expect(url.searchParams.get('status')).toBe('ACTIVE');
    expect(url.searchParams.get('q')).toBe('EMP-1');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('keeps the fields a row shows and drops the rest', async () => {
    const { impl } = answering({ items: [DRIVER], nextCursor: null, hasMore: false });
    const result = await withFetch(impl, () => fetchDrivers(SESSION));

    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.items[0]).toEqual({
      id: 'DRV_1',
      userId: 'USR_9',
      employeeNo: 'EMP-1',
      licenceNumber: 'LIC-1',
      licenceClass: 'B',
      licenceValidTo: '2027-01-01T00:00:00.000Z',
      status: 'ACTIVE',
    });
    expect(JSON.stringify(result.data)).not.toContain('createdBy');
    expect(JSON.stringify(result.data)).not.toContain('version');
  });

  it('accepts a status this portal has never heard of', async () => {
    const { impl } = answering({
      items: [{ ...DRIVER, status: 'ON_LEAVE' }],
      nextCursor: null,
      hasMore: false,
    });
    const result = await withFetch(impl, () => fetchDrivers(SESSION));
    expect(result.kind).toBe('OK');
    if (result.kind === 'OK') expect(result.data.items[0]!.status).toBe('ON_LEAVE');
  });
});

describe('how a refusal comes back', () => {
  it('separates "not yours" from "not here" from "broken"', async () => {
    const forbidden = answering({}, 403);
    expect((await withFetch(forbidden.impl, () => fetchDrivers(SESSION))).kind).toBe('FORBIDDEN');

    const missing = answering({}, 404);
    expect((await withFetch(missing.impl, () => fetchDriver(SESSION, 'DRV_X'))).kind).toBe(
      'NOT_FOUND',
    );

    const broken = answering({}, 503);
    const result = await withFetch(broken.impl, () => fetchDrivers(SESSION));
    expect(result.kind).toBe('UNAVAILABLE');
    if (result.kind === 'UNAVAILABLE') expect(result.status).toBe(503);
  });
});

describe('the detail', () => {
  it('encodes the id into the path rather than interpolating it', async () => {
    const { impl, urls } = answering(DRIVER);
    await withFetch(impl, () => fetchDriver(SESSION, 'DRV/../secret'));
    expect(new URL(urls[0]!).pathname).toBe('/v1/drivers/DRV%2F..%2Fsecret');
  });

  it('keeps the notes and status reason, drops the audit actors', async () => {
    const { impl } = answering({ ...DRIVER, statusReason: 'اعتراض' });
    const result = await withFetch(impl, () => fetchDriver(SESSION, 'DRV_1'));
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.statusReason).toBe('اعتراض');
    expect(JSON.stringify(result.data)).not.toContain('updatedBy');
  });
});

describe('registering a driver', () => {
  function values(overrides: Partial<typeof EMPTY_CREATE_DRIVER_FORM> = {}) {
    return {
      ...EMPTY_CREATE_DRIVER_FORM,
      userId: 'USR_01J00000000000000000000000',
      ...overrides,
    };
  }

  it('reads every field as a string and treats an absent one as empty', () => {
    const form = new FormData();
    form.set('userId', 'USR_1');
    form.set('employeeNo', 'EMP-1');
    expect(createDriverFormValues(form)).toEqual({
      ...EMPTY_CREATE_DRIVER_FORM,
      userId: 'USR_1',
      employeeNo: 'EMP-1',
    });
  });

  it('requires a user id', () => {
    const parsed = parseCreateDriverForm(values({ userId: '' }));
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { userId: 'شناسهٔ کاربر را وارد کنید' },
    });
  });

  it('refuses a user id that is not one', () => {
    const parsed = parseCreateDriverForm(values({ userId: 'not-a-user' }));
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { userId: 'شناسهٔ کاربر معتبر نیست' } });
  });

  it('omits an empty optional rather than sending an empty string', () => {
    const parsed = parseCreateDriverForm(values());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.employeeNo).toBeUndefined();
    expect(parsed.request.licenceValidTo).toBeUndefined();
  });

  it('reads a licence expiry as Tehran midnight, not UTC midnight', () => {
    // Midnight in Tehran on 1 January is still 31 December in UTC, which
    // would silently move the date the person picked back by one.
    const parsed = parseCreateDriverForm(values({ licenceValidTo: '2027-01-01' }));
    expect(parsed).toMatchObject({
      ok: true,
      request: { licenceValidTo: '2026-12-31T20:30:00.000Z' },
    });
  });

  it('names a path for every field the form posts', () => {
    for (const field of Object.keys(EMPTY_CREATE_DRIVER_FORM)) {
      expect(CREATE_DRIVER_FIELD_MAPPING.paths[field]).toBe(field);
    }
  });

  it('translates the duplicate-registration sentence fleet-service actually emits', () => {
    expect(CREATE_DRIVER_FIELD_MAPPING.messages?.['Driver already exists']).toBeDefined();
  });

  it('refuses a bidi control character hidden in an identifier field (L5-06)', () => {
    // RIGHT-TO-LEFT OVERRIDE, planted in the middle of an otherwise ordinary
    // employee number — fleet-service accepts it unchanged, and it can make
    // the value render as a different identifier than the one typed.
    const employeeNo = parseCreateDriverForm(values({ employeeNo: `EMP-${RLO}102` }));
    expect(employeeNo.ok).toBe(false);
    const licenceNumber = parseCreateDriverForm(values({ licenceNumber: `LIC-${RLO}102` }));
    expect(licenceNumber.ok).toBe(false);
    const licenceClass = parseCreateDriverForm(values({ licenceClass: `B${RLO}` }));
    expect(licenceClass.ok).toBe(false);
  });
});

describe('editing a driver', () => {
  it('reads every field as a string, defaulting an absent one to empty', () => {
    const form = new FormData();
    form.set('employeeNo', 'EMP-2');
    expect(updateDriverFormValues(form)).toEqual({
      ...EMPTY_UPDATE_DRIVER_FORM,
      employeeNo: 'EMP-2',
    });
  });

  it('sends null for a field left blank, never omits it', () => {
    // This form always shows the driver's current values, so a blank field
    // the person did not touch was already blank — omitting it would leave
    // fleet-service unable to tell "unchanged" from "cleared".
    const parsed = parseUpdateDriverForm(EMPTY_UPDATE_DRIVER_FORM);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request).toEqual({
      employeeNo: null,
      licenceNumber: null,
      licenceClass: null,
      licenceValidTo: null,
      notes: null,
    });
    for (const key of Object.keys(parsed.request)) {
      expect(key in parsed.request).toBe(true);
    }
  });

  it('sends the value the person typed for a field they filled in', () => {
    const parsed = parseUpdateDriverForm({
      ...EMPTY_UPDATE_DRIVER_FORM,
      employeeNo: 'EMP-3',
      licenceValidTo: '2027-06-01',
    });
    expect(parsed).toMatchObject({
      ok: true,
      request: { employeeNo: 'EMP-3', licenceValidTo: '2027-05-31T20:30:00.000Z' },
    });
  });

  it('names a path for every field the form posts', () => {
    for (const field of Object.keys(EMPTY_UPDATE_DRIVER_FORM)) {
      expect(UPDATE_DRIVER_FIELD_MAPPING.paths[field]).toBe(field);
    }
  });

  it('translates the optimistic-lock and terminal-status sentences driver.service.ts actually emits', () => {
    expect(
      UPDATE_DRIVER_FIELD_MAPPING.messages?.[
        'Driver was modified by another request; reload and retry'
      ],
    ).toBeDefined();
    expect(
      UPDATE_DRIVER_FIELD_MAPPING.messages?.[
        'A deactivated driver is a historical record and cannot be edited'
      ],
    ).toBeDefined();
  });

  it('refuses a bidi control character hidden in an identifier field (L5-06)', () => {
    const parsed = parseUpdateDriverForm({
      ...EMPTY_UPDATE_DRIVER_FORM,
      employeeNo: `EMP-${RLO}102`,
    });
    expect(parsed.ok).toBe(false);
  });
});

describe('changing status', () => {
  it('reads status and reason as strings', () => {
    const form = new FormData();
    form.set('status', 'SUSPENDED');
    form.set('reason', 'بازبینی مدارک');
    expect(changeStatusFormValues(form)).toEqual({ status: 'SUSPENDED', reason: 'بازبینی مدارک' });
  });

  it('requires a reason — AGENTS.md S-06', () => {
    const parsed = parseChangeStatusForm({ status: 'SUSPENDED', reason: '' });
    expect(parsed.ok).toBe(false);
  });

  it('requires a real status value', () => {
    const parsed = parseChangeStatusForm({ status: '', reason: 'بازبینی مدارک' });
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { status: 'وضعیت را انتخاب کنید' } });
  });

  it('parses a legal submission', () => {
    const parsed = parseChangeStatusForm({ status: 'SUSPENDED', reason: 'بازبینی مدارک' });
    expect(parsed).toMatchObject({
      ok: true,
      request: { status: 'SUSPENDED', reason: 'بازبینی مدارک' },
    });
  });
});

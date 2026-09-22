/**
 * @jest-environment node
 */
import {
  assignFormValues,
  ASSIGN_FIELD_MAPPING,
  endAssignmentFormValues,
  END_ASSIGNMENT_FIELD_MAPPING,
  fetchDriverAssignments,
  parseAssignForm,
  parseEndAssignmentForm,
} from './assignments';
import { EMPTY_ASSIGN_DRIVER_FORM, EMPTY_END_ASSIGNMENT_FORM } from '@/lib/driver-fields';
import type { WebSession } from './session';

/**
 * Reading a driver's assignments, and parsing the two forms that put a
 * driver on a machine or take them off it. Mirrors `drivers.spec.ts` for the
 * read and `usage.spec.ts` for the write parsing.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
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

const ASSIGNMENT = {
  id: 'ASG_1',
  organizationId: 'ORG_1',
  driverId: 'DRV_1',
  assetId: 'AST_1',
  active: true,
  startedAt: '2026-09-01T00:00:00.000Z',
  endedAt: null,
  purpose: null,
  endReason: null,
  endNotes: null,
  assignedBy: 'USR_2',
  endedBy: null,
};

describe('a driver assignment history', () => {
  it('reads via the driver-scoped endpoint, encoding the id', async () => {
    const { impl, urls } = answering({ items: [ASSIGNMENT], nextCursor: null, hasMore: false });
    await withFetch(impl, () => fetchDriverAssignments(SESSION, 'DRV/../secret'));
    expect(new URL(urls[0]!).pathname).toBe('/v1/drivers/DRV%2F..%2Fsecret/assignments');
  });

  it('keeps what the screen shows and drops the assignee', async () => {
    const { impl } = answering({ items: [ASSIGNMENT], nextCursor: null, hasMore: false });
    const result = await withFetch(impl, () => fetchDriverAssignments(SESSION, 'DRV_1'));
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.items[0]).toEqual({
      id: 'ASG_1',
      driverId: 'DRV_1',
      assetId: 'AST_1',
      active: true,
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: null,
      purpose: null,
      endReason: null,
      endNotes: null,
    });
    expect(JSON.stringify(result.data)).not.toContain('assignedBy');
  });

  it('separates a refusal from an absence', async () => {
    const forbidden = answering({}, 403);
    expect(
      (await withFetch(forbidden.impl, () => fetchDriverAssignments(SESSION, 'DRV_1'))).kind,
    ).toBe('FORBIDDEN');
  });
});

const DRIVER_ID = 'DRV_01J00000000000000000000000';

describe('assigning a driver to a machine', () => {
  function values(overrides: Partial<typeof EMPTY_ASSIGN_DRIVER_FORM> = {}) {
    return { ...EMPTY_ASSIGN_DRIVER_FORM, assetId: 'AST_01JASSET000000000000000000', ...overrides };
  }

  it('reads every field, defaulting an absent one to empty', () => {
    const form = new FormData();
    form.set('assetId', 'AST_1');
    expect(assignFormValues(form)).toEqual({ ...EMPTY_ASSIGN_DRIVER_FORM, assetId: 'AST_1' });
  });

  it('builds the request with the bound driver id, not a form field', () => {
    const parsed = parseAssignForm(values(), DRIVER_ID);
    expect(parsed).toMatchObject({
      ok: true,
      request: { driverId: DRIVER_ID, assetId: values().assetId },
    });
  });

  it('omits a blank start time rather than sending one the service must parse', () => {
    const parsed = parseAssignForm(values({ startedAt: '' }), DRIVER_ID);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.startedAt).toBeUndefined();
  });

  it('reads a filled start time as Tehran wall-clock time', () => {
    const parsed = parseAssignForm(values({ startedAt: '2026-09-21T08:00' }), DRIVER_ID);
    expect(parsed).toMatchObject({ ok: true, request: { startedAt: '2026-09-21T04:30:00.000Z' } });
  });

  it('refuses an asset id that is not one', () => {
    const parsed = parseAssignForm(values({ assetId: 'not-an-asset' }), DRIVER_ID);
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { assetId: 'شناسهٔ ماشین معتبر نیست' },
    });
  });

  it('names a path for every field the form posts, but not the bound driver id', () => {
    for (const field of Object.keys(EMPTY_ASSIGN_DRIVER_FORM)) {
      expect(ASSIGN_FIELD_MAPPING.paths[field]).toBe(field);
    }
    expect(ASSIGN_FIELD_MAPPING.paths.driverId).toBeUndefined();
  });

  it('translates the exclusivity sentences assignment.service.ts actually emits', () => {
    expect(
      ASSIGN_FIELD_MAPPING.messages?.[
        'This driver already holds an active assignment. End it before starting another.'
      ],
    ).toBeDefined();
    expect(
      ASSIGN_FIELD_MAPPING.messages?.[
        'This machine is already assigned to a driver. End that assignment first.'
      ],
    ).toBeDefined();
  });
});

describe('ending an assignment', () => {
  it('reads reason and notes, defaulting reason to COMPLETED', () => {
    const form = new FormData();
    form.set('notes', 'بازگشت به پارکینگ');
    expect(endAssignmentFormValues(form)).toEqual({
      ...EMPTY_END_ASSIGNMENT_FORM,
      notes: 'بازگشت به پارکینگ',
    });
  });

  it('parses the default reason with no notes', () => {
    const parsed = parseEndAssignmentForm(EMPTY_END_ASSIGNMENT_FORM);
    expect(parsed).toMatchObject({ ok: true, request: { reason: 'COMPLETED' } });
  });

  it('falls back to COMPLETED for a reason this portal does not offer, rather than refusing', () => {
    const parsed = parseEndAssignmentForm({ ...EMPTY_END_ASSIGNMENT_FORM, reason: 'MADE_UP' });
    expect(parsed).toMatchObject({ ok: true, request: { reason: 'COMPLETED' } });
  });

  it('names a path for every field the form posts', () => {
    for (const field of Object.keys(EMPTY_END_ASSIGNMENT_FORM)) {
      expect(END_ASSIGNMENT_FIELD_MAPPING.paths[field]).toBe(field);
    }
  });

  it('translates the already-ended sentences assignment.service.ts actually emits', () => {
    expect(
      END_ASSIGNMENT_FIELD_MAPPING.messages?.['This assignment has already ended'],
    ).toBeDefined();
    expect(
      END_ASSIGNMENT_FIELD_MAPPING.messages?.['This assignment was ended by another request'],
    ).toBeDefined();
  });
});

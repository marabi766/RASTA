/**
 * @jest-environment node
 */
import {
  fetchOrganization,
  parseUpdateOrganizationForm,
  updateOrganization,
  updateOrganizationFormValues,
} from './organizations';
import type { WebSession } from './session';

/**
 * Reading one organization and editing its profile.
 *
 * The case worth protecting here is the nullable pair: `shortName` and
 * `externalCode` are nullable on organization-service, so an emptied field
 * has to arrive as `null` — "clear it" — and not as `""`, which the service
 * would store as an empty string, nor be dropped, which would leave the old
 * value in place while the form showed it gone.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'admin',
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
  const seen: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, seen };
}

const ORGANIZATION = {
  id: 'ORG_1',
  name: 'دهیاری نمونه',
  shortName: 'نمونه',
  externalCode: 'DEH-001',
  type: 'DEHYARI',
  status: 'ACTIVE',
  parentId: null,
  path: null,
  depth: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('fetchOrganization', () => {
  it('reads one organization by id', async () => {
    const { impl, seen } = answering(ORGANIZATION);
    const result = await withFetch(impl, () => fetchOrganization(SESSION, 'ORG_1'));

    expect(result).toMatchObject({ kind: 'OK', data: { name: 'دهیاری نمونه' } });
    expect(seen[0]!.url).toContain('/v1/organizations/ORG_1');
  });

  it('drops metadata rather than carrying it into the page', async () => {
    // Free-form and unrendered, and a React tree is serialized into the page
    // (`docs/07` § 7.3).
    const { impl } = answering({ ...ORGANIZATION, metadata: { secret: 'value' } });
    const result = await withFetch(impl, () => fetchOrganization(SESSION, 'ORG_1'));

    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('renders a refusal and an absence as different outcomes', async () => {
    const forbidden = answering({}, 403);
    await expect(
      withFetch(forbidden.impl, () => fetchOrganization(SESSION, 'ORG_1')),
    ).resolves.toEqual({ kind: 'FORBIDDEN' });

    const missing = answering({}, 404);
    await expect(
      withFetch(missing.impl, () => fetchOrganization(SESSION, 'ORG_9')),
    ).resolves.toEqual({ kind: 'NOT_FOUND' });
  });
});

describe('parseUpdateOrganizationForm', () => {
  it('accepts a complete form', () => {
    expect(
      parseUpdateOrganizationForm({ name: 'نام تازه', shortName: 'کوتاه', externalCode: 'X-1' }),
    ).toMatchObject({ ok: true, request: { name: 'نام تازه', shortName: 'کوتاه' } });
  });

  it('sends an emptied nullable field as null, which means clear it', () => {
    const parsed = parseUpdateOrganizationForm({
      name: 'نام تازه',
      shortName: '',
      externalCode: '',
    });

    expect(parsed).toMatchObject({
      ok: true,
      request: { shortName: null, externalCode: null },
    });
  });

  it('refuses an emptied name, which has no null to mean anything', () => {
    const parsed = parseUpdateOrganizationForm({ name: '', shortName: '', externalCode: '' });
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { name: 'نام سازمان را وارد کنید' },
    });
  });
});

describe('updateOrganization', () => {
  it('sends a PATCH, because this is an edit and not a create', async () => {
    const { impl, seen } = answering({ id: 'ORG_1' });

    await withFetch(impl, () =>
      updateOrganization(
        SESSION,
        'ORG_1',
        { name: 'نام تازه', shortName: null, externalCode: null },
        'sub_aaaaaaaaaaaaaaaaaaaa',
      ),
    );

    expect(seen[0]!.method).toBe('PATCH');
    expect(seen[0]!.url).toContain('/v1/organizations/ORG_1');
    expect(seen[0]!.body).toEqual({ name: 'نام تازه', shortName: null, externalCode: null });
  });

  it('maps a service field error back onto the field that caused it', async () => {
    const { impl } = answering(
      {
        code: 'VALIDATION_ERROR',
        message: 'invalid',
        details: [{ path: 'name', message: 'نام تکراری است' }],
      },
      422,
    );

    const result = await withFetch(impl, () =>
      updateOrganization(
        SESSION,
        'ORG_1',
        { name: 'تکراری', shortName: null, externalCode: null },
        'sub_aaaaaaaaaaaaaaaaaaaa',
      ),
    );

    expect(result).toMatchObject({ kind: 'INVALID', fieldErrors: { name: 'نام تکراری است' } });
  });
});

describe('updateOrganizationFormValues', () => {
  it('reads the three fields the service accepts and nothing else', () => {
    const form = new FormData();
    form.set('name', ' نام ');
    form.set('shortName', 'کوتاه');
    form.set('externalCode', 'X-1');
    form.set('status', 'SUSPENDED');

    const values = updateOrganizationFormValues(form);

    expect(values).toEqual({ name: 'نام', shortName: 'کوتاه', externalCode: 'X-1' });
    expect(values).not.toHaveProperty('status');
  });
});

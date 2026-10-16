/**
 * @jest-environment node
 */
import { fetchSupplier, fetchSuppliers } from './suppliers';
import type { WebSession } from './session';

/**
 * Reading suppliers. The cases that would be silent if wrong: an actor id or
 * a raw evidence document id reaching the page, a malformed timestamp
 * crashing the render instead of answering `MALFORMED`, and a 404 (another
 * tenant's supplier) told apart from a refusal.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'owner',
  organizationId: 'ORG_OWNER',
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

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const SUPPLIER_SUMMARY = {
  id: 'SUP_1',
  organizationId: 'ORG_OWNER',
  displayName: 'تعمیرگاه البرز',
  status: 'ACTIVE',
  capabilities: ['WORKSHOP_SERVICE'],
  qualifiedFor: ['WORKSHOP_SERVICE'],
  registeredAt: '2026-08-01T08:00:00.000Z',
};

const SUPPLIER_DETAIL = {
  ...SUPPLIER_SUMMARY,
  registeredBy: 'USR_ACTOR_SECRET',
  qualifications: [
    {
      id: 'QUAL_1',
      capability: 'WORKSHOP_SERVICE',
      state: 'APPROVED',
      statement: 'مجهز به دستگاه بالانس',
      submittedBy: 'USR_ACTOR_SECRET',
      submittedAt: '2026-08-02T08:00:00.000Z',
      decidedBy: 'USR_ACTOR_SECRET',
      decidedAt: '2026-08-03T08:00:00.000Z',
      decisionNote: 'مستندات کامل بود',
      evidence: [{ documentId: 'DOC_ACTOR_SECRET', label: 'مجوز' }],
      current: true,
    },
  ],
  suspensions: [
    {
      id: 'SUS_1',
      reason: 'شکایت تکراری مشتریان',
      suspendedBy: 'USR_ACTOR_SECRET',
      suspendedAt: '2026-09-01T08:00:00.000Z',
      reinstatedBy: null,
      reinstatedAt: null,
      reinstatementNote: null,
      open: true,
    },
  ],
};

describe('reading suppliers', () => {
  it('reads the directory with a page size and the filters that were set, and only those', async () => {
    const { impl, urls } = answering({
      items: [SUPPLIER_SUMMARY],
      nextCursor: 'c2',
      hasMore: true,
    });
    const result = await withFetch(impl, () =>
      fetchSuppliers(SESSION, { status: 'ACTIVE', capability: 'WORKSHOP_SERVICE', cursor: 'c1' }),
    );

    expect(urls[0]).toBe(
      'http://gateway.test:3000/v1/suppliers?limit=20&status=ACTIVE&capability=WORKSHOP_SERVICE&cursor=c1',
    );
    expect(result.kind === 'OK' && result.data.nextCursor).toBe('c2');

    const bare = answering({ items: [], nextCursor: null, hasMore: false });
    await withFetch(bare.impl, () => fetchSuppliers(SESSION));
    expect(bare.urls[0]).toBe('http://gateway.test:3000/v1/suppliers?limit=20');
  });

  it('encodes the id into the detail path', async () => {
    const { impl, urls } = answering(SUPPLIER_DETAIL);
    await withFetch(impl, () => fetchSupplier(SESSION, '../x?y'));
    expect(urls[0]).toBe('http://gateway.test:3000/v1/suppliers/..%2Fx%3Fy');
  });

  it('never lets an actor id or a raw evidence document id into what the screen receives', async () => {
    const { impl } = answering(SUPPLIER_DETAIL);
    const result = await withFetch(impl, () => fetchSupplier(SESSION, 'SUP_1'));

    expect(result.kind).toBe('OK');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('USR_ACTOR_SECRET');
    expect(serialized).not.toContain('DOC_ACTOR_SECRET');
    expect(result.kind === 'OK' && result.data.qualifications[0]?.evidenceCount).toBe(1);
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [503, 'UNAVAILABLE'],
  ])('maps a %i from the service to %s', async (status, kind) => {
    const { impl } = answering(
      { code: 'X', message: 'raw service text', correlationId: 'c' },
      status,
    );
    const result = await withFetch(impl, () => fetchSupplier(SESSION, 'SUP_1'));
    expect(result.kind).toBe(kind);
    // No raw service text is carried into the result.
    expect(JSON.stringify(result)).not.toContain('raw service text');
  });

  describe('timestamps', () => {
    const BAD_INSTANTS = ['UPSTREAM_INVALID_TIMESTAMP', '', '2026-09-20', '2026-09-20T08:00:00'];

    it.each(BAD_INSTANTS)('refuses %j as a list registeredAt', async (bad) => {
      const { impl } = answering({ items: [{ ...SUPPLIER_SUMMARY, registeredAt: bad }] });
      const result = await withFetch(impl, () => fetchSuppliers(SESSION));
      expect(result.kind).toBe('MALFORMED');
      expect(JSON.stringify(result)).not.toContain('UPSTREAM_INVALID');
    });

    it.each(['submittedAt', 'decidedAt'] as const)(
      'refuses a malformed qualification %s on the detail',
      async (field) => {
        const bad = answering({
          ...SUPPLIER_DETAIL,
          qualifications: [{ ...SUPPLIER_DETAIL.qualifications[0], [field]: 'not a date' }],
        });
        expect((await withFetch(bad.impl, () => fetchSupplier(SESSION, 'SUP_1'))).kind).toBe(
          'MALFORMED',
        );
      },
    );

    it('accepts a UTC instant with or without an offset', async () => {
      const { impl } = answering({
        items: [
          { ...SUPPLIER_SUMMARY, registeredAt: '2026-08-01T08:00:00Z' },
          { ...SUPPLIER_SUMMARY, registeredAt: '2026-08-01T11:30:00+03:30' },
        ],
      });
      const result = await withFetch(impl, () => fetchSuppliers(SESSION));
      expect(result.kind).toBe('OK');
    });

    it('does not read a field the list never renders', async () => {
      const { impl } = answering({
        items: [{ ...SUPPLIER_SUMMARY, registeredBy: 'not rendered' }],
      });
      const result = await withFetch(impl, () => fetchSuppliers(SESSION));
      expect(result.kind).toBe('OK');
      expect(JSON.stringify(result)).not.toContain('registeredBy');
    });
  });

  it('treats a body that does not match the schema as malformed', async () => {
    const { impl } = answering({ items: 'nope' });
    const result = await withFetch(impl, () => fetchSuppliers(SESSION));
    expect(result.kind).toBe('MALFORMED');
  });
});

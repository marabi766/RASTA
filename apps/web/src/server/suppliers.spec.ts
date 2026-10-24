/**
 * @jest-environment node
 */
import { fetchSupplier, fetchSuppliers } from './suppliers';
import type { WebSession } from './session';

/**
 * Reading suppliers. The cases that would be silent if wrong: an actor id or
 * an evidence entry without its id, a malformed timestamp
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
      rejectionReason: null,
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

const pageOf = (items: unknown[]) => ({ items, nextCursor: null, hasMore: false });

function omit<T extends object>(value: T, field: keyof T): unknown {
  const copy: Partial<T> = { ...value };
  delete copy[field];
  return copy;
}

const QUALIFICATION = SUPPLIER_DETAIL.qualifications[0]!;
const SUSPENSION = SUPPLIER_DETAIL.suspensions[0]!;

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

  it('never lets an actor id into what the screen receives, and keeps evidence as the API returns it', async () => {
    const { impl } = answering(SUPPLIER_DETAIL);
    const result = await withFetch(impl, () => fetchSupplier(SESSION, 'SUP_1'));

    expect(result.kind).toBe('OK');
    expect(JSON.stringify(result)).not.toContain('USR_ACTOR_SECRET');
    // By id and label only: the portal never fetches or resolves a document.
    expect(result.kind === 'OK' && result.data.qualifications[0]?.evidence).toEqual([
      { documentId: 'DOC_ACTOR_SECRET', label: 'مجوز' },
    ]);
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
      const { impl } = answering(pageOf([{ ...SUPPLIER_SUMMARY, registeredAt: bad }]));
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
      const { impl } = answering(
        pageOf([
          { ...SUPPLIER_SUMMARY, registeredAt: '2026-08-01T08:00:00Z' },
          { ...SUPPLIER_SUMMARY, registeredAt: '2026-08-01T11:30:00+03:30' },
        ]),
      );
      const result = await withFetch(impl, () => fetchSuppliers(SESSION));
      expect(result.kind).toBe('OK');
    });

    it('does not read a field the list never renders', async () => {
      const { impl } = answering(pageOf([{ ...SUPPLIER_SUMMARY, registeredBy: 'not rendered' }]));
      const result = await withFetch(impl, () => fetchSuppliers(SESSION));
      expect(result.kind).toBe('OK');
      expect(JSON.stringify(result)).not.toContain('registeredBy');
    });
  });

  it('treats a body that does not match the schema as malformed', async () => {
    const { impl } = answering({ items: 'nope', nextCursor: null, hasMore: false });
    const result = await withFetch(impl, () => fetchSuppliers(SESSION));
    expect(result.kind).toBe('MALFORMED');
  });
});

/**
 * Distinct from an invalid value: a field supplier-service's response schema
 * requires (`supplier/dto.ts`, `openapi/document.ts`) that is simply absent.
 * None may default into a fact — "never suspended", "closed", "not currently
 * valid", "no documents", "end of the directory" — so each omission is
 * `MALFORMED`, never `OK`.
 */
describe('a response missing a required field, not merely an invalid one', () => {
  async function detailWith(body: unknown) {
    const { impl } = answering(body);
    return withFetch(impl, () => fetchSupplier(SESSION, 'SUP_1'));
  }

  it.each(['items', 'nextCursor', 'hasMore'] as const)(
    'reads a directory page missing %s as MALFORMED',
    async (field) => {
      const { impl } = answering(omit(pageOf([SUPPLIER_SUMMARY]), field));
      expect((await withFetch(impl, () => fetchSuppliers(SESSION))).kind).toBe('MALFORMED');
    },
  );

  it.each(Object.keys(SUPPLIER_SUMMARY) as (keyof typeof SUPPLIER_SUMMARY)[])(
    'reads a directory entry missing %s as MALFORMED',
    async (field) => {
      const { impl } = answering(pageOf([omit(SUPPLIER_SUMMARY, field)]));
      expect((await withFetch(impl, () => fetchSuppliers(SESSION))).kind).toBe('MALFORMED');
    },
  );

  it.each<keyof typeof SUPPLIER_DETAIL>([
    ...(Object.keys(SUPPLIER_SUMMARY) as (keyof typeof SUPPLIER_SUMMARY)[]),
    'qualifications',
    'suspensions',
  ])('reads a detail missing %s as MALFORMED', async (field) => {
    expect((await detailWith(omit(SUPPLIER_DETAIL, field))).kind).toBe('MALFORMED');
  });

  it.each([
    'id',
    'capability',
    'state',
    'statement',
    'submittedAt',
    'decidedAt',
    'rejectionReason',
    'evidence',
    'current',
  ] as const)('reads a qualification missing %s as MALFORMED', async (field) => {
    expect(
      (await detailWith({ ...SUPPLIER_DETAIL, qualifications: [omit(QUALIFICATION, field)] })).kind,
    ).toBe('MALFORMED');
  });

  it.each(['id', 'reason', 'suspendedAt', 'reinstatedAt', 'reinstatementNote', 'open'] as const)(
    'reads a suspension missing %s as MALFORMED',
    async (field) => {
      expect(
        (await detailWith({ ...SUPPLIER_DETAIL, suspensions: [omit(SUSPENSION, field)] })).kind,
      ).toBe('MALFORMED');
    },
  );

  it('reads a qualification with no decisionNote key — the supplier’s own reading — and keeps the reason', async () => {
    // supplier-service leaves the reviewer's note out for everyone but a
    // reviewer (Codex review of PR 366, finding 1); absent is not malformed.
    const result = await detailWith({
      ...SUPPLIER_DETAIL,
      qualifications: [
        {
          ...(omit(QUALIFICATION, 'decisionNote') as object),
          state: 'REJECTED',
          rejectionReason: 'پروانه منقضی شده است',
        },
      ],
    });

    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.qualifications[0]).not.toHaveProperty('decisionNote');
    expect(result.data.qualifications[0]!.rejectionReason).toBe('پروانه منقضی شده است');
  });

  it('keeps an explicit [], false and null as the facts they are', async () => {
    const result = await detailWith({
      ...SUPPLIER_DETAIL,
      capabilities: [],
      qualifiedFor: [],
      qualifications: [
        {
          ...QUALIFICATION,
          state: 'SUBMITTED',
          statement: null,
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
          evidence: [],
          current: false,
        },
      ],
      suspensions: [
        { ...SUSPENSION, reinstatedBy: null, reinstatedAt: null, reinstatementNote: null },
        {
          ...SUSPENSION,
          id: 'SUS_0',
          open: false,
          reinstatedAt: '2026-08-20T08:00:00.000Z',
          reinstatementNote: 'رفع شد',
        },
      ],
    });

    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.qualifiedFor).toEqual([]);
    expect(result.data.qualifications[0]).toMatchObject({
      statement: null,
      decidedAt: null,
      decisionNote: null,
      evidence: [],
      evidenceCount: 0,
      current: false,
    });
    expect(result.data.suspensions.map((s) => s.open)).toEqual([true, false]);

    const empty = await detailWith({ ...SUPPLIER_DETAIL, qualifications: [], suspensions: [] });
    expect(empty.kind === 'OK' && empty.data.suspensions).toEqual([]);

    const { impl } = answering({ items: [], nextCursor: null, hasMore: false });
    const page = await withFetch(impl, () => fetchSuppliers(SESSION));
    expect(page).toEqual({ kind: 'OK', data: { items: [], nextCursor: null, hasMore: false } });
  });
});

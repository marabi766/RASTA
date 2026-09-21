/**
 * @jest-environment node
 */
import { fetchAssets, fetchDossier } from './assets';
import type { WebSession } from './session';

/**
 * What the portal asks the gateway for, and what it keeps from the answer.
 *
 * The keeping is the part worth testing. asset-service's dossier carries
 * coordinates, document references and raw specification blobs; none of it is
 * declared here, so none of it survives parsing — and what does not survive
 * parsing cannot reach a React tree, which is serialized into the page.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'dehyar',
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

const ASSET = {
  id: 'AST_1',
  organizationId: 'ORG_1',
  assetTag: '۱۲ ب ۳۴۵ ایران ۵۶',
  name: 'لودر',
  type: 'HEAVY_MACHINERY',
  status: 'ACTIVE',
  manufacturer: 'کوماتسو',
  model: 'WA320',
  serialNumber: 'SER-0001',
  manufactureYear: 2018,
  commissionedAt: '2026-01-01T00:00:00.000Z',
  decommissionedAt: null,
  specifications: { engineHours: 4380 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('the list', () => {
  it('asks the gateway, with only the filters the caller set', async () => {
    const { impl, urls } = answering({ items: [ASSET], nextCursor: null, hasMore: false });

    await withFetch(impl, async () => {
      await fetchAssets(SESSION, { status: 'ACTIVE', q: 'لودر' });
    });

    const url = new URL(urls[0]!);
    expect(url.origin).toBe('http://gateway.test:3000');
    expect(url.pathname).toBe('/v1/assets');
    expect(url.searchParams.get('status')).toBe('ACTIVE');
    expect(url.searchParams.get('q')).toBe('لودر');
    expect(url.searchParams.get('limit')).toBe('20');
    // An empty filter is a filter nobody asked for, and the service refuses
    // an empty `q`.
    expect(url.searchParams.has('type')).toBe(false);
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('keeps the fields a row shows and drops the rest', async () => {
    const { impl } = answering({ items: [ASSET], nextCursor: 'CUR_1', hasMore: true });

    const result = await withFetch(impl, () => fetchAssets(SESSION));

    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.items[0]).toEqual({
      id: 'AST_1',
      assetTag: '۱۲ ب ۳۴۵ ایران ۵۶',
      name: 'لودر',
      type: 'HEAVY_MACHINERY',
      status: 'ACTIVE',
      manufacturer: 'کوماتسو',
      model: 'WA320',
      manufactureYear: 2018,
      commissionedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(result.data)).not.toContain('SER-0001');
    expect(JSON.stringify(result.data)).not.toContain('engineHours');
    expect(result.data.nextCursor).toBe('CUR_1');
  });

  it('accepts a status this portal has never heard of', async () => {
    // A value the portal does not know means the service moved ahead of it.
    // Refusing the whole page over one unknown word would be worse than
    // showing the word.
    const { impl } = answering({
      items: [{ ...ASSET, status: 'IMPOUNDED' }],
      nextCursor: null,
      hasMore: false,
    });

    const result = await withFetch(impl, () => fetchAssets(SESSION));
    expect(result.kind).toBe('OK');
    if (result.kind === 'OK') expect(result.data.items[0]!.status).toBe('IMPOUNDED');
  });
});

describe('how a refusal comes back', () => {
  it('separates "not yours" from "not here" from "broken"', async () => {
    // Three different sentences to a person, so three different outcomes.
    const forbidden = answering({}, 403);
    expect((await withFetch(forbidden.impl, () => fetchAssets(SESSION))).kind).toBe('FORBIDDEN');

    const missing = answering({}, 404);
    expect((await withFetch(missing.impl, () => fetchDossier(SESSION, 'AST_X'))).kind).toBe(
      'NOT_FOUND',
    );

    const broken = answering({}, 503);
    const result = await withFetch(broken.impl, () => fetchAssets(SESSION));
    expect(result.kind).toBe('UNAVAILABLE');
    if (result.kind === 'UNAVAILABLE') expect(result.status).toBe(503);
  });

  it('refuses an answer that does not match the contract', async () => {
    const { impl } = answering({ items: [{ id: 'AST_1' }], hasMore: false });
    expect((await withFetch(impl, () => fetchAssets(SESSION))).kind).toBe('MALFORMED');
  });
});

describe('the dossier', () => {
  const DOSSIER = {
    asset: ASSET,
    organizationName: 'دهیاری نمونه',
    currentLocation: { id: 'LOC_1', coordinate: { lat: 35.7, lon: 51.4 } },
    compliance: {
      operable: false,
      blockers: ['INSURANCE_EXPIRED', 'INSPECTION_EXPIRED'],
      activeInsurance: null,
      latestInspection: {
        id: 'INS_1',
        certificateNo: 'C-1',
        centerName: 'مرکز نمونه',
        inspectedAt: '2025-01-01T00:00:00.000Z',
        validTo: '2026-01-01T00:00:00.000Z',
        result: 'PASSED',
        notes: null,
        daysUntilExpiry: -30,
      },
    },
    costs: {
      totalMinor: '120000000',
      maintenanceMinor: '90000000',
      partsAndOrdersMinor: '30000000',
      entryCount: 7,
    },
    documents: [{ id: 'DOC_1', documentId: 'DCM_1', kind: 'PHOTO', title: 'عکس' }],
    recentActivity: [
      {
        id: 'TL_1',
        eventName: 'MAINTENANCE_COMPLETED',
        sourceService: 'maintenance-service',
        category: 'MAINTENANCE',
        title: 'سرویس دوره‌ای',
        description: null,
        amountMinor: '90000000',
        detail: { workOrderId: 'WO_1' },
        occurredAt: '2026-02-01T00:00:00.000Z',
      },
    ],
    transferCount: 2,
  };

  it('encodes the id into the path rather than interpolating it', async () => {
    const { impl, urls } = answering(DOSSIER);
    await withFetch(impl, () => fetchDossier(SESSION, 'AST/../secret'));
    // An id with a slash would otherwise address a different endpoint.
    expect(new URL(urls[0]!).pathname).toBe('/v1/assets/AST%2F..%2Fsecret/dossier');
  });

  it('keeps every blocker, not only the first', async () => {
    // An operator who clears one blocker should not have to discover the next
    // by trying again.
    const { impl } = answering(DOSSIER);
    const result = await withFetch(impl, () => fetchDossier(SESSION, 'AST_1'));
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.compliance.blockers).toEqual(['INSURANCE_EXPIRED', 'INSPECTION_EXPIRED']);
  });

  it('drops the coordinate, the documents and the event detail', async () => {
    const { impl } = answering(DOSSIER);
    const result = await withFetch(impl, () => fetchDossier(SESSION, 'AST_1'));
    if (result.kind !== 'OK') throw new Error('expected a dossier');

    const serialised = JSON.stringify(result.data);
    expect(serialised).not.toContain('51.4');
    expect(serialised).not.toContain('DCM_1');
    expect(serialised).not.toContain('workOrderId');
    // And keeps what the screen actually renders.
    expect(result.data.costs.totalMinor).toBe('120000000');
    expect(result.data.recentActivity[0]!.title).toBe('سرویس دوره‌ای');
  });

  it('keeps money as a string', async () => {
    // A rial total does not survive a JSON number (ADR-022).
    const { impl } = answering(DOSSIER);
    const result = await withFetch(impl, () => fetchDossier(SESSION, 'AST_1'));
    if (result.kind !== 'OK') throw new Error('expected a dossier');
    expect(typeof result.data.costs.totalMinor).toBe('string');
    expect(typeof result.data.recentActivity[0]!.amountMinor).toBe('string');
  });
});

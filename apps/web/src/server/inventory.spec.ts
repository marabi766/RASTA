/**
 * @jest-environment node
 */
import { fetchStock, fetchWarehouse, fetchWarehouses } from './inventory';
import type { WebSession } from './session';

/**
 * Reading warehouses and stock. The cases that would be silent if wrong: a
 * quantity that is not a whole number within the stored range rendering anyway,
 * a malformed timestamp reaching the page, coordinates or actor data traveling
 * with the render, and a 404 (another tenant's warehouse) told apart from an
 * outage.
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

const WAREHOUSE_ID = 'WHS_01HZZZZZZZZZZZZZZZZZZZZZZZ';

const WAREHOUSE = {
  id: WAREHOUSE_ID,
  organizationId: 'ORG_SECRET',
  name: 'انبار مرکزی',
  location: { latitude: 35.7, longitude: 51.4 },
  status: 'ACTIVE',
  createdAt: '2026-09-19T08:00:00.000Z',
  updatedAt: '2026-09-20T08:00:00.000Z',
  version: 3,
};

const STOCK_ITEM = {
  id: 'SKI_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  organizationId: 'ORG_SECRET',
  warehouseId: WAREHOUSE_ID,
  productId: 'PRD_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  onHandQuantity: 120,
  reservedQuantity: 20,
  availableQuantity: 100,
  version: 7,
  createdAt: '2026-09-19T08:00:00.000Z',
  updatedAt: '2026-09-20T08:00:00.000Z',
};

const page = (items: unknown[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
  hasMore: nextCursor !== null,
});

describe('reading warehouses', () => {
  it('asks for a page of the caller’s warehouses and follows the cursor', async () => {
    const { impl, urls } = answering(page([WAREHOUSE], 'WHS_NEXT'));
    const result = await withFetch(impl, () => fetchWarehouses(SESSION, 'WHS_PREV'));

    expect(urls[0]).toBe('http://gateway.test:3000/v1/warehouses?limit=20&cursor=WHS_PREV');
    expect(result.kind === 'OK' && result.data.nextCursor).toBe('WHS_NEXT');

    const bare = answering(page([]));
    await withFetch(bare.impl, () => fetchWarehouses(SESSION));
    expect(bare.urls[0]).toBe('http://gateway.test:3000/v1/warehouses?limit=20');
  });

  it('keeps only what is rendered: no coordinates, organization id or version', async () => {
    const { impl } = answering(page([WAREHOUSE]));
    const result = await withFetch(impl, () => fetchWarehouses(SESSION));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ORG_SECRET');
    expect(serialized).not.toContain('latitude');
    expect(serialized).not.toContain('version');
    expect(result.kind === 'OK' && result.data.items[0]?.name).toBe('انبار مرکزی');
  });

  it('encodes the id into the path', async () => {
    const { impl, urls } = answering(WAREHOUSE);
    await withFetch(impl, () => fetchWarehouse(SESSION, '../x?y'));
    expect(urls[0]).toBe('http://gateway.test:3000/v1/warehouses/..%2Fx%3Fy');
  });

  it.each(['createdAt'] as const)('refuses a malformed or missing %s', async (field) => {
    for (const bad of ['UPSTREAM_INVALID_TIMESTAMP', '', '2026-09-20', '2026-09-20T08:00:00']) {
      const { impl } = answering(page([{ ...WAREHOUSE, [field]: bad }]));
      const result = await withFetch(impl, () => fetchWarehouses(SESSION));
      expect(result.kind).toBe('MALFORMED');
      expect(JSON.stringify(result)).not.toContain('UPSTREAM_INVALID');
    }
    const without = Object.fromEntries(Object.entries(WAREHOUSE).filter(([k]) => k !== field));
    const missing = answering(page([without]));
    expect((await withFetch(missing.impl, () => fetchWarehouses(SESSION))).kind).toBe('MALFORMED');
  });

  it('refuses a warehouse without a name', async () => {
    const { impl } = answering(page([{ ...WAREHOUSE, name: 7 }]));
    expect((await withFetch(impl, () => fetchWarehouses(SESSION))).kind).toBe('MALFORMED');
  });
});

describe('reading stock', () => {
  it('asks for one warehouse’s items, with the cursor when there is one', async () => {
    const { impl, urls } = answering(page([STOCK_ITEM], 'SKI_NEXT'));
    const result = await withFetch(impl, () => fetchStock(SESSION, WAREHOUSE_ID, 'SKI_PREV'));

    expect(urls[0]).toBe(
      `http://gateway.test:3000/v1/stock?limit=20&warehouseId=${WAREHOUSE_ID}&cursor=SKI_PREV`,
    );
    expect(result.kind === 'OK' && result.data.nextCursor).toBe('SKI_NEXT');
  });

  it('keeps the service’s three figures as they arrived, without recomputing available', async () => {
    // available ≠ on hand − reserved on purpose: the portal shows the service's figure.
    const odd = { ...STOCK_ITEM, onHandQuantity: 10, reservedQuantity: 4, availableQuantity: 5 };
    const { impl } = answering(page([odd]));
    const result = await withFetch(impl, () => fetchStock(SESSION, WAREHOUSE_ID));

    expect(result.kind === 'OK' && result.data.items[0]).toMatchObject({
      onHandQuantity: 10,
      reservedQuantity: 4,
      availableQuantity: 5,
    });
  });

  it('keeps only what is rendered: no organization id, version or creation time', async () => {
    const { impl } = answering(page([STOCK_ITEM]));
    const result = await withFetch(impl, () => fetchStock(SESSION, WAREHOUSE_ID));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ORG_SECRET');
    expect(serialized).not.toContain('"version"');
    expect(serialized).not.toContain('createdAt');
  });

  it.each(['onHandQuantity', 'reservedQuantity', 'availableQuantity'] as const)(
    'refuses %s that is not a whole non-negative number within the stored range',
    async (field) => {
      for (const bad of [1.5, -1, 2_147_483_648, '12', null, Number.NaN]) {
        const { impl } = answering(page([{ ...STOCK_ITEM, [field]: bad }]));
        const result = await withFetch(impl, () => fetchStock(SESSION, WAREHOUSE_ID));
        expect(result.kind).toBe('MALFORMED');
      }
      const without = Object.fromEntries(Object.entries(STOCK_ITEM).filter(([k]) => k !== field));
      const missing = answering(page([without]));
      expect((await withFetch(missing.impl, () => fetchStock(SESSION, WAREHOUSE_ID))).kind).toBe(
        'MALFORMED',
      );
    },
  );

  it('accepts the largest stored quantity and zero', async () => {
    const edge = {
      ...STOCK_ITEM,
      onHandQuantity: 2_147_483_647,
      reservedQuantity: 0,
      availableQuantity: 2_147_483_647,
    };
    const { impl } = answering(page([edge]));
    expect((await withFetch(impl, () => fetchStock(SESSION, WAREHOUSE_ID))).kind).toBe('OK');
  });

  it.each(['updatedAt'] as const)('refuses a malformed %s', async (field) => {
    const { impl } = answering(page([{ ...STOCK_ITEM, [field]: 'UPSTREAM_INVALID_TIMESTAMP' }]));
    const result = await withFetch(impl, () => fetchStock(SESSION, WAREHOUSE_ID));
    expect(result.kind).toBe('MALFORMED');
    expect(JSON.stringify(result)).not.toContain('UPSTREAM_INVALID');
  });
});

describe('what the service answers instead', () => {
  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [503, 'UNAVAILABLE'],
  ])('maps a %i to %s on every read, carrying no raw service text', async (status, kind) => {
    const body = { code: 'X', message: 'raw service text', correlationId: 'c' };
    const reads: (() => Promise<{ kind: string }>)[] = [
      () => fetchWarehouses(SESSION),
      () => fetchWarehouse(SESSION, WAREHOUSE_ID),
      () => fetchStock(SESSION, WAREHOUSE_ID),
    ];
    for (const run of reads) {
      const { impl } = answering(body, status);
      const result = await withFetch(impl, run);
      expect(result.kind).toBe(kind);
      expect(JSON.stringify(result)).not.toContain('raw service text');
    }
  });

  it('treats a body that does not match the schema as malformed', async () => {
    const { impl } = answering({ items: 'nope' });
    expect((await withFetch(impl, () => fetchWarehouses(SESSION))).kind).toBe('MALFORMED');
    expect((await withFetch(impl, () => fetchStock(SESSION, WAREHOUSE_ID))).kind).toBe('MALFORMED');
  });
});

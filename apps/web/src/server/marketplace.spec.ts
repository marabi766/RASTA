/**
 * @jest-environment node
 */
import { fetchOffers, fetchProduct, searchProducts } from './marketplace';
import type { WebSession } from './session';

/**
 * Reading the marketplace catalogue. Mirrors `assets.spec.ts`/`drivers.spec.ts`
 * — this module designs nothing new, so its tests do not either.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'buyer',
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

const OFFER = {
  id: 'OFR_1',
  productId: 'PRD_1',
  supplierOrganizationId: 'ORG_9',
  unitPriceMinor: '300000',
  currency: 'IRR',
  availableQuantity: 15,
  leadTimeDays: 5,
  minimumQuantity: 1,
  supplierQualification: 'UNAVAILABLE',
};

const PRODUCT = {
  id: 'PRD_1',
  sku: 'SKU-1',
  name: 'شیلنگ هیدرولیک صنعتی',
  description: null,
  category: 'PARTS',
  kind: 'GOOD',
  unit: 'عدد',
  offers: [OFFER],
};

describe('searching the catalogue', () => {
  it('sends only the filters the caller set', async () => {
    const { impl, urls } = answering({ items: [PRODUCT] });
    await withFetch(impl, () => searchProducts(SESSION, { q: 'شیلنگ', category: 'PARTS' }));
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/v1/products');
    expect(url.searchParams.get('q')).toBe('شیلنگ');
    expect(url.searchParams.get('category')).toBe('PARTS');
    expect(url.searchParams.has('sort')).toBe(false);
  });

  it('sends no query string at all for an unfiltered search', async () => {
    const { impl, urls } = answering({ items: [] });
    await withFetch(impl, () => searchProducts(SESSION));
    expect(urls[0]).toBe('http://gateway.test:3000/v1/products');
  });

  it('keeps each product’s offers, sorted as the service returned them', async () => {
    const { impl } = answering({ items: [PRODUCT] });
    const result = await withFetch(impl, () => searchProducts(SESSION));
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.items[0]!.offers[0]!.unitPriceMinor).toBe('300000');
  });

  it('separates a refusal from an outage', async () => {
    const forbidden = answering({}, 403);
    expect((await withFetch(forbidden.impl, () => searchProducts(SESSION))).kind).toBe('FORBIDDEN');

    const broken = answering({}, 503);
    const result = await withFetch(broken.impl, () => searchProducts(SESSION));
    expect(result.kind).toBe('UNAVAILABLE');
    if (result.kind === 'UNAVAILABLE') expect(result.status).toBe(503);
  });
});

describe('one product', () => {
  it('encodes the id into the path rather than interpolating it', async () => {
    const { impl, urls } = answering(PRODUCT);
    await withFetch(impl, () => fetchProduct(SESSION, 'PRD/../secret'));
    expect(new URL(urls[0]!).pathname).toBe('/v1/products/PRD%2F..%2Fsecret');
  });

  it('answers 404 for a product that does not exist', async () => {
    const missing = answering({}, 404);
    expect((await withFetch(missing.impl, () => fetchProduct(SESSION, 'PRD_X'))).kind).toBe(
      'NOT_FOUND',
    );
  });
});

describe('offers for one product', () => {
  it('reads via the product-scoped endpoint, carrying the sort', async () => {
    const { impl, urls } = answering({ items: [OFFER] });
    await withFetch(impl, () => fetchOffers(SESSION, 'PRD_1', 'LEAD_TIME_ASC'));
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/v1/products/PRD_1/offers');
    expect(url.searchParams.get('sort')).toBe('LEAD_TIME_ASC');
  });

  it('keeps the qualification flag exactly as the service sent it, never inventing a check', async () => {
    const { impl } = answering({ items: [OFFER] });
    const result = await withFetch(impl, () => fetchOffers(SESSION, 'PRD_1'));
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.data.items[0]!.supplierQualification).toBe('UNAVAILABLE');
  });
});

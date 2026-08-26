import { normalizeRoute } from './metrics';

/**
 * Route normalisation is what keeps Prometheus from being taken down by this
 * service. Every distinct label value creates a time series, so a concrete
 * asset id in a route label means one series per asset.
 */
describe('normalizeRoute', () => {
  it.each([
    ['/v1/assets/AST_01JBQ8Z4K7M2N5P8R1T3V6X9Y2', '/v1/assets/:id'],
    ['/v1/assets/AST_01JBQ8Z4K7M2N5P8R1T3V6X9Y2/usage', '/v1/assets/:id/usage'],
    ['/v1/orders/ORD_01JBQ8Z4K7M2N5P8R1T3V6X9Y2/confirm-receipt', '/v1/orders/:id/confirm-receipt'],
    ['/v1/organizations/ORG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2/children', '/v1/organizations/:id/children'],
  ])('collapses the prefixed ULID in %p', (input, expected) => {
    expect(normalizeRoute(input)).toBe(expected);
  });

  it('collapses a UUID', () => {
    expect(normalizeRoute('/v1/documents/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(
      '/v1/documents/:id',
    );
  });

  it('collapses a numeric id', () => {
    expect(normalizeRoute('/v1/pages/42')).toBe('/v1/pages/:id');
  });

  it('leaves a static route untouched', () => {
    expect(normalizeRoute('/v1/fleet/availability')).toBe('/v1/fleet/availability');
  });

  it('drops the query string, which is unbounded by definition', () => {
    expect(normalizeRoute('/v1/assets?status=ACTIVE&cursor=eyJpZCI6')).toBe('/v1/assets');
  });

  it('handles the root path', () => {
    expect(normalizeRoute('/')).toBe('/');
  });

  it('does not mistake a hyphenated route segment for an id', () => {
    expect(normalizeRoute('/v1/maintenance-requests/due')).toBe('/v1/maintenance-requests/due');
  });
});

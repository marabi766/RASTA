import { driftEvidenceOwnerChangesTotal, normalizeRoute, registry } from './metrics';

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

describe('driftEvidenceOwnerChangesTotal', () => {
  const metricName = 'rasta_drift_evidence_owner_changes_total';

  it('counts two redelivery occurrences on the single fleet-service series with a compatible inc spy', async () => {
    const before = await registry.getSingleMetric(metricName)?.get();
    const beforeValue =
      before?.values.find(({ labels }) => labels.service === 'fleet-service')?.value ?? 0;
    const increment = jest.spyOn(driftEvidenceOwnerChangesTotal, 'inc');
    try {
      driftEvidenceOwnerChangesTotal.inc();
      driftEvidenceOwnerChangesTotal.inc();

      expect(increment).toHaveBeenCalledTimes(2);
      expect(increment).toHaveBeenNthCalledWith(1);
      expect(increment).toHaveBeenNthCalledWith(2);
      const after = await registry.getSingleMetric(metricName)?.get();
      expect(after?.type).toBe('counter');
      expect(after?.values).toEqual([
        { value: beforeValue + 2, labels: { service: 'fleet-service' } },
      ]);
      expect(await registry.getSingleMetricAsString(metricName)).toContain(
        `${metricName}{service="fleet-service"} ${beforeValue + 2}`,
      );
    } finally {
      increment.mockRestore();
    }
  });

  it('exports HELP describing committed occurrences rather than unique events', async () => {
    expect(await registry.getSingleMetricAsString(metricName)).toContain(
      `# HELP ${metricName} Committed drift evidence redelivery occurrences with a changed live owner (not unique events)`,
    );
  });
});

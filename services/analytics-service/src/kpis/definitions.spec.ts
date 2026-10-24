import { KPI_DEFINITIONS } from './definitions';
import { baselineValue, kpiStatusSchema, kpisQuerySchema, kpisViewSchema } from './dto';

describe('registered KPI definitions and closed statuses (ADR-071 § 6)', () => {
  it('registers a count and a baseline reference with explicit units, dependencies and formulas', () => {
    expect(KPI_DEFINITIONS).toEqual([
      expect.objectContaining({
        key: 'MAINTENANCE_COMPLETED_COUNT',
        unit: 'COUNT',
        dependsOnBaseline: false,
      }),
      expect.objectContaining({
        key: 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES',
        unit: 'MINUTES',
        dependsOnBaseline: true,
      }),
    ]);
    expect(new Set(KPI_DEFINITIONS.map((definition) => definition.key)).size).toBe(
      KPI_DEFINITIONS.length,
    );
    expect(KPI_DEFINITIONS.every((definition) => definition.formula.length > 0)).toBe(true);
  });

  it('does not invent a savings, preventive/emergency ratio or procurement KPI', () => {
    expect(KPI_DEFINITIONS.map((definition) => definition.key).join(',')).not.toMatch(
      /SAVINGS|AVOIDED|RATIO|PROCUREMENT/,
    );
  });

  it('missing baseline is null, never zero; a recorded zero remains an available string', () => {
    expect(baselineValue(null)).toEqual({ status: 'INSUFFICIENT_BASELINE', value: null });
    expect(baselineValue('0')).toEqual({ status: 'AVAILABLE', value: '0' });
    expect(baselineValue('9223372036854775807')).toEqual({
      status: 'AVAILABLE',
      value: '9223372036854775807',
    });
    expect(kpiStatusSchema.options).toEqual(['AVAILABLE', 'INSUFFICIENT_BASELINE']);
    expect(kpiStatusSchema.safeParse('UNKNOWN').success).toBe(false);
  });

  it.each([
    { status: 'AVAILABLE', value: null },
    { status: 'INSUFFICIENT_BASELINE', value: '0' },
    { status: 'INSUFFICIENT_BASELINE', value: 0 },
    { status: 'SUPPRESSED', value: null },
  ])('refuses an inconsistent status/value contract: %j', (value) => {
    expect(
      kpisViewSchema.safeParse({
        organizationId: 'ORG-A',
        from: '2026-10-01T00:00:00Z',
        to: '2026-11-01T00:00:00Z',
        earliestCompletionAt: null,
        kpis: [{ key: KPI_DEFINITIONS[1].key, unit: 'MINUTES', dependsOnBaseline: true, ...value }],
      }).success,
    ).toBe(false);
  });

  it('reuses strict explicit windows, including equivalent offset instants', () => {
    expect(
      kpisQuerySchema.safeParse({ from: '2026-10-01T03:30:00+03:30', to: '2026-10-01T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(
      kpisQuerySchema.safeParse({
        from: '2026-10-01T00:00:00Z',
        to: '2026-11-01T00:00:00Z',
        scope: 'ALL',
      }).success,
    ).toBe(false);
  });
});

import { fleetDashboardViewSchema } from './dto';
import { completedByType, toFleetDashboardView } from './views';
import type { MaintenanceTotalsRow } from './maintenance-fact.repository';

const row = (overrides: Partial<MaintenanceTotalsRow>): MaintenanceTotalsRow => ({
  maintenanceType: 'PREVENTIVE',
  currency: 'IRR',
  completedCount: 1,
  downtimeKnownCount: 1,
  downtimeMinutes: 60,
  totalCostMinor: 100n,
  ...overrides,
});

describe('completedByType', () => {
  it('sums counts and downtime across currencies and keeps cost per currency', () => {
    expect(
      completedByType([
        row({
          currency: 'EUR',
          completedCount: 1,
          downtimeKnownCount: 0,
          downtimeMinutes: 0,
          totalCostMinor: 7n,
        }),
        row({
          currency: 'IRR',
          completedCount: 2,
          downtimeKnownCount: 2,
          downtimeMinutes: 30,
          totalCostMinor: 9_000_000_000_000_000_000n,
        }),
        row({
          maintenanceType: 'CORRECTIVE',
          completedCount: 3,
          downtimeKnownCount: 1,
          downtimeMinutes: 45,
        }),
      ]),
    ).toEqual([
      {
        type: 'PREVENTIVE',
        count: 3,
        downtime: { knownCount: 2, totalMinutes: 30 },
        cost: [
          { currency: 'EUR', amountMinor: '7' },
          { currency: 'IRR', amountMinor: '9000000000000000000' },
        ],
      },
      {
        type: 'CORRECTIVE',
        count: 3,
        downtime: { knownCount: 1, totalMinutes: 45 },
        cost: [{ currency: 'IRR', amountMinor: '100' }],
      },
    ]);
  });

  it('answers an empty window as an empty list, not as zeros', () => {
    expect(completedByType([])).toEqual([]);
  });
});

describe('toFleetDashboardView', () => {
  it('matches the published schema, with no earliest completion when none is held', () => {
    const view = toFleetDashboardView({
      organizationId: 'ORG_A',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-11-01T00:00:00.000Z'),
      earliestCompletion: null,
      rows: [row({})],
    });
    expect(fleetDashboardViewSchema.parse(view)).toEqual(view);
    expect(view.earliestCompletionAt).toBeNull();
    expect(view.from).toBe('2026-10-01T00:00:00.000Z');
  });
});

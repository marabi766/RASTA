import { screen } from '@testing-library/react';
import { FleetView } from './fleet-view';
import {
  expectNoAxeViolations,
  makeHarness,
  renderWithSession,
  respondError,
  renderRoute,
} from '@/test/harness';

/**
 * Fleet operations.
 *
 * The two assertions worth having here both defend against a UI being *helpful*
 * in a way that loses information the service went to trouble to provide.
 */

const AVAILABILITY = {
  items: [
    {
      assetId: 'ast_1',
      assetName: 'گریدر شمال',
      assetType: 'GRADER',
      assetTag: null,
      available: false,
      blockers: [
        { code: 'IN_MAINTENANCE', owner: 'maintenance-service', detail: 'دستور کار باز دارد' },
        { code: 'DISPATCH_BLOCKED', owner: 'asset-service', detail: 'بیمه منقضی شده' },
      ],
      currentAssignment: null,
    },
  ],
  nextCursor: null,
  hasMore: true,
};

const UTILIZATION = {
  items: [
    {
      assetId: 'ast_1',
      assetName: 'گریدر شمال',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      usedHours: '0',
      kilometres: '0',
      availableHours: '160',
      utilizationPercent: null,
      recordCount: 0,
      assignmentCount: 0,
    },
  ],
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
};

const EMPTY = { items: [], nextCursor: null, hasMore: false };

/** Routes each of the five reads this screen makes to its own fixture. */
function fleetRoutes(overrides: Record<string, unknown> = {}) {
  return {
    '/v1/fleet/availability': AVAILABILITY,
    '/v1/fleet/utilization': UTILIZATION,
    '/v1/drivers': EMPTY,
    '/v1/assignments': EMPTY,
    '/v1/usage-records': EMPTY,
    ...overrides,
  };
}

describe('dispatch readiness', () => {
  it('names every blocker and the service that owns it', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(fleetRoutes()));

    renderWithSession(<FleetView />, session);
    await screen.findAllByText('گریدر شمال');

    // Both blockers, not just the first — an operator fixing one should not
    // have to re-check to discover the next.
    expect(screen.getByText('در تعمیرگاه')).toBeInTheDocument();
    expect(screen.getByText('ممنوعیت اعزام')).toBeInTheDocument();

    // Attribution is the feature: it is what tells an operator whether to call
    // the workshop or renew a policy.
    expect(screen.getByText('maintenance-service')).toBeInTheDocument();
    expect(screen.getByText('asset-service')).toBeInTheDocument();
  });

  it('renders an unavailable machine as unavailable', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(fleetRoutes()));

    renderWithSession(<FleetView />, session);
    await screen.findAllByText('گریدر شمال');

    // Scoped to the availability table: «خیر» is the dispatch verdict, and the
    // assertion should fail if that column stops rendering even while some
    // other section happens to contain the same word.
    expect(screen.getByRole('table', { name: /ماشین ارزیابی شد/ })).toHaveTextContent('خیر');
  });
});

describe('utilisation', () => {
  it('says "no readings" rather than showing zero percent', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(fleetRoutes()));

    renderWithSession(<FleetView />, session);

    // docs/04 § 4.15: "we have no data" and "the machine sat idle" are
    // different facts, and reporting the first as the second is how a
    // dashboard invents data.
    expect(await screen.findByText('داده‌ای ثبت نشده')).toBeInTheDocument();
    expect(screen.queryByText('۰٪')).not.toBeInTheDocument();
  });

  it('shows a real percentage when the service computed one', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute(
        fleetRoutes({
          '/v1/fleet/utilization': {
            ...UTILIZATION,
            items: [{ ...UTILIZATION.items[0], utilizationPercent: '62.5', recordCount: 12 }],
          },
        }),
      ),
    );

    renderWithSession(<FleetView />, session);

    expect(await screen.findByText('۶۲.۵٪')).toBeInTheDocument();
  });
});

describe('failures', () => {
  it('shows each section its own failure rather than blanking the page', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation((input: string) =>
      new URL(input).pathname === '/v1/fleet/availability'
        ? respondError(503, 'UPSTREAM_UNAVAILABLE')()
        : renderRoute(fleetRoutes())(input),
    );

    renderWithSession(<FleetView />, session);

    // The availability read failed; utilisation still rendered.
    expect(await screen.findByRole('alert')).toHaveTextContent('cid-gateway');
    expect(await screen.findByText('داده‌ای ثبت نشده')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(fleetRoutes()));

    const { container } = renderWithSession(<FleetView />, session);
    await screen.findAllByText('گریدر شمال');

    await expectNoAxeViolations(container);
  });
});

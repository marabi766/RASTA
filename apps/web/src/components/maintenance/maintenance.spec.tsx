import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MaintenanceView } from './maintenance-view';
import { MaintenanceRequestDetailView } from './request-detail-view';
import {
  expectNoAxeViolations,
  makeHarness,
  renderRoute,
  renderWithSession,
  respondError,
} from '@/test/harness';

/**
 * Maintenance.
 *
 * The due list is the screen worth protecting with tests: its whole value is
 * that the verdict is computed per call and names which trigger produced it. A
 * UI that rendered "overdue" and dropped the trigger would keep the word and
 * lose the reason.
 */

const OVERDUE = {
  id: 'sch_1',
  organizationId: 'org_one',
  assetId: 'ast_1',
  assetName: 'گریدر شمال',
  title: 'سرویس ۲۵۰ ساعت',
  maintenanceType: 'PREVENTIVE',
  recurrence: 'RECURRING',
  status: 'ACTIVE',
  intervalDays: null,
  intervalHours: '250',
  intervalKilometres: null,
  leadDays: null,
  leadHours: '20',
  leadKilometres: null,
  lastServicedAt: '2025-12-01T00:00:00.000Z',
  lastServicedHourMeter: '4120.50',
  lastServicedOdometer: null,
  lastServiceRequestId: null,
  notes: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  due: {
    state: 'OVERDUE',
    basis: 'HOURS',
    dueBy: null,
    dueAtMeter: '4370.50',
    triggers: [
      { basis: 'HOURS', state: 'OVERDUE', dueAt: null, dueAtMeter: '4370.50', remaining: '-16.00' },
      {
        basis: 'TIME',
        state: 'NOT_DUE',
        dueAt: '2026-06-01T00:00:00.000Z',
        dueAtMeter: null,
        remaining: '92',
      },
    ],
  },
  meter: { hourMeter: '4386.50', odometer: '0', lastPeriodEnd: '2026-02-01T00:00:00.000Z' },
  openRequestId: 'mrq_1',
};

const REQUEST = {
  id: 'mrq_1',
  organizationId: 'org_one',
  assetId: 'ast_1',
  scheduleId: 'sch_1',
  type: 'PREVENTIVE',
  status: 'APPROVED',
  severity: null,
  title: 'تعویض روغن و فیلتر',
  description: null,
  reportedAt: '2026-02-01T00:00:00.000Z',
  reportedBy: 'usr_1',
  dueDate: null,
  outOfServiceAt: null,
  returnedToServiceAt: null,
  downtimeMinutes: null,
  startedAt: null,
  startedBy: null,
  completedAt: null,
  completedBy: null,
  approvedAt: '2026-02-05T00:00:00.000Z',
  approvedBy: 'usr_2',
  approvalNotes: 'هزینه بررسی و تأیید شد.',
  cancelledAt: null,
  cancelledBy: null,
  cancellationReason: null,
  totalCostMinor: '128500000',
  currency: 'IRR',
};

const listRoutes = {
  '/v1/maintenance-schedules/due': { items: [OVERDUE], nextCursor: null, hasMore: false },
  '/v1/maintenance-requests': { items: [REQUEST], nextCursor: null, hasMore: false },
  '/v1/repair-orders': { items: [], nextCursor: null, hasMore: false },
};

describe('what needs servicing', () => {
  it('names the trigger that came due and how much is left', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(listRoutes));

    renderWithSession(<MaintenanceView />, session);
    await screen.findByText('سرویس ۲۵۰ ساعت');

    // The verdict alone would be useless: the reason it is overdue is the
    // hours trigger, and the time trigger is not due at all.
    expect(screen.getByText('ساعت کارکرد')).toBeInTheDocument();
    expect(screen.getByText('زمان')).toBeInTheDocument();
    expect(screen.getByText('گذشته از موعد')).toBeInTheDocument();
    expect(screen.getByText(/باقی‌مانده: -۱۶.۰۰/)).toBeInTheDocument();
  });

  it('shows the live meter the verdict was computed against', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(listRoutes));

    renderWithSession(<MaintenanceView />, session);
    await screen.findByText('سرویس ۲۵۰ ساعت');

    // Computed on this call from this reading — not read from a stored flag a
    // background scan may never have refreshed.
    expect(screen.getByText(/ساعت: ۴۳۸۶.۵۰/)).toBeInTheDocument();
  });

  it('asks for the whole picture when the operator wants it', async () => {
    const user = userEvent.setup();
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(listRoutes));

    renderWithSession(<MaintenanceView />, session);
    await screen.findByText('سرویس ۲۵۰ ساعت');

    await user.click(screen.getByRole('button', { name: /نمایش همهٔ برنامه‌ها/ }));

    const call = fetchMock.mock.calls
      .map(([url]) => new URL(url as string))
      .findLast((url) => url.pathname === '/v1/maintenance-schedules/due');

    expect(call?.searchParams.get('includeNotDue')).toBe('true');
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(listRoutes));

    const { container } = renderWithSession(<MaintenanceView />, session);
    await screen.findByText('سرویس ۲۵۰ ساعت');

    await expectNoAxeViolations(container);
  });
});

describe('repair orders', () => {
  it('renders an empty list as an empty list, not as a permission error', async () => {
    // A narrowed caller gets an empty page rather than a 403, for the same
    // non-disclosure reason a cross-tenant read answers 404. The screen has to
    // say what that means instead of implying there is nothing to see.
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(listRoutes));

    renderWithSession(<MaintenanceView />, session);

    expect(await screen.findByText('دستور کاری برای شما قابل مشاهده نیست')).toBeInTheDocument();
  });
});

describe('one maintenance request', () => {
  it('shows who approved the cost and when', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/maintenance-requests/mrq_1': {
          ...REQUEST,
          repairOrders: [],
          costBreakdown: [{ category: 'PART', amountMinor: '128500000', currency: 'IRR' }],
        },
      }),
    );

    renderWithSession(<MaintenanceRequestDetailView requestId="mrq_1" />, session);
    await screen.findByText('تعویض روغن و فیلتر');

    expect(screen.getByText('تأیید شده')).toBeInTheDocument();
    expect(screen.getByText('usr_2')).toBeInTheDocument();
    expect(screen.getAllByText('۱۲۸٬۵۰۰٬۰۰۰ ریال').length).toBeGreaterThan(0);
  });

  it('reports a missing request rather than rendering a blank detail', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(404, 'NOT_FOUND'));

    renderWithSession(<MaintenanceRequestDetailView requestId="mrq_missing" />, session);

    expect(await screen.findByRole('alert')).toHaveTextContent('یافت نشد');
  });
});

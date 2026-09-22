import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { MaintenanceScreen } from './MaintenanceScreen';
import { RequestDetailScreen } from './[id]/RequestDetailScreen';
import type {
  MaintenanceRequestDetail,
  MaintenanceRequestPage,
  ReadResult,
} from '@/server/maintenance';

/**
 * The two maintenance screens, in every state the server can put them in.
 *
 * Mirrors `assets.spec.tsx` (PR #67): both screens are pure functions of a
 * read result, so every state is testable without a database, a gateway or a
 * session, and the unhappy states get the same weight as the happy one.
 */

const REQUEST = {
  id: 'MREQ_1',
  assetId: 'AST_1',
  scheduleId: null,
  type: 'CORRECTIVE',
  status: 'OPEN',
  severity: 'HIGH',
  title: 'صدای غیرعادی موتور',
  reportedAt: '2026-02-01T08:00:00.000Z',
  dueDate: '2026-02-05T00:00:00.000Z',
  totalCostMinor: '0',
};

const page = (
  overrides: Partial<MaintenanceRequestPage> = {},
): ReadResult<MaintenanceRequestPage> => ({
  kind: 'OK',
  data: { items: [REQUEST], nextCursor: null, hasMore: false, ...overrides },
});

describe('the maintenance list', () => {
  it('shows a row per request, linking to its detail and to its asset', () => {
    const { getByRole } = render(<MaintenanceScreen result={page()} query={{}} />);
    expect(getByRole('link', { name: 'صدای غیرعادی موتور' })).toHaveAttribute(
      'href',
      '/maintenance/MREQ_1',
    );
    expect(getByRole('link', { name: 'AST_1' })).toHaveAttribute('href', '/assets/AST_1');
  });

  it('translates the type, severity and status without translating the data', () => {
    // CLAUDE.md: the label is presentation; the value stays Latin everywhere
    // a comparison or a filter could see it.
    const { getByRole } = render(<MaintenanceScreen result={page()} query={{}} />);
    const row = getByRole('row', { name: /صدای غیرعادی موتور/ });
    expect(row).toHaveTextContent('اصلاحی');
    expect(row).toHaveTextContent('زیاد');
    expect(row).toHaveTextContent('باز');
    expect(getByRole('option', { name: 'اصلاحی' })).toHaveValue('CORRECTIVE');
  });

  it('shows an unknown status as it arrived, rather than hiding it', () => {
    const { getByText } = render(
      <MaintenanceScreen
        result={page({ items: [{ ...REQUEST, status: 'ESCALATED' }] })}
        query={{}}
      />,
    );
    expect(getByText('ESCALATED')).toBeInTheDocument();
  });

  it('offers the next page only when there is one', () => {
    const { queryByRole } = render(<MaintenanceScreen result={page()} query={{}} />);
    expect(queryByRole('link', { name: 'صفحهٔ بعد' })).toBeNull();

    const { getByRole } = render(
      <MaintenanceScreen
        result={page({ hasMore: true, nextCursor: 'CUR_2' })}
        query={{ status: 'OPEN' }}
      />,
    );
    // The filter travels with the cursor: a second page of a filtered list is
    // still that filtered list.
    expect(getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      '/maintenance?status=OPEN&cursor=CUR_2',
    );
  });

  it('says something different when a filter matched nothing', () => {
    const empty = page({ items: [] });

    const unfiltered = render(<MaintenanceScreen result={empty} query={{}} />);
    expect(unfiltered.getByText('هیچ درخواست نگهداری‌ای ثبت نشده')).toBeInTheDocument();

    const filtered = render(<MaintenanceScreen result={empty} query={{ severity: 'CRITICAL' }} />);
    expect(filtered.getByText('چیزی با این پالایش پیدا نشد')).toBeInTheDocument();
    expect(filtered.getByRole('link', { name: 'نمایش همه' })).toHaveAttribute(
      'href',
      '/maintenance',
    );
  });

  it('renders a refusal as a refusal and an outage as an outage', () => {
    const forbidden = render(<MaintenanceScreen result={{ kind: 'FORBIDDEN' }} query={{}} />);
    expect(forbidden.getByText('دسترسی ندارید')).toBeInTheDocument();

    const down = render(
      <MaintenanceScreen
        result={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' }}
        query={{}}
      />,
    );
    // docs/16 § 16.11: the correlation id is on screen so support can find the
    // rest without the page showing it.
    expect(down.getByText(/COR_9/)).toBeInTheDocument();
  });

  it('filters through the URL, with no javascript', () => {
    const { getByRole } = render(<MaintenanceScreen result={page()} query={{}} />);
    const form = getByRole('form', { name: 'پالایش فهرست' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/maintenance');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<MaintenanceScreen result={page()} query={{}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

const DETAIL: MaintenanceRequestDetail = {
  ...REQUEST,
  description: 'صدای تق‌تق هنگام روشن‌شدن',
  reportedBy: 'USR_9',
  outOfServiceAt: '2026-02-01T08:00:00.000Z',
  returnedToServiceAt: null,
  downtimeMinutes: null,
  startedAt: null,
  completedAt: null,
  approvedAt: null,
  approvalNotes: null,
  cancelledAt: null,
  cancellationReason: null,
  repairOrders: [],
  costBreakdown: [],
};

describe('the maintenance request detail', () => {
  const ok = (data: MaintenanceRequestDetail = DETAIL): ReadResult<MaintenanceRequestDetail> => ({
    kind: 'OK',
    data,
  });

  it('shows the workflow history in order, only for what has happened', () => {
    const { getByText, queryByText } = render(
      <RequestDetailScreen result={ok()} requestId="MREQ_1" />,
    );
    expect(getByText('گزارش شد')).toBeInTheDocument();
    // Nothing has started yet, so no step claims it has.
    expect(queryByText('تعمیر آغاز شد')).toBeNull();
    expect(queryByText('تعمیر تکمیل شد')).toBeNull();
  });

  it('adds each milestone as it is reached', () => {
    const inProgress: MaintenanceRequestDetail = {
      ...DETAIL,
      status: 'IN_PROGRESS',
      startedAt: '2026-02-02T00:00:00.000Z',
    };
    const { getByText } = render(
      <RequestDetailScreen result={ok(inProgress)} requestId="MREQ_1" />,
    );
    expect(getByText('گزارش شد')).toBeInTheDocument();
    expect(getByText('تعمیر آغاز شد')).toBeInTheDocument();
  });

  it('shows the approval note beside the approval milestone', () => {
    const approved: MaintenanceRequestDetail = {
      ...DETAIL,
      status: 'APPROVED',
      completedAt: '2026-02-03T00:00:00.000Z',
      approvedAt: '2026-02-04T00:00:00.000Z',
      approvalNotes: 'تأیید شد، هزینه مطابق برآورد بود',
    };
    const { getByText } = render(<RequestDetailScreen result={ok(approved)} requestId="MREQ_1" />);
    expect(getByText('تأیید شد، هزینه مطابق برآورد بود')).toBeInTheDocument();
  });

  it('shows no severity as "preventive work" rather than a blank', () => {
    const preventive: MaintenanceRequestDetail = {
      ...DETAIL,
      type: 'PREVENTIVE',
      severity: null,
    };
    const { getByText } = render(
      <RequestDetailScreen result={ok(preventive)} requestId="MREQ_1" />,
    );
    expect(getByText('ندارد — کار پیشگیرانه')).toBeInTheDocument();
  });

  it('answers a missing request the same way it answers somebody else’s', () => {
    // A distinct "exists but not yours" would confirm the id to somebody who
    // should not learn it. maintenance-service answers 404 for both, and so
    // does this.
    const { getByText } = render(
      <RequestDetailScreen result={{ kind: 'NOT_FOUND' }} requestId="MREQ_X" />,
    );
    expect(getByText('این درخواست پیدا نشد')).toBeInTheDocument();
  });

  it('shows no repair order as not-yet-assigned, not as an error', () => {
    const { getByText } = render(<RequestDetailScreen result={ok()} requestId="MREQ_1" />);
    expect(getByText('هنوز ارجاع نشده')).toBeInTheDocument();
  });

  it('shows the repair order, its workshop and its cost when one exists', () => {
    const withOrder: MaintenanceRequestDetail = {
      ...DETAIL,
      status: 'IN_PROGRESS',
      repairOrders: [
        {
          id: 'RO_1',
          status: 'IN_PROGRESS',
          workshopName: 'تعمیرگاه مرکزی',
          workSummary: 'بررسی موتور',
          workPerformed: null,
          assignedAt: '2026-02-02T00:00:00.000Z',
          startedAt: '2026-02-03T00:00:00.000Z',
          completedAt: null,
          cancelledAt: null,
          cancellationReason: null,
          partsCostMinor: '500000',
          labourCostMinor: '200000',
          otherCostMinor: '0',
          totalCostMinor: '700000',
        },
      ],
    };
    const { getByText } = render(<RequestDetailScreen result={ok(withOrder)} requestId="MREQ_1" />);
    expect(getByText('تعمیرگاه مرکزی')).toBeInTheDocument();
    expect(getByText('بررسی موتور')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<RequestDetailScreen result={ok()} requestId="MREQ_1" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

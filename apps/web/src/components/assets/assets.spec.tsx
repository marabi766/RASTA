import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssetsView } from './assets-view';
import { DossierView } from './dossier-view';
import {
  expectNoAxeViolations,
  makeHarness,
  renderRoute,
  renderWithSession,
  respondError,
  respondJson,
} from '@/test/harness';

const ASSET = {
  id: 'ast_1',
  organizationId: 'org_one',
  assetTag: '12B345',
  name: 'گریدر شمال',
  type: 'GRADER',
  manufacturer: 'کوماتسو',
  model: 'GD535',
  serialNumber: 'SN-1',
  manufactureYear: 2019,
  status: 'IN_MAINTENANCE',
  commissionedAt: '2020-03-01T00:00:00.000Z',
  decommissionedAt: null,
  specifications: {},
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const DOSSIER = {
  asset: ASSET,
  organizationName: 'دهیاری الف',
  currentLocation: null,
  compliance: {
    operable: false,
    blockers: ['بیمه‌نامهٔ فعال ندارد', 'دستور کار تعمیر باز دارد'],
    activeInsurance: null,
    latestInspection: {
      id: 'ins_1',
      certificateNo: 'CERT-9',
      centerName: null,
      inspectedAt: '2025-06-01T00:00:00.000Z',
      validTo: '2026-06-01T00:00:00.000Z',
      result: 'PASS',
      notes: null,
      daysUntilExpiry: -12,
    },
  },
  costs: {
    totalMinor: '9007199254740993',
    maintenanceMinor: '128500000',
    partsAndOrdersMinor: '0',
    entryCount: 7,
  },
  documents: [],
  recentActivity: [],
  transferCount: 1,
};

const TIMELINE = {
  items: [
    {
      id: 'tl_1',
      eventName: 'MAINTENANCE_APPROVED',
      sourceService: 'maintenance-service',
      category: 'MAINTENANCE',
      title: 'هزینهٔ تعمیر تأیید شد',
      description: null,
      amountMinor: '128500000',
      detail: {},
      occurredAt: '2026-02-01T00:00:00.000Z',
    },
  ],
  nextCursor: null,
  hasMore: false,
};

describe('asset register', () => {
  it('lists the acting organization machines', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [ASSET], nextCursor: null, hasMore: false }));

    renderWithSession(<AssetsView />, session);

    expect(await screen.findByText('گریدر شمال')).toBeInTheDocument();
    // The Latin enum travels with the Persian label; a colour alone never
    // carries meaning (docs/16 § 16.9).
    // Scoped to the row: «در تعمیر» is also one of the filter options, and an
    // assertion that matched either would pass even if the column disappeared.
    const row = screen.getByRole('row', { name: /گریدر شمال/ });
    expect(row).toHaveTextContent('IN_MAINTENANCE');
    expect(row).toHaveTextContent('در تعمیر');
  });

  it('filters by the real operational status enum', async () => {
    const user = userEvent.setup();
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [], nextCursor: null, hasMore: false }));

    renderWithSession(<AssetsView />, session);
    await screen.findByText('ماشینی با این مشخصات پیدا نشد');

    await user.selectOptions(screen.getByLabelText('وضعیت عملیاتی'), 'OUT_OF_SERVICE');

    const url = new URL((fetchMock.mock.calls.at(-1) as [string])[0]);
    expect(url.searchParams.get('status')).toBe('OUT_OF_SERVICE');
  });

  it('renders a tenant refusal as a tenant problem', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(403, 'TENANT_MISMATCH'));

    renderWithSession(<AssetsView />, session);

    expect(await screen.findByText('سازمان فعال با این داده هم‌خوان نیست')).toBeInTheDocument();
  });
});

describe('electronic dossier', () => {
  const routes = {
    '/v1/assets/ast_1/dossier': DOSSIER,
    '/v1/assets/ast_1/timeline': TIMELINE,
  };

  it('lists every dispatch blocker, not only the first', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(routes));

    renderWithSession(<DossierView assetId="ast_1" />, session);
    await screen.findByText('آیا امروز قابل اعزام است؟');

    expect(screen.getByText('بیمه‌نامهٔ فعال ندارد')).toBeInTheDocument();
    expect(screen.getByText('دستور کار تعمیر باز دارد')).toBeInTheDocument();
    expect(screen.getByText('غیرقابل اعزام')).toBeInTheDocument();
  });

  it('renders an accumulated cost beyond safe-integer range exactly', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(routes));

    renderWithSession(<DossierView assetId="ast_1" />, session);

    expect(await screen.findByText('۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ ریال')).toBeInTheDocument();
  });

  it('writes the manufacture year as a year, not as a quantity', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(routes));

    renderWithSession(<DossierView assetId="ast_1" />, session);

    // «۲٬۰۱۹» would be a count of two thousand and nineteen. The year is an
    // identifier and takes no thousands separator.
    expect(await screen.findByText('۲۰۱۹')).toBeInTheDocument();
    expect(screen.queryByText('۲٬۰۱۹')).not.toBeInTheDocument();
  });

  it('reads a negative daysUntilExpiry as time already elapsed', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(routes));

    renderWithSession(<DossierView assetId="ast_1" />, session);

    // The field goes negative once lapsed, so the copy has to follow it rather
    // than rendering "−12 days remaining".
    expect(await screen.findByText('۱۲ روز از انقضا گذشته است')).toBeInTheDocument();
  });

  it('names the service that produced each timeline entry', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(routes));

    renderWithSession(<DossierView assetId="ast_1" />, session);
    await screen.findByText('هزینهٔ تعمیر تأیید شد');

    // "Who said this" is the question a timeline row invites, and the projector
    // knows the answer.
    expect(screen.getByText('maintenance-service')).toBeInTheDocument();
    expect(screen.getByText('MAINTENANCE_APPROVED')).toBeInTheDocument();
  });

  it('shows a dossier failure without losing the page', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(404, 'NOT_FOUND'));

    renderWithSession(<DossierView assetId="ast_1" />, session);

    expect(await screen.findByRole('alert')).toHaveTextContent('یافت نشد');
  });

  it('keeps the dossier when only the timeline fails', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation((input: string) =>
      new URL(input).pathname.endsWith('/timeline')
        ? respondError(503, 'UPSTREAM_UNAVAILABLE')()
        : renderRoute(routes)(input),
    );

    renderWithSession(<DossierView assetId="ast_1" />, session);

    expect(await screen.findByText('آیا امروز قابل اعزام است؟')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('cid-gateway');
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(routes));

    const { container } = renderWithSession(<DossierView assetId="ast_1" />, session);
    await screen.findByText('هزینهٔ تعمیر تأیید شد');

    await expectNoAxeViolations(container);
  });
});

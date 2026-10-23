import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import {
  fetchSupplier,
  fetchSuppliers,
  type ReadResult,
  type SupplierDetail,
  type SupplierPage,
  type SupplierSummary,
} from '@/server/suppliers';

import { SuppliersScreen } from './SuppliersScreen';
import { SupplierDetailScreen } from './[id]/SupplierDetailScreen';

/**
 * What `/suppliers` and `/suppliers/[id]` render: every outcome the server
 * read can hand back (empty, permission, degraded, absent), the directory's
 * catalogue-safe fields, and the private record's qualification and
 * suspension history — with no actor id anywhere in the rendered text and each
 * evidence document by its id and label only, as the API returns it.
 */

// A plain anchor: `next/link` prefetches through an intersection observer whose
// state updates land outside `act` and drown the output in warnings.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mockCallGateway = jest.fn();
jest.mock('@/server/gateway', () => ({
  ...jest.requireActual('@/server/gateway'),
  callGateway: (...args: unknown[]) => mockCallGateway(...args),
}));

const SUPPLIER: SupplierSummary = {
  id: 'SUP_1',
  organizationId: 'ORG_OWNER',
  displayName: 'تعمیرگاه البرز',
  status: 'ACTIVE',
  capabilities: ['WORKSHOP_SERVICE'],
  qualifiedFor: ['WORKSHOP_SERVICE'],
  registeredAt: '2026-08-01T08:00:00.000Z',
};

const SUSPENDED_SUPPLIER: SupplierSummary = {
  ...SUPPLIER,
  id: 'SUP_2',
  displayName: 'تأمین‌کنندهٔ تعلیق‌شده',
  status: 'SUSPENDED',
  qualifiedFor: [],
};

const DETAIL: SupplierDetail = {
  ...SUPPLIER,
  qualifications: [
    {
      id: 'QUAL_1',
      capability: 'WORKSHOP_SERVICE',
      state: 'APPROVED',
      statement: 'مجهز به دستگاه بالانس',
      submittedAt: '2026-08-02T08:00:00.000Z',
      decidedAt: '2026-08-03T08:00:00.000Z',
      decisionNote: 'مستندات کامل بود',
      rejectionReason: null,
      evidence: [{ documentId: 'DOC_1', label: 'پروانه کسب' }],
      evidenceCount: 1,
      current: true,
    },
  ],
  suspensions: [
    {
      id: 'SUS_1',
      reason: 'شکایت تکراری مشتریان',
      suspendedAt: '2026-09-01T08:00:00.000Z',
      reinstatedAt: null,
      reinstatementNote: null,
      open: true,
    },
  ],
};

const page = (
  items: SupplierSummary[],
  nextCursor: string | null = null,
): ReadResult<SupplierPage> => ({
  kind: 'OK',
  data: { items, nextCursor, hasMore: nextCursor !== null },
});

describe('the supplier directory', () => {
  it('shows each supplier with a status word, its categories and a link to it', () => {
    render(<SuppliersScreen result={page([SUPPLIER])} query={{}} />);

    expect(screen.getByRole('link', { name: SUPPLIER.displayName })).toHaveAttribute(
      'href',
      '/suppliers/SUP_1',
    );
    expect(screen.getAllByText('فعال').length).toBeGreaterThan(0);
    // The capability also names a filter link, so the row's own text is one of several matches.
    expect(screen.getAllByText('خدمات تعمیرگاهی').length).toBeGreaterThan(0);
  });

  it('says a suspended supplier has no active qualification, without hiding the categories it claims', () => {
    render(<SuppliersScreen result={page([SUSPENDED_SUPPLIER])} query={{}} />);

    expect(screen.getByText('در حال حاضر برای هیچ دسته‌ای صلاحیت فعال ندارد')).toBeInTheDocument();
    expect(screen.getAllByText('خدمات تعمیرگاهی').length).toBeGreaterThan(0);
  });

  it('marks the active filters and keeps them in the next-page link', () => {
    render(
      <SuppliersScreen
        result={page([SUPPLIER], 'c2')}
        query={{ status: 'ACTIVE', capability: 'WORKSHOP_SERVICE' }}
      />,
    );

    expect(screen.getByRole('link', { name: 'فعال' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'خدمات تعمیرگاهی' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      '/suppliers?status=ACTIVE&capability=WORKSHOP_SERVICE&cursor=c2',
    );
  });

  it('says so when there are none, with and without a filter', () => {
    const { rerender } = render(<SuppliersScreen result={page([])} query={{}} />);
    expect(screen.getByText('هنوز تأمین‌کننده‌ای در این فهرست نیست.')).toBeInTheDocument();

    rerender(<SuppliersScreen result={page([])} query={{ status: 'SUSPENDED' }} />);
    expect(screen.getByText('تأمین‌کننده‌ای با این فیلتر یافت نشد.')).toBeInTheDocument();
  });

  it('renders a refusal as no access', () => {
    render(<SuppliersScreen result={{ kind: 'FORBIDDEN' }} query={{}} />);
    expect(screen.getByText('فهرست تأمین‌کنندگان در اختیار شما نیست.')).toBeInTheDocument();
  });

  it.each([
    { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' },
    { kind: 'MALFORMED', correlationId: 'corr-1' },
  ] as const)(
    'renders a degraded read ($kind) with the correlation id and fixed text',
    (result) => {
      render(<SuppliersScreen result={result} query={{}} />);
      expect(screen.getByText(/فهرست تأمین‌کنندگان خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-1/)).toBeInTheDocument();
    },
  );

  // One test per state: each axe run gets the whole default timeout to
  // itself, rather than sharing one 5 s budget across every state (main red
  // on inventory a11y, #297).
  it.each<[string, ReadResult<SupplierPage>]>([
    ['suppliers, more to page', page([SUPPLIER], 'c2')],
    ['no suppliers', page([])],
    ['refused', { kind: 'FORBIDDEN' }],
    ['not found', { kind: 'NOT_FOUND' }],
    ['unavailable', { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' }],
    ['malformed', { kind: 'MALFORMED', correlationId: 'corr-1' }],
  ])('has no accessibility violations (%s)', async (_name, result) => {
    const { container } = render(<SuppliersScreen result={result} query={{}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the supplier detail', () => {
  it('shows the record, its qualifications and its suspension history', () => {
    render(<SupplierDetailScreen result={{ kind: 'OK', data: DETAIL }} />);

    expect(screen.getByRole('heading', { name: SUPPLIER.displayName })).toBeInTheDocument();
    expect(screen.getByText('تأییدشده')).toBeInTheDocument();
    expect(screen.getByText('در حال حاضر معتبر')).toBeInTheDocument();
    expect(screen.getByText('مجهز به دستگاه بالانس')).toBeInTheDocument();
    expect(
      screen.getByText('یادداشت خصوصی بازبین (فقط بازبینان پلتفرم می‌بینند): مستندات کامل بود'),
    ).toBeInTheDocument();
    expect(screen.getByText(/۱ سند پیوست‌شده/)).toBeInTheDocument();
    expect(screen.getByText('شکایت تکراری مشتریان')).toBeInTheDocument();
    expect(screen.getByText('باز')).toBeInTheDocument();
  });

  it('says there is no qualification and no suspension when neither exists', () => {
    render(
      <SupplierDetailScreen
        result={{ kind: 'OK', data: { ...DETAIL, qualifications: [], suspensions: [] } }}
      />,
    );
    expect(
      screen.getByText('این تأمین‌کننده هنوز برای هیچ دسته‌ای صلاحیت ارسال نکرده است.'),
    ).toBeInTheDocument();
    expect(screen.getByText('این تأمین‌کننده تا کنون تعلیق نشده است.')).toBeInTheDocument();
  });

  it('shows a closed suspension with its reinstatement note', () => {
    render(
      <SupplierDetailScreen
        result={{
          kind: 'OK',
          data: {
            ...DETAIL,
            suspensions: [
              {
                ...DETAIL.suspensions[0]!,
                open: false,
                reinstatedAt: '2026-09-10T08:00:00.000Z',
                reinstatementNote: 'شکایت پیگیری و برطرف شد',
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText('بسته‌شده')).toBeInTheDocument();
    expect(screen.getByText(/شکایت پیگیری و برطرف شد/)).toBeInTheDocument();
  });

  it('answers another tenant’s supplier exactly as one that does not exist', () => {
    const { container } = render(<SupplierDetailScreen result={{ kind: 'NOT_FOUND' }} />);
    expect(screen.getByText('این تأمین‌کننده پیدا نشد')).toBeInTheDocument();
    expect(container.textContent).not.toContain('SUP_');
  });

  it('renders refusal and degraded outcomes with fixed text', () => {
    const { rerender } = render(<SupplierDetailScreen result={{ kind: 'FORBIDDEN' }} />);
    expect(screen.getByText('این تأمین‌کننده در اختیار شما نیست.')).toBeInTheDocument();

    rerender(
      <SupplierDetailScreen
        result={{ kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-9' }}
      />,
    );
    expect(screen.getByText(/پروندهٔ تأمین‌کننده خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-9/)).toBeInTheDocument();
  });

  it.each<[string, ReadResult<SupplierDetail>]>([
    ['record with history', { kind: 'OK', data: DETAIL }],
    [
      'no qualification, no suspension',
      { kind: 'OK', data: { ...DETAIL, qualifications: [], suspensions: [] } },
    ],
    ['not found', { kind: 'NOT_FOUND' }],
    ['refused', { kind: 'FORBIDDEN' }],
    ['unavailable', { kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-9' }],
    ['malformed', { kind: 'MALFORMED', correlationId: 'corr-2' }],
  ])('has no accessibility violations (%s)', async (_name, result) => {
    const { container } = render(<SupplierDetailScreen result={result} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * Read to render, through the real readers: a 200 whose timestamp is not an
 * instant must reach the screen as the fixed malformed-response text rather
 * than throwing while rendering.
 */
describe('a malformed timestamp, from the response to the page', () => {
  const UPSTREAM = 'UPSTREAM_INVALID_TIMESTAMP';

  beforeEach(() => {
    Object.assign(process.env, {
      API_GATEWAY_URL: 'http://gateway.test:3000',
      OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
      OIDC_CLIENT_ID: 'rasta-web',
      WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
      WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
    });
  });

  afterEach(() => {
    mockCallGateway.mockReset();
  });

  const session = {
    subject: 'USR_1',
    username: 'owner',
    organizationId: 'ORG_OWNER',
    accessToken: 'access-token-value',
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf',
    issuedAt: 1_900_000_000,
  };

  it('shows the fixed list text for a bad registeredAt', async () => {
    mockCallGateway.mockResolvedValue({
      data: { items: [{ ...SUPPLIER, registeredAt: UPSTREAM }], nextCursor: null, hasMore: false },
      correlationId: 'corr-list',
    });
    const result = await fetchSuppliers(session);

    render(<SuppliersScreen result={result} query={{}} />);
    expect(screen.getByText(/فهرست تأمین‌کنندگان خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-list/)).toBeInTheDocument();
  });

  it('shows the fixed detail text for a bad qualification submittedAt', async () => {
    mockCallGateway.mockResolvedValue({
      data: {
        ...SUPPLIER,
        qualifications: [{ ...DETAIL.qualifications[0], submittedAt: UPSTREAM, evidence: [] }],
        suspensions: [],
      },
      correlationId: 'corr-detail',
    });
    const result = await fetchSupplier(session, 'SUP_1');

    render(<SupplierDetailScreen result={result} />);
    expect(screen.getByText(/پروندهٔ تأمین‌کننده خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-detail/)).toBeInTheDocument();
  });

  it('still renders a well-formed record through the same path', async () => {
    mockCallGateway.mockResolvedValue({
      data: {
        ...SUPPLIER,
        qualifications: [{ ...DETAIL.qualifications[0], evidence: [] }],
        suspensions: [],
      },
      correlationId: 'corr-ok',
    });
    const result = await fetchSupplier(session, 'SUP_1');

    render(<SupplierDetailScreen result={result} />);
    expect(screen.getByRole('heading', { name: SUPPLIER.displayName })).toBeInTheDocument();
  });
});

/**
 * Read to render, for a required field that is absent rather than invalid: the
 * page shows the fixed malformed-response text, never the fact a default would
 * have invented ("never suspended", "closed", "no active qualification", "not
 * currently valid", "no documents", no next page).
 */
describe('a missing required field, from the response to the page', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      API_GATEWAY_URL: 'http://gateway.test:3000',
      OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
      OIDC_CLIENT_ID: 'rasta-web',
      WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
      WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
    });
  });

  afterEach(() => {
    mockCallGateway.mockReset();
  });

  const session = {
    subject: 'USR_1',
    username: 'owner',
    organizationId: 'ORG_OWNER',
    accessToken: 'access-token-value',
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf',
    issuedAt: 1_900_000_000,
  };

  // What supplier-service sends for DETAIL's qualification (`evidence`, not `evidenceCount`).
  const QUALIFICATION_WIRE = {
    id: 'QUAL_1',
    capability: 'WORKSHOP_SERVICE',
    state: 'APPROVED',
    statement: 'مجهز به دستگاه بالانس',
    submittedBy: 'USR_A',
    submittedAt: '2026-08-02T08:00:00.000Z',
    decidedBy: 'USR_A',
    decidedAt: '2026-08-03T08:00:00.000Z',
    decisionNote: 'مستندات کامل بود',
    rejectionReason: null,
    evidence: [{ documentId: 'DOC_1', label: null }],
    current: true,
  };
  const SUSPENSION_WIRE = { ...DETAIL.suspensions[0]!, suspendedBy: 'USR_A', reinstatedBy: null };
  const DETAIL_WIRE = {
    ...SUPPLIER,
    registeredBy: 'USR_A',
    qualifications: [QUALIFICATION_WIRE],
    suspensions: [SUSPENSION_WIRE],
  };

  function without<T extends object>(value: T, field: keyof T): unknown {
    const copy: Partial<T> = { ...value };
    delete copy[field];
    return copy;
  }

  async function renderDetail(data: unknown) {
    mockCallGateway.mockResolvedValue({ data, correlationId: 'corr-omit' });
    const result = await fetchSupplier(session, 'SUP_1');
    return render(<SupplierDetailScreen result={result} />);
  }

  it.each<[string, unknown, string]>([
    ['suspensions', without(DETAIL_WIRE, 'suspensions'), 'این تأمین‌کننده تا کنون تعلیق نشده است.'],
    [
      'qualifications',
      without(DETAIL_WIRE, 'qualifications'),
      'این تأمین‌کننده هنوز برای هیچ دسته‌ای صلاحیت ارسال نکرده است.',
    ],
    [
      'a suspension’s open',
      { ...DETAIL_WIRE, suspensions: [without(SUSPENSION_WIRE, 'open')] },
      'بسته‌شده',
    ],
    [
      'a qualification’s current',
      { ...DETAIL_WIRE, qualifications: [without(QUALIFICATION_WIRE, 'current')] },
      'در حال حاضر معتبر نیست',
    ],
    [
      'a qualification’s evidence',
      { ...DETAIL_WIRE, qualifications: [without(QUALIFICATION_WIRE, 'evidence')] },
      'بدون سند پیوست‌شده',
    ],
    ['qualifiedFor', without(DETAIL_WIRE, 'qualifiedFor'), 'در حال حاضر هیچ دسته‌ای'],
  ])(
    'shows the fixed detail text, and no invented fact, when %s is missing',
    async (_f, data, fact) => {
      const { container } = await renderDetail(data);
      expect(screen.getByText(/پروندهٔ تأمین‌کننده خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-omit/)).toBeInTheDocument();
      expect(container.textContent).not.toContain(fact);
    },
  );

  it.each<[string, unknown]>([
    ['hasMore', { items: [SUPPLIER], nextCursor: 'c2' }],
    ['nextCursor', { items: [SUPPLIER], hasMore: true }],
    [
      'qualifiedFor',
      { items: [without(SUPPLIER, 'qualifiedFor')], nextCursor: null, hasMore: false },
    ],
  ])('shows the fixed list text, and no rows, when %s is missing', async (_f, data) => {
    mockCallGateway.mockResolvedValue({ data, correlationId: 'corr-omit-list' });
    const result = await fetchSuppliers(session);

    const { container } = render(<SuppliersScreen result={result} query={{}} />);
    expect(screen.getByText(/فهرست تأمین‌کنندگان خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-omit-list/)).toBeInTheDocument();
    expect(container.textContent).not.toContain(SUPPLIER.displayName);
    expect(container.textContent).not.toContain('در حال حاضر برای هیچ دسته‌ای صلاحیت فعال ندارد');
    expect(screen.queryByRole('link', { name: 'صفحهٔ بعد' })).not.toBeInTheDocument();
  });

  it('renders the same record, complete, as the facts it states', async () => {
    await renderDetail(DETAIL_WIRE);
    expect(screen.getByRole('heading', { name: SUPPLIER.displayName })).toBeInTheDocument();
    expect(screen.getByText('در حال حاضر معتبر')).toBeInTheDocument();
    expect(screen.getByText('باز')).toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import {
  fetchProject,
  fetchProjects,
  type ProjectDetail,
  type ProjectPage,
  type ProjectSummary,
  type ReadResult,
} from '@/server/projects';

import { ProjectsScreen, formatEstimate } from './ProjectsScreen';
import { ProjectDetailScreen } from './[id]/ProjectDetailScreen';

/**
 * What `/projects` and `/projects/[id]` render: every outcome the server read
 * can hand back (empty, permission, degraded, absent), the estimate as Persian
 * digits from a string, and no raw service text.
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

const PROJECT: ProjectSummary = {
  id: 'PRJ_1',
  title: 'زیرسازی جادهٔ دسترسی',
  operationType: 'خاکبرداری',
  locationDescription: 'کیلومتر ۱۲ محور شمالی',
  estimatedCostMinor: '90071992547409931234',
  status: 'APPROVED',
  statusChangedAt: '2026-09-20T08:00:00.000Z',
};

const DETAIL: ProjectDetail = {
  ...PROJECT,
  hasArea: true,
  statusReason: null,
  createdAt: '2026-09-19T08:00:00.000Z',
  scopeOfWork: 'خاکبرداری و تسطیح',
  needsSummary: { draft: 1, submitted: 2, withdrawn: 0 },
};

const page = (
  items: ProjectSummary[],
  nextCursor: string | null = null,
): ReadResult<ProjectPage> => ({
  kind: 'OK',
  data: { items, nextCursor, hasMore: nextCursor !== null },
});

describe('the project list', () => {
  it('shows each project with a status word, a Persian-digit estimate and a link to it', () => {
    render(<ProjectsScreen demoMode="REAL" result={page([PROJECT])} query={{}} />);

    expect(screen.getByRole('link', { name: PROJECT.title })).toHaveAttribute(
      'href',
      '/projects/PRJ_1',
    );
    expect(screen.getAllByText('تأییدشده').length).toBeGreaterThan(0);
    // Past 2^53, exact, and no Latin digit in the money.
    const estimate = formatEstimate(PROJECT.estimatedCostMinor);
    expect(estimate).toMatch(/۹۰[٬,]?۰۷۱/);
    expect(estimate).not.toMatch(/[0-9]/);
    expect(screen.getByText(estimate)).toBeInTheDocument();
  });

  it('says an estimate is missing instead of showing zero', () => {
    expect(formatEstimate(null)).toBe('برآورد نشده');
  });

  it('marks the active filter and keeps it in the next-page link', () => {
    render(
      <ProjectsScreen
        demoMode="REAL"
        result={page([PROJECT], 'c2')}
        query={{ status: 'APPROVED' }}
      />,
    );

    expect(screen.getByRole('link', { name: 'تأییدشده' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      '/projects?status=APPROVED&cursor=c2',
    );
  });

  it('says so when there are none, with and without a filter', () => {
    const { rerender } = render(<ProjectsScreen demoMode="REAL" result={page([])} query={{}} />);
    expect(screen.getByText('این سازمان هنوز پروژه‌ای ثبت نکرده است.')).toBeInTheDocument();

    rerender(<ProjectsScreen demoMode="REAL" result={page([])} query={{ status: 'DRAFT' }} />);
    expect(screen.getByText('پروژه‌ای در وضعیت «پیش‌نویس» نیست.')).toBeInTheDocument();
  });

  it('renders a refusal as no access', () => {
    render(<ProjectsScreen demoMode="REAL" result={{ kind: 'FORBIDDEN' }} query={{}} />);
    expect(screen.getByText('فهرست پروژه‌های این سازمان در اختیار شما نیست.')).toBeInTheDocument();
  });

  it.each([
    { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' },
    { kind: 'MALFORMED', correlationId: 'corr-1' },
  ] as const)(
    'renders a degraded read ($kind) with the correlation id and fixed text',
    (result) => {
      render(<ProjectsScreen demoMode="REAL" result={result} query={{}} />);
      expect(screen.getByText(/فهرست پروژه‌ها خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-1/)).toBeInTheDocument();
    },
  );

  // One test per state, here and in the detail below: each axe run gets the
  // whole default timeout to itself instead of sharing one across the states.
  it.each([
    ['more to page', page([PROJECT], 'c2')],
    ['empty', page([])],
    ['refused', { kind: 'FORBIDDEN' } as const],
    ['not found', { kind: 'NOT_FOUND' } as const],
    ['unavailable', { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' } as const],
    ['malformed', { kind: 'MALFORMED', correlationId: 'corr-1' } as const],
  ])('has no accessibility violations (%s)', async (_name, result) => {
    const { container } = render(<ProjectsScreen demoMode="REAL" result={result} query={{}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the project detail', () => {
  it('shows the record, the scope of work and the needs summary', () => {
    render(<ProjectDetailScreen demoMode="REAL" result={{ kind: 'OK', data: DETAIL }} />);

    expect(screen.getByRole('heading', { name: PROJECT.title })).toBeInTheDocument();
    expect(screen.getByText('خاکبرداری و تسطیح')).toBeInTheDocument();
    expect(screen.getByText('ارسال‌شده: ۲')).toBeInTheDocument();
    expect(screen.getByText('ثبت شده')).toBeInTheDocument();
  });

  it('says there is no scope of work, and shows the reason when the service gave one', () => {
    render(
      <ProjectDetailScreen
        demoMode="REAL"
        result={{
          kind: 'OK',
          data: { ...DETAIL, scopeOfWork: '', needsSummary: null, statusReason: 'نیاز به اصلاح' },
        }}
      />,
    );
    expect(screen.getByText('شرح کاری ثبت نشده')).toBeInTheDocument();
    expect(screen.getByText(/نیاز به اصلاح/)).toBeInTheDocument();
    expect(screen.queryByText('نیازها')).not.toBeInTheDocument();
  });

  it('answers another tenant’s project exactly as one that does not exist', () => {
    const { container } = render(
      <ProjectDetailScreen demoMode="REAL" result={{ kind: 'NOT_FOUND' }} />,
    );
    expect(screen.getByText('این پروژه پیدا نشد')).toBeInTheDocument();
    // No id, and no hint that it exists elsewhere.
    expect(container.textContent).not.toContain('PRJ_');
    expect(container.textContent).not.toContain('سازمان دیگر');
  });

  it('renders refusal and degraded outcomes with fixed text', () => {
    const { rerender } = render(
      <ProjectDetailScreen demoMode="REAL" result={{ kind: 'FORBIDDEN' }} />,
    );
    expect(screen.getByText('این پروژه در اختیار شما نیست.')).toBeInTheDocument();

    rerender(
      <ProjectDetailScreen
        demoMode="REAL"
        result={{ kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-9' }}
      />,
    );
    expect(screen.getByText(/جزئیات پروژه خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-9/)).toBeInTheDocument();
  });

  it.each([
    ['shown', { kind: 'OK', data: DETAIL } as const],
    ['not found', { kind: 'NOT_FOUND' } as const],
    ['refused', { kind: 'FORBIDDEN' } as const],
    ['unavailable', { kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-9' } as const],
    ['malformed', { kind: 'MALFORMED', correlationId: 'corr-2' } as const],
  ])('has no accessibility violations (%s)', async (_name, result) => {
    const { container } = render(<ProjectDetailScreen demoMode="REAL" result={result} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * Read to render, through the real readers: a 200 whose timestamp is not an
 * instant must reach the screen as the fixed malformed-response text. Before
 * the schema checked timestamps it passed as `OK` and the date formatter threw
 * while rendering, with the upstream value in the exception message.
 */
describe('a malformed timestamp, from the response to the page', () => {
  const UPSTREAM = 'UPSTREAM_INVALID_TIMESTAMP';

  const wire = {
    ...DETAIL,
    organizationId: 'ORG_OWNER',
    statusChangedBy: 'USR_X',
    createdBy: 'USR_X',
    updatedAt: UPSTREAM,
  };

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

  it.each(['statusChangedAt'])('shows the fixed list text for a bad %s', async (field) => {
    mockCallGateway.mockResolvedValue({
      data: { items: [{ ...wire, [field]: UPSTREAM }], nextCursor: null, hasMore: false },
      correlationId: 'corr-list',
    });
    const result = await fetchProjects(session);

    const { container } = render(<ProjectsScreen demoMode="REAL" result={result} query={{}} />);
    expect(screen.getByText(/فهرست پروژه‌ها خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-list/)).toBeInTheDocument();
    expect(container.textContent).not.toContain(UPSTREAM);
  });

  it.each(['statusChangedAt', 'createdAt'])(
    'shows the fixed detail text for a bad %s',
    async (field) => {
      mockCallGateway.mockResolvedValue({
        data: { ...wire, [field]: UPSTREAM },
        correlationId: 'corr-detail',
      });
      const result = await fetchProject(session, 'PRJ_1');

      const { container } = render(<ProjectDetailScreen demoMode="REAL" result={result} />);
      expect(screen.getByText(/جزئیات پروژه خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-detail/)).toBeInTheDocument();
      expect(container.textContent).not.toContain(UPSTREAM);
    },
  );

  it('still renders a well-formed record through the same path', async () => {
    mockCallGateway.mockResolvedValue({
      data: { ...wire, updatedAt: '2026-09-20T08:00:00.000Z' },
      correlationId: 'corr-ok',
    });
    const result = await fetchProject(session, 'PRJ_1');

    render(<ProjectDetailScreen demoMode="REAL" result={result} />);
    expect(screen.getByRole('heading', { name: PROJECT.title })).toBeInTheDocument();
  });
});

describe('the project list and the project: «حالت نمایشی» over the estimates (Q-14)', () => {
  const LABEL = 'حالت نمایشی';
  const UNKNOWN = 'وضعیت درگاه پرداخت معلوم نیست';

  it.each([
    ['SIMULATED', LABEL],
    ['UNKNOWN', UNKNOWN],
  ] as const)('draws %s’s notice on both', (demoMode, text) => {
    const list = render(<ProjectsScreen demoMode={demoMode} result={page([PROJECT])} query={{}} />);
    expect(list.getByText(text)).toBeInTheDocument();
    list.unmount();
    render(<ProjectDetailScreen demoMode={demoMode} result={{ kind: 'OK', data: DETAIL }} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('draws none on either once the provider is real', () => {
    const list = render(<ProjectsScreen demoMode="REAL" result={page([PROJECT])} query={{}} />);
    expect(list.queryByText(LABEL)).toBeNull();
    expect(list.queryByText(UNKNOWN)).toBeNull();
    list.unmount();
    render(<ProjectDetailScreen demoMode="REAL" result={{ kind: 'OK', data: DETAIL }} />);
    expect(screen.queryByText(LABEL)).toBeNull();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
  });
});

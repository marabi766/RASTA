import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import {
  fetchOpenTender,
  fetchOpenTenders,
  fetchTender,
  fetchTenders,
  type OpenTenderDetail,
  type OpenTenderPage,
  type OpenTenderSummary,
  type ReadResult,
  type TenderCriteria,
  type TenderDetail,
  type TenderPage,
  type TenderSummary,
} from '@/server/tenders';

import { TendersScreen, formatBidWindow, type TendersView } from './TendersScreen';
import { OpenTenderDetailScreen, OwnTenderDetailScreen } from './[id]/TenderDetailScreen';

/**
 * What `/tenders` and `/tenders/[id]` render: every outcome the server read can
 * hand back (empty, permission, degraded, absent) on both sides, Jalali windows
 * with Persian digits, and no raw service text. Nothing here has a bid in it.
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

const OWN: TenderSummary = {
  id: 'TND_1',
  title: 'زیرسازی جادهٔ دسترسی',
  procurementNature: 'FORMAL_TENDER',
  visibility: 'RESTRICTED',
  bidOpeningAt: '2026-10-20T08:00:00.000Z',
  bidClosingAt: '2026-10-30T08:00:00.000Z',
  status: 'PUBLISHED',
  statusChangedAt: '2026-10-19T08:00:00.000Z',
};

const OPEN: OpenTenderSummary = {
  id: 'TND_9',
  title: 'آسفالت محور شمالی',
  procurementNature: 'INQUIRY',
  visibility: 'PUBLIC',
  bidOpeningAt: '2026-10-20T08:00:00.000Z',
  bidClosingAt: '2026-10-30T08:00:00.000Z',
};

const OWN_DETAIL: TenderDetail = {
  ...OWN,
  projectId: 'PRJ_1',
  scopeOfWork: 'خاکبرداری و تسطیح',
  statusReason: null,
  statusReasonCode: null,
  publishedAt: '2026-10-19T08:00:00.000Z',
  createdAt: '2026-10-18T08:00:00.000Z',
};

const OPEN_DETAIL: OpenTenderDetail = {
  ...OPEN,
  scopeOfWork: 'آسفالت دو لایه',
  criteria: [
    { code: 'PRICE', label: 'قیمت', weightBp: 6000, scoringMethod: 'MANUAL_SCORE', maxScore: 100 },
    { code: 'ISO', label: 'گواهی کیفیت', weightBp: 4000, scoringMethod: 'PASS_FAIL', maxScore: 1 },
  ],
};

const CRITERIA: TenderCriteria = {
  items: OPEN_DETAIL.criteria.map((criterion) => ({ ...criterion })),
  totalWeightBp: 10000,
  complete: true,
};

const ownPage = (
  items: TenderSummary[],
  nextCursor: string | null = null,
): ReadResult<TenderPage> => ({
  kind: 'OK',
  data: { items, nextCursor, hasMore: nextCursor !== null },
});

const openPage = (
  items: OpenTenderSummary[],
  nextCursor: string | null = null,
): ReadResult<OpenTenderPage> => ({
  kind: 'OK',
  data: { items, nextCursor, hasMore: nextCursor !== null },
});

const sides = (
  own: ReadResult<TenderPage> | null,
  open: ReadResult<OpenTenderPage> | null,
): TendersView => ({ kind: 'SIDES', own, open });

describe('the tender list, owner side', () => {
  it('shows each tender with a status word, a Jalali window in Persian digits and a link to it', () => {
    const { container } = render(<TendersScreen view={sides(ownPage([OWN]), null)} query={{}} />);

    expect(screen.getByRole('link', { name: OWN.title })).toHaveAttribute('href', '/tenders/TND_1');
    expect(screen.getAllByText('منتشرشده').length).toBeGreaterThan(0);
    expect(screen.getByText(/مناقصه · فقط دعوت‌شدگان/)).toBeInTheDocument();
    const window = formatBidWindow(OWN.bidOpeningAt, OWN.bidClosingAt);
    expect(window).toMatch(/^از ۱۴۰۵\/۰۷\/۲۸ .* تا ۱۴۰۵\/۰۸\/۰۸ /);
    expect(screen.getByText(window)).toBeInTheDocument();
    expect(container.textContent).not.toContain('2026');
  });

  it('says a window is missing rather than showing a blank', () => {
    expect(formatBidWindow(null, null)).toBe('بازهٔ پیشنهاد تعیین نشده');
  });

  it('marks the active filter and keeps it in the next-page link', () => {
    render(
      <TendersScreen view={sides(ownPage([OWN], 'c2'), null)} query={{ status: 'PUBLISHED' }} />,
    );

    expect(screen.getByRole('link', { name: 'منتشرشده' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      '/tenders?status=PUBLISHED&cursor=c2',
    );
  });

  it('says so when there are none, with and without a filter', () => {
    const { rerender } = render(<TendersScreen view={sides(ownPage([]), null)} query={{}} />);
    expect(screen.getByText('این سازمان هنوز مناقصه‌ای ثبت نکرده است.')).toBeInTheDocument();

    rerender(<TendersScreen view={sides(ownPage([]), null)} query={{ status: 'DRAFT' }} />);
    expect(screen.getByText('مناقصه‌ای در وضعیت «پیش‌نویس» نیست.')).toBeInTheDocument();
  });

  it('renders a refusal as no access, with fixed text', () => {
    render(<TendersScreen view={sides({ kind: 'FORBIDDEN' }, null)} query={{}} />);
    expect(screen.getByText('فهرست مناقصه‌های این سازمان در اختیار شما نیست.')).toBeInTheDocument();
  });

  it.each([
    { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' },
    { kind: 'MALFORMED', correlationId: 'corr-1' },
  ] as const)(
    'renders a degraded read ($kind) with the correlation id and fixed text',
    (result) => {
      render(<TendersScreen view={sides(result, null)} query={{}} />);
      expect(screen.getByText(/فهرست مناقصه‌ها خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-1/)).toBeInTheDocument();
    },
  );
});

describe('the tender list, bidder side', () => {
  it('links each open tender to the bidder’s door and shows no status or bid information', () => {
    const { container } = render(<TendersScreen view={sides(null, openPage([OPEN]))} query={{}} />);

    expect(screen.getByRole('link', { name: OPEN.title })).toHaveAttribute(
      'href',
      '/tenders/TND_9?view=open',
    );
    expect(screen.getByText(/استعلام · عمومی/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'وضعیت مناقصه' })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/پیشنهاددهنده|تعداد پیشنهاد/);
  });

  it('pages on its own cursor, leaving the owner’s alone', () => {
    render(
      <TendersScreen
        view={sides(ownPage([OWN], 'o2'), openPage([OPEN], 'b2'))}
        query={{ status: 'PUBLISHED', cursor: 'o1' }}
      />,
    );

    const next = screen
      .getAllByRole('link', { name: 'صفحهٔ بعد' })
      .map((a) => a.getAttribute('href'));
    expect(next).toEqual([
      '/tenders?status=PUBLISHED&cursor=o2',
      '/tenders?status=PUBLISHED&cursor=o1&openCursor=b2',
    ]);
  });

  it('says so when nothing is open, and renders refusal and degraded reads as fixed text', () => {
    const { rerender } = render(<TendersScreen view={sides(null, openPage([]))} query={{}} />);
    expect(screen.getByText('مناقصهٔ بازی نیست')).toBeInTheDocument();

    rerender(<TendersScreen view={sides(null, { kind: 'FORBIDDEN' })} query={{}} />);
    expect(screen.getByText('مناقصه‌های باز برای پیشنهاد در اختیار شما نیست.')).toBeInTheDocument();

    rerender(
      <TendersScreen
        view={sides(null, { kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-7' })}
        query={{}}
      />,
    );
    expect(screen.getByText(/فهرست مناقصه‌های باز خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-7/)).toBeInTheDocument();
  });
});

describe('the tender list, when the roles could not be read', () => {
  it('asks nothing and says so', () => {
    render(
      <TendersScreen view={{ kind: 'IDENTITY_UNAVAILABLE', correlationId: 'corr-3' }} query={{}} />,
    );
    expect(screen.getByText(/نقش شما در این سازمان خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-3/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('the tender list has no accessibility violations in any state', () => {
  it('passes jest-axe', async () => {
    const failures = [
      { kind: 'FORBIDDEN' } as const,
      { kind: 'NOT_FOUND' } as const,
      { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' } as const,
      { kind: 'MALFORMED', correlationId: 'corr-1' } as const,
    ];
    const views: TendersView[] = [
      sides(ownPage([OWN], 'c2'), openPage([OPEN], 'b2')),
      sides(ownPage([]), openPage([])),
      { kind: 'IDENTITY_UNAVAILABLE', correlationId: 'corr-3' },
      ...failures.flatMap((failure) => [sides(failure, null), sides(null, failure)]),
    ];

    for (const view of views) {
      const { container, unmount } = render(<TendersScreen view={view} query={{}} />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  }, 60_000);
});

describe('the owner’s tender detail', () => {
  it('shows the record, the window, the scope and the criteria summary', () => {
    const { container } = render(
      <OwnTenderDetailScreen
        result={{ kind: 'OK', data: OWN_DETAIL }}
        criteria={{ kind: 'OK', data: CRITERIA }}
      />,
    );

    expect(screen.getByRole('heading', { name: OWN.title })).toBeInTheDocument();
    expect(screen.getByText('خاکبرداری و تسطیح')).toBeInTheDocument();
    expect(screen.getByText(/۲ معیار · مجموع وزن‌ها ۱۰۰٪/)).toBeInTheDocument();
    expect(screen.getByText('قیمت')).toBeInTheDocument();
    expect(screen.getByText(/وزن ۶۰٪ · امتیازدهی دستی · حداکثر امتیاز ۱۰۰/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('2026');
  });

  it('says a DRAFT has no window or publication yet, and a cancelled tender why', () => {
    render(
      <OwnTenderDetailScreen
        result={{
          kind: 'OK',
          data: {
            ...OWN_DETAIL,
            status: 'CANCELLED',
            bidOpeningAt: null,
            bidClosingAt: null,
            publishedAt: null,
            scopeOfWork: '',
            statusReasonCode: 'NO_QUALIFIED_BID',
            statusReason: 'هیچ پیشنهادی صلاحیت نداشت',
          },
        }}
        criteria={{ kind: 'OK', data: { items: [], totalWeightBp: 0, complete: false } }}
      />,
    );

    expect(screen.getByText('منتشر نشده')).toBeInTheDocument();
    expect(screen.getAllByText('تعیین نشده').length).toBe(2);
    expect(screen.getByText('شرح کاری ثبت نشده')).toBeInTheDocument();
    expect(screen.getByText('دلیل: پیشنهاد واجد شرایطی نبود')).toBeInTheDocument();
    expect(screen.getByText(/هیچ پیشنهادی صلاحیت نداشت/)).toBeInTheDocument();
    expect(screen.getByText('معیاری ثبت نشده')).toBeInTheDocument();
  });

  it('flags weights that do not sum to the whole', () => {
    render(
      <OwnTenderDetailScreen
        result={{ kind: 'OK', data: { ...OWN_DETAIL, status: 'DRAFT' } }}
        criteria={{
          kind: 'OK',
          data: { items: [CRITERIA.items[0]!], totalWeightBp: 6000, complete: false },
        }}
      />,
    );
    expect(screen.getByText(/مجموع وزن‌ها ۶۰٪ \(کامل نیست\)/)).toBeInTheDocument();
  });

  it('keeps the tender when only the criteria could not be read', () => {
    render(
      <OwnTenderDetailScreen
        result={{ kind: 'OK', data: OWN_DETAIL }}
        criteria={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-c' }}
      />,
    );
    expect(screen.getByRole('heading', { name: OWN.title })).toBeInTheDocument();
    expect(screen.getByText(/معیارهای ارزیابی خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-c/)).toBeInTheDocument();
  });

  it('answers a tender the caller may not see exactly as one that does not exist', () => {
    const { container } = render(
      <OwnTenderDetailScreen result={{ kind: 'NOT_FOUND' }} criteria={null} />,
    );
    expect(screen.getByText('این مناقصه پیدا نشد')).toBeInTheDocument();
    // No id, and no hint that it exists elsewhere.
    expect(container.textContent).not.toContain('TND_');
    expect(container.textContent).not.toContain('سازمان دیگر');
  });

  it('renders refusal and degraded outcomes with fixed text', () => {
    const { rerender } = render(
      <OwnTenderDetailScreen result={{ kind: 'FORBIDDEN' }} criteria={null} />,
    );
    expect(screen.getByText('این مناقصه در اختیار شما نیست.')).toBeInTheDocument();

    rerender(
      <OwnTenderDetailScreen
        result={{ kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-9' }}
        criteria={null}
      />,
    );
    expect(screen.getByText(/جزئیات مناقصه خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-9/)).toBeInTheDocument();
  });

  it('has no accessibility violations in any state', async () => {
    const states: {
      result: ReadResult<TenderDetail>;
      criteria: ReadResult<TenderCriteria> | null;
    }[] = [
      { result: { kind: 'OK', data: OWN_DETAIL }, criteria: { kind: 'OK', data: CRITERIA } },
      {
        result: {
          kind: 'OK',
          data: {
            ...OWN_DETAIL,
            status: 'CANCELLED',
            statusReasonCode: 'OWNER_REQUEST',
            statusReason: 'x',
          },
        },
        criteria: { kind: 'OK', data: { items: [], totalWeightBp: 0, complete: false } },
      },
      { result: { kind: 'OK', data: OWN_DETAIL }, criteria: { kind: 'FORBIDDEN' } },
      {
        result: { kind: 'OK', data: OWN_DETAIL },
        criteria: { kind: 'MALFORMED', correlationId: 'c' },
      },
      { result: { kind: 'NOT_FOUND' }, criteria: null },
      { result: { kind: 'FORBIDDEN' }, criteria: null },
      { result: { kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-9' }, criteria: null },
      { result: { kind: 'MALFORMED', correlationId: 'corr-2' }, criteria: null },
    ];

    for (const state of states) {
      const { container, unmount } = render(
        <OwnTenderDetailScreen result={state.result} criteria={state.criteria} />,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  }, 60_000);
});

describe('the bidder’s tender detail', () => {
  it('shows the window, the scope and the frozen criteria, and offers no bid form', () => {
    render(<OpenTenderDetailScreen result={{ kind: 'OK', data: OPEN_DETAIL }} />);

    expect(screen.getByRole('heading', { name: OPEN.title })).toBeInTheDocument();
    expect(screen.getByText('آسفالت دو لایه')).toBeInTheDocument();
    expect(screen.getByText(/وزن ۴۰٪ · قبول یا رد · حداکثر امتیاز ۱/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('says so when no criteria were announced', () => {
    render(
      <OpenTenderDetailScreen result={{ kind: 'OK', data: { ...OPEN_DETAIL, criteria: [] } }} />,
    );
    expect(screen.getByText('معیاری ثبت نشده')).toBeInTheDocument();
  });

  it('renders every non-OK outcome with fixed text and no id', () => {
    for (const [result, text] of [
      [{ kind: 'NOT_FOUND' }, 'این مناقصه پیدا نشد'],
      [{ kind: 'FORBIDDEN' }, 'این مناقصه در اختیار شما نیست.'],
      [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-5' }, /جزئیات مناقصه خوانده نشد/],
      [{ kind: 'MALFORMED', correlationId: 'corr-6' }, /جزئیات مناقصه خوانده نشد/],
    ] as const) {
      const { container, unmount } = render(<OpenTenderDetailScreen result={result} />);
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(container.textContent).not.toContain('TND_');
      unmount();
    }
  });

  it('has no accessibility violations in any state', async () => {
    const results: ReadResult<OpenTenderDetail>[] = [
      { kind: 'OK', data: OPEN_DETAIL },
      { kind: 'OK', data: { ...OPEN_DETAIL, criteria: [], scopeOfWork: '' } },
      { kind: 'NOT_FOUND' },
      { kind: 'FORBIDDEN' },
      { kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-9' },
      { kind: 'MALFORMED', correlationId: 'corr-2' },
    ];
    for (const result of results) {
      const { container, unmount } = render(<OpenTenderDetailScreen result={result} />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  }, 60_000);
});

/**
 * Read to render, through the real readers: a 200 whose timestamp is not an
 * instant must reach the screen as the fixed malformed-response text, with the
 * upstream value nowhere in the page.
 */
describe('a malformed timestamp, from the response to the page', () => {
  const UPSTREAM = 'UPSTREAM_INVALID_TIMESTAMP';

  const wire = {
    ...OWN_DETAIL,
    organizationId: 'ORG_OWNER',
    statusChangedBy: 'USR_X',
    createdBy: 'USR_X',
    updatedAt: '2026-10-19T08:00:00.000Z',
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

  it.each(['statusChangedAt', 'bidOpeningAt', 'bidClosingAt'])(
    'shows the fixed owner list text for a bad %s',
    async (field) => {
      mockCallGateway.mockResolvedValue({
        data: { items: [{ ...wire, [field]: UPSTREAM }], nextCursor: null, hasMore: false },
        correlationId: 'corr-list',
      });
      const result = await fetchTenders(session);

      const { container } = render(<TendersScreen view={sides(result, null)} query={{}} />);
      expect(screen.getByText(/فهرست مناقصه‌ها خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-list/)).toBeInTheDocument();
      expect(container.textContent).not.toContain(UPSTREAM);
    },
  );

  it.each(['statusChangedAt', 'createdAt', 'publishedAt'])(
    'shows the fixed owner detail text for a bad %s',
    async (field) => {
      mockCallGateway.mockResolvedValue({
        data: { ...wire, [field]: UPSTREAM },
        correlationId: 'corr-detail',
      });
      const result = await fetchTender(session, 'TND_1');

      const { container } = render(<OwnTenderDetailScreen result={result} criteria={null} />);
      expect(screen.getByText(/جزئیات مناقصه خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-detail/)).toBeInTheDocument();
      expect(container.textContent).not.toContain(UPSTREAM);
    },
  );

  it.each(['bidOpeningAt', 'bidClosingAt'])(
    'shows the fixed bidder text for a bad %s, in the list and the detail',
    async (field) => {
      const bad = { ...OPEN_DETAIL, [field]: UPSTREAM };

      mockCallGateway.mockResolvedValue({
        data: { items: [bad], nextCursor: null, hasMore: false },
        correlationId: 'corr-open',
      });
      const list = render(
        <TendersScreen view={sides(null, await fetchOpenTenders(session))} query={{}} />,
      );
      expect(screen.getByText(/فهرست مناقصه‌های باز خوانده نشد/)).toBeInTheDocument();
      expect(list.container.textContent).not.toContain(UPSTREAM);
      list.unmount();

      mockCallGateway.mockResolvedValue({ data: bad, correlationId: 'corr-open-detail' });
      const detail = render(
        <OpenTenderDetailScreen result={await fetchOpenTender(session, 'TND_9')} />,
      );
      expect(screen.getByText(/جزئیات مناقصه خوانده نشد/)).toBeInTheDocument();
      expect(detail.container.textContent).not.toContain(UPSTREAM);
    },
  );

  it('still renders a well-formed record through the same path', async () => {
    mockCallGateway.mockResolvedValue({ data: wire, correlationId: 'corr-ok' });
    const result = await fetchTender(session, 'TND_1');

    render(<OwnTenderDetailScreen result={result} criteria={null} />);
    expect(screen.getByRole('heading', { name: OWN.title })).toBeInTheDocument();
  });
});

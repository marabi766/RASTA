import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import {
  fetchAmendments,
  fetchContract,
  fetchContracts,
  fetchMilestones,
  type Amendment,
  type AmendmentPage,
  type ContractDetail,
  type ContractPage,
  type ContractSummary,
  type Milestone,
  type MilestonePage,
  type ReadResult,
} from '@/server/contracts';

import { ContractsScreen } from './ContractsScreen';
import { ContractDetailScreen } from './[id]/ContractDetailScreen';

/**
 * What `/contracts` and `/contracts/[id]` render: every outcome the server
 * read can hand back (empty, permission, degraded, absent), money as a
 * Persian-digit decimal string never converted to a number, Jalali dates, and
 * no raw service text.
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

const CONTRACT: ContractSummary = {
  id: 'CNT_1',
  organizationId: 'ORG_EMPLOYER',
  contractorOrganizationId: 'ORG_CONTRACTOR',
  tenderId: 'TND_1',
  projectId: 'PRJ_1',
  status: 'SIGNED',
  amountMinor: '90071992547409931234',
  currentAmountMinor: '90071992547409931234',
  awardedAt: '2026-10-01T08:00:00.000Z',
  statusChangedAt: '2026-10-05T08:00:00.000Z',
};

const DETAIL: ContractDetail = {
  ...CONTRACT,
  winningBidId: 'BID_1',
  amendmentsTotalMinor: '0',
  employerSignedAt: '2026-10-04T08:00:00.000Z',
  contractorSignedAt: '2026-10-05T08:00:00.000Z',
  authorityReviewRequired: false,
  authorityReviewReason: null,
  cancelReasonCode: null,
  cancelNote: null,
  createdAt: '2026-10-01T08:05:00.000Z',
  updatedAt: '2026-10-05T08:00:00.000Z',
  version: 2,
};

const AMENDMENT: Amendment = {
  id: 'AMD_1',
  contractId: 'CNT_1',
  organizationId: 'ORG_EMPLOYER',
  amendmentNumber: 1,
  deltaMinor: '5000000',
  reasonCode: 'SCOPE_CHANGE',
  reasonText: 'افزایش محدودهٔ کار',
  status: 'PROPOSED',
  employerSignedAt: '2026-10-06T08:00:00.000Z',
  contractorSignedAt: null,
  authorityReviewRequired: false,
  proposedAt: '2026-10-06T08:00:00.000Z',
  effectiveAt: null,
  updatedAt: '2026-10-06T08:00:00.000Z',
  version: 1,
};

const MILESTONE: Milestone = {
  id: 'MST_1',
  contractId: 'CNT_1',
  organizationId: 'ORG_EMPLOYER',
  title: 'تکمیل فاز اول',
  plannedDate: '2026-11-15',
  plannedShareBp: 2500,
  referenced: false,
  createdAt: '2026-10-01T08:05:00.000Z',
  updatedAt: '2026-10-01T08:05:00.000Z',
  version: 1,
};

const page = (
  items: ContractSummary[],
  nextCursor: string | null = null,
): ReadResult<ContractPage> => ({
  kind: 'OK',
  data: { items, nextCursor, hasMore: nextCursor !== null },
});

const amendmentPage = (
  items: Amendment[],
  nextCursor: string | null = null,
): ReadResult<AmendmentPage> => ({
  kind: 'OK',
  data: { items, nextCursor, hasMore: nextCursor !== null },
});

const milestonePage = (items: Milestone[]): ReadResult<MilestonePage> => ({
  kind: 'OK',
  data: { items, nextCursor: null, hasMore: false },
});

describe('the contract list', () => {
  it('shows each contract with a status word, both parties, a Persian-digit amount and a link to it', () => {
    render(<ContractsScreen result={page([CONTRACT])} query={{}} />);

    expect(screen.getByRole('link', { name: /CNT_1/ })).toHaveAttribute('href', '/contracts/CNT_1');
    expect(screen.getAllByText('امضاشده').length).toBeGreaterThan(0);
    expect(screen.getByText(/ORG_EMPLOYER/)).toBeInTheDocument();
    expect(screen.getByText(/ORG_CONTRACTOR/)).toBeInTheDocument();
    expect(screen.getByText(/۹۰[٬,]?۰۷۱/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/90071992547409931234/);
  });

  it('marks the active filter and keeps it in the next-page link', () => {
    render(<ContractsScreen result={page([CONTRACT], 'c2')} query={{ status: 'SIGNED' }} />);

    expect(screen.getByRole('link', { name: 'امضاشده' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      '/contracts?status=SIGNED&cursor=c2',
    );
  });

  it('says so when there are none, with and without a filter', () => {
    const { rerender } = render(<ContractsScreen result={page([])} query={{}} />);
    expect(screen.getByText('این سازمان هنوز طرف هیچ قراردادی نیست.')).toBeInTheDocument();

    rerender(<ContractsScreen result={page([])} query={{ status: 'DRAFT' }} />);
    expect(screen.getByText('قراردادی در وضعیت «پیش‌نویس» نیست.')).toBeInTheDocument();
  });

  it('renders a refusal as no access, with fixed text', () => {
    render(<ContractsScreen result={{ kind: 'FORBIDDEN' }} query={{}} />);
    expect(screen.getByText('فهرست قراردادهای این سازمان در اختیار شما نیست.')).toBeInTheDocument();
  });

  it.each([
    { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' },
    { kind: 'MALFORMED', correlationId: 'corr-1' },
  ] as const)(
    'renders a degraded read ($kind) with the correlation id and fixed text',
    (result) => {
      render(<ContractsScreen result={result} query={{}} />);
      expect(screen.getByText(/فهرست قراردادها خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-1/)).toBeInTheDocument();
    },
  );

  // One test per state: each axe run gets the whole default timeout to
  // itself instead of sharing one across every state (#297).
  it.each<[string, ReadResult<ContractPage>]>([
    ['more to page', page([CONTRACT], 'c2')],
    ['empty', page([])],
    ['refused', { kind: 'FORBIDDEN' }],
    ['not found', { kind: 'NOT_FOUND' }],
    ['unavailable', { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' }],
    ['malformed', { kind: 'MALFORMED', correlationId: 'corr-1' }],
  ])('has no accessibility violations (%s)', async (_name, result) => {
    const { container } = render(<ContractsScreen result={result} query={{}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the contract detail', () => {
  it('shows status, parties, amounts, signature facts, amendments and milestones', () => {
    render(
      <ContractDetailScreen
        result={{ kind: 'OK', data: DETAIL }}
        amendments={amendmentPage([AMENDMENT])}
        milestones={milestonePage([MILESTONE])}
      />,
    );

    expect(screen.getAllByText('امضاشده').length).toBeGreaterThan(0);
    expect(screen.getByText('ORG_EMPLOYER')).toBeInTheDocument();
    expect(screen.getByText('ORG_CONTRACTOR')).toBeInTheDocument();
    expect(screen.getByText('افزایش محدودهٔ کار')).toBeInTheDocument();
    expect(screen.getByText('تکمیل فاز اول')).toBeInTheDocument();
    expect(screen.getByText(/۲۵٪/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/90071992547409931234/);
  });

  it('says a signature has not happened yet, and shows the authority-review note when flagged', () => {
    render(
      <ContractDetailScreen
        result={{
          kind: 'OK',
          data: { ...DETAIL, contractorSignedAt: null, authorityReviewRequired: true },
        }}
        amendments={amendmentPage([])}
        milestones={milestonePage([])}
      />,
    );

    expect(screen.getByText('هنوز امضا نشده')).toBeInTheDocument();
    expect(screen.getByText(/در حال بازبینی اختیار است/)).toBeInTheDocument();
  });

  it('shows the cancellation reason on a cancelled contract', () => {
    render(
      <ContractDetailScreen
        result={{
          kind: 'OK',
          data: {
            ...DETAIL,
            status: 'CANCELLED',
            cancelReasonCode: 'MUTUAL_AGREEMENT',
            cancelNote: 'توافق دو طرف',
          },
        }}
        amendments={amendmentPage([])}
        milestones={milestonePage([])}
      />,
    );

    expect(screen.getByText(/MUTUAL_AGREEMENT/)).toBeInTheDocument();
    expect(screen.getByText(/توافق دو طرف/)).toBeInTheDocument();
  });

  it('says there are no amendments or milestones, each independently', () => {
    render(
      <ContractDetailScreen
        result={{ kind: 'OK', data: DETAIL }}
        amendments={amendmentPage([])}
        milestones={milestonePage([])}
      />,
    );

    expect(screen.getByText('برای این قرارداد هنوز الحاقیه‌ای ثبت نشده است.')).toBeInTheDocument();
    expect(
      screen.getByText('برای این قرارداد هنوز Milestoneای برنامه‌ریزی نشده است.'),
    ).toBeInTheDocument();
  });

  it('links to the next page of amendments, under the contract, when the service says there is more', () => {
    render(
      <ContractDetailScreen
        result={{ kind: 'OK', data: DETAIL }}
        amendments={amendmentPage([AMENDMENT], 'a2')}
        milestones={milestonePage([MILESTONE])}
      />,
    );

    expect(screen.getByRole('link', { name: 'صفحهٔ بعدِ الحاقیه‌ها' })).toHaveAttribute(
      'href',
      '/contracts/CNT_1?amendmentCursor=a2',
    );
  });

  it('shows no amendments pagination link when the service says there is no more', () => {
    render(
      <ContractDetailScreen
        result={{ kind: 'OK', data: DETAIL }}
        amendments={amendmentPage([AMENDMENT])}
        milestones={milestonePage([MILESTONE])}
      />,
    );

    expect(screen.queryByRole('link', { name: 'صفحهٔ بعدِ الحاقیه‌ها' })).not.toBeInTheDocument();
  });

  it('keeps the contract when only the amendments or only the milestones could not be read', () => {
    render(
      <ContractDetailScreen
        result={{ kind: 'OK', data: DETAIL }}
        amendments={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-a' }}
        milestones={{ kind: 'FORBIDDEN' }}
      />,
    );

    expect(screen.getByText(/الحاقیه‌ها خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-a/)).toBeInTheDocument();
    expect(screen.getByText('Milestoneهای این قرارداد در اختیار شما نیست.')).toBeInTheDocument();
  });

  it('answers a contract the caller may not see exactly as one that does not exist', () => {
    const { container } = render(
      <ContractDetailScreen result={{ kind: 'NOT_FOUND' }} amendments={null} milestones={null} />,
    );
    expect(screen.getByText('این قرارداد پیدا نشد')).toBeInTheDocument();
    // No id, and no hint that it exists elsewhere.
    expect(container.textContent).not.toContain('CNT_');
    expect(container.textContent).not.toContain('سازمان دیگر');
  });

  it('renders refusal and degraded outcomes with fixed text', () => {
    const { rerender } = render(
      <ContractDetailScreen result={{ kind: 'FORBIDDEN' }} amendments={null} milestones={null} />,
    );
    expect(screen.getByText('این قرارداد در اختیار شما نیست.')).toBeInTheDocument();

    rerender(
      <ContractDetailScreen
        result={{ kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-9' }}
        amendments={null}
        milestones={null}
      />,
    );
    expect(screen.getByText(/جزئیات قرارداد خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-9/)).toBeInTheDocument();
  });

  it.each<
    [
      string,
      ReadResult<ContractDetail>,
      ReadResult<AmendmentPage> | null,
      ReadResult<MilestonePage> | null,
    ]
  >([
    [
      'with amendments and milestones',
      { kind: 'OK', data: DETAIL },
      amendmentPage([AMENDMENT]),
      milestonePage([MILESTONE]),
    ],
    [
      'with an amendments pagination link',
      { kind: 'OK', data: DETAIL },
      amendmentPage([AMENDMENT], 'a2'),
      milestonePage([MILESTONE]),
    ],
    [
      'no amendments or milestones',
      { kind: 'OK', data: DETAIL },
      amendmentPage([]),
      milestonePage([]),
    ],
    ['amendments refused', { kind: 'OK', data: DETAIL }, { kind: 'FORBIDDEN' }, milestonePage([])],
    [
      'milestones malformed',
      { kind: 'OK', data: DETAIL },
      amendmentPage([]),
      { kind: 'MALFORMED', correlationId: 'c' },
    ],
    ['not found', { kind: 'NOT_FOUND' }, null, null],
    ['refused', { kind: 'FORBIDDEN' }, null, null],
    ['unavailable', { kind: 'UNAVAILABLE', status: 502, correlationId: 'corr-9' }, null, null],
    ['malformed', { kind: 'MALFORMED', correlationId: 'corr-2' }, null, null],
  ])('has no accessibility violations (%s)', async (_name, result, amendments, milestones) => {
    const { container } = render(
      <ContractDetailScreen result={result} amendments={amendments} milestones={milestones} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * Read to render, through the real readers: a 200 whose timestamp is not an
 * instant must reach the screen as the fixed malformed-response text, with
 * the upstream value nowhere in the page.
 */
describe('a malformed timestamp, from the response to the page', () => {
  const UPSTREAM = 'UPSTREAM_INVALID_TIMESTAMP';

  const wire = {
    ...DETAIL,
    employerSignedAt: null,
    contractorSignedAt: null,
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
    organizationId: 'ORG_EMPLOYER',
    accessToken: 'access-token-value',
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf',
    issuedAt: 1_900_000_000,
  };

  it.each(['awardedAt', 'statusChangedAt'])(
    'shows the fixed list text for a bad %s',
    async (field) => {
      mockCallGateway.mockResolvedValue({
        data: { items: [{ ...wire, [field]: UPSTREAM }], nextCursor: null, hasMore: false },
        correlationId: 'corr-list',
      });
      const result = await fetchContracts(session);

      const { container } = render(<ContractsScreen result={result} query={{}} />);
      expect(screen.getByText(/فهرست قراردادها خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-list/)).toBeInTheDocument();
      expect(container.textContent).not.toContain(UPSTREAM);
    },
  );

  it.each(['createdAt', 'updatedAt', 'awardedAt', 'statusChangedAt'])(
    'shows the fixed detail text for a bad %s',
    async (field) => {
      mockCallGateway.mockResolvedValue({
        data: { ...wire, [field]: UPSTREAM },
        correlationId: 'corr-detail',
      });
      const result = await fetchContract(session, 'CNT_1');

      const { container } = render(
        <ContractDetailScreen result={result} amendments={null} milestones={null} />,
      );
      expect(screen.getByText(/جزئیات قرارداد خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-detail/)).toBeInTheDocument();
      expect(container.textContent).not.toContain(UPSTREAM);
    },
  );

  it('shows the fixed amendments text for a bad timestamp', async () => {
    mockCallGateway.mockResolvedValue({
      data: { items: [{ ...AMENDMENT, proposedAt: UPSTREAM }], nextCursor: null, hasMore: false },
      correlationId: 'corr-amd',
    });
    const result = await fetchAmendments(session, 'CNT_1');

    const { container } = render(
      <ContractDetailScreen
        result={{ kind: 'OK', data: DETAIL }}
        amendments={result}
        milestones={milestonePage([])}
      />,
    );
    expect(screen.getByText(/الحاقیه‌ها خوانده نشد/)).toBeInTheDocument();
    expect(container.textContent).not.toContain(UPSTREAM);
  });

  it('shows the fixed milestones text for a bad timestamp', async () => {
    mockCallGateway.mockResolvedValue({
      data: { items: [{ ...MILESTONE, createdAt: UPSTREAM }], nextCursor: null, hasMore: false },
      correlationId: 'corr-mst',
    });
    const result = await fetchMilestones(session, 'CNT_1');

    const { container } = render(
      <ContractDetailScreen
        result={{ kind: 'OK', data: DETAIL }}
        amendments={amendmentPage([])}
        milestones={result}
      />,
    );
    expect(screen.getByText(/Milestoneها خوانده نشد/)).toBeInTheDocument();
    expect(container.textContent).not.toContain(UPSTREAM);
  });

  it('forwards a given amendment cursor to the gateway', async () => {
    mockCallGateway.mockResolvedValue({
      data: { items: [AMENDMENT], nextCursor: null, hasMore: false },
      correlationId: 'corr-cursor',
    });

    await fetchAmendments(session, 'CNT_1', 'a2');

    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/v1/contracts/CNT_1/amendments?limit=20&cursor=a2' }),
    );
  });

  it('still renders a well-formed record through the same path', async () => {
    mockCallGateway.mockResolvedValue({ data: wire, correlationId: 'corr-ok' });
    const result = await fetchContract(session, 'CNT_1');

    render(<ContractDetailScreen result={result} amendments={null} milestones={null} />);
    expect(screen.getByText('شناسه')).toBeInTheDocument();
  });
});

/**
 * Distinct from a bad timestamp (a present but invalid value): a required field the
 * service contract marks non-optional (`contract/dto.ts`, `amendment/dto.ts`,
 * `milestone/dto.ts`) that is simply missing from the response. None of these may default
 * to `null`/`false` and quietly become a fact nobody signed or reviewed — omission must
 * read as `MALFORMED`, same as an invalid value, never as `OK`.
 */
describe('a response missing a required field, not merely an invalid one', () => {
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
    organizationId: 'ORG_EMPLOYER',
    accessToken: 'access-token-value',
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf',
    issuedAt: 1_900_000_000,
  };

  function omit<T extends object>(value: T, field: keyof T): unknown {
    const copy: Partial<T> = { ...value };
    delete copy[field];
    return copy;
  }

  it.each<keyof ContractDetail>([
    'employerSignedAt',
    'contractorSignedAt',
    'authorityReviewRequired',
    'authorityReviewReason',
    'cancelReasonCode',
    'cancelNote',
  ])('reads a contract missing %s as MALFORMED', async (field) => {
    mockCallGateway.mockResolvedValue({
      data: omit(DETAIL, field),
      correlationId: 'corr-omit',
    });

    const result = await fetchContract(session, 'CNT_1');

    expect(result.kind).toBe('MALFORMED');
  });

  it.each<keyof Amendment>([
    'employerSignedAt',
    'contractorSignedAt',
    'authorityReviewRequired',
    'effectiveAt',
  ])('reads an amendment missing %s as MALFORMED', async (field) => {
    mockCallGateway.mockResolvedValue({
      data: { items: [omit(AMENDMENT, field)], nextCursor: null, hasMore: false },
      correlationId: 'corr-omit',
    });

    const result = await fetchAmendments(session, 'CNT_1');

    expect(result.kind).toBe('MALFORMED');
  });

  it.each<keyof Milestone>(['plannedShareBp', 'referenced'])(
    'reads a milestone missing %s as MALFORMED',
    async (field) => {
      mockCallGateway.mockResolvedValue({
        data: { items: [omit(MILESTONE, field)], nextCursor: null, hasMore: false },
        correlationId: 'corr-omit',
      });

      const result = await fetchMilestones(session, 'CNT_1');

      expect(result.kind).toBe('MALFORMED');
    },
  );

  it.each(['nextCursor', 'hasMore'] as const)(
    'reads a contract page missing %s as MALFORMED',
    async (field) => {
      mockCallGateway.mockResolvedValue({
        data: omit({ items: [CONTRACT], nextCursor: null, hasMore: false }, field),
        correlationId: 'corr-omit',
      });

      const result = await fetchContracts(session);

      expect(result.kind).toBe('MALFORMED');
    },
  );
});

describe('the contract list: «حالت نمایشی» (Q-14)', () => {
  it('is drawn when the provider is simulated', () => {
    render(<ContractsScreen result={page([CONTRACT])} query={{}} demoMode={true} />);
    expect(screen.getByText('حالت نمایشی')).toBeInTheDocument();
  });

  it('is absent when it is not', () => {
    render(<ContractsScreen result={page([CONTRACT])} query={{}} demoMode={false} />);
    expect(screen.queryByText('حالت نمایشی')).toBeNull();
  });
});

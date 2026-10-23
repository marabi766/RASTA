/**
 * @jest-environment node
 */

/**
 * «حالت نمایشی» on the money routes (Q-14), run as the server components they
 * are, against a fake gateway: every module real, `fetch` answering by path.
 * What the screens are handed — and so what they draw — is what the provider
 * read actually came back as, through `fetchDemoMode`, not a `demoMode` a test
 * chose (review of PR 361 r1, findings 1 and 2).
 *
 * - A contractor's contract asks the disclosure every member may read, with
 *   its own bearer, and never the administrators' provider read.
 * - A refused, failed, timed-out or malformed read is UNKNOWN: said in place
 *   of the label, and the screen withholds what moves money.
 * - The screens added in round 2 carry the label, and only while simulated.
 */

import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const mockSession = { current: null as unknown };

jest.mock('@/server/current-session', () => ({
  currentSession: async () => mockSession.current,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
// Client-side form actions are never called here; their modules pull in what a
// server render does not need.
jest.mock('@/app/marketplace/[productId]/place-order-actions', () => ({
  submitPlaceOrder: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const page = (path: string): Page => (require(path) as { default: Page }).default;
const { DemoModeNotice } = require('./DemoModeNotice') as typeof import('./DemoModeNotice');
const { ContractDetailScreen } =
  require('./contracts/[id]/ContractDetailScreen') as typeof import('./contracts/[id]/ContractDetailScreen');
const { OrderDetailScreen } =
  require('./orders/[id]/OrderDetailScreen') as typeof import('./orders/[id]/OrderDetailScreen');
const { OffersScreen } =
  require('./marketplace/[productId]/OffersScreen') as typeof import('./marketplace/[productId]/OffersScreen');
const { ProjectDetailScreen } =
  require('./projects/[id]/ProjectDetailScreen') as typeof import('./projects/[id]/ProjectDetailScreen');
const { ProjectsScreen } =
  require('./projects/ProjectsScreen') as typeof import('./projects/ProjectsScreen');
const { TimelineScreen } =
  require('./assets/[id]/timeline/TimelineScreen') as typeof import('./assets/[id]/timeline/TimelineScreen');
const fixtures =
  require('@/test/contract-command-fixtures') as typeof import('@/test/contract-command-fixtures');
/* eslint-enable @typescript-eslint/no-require-imports */

const DISCLOSURE = '/v1/wallets/provider/disclosure';
const LABEL = 'حالت نمایشی';
const UNKNOWN = 'وضعیت درگاه پرداخت معلوم نیست';

/** What the fake gateway answers, by path; anything else is a 404. */
type Answer = { status: number; body?: unknown } | 'THROW' | 'TIMEOUT';
let answers: Record<string, Answer> = {};
/** Every request the page made: path and bearer. */
let asked: { path: string; authorization: string | null }[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  answers = {};
  asked = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const answer = answers[url.pathname] ?? { status: 404, body: { code: 'NOT_FOUND' } };
    if (answer === 'THROW') throw new TypeError('fetch failed');
    if (answer === 'TIMEOUT') throw new DOMException('The operation timed out.', 'TimeoutError');
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function signedIn(org: string, roles: string[]) {
  const accessToken = jwt({
    org_id: org,
    org_ids: [org],
    org_roles: roles.map((role) => `${org}:${role}`),
    rasta_uid: 'USR-1',
  });
  mockSession.current = {
    subject: 'user-1',
    username: 'u',
    organizationId: org,
    accessToken,
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf-token-for-this-session',
    issuedAt: Math.floor(Date.now() / 1000) - 60,
  };
  return `Bearer ${accessToken}`;
}

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const item of node) elements(item, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values(node.props as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

/** The one element of `type` the page drew, and its markup. */
function drawn(
  tree: ReactElement,
  type: unknown,
): { props: Record<string, unknown>; html: string } {
  const found = elements(tree).filter((element) => element.type === type);
  expect(found).toHaveLength(1);
  return {
    props: found[0]!.props as Record<string, unknown>,
    html: renderToStaticMarkup(found[0]!),
  };
}

const run = (path: string, params: Record<string, string>, search = {}) =>
  page(path)({ params: Promise.resolve(params), searchParams: Promise.resolve(search) });

/** Each way the read can fail, and what the old `false` made of it. */
const FAILURES: [string, Answer][] = [
  ['refused (403)', { status: 403, body: { code: 'FORBIDDEN' } }],
  ['unavailable (503)', { status: 503 }],
  ['malformed', { status: 200, body: { provider: 'mock' } }],
  ['unreachable', 'THROW'],
  ['timed out', 'TIMEOUT'],
];

// ---------------------------------------------------------------------------

describe('/contracts/[id] for a contractor holding no other role (finding 2)', () => {
  const contract = () => {
    answers[`/v1/contracts/${fixtures.CONTRACT_ID}`] = { status: 200, body: fixtures.SIGNED };
  };

  it('asks the members’ disclosure with its own bearer — never the administrators’ provider read — and is labelled', async () => {
    const bearer = signedIn(fixtures.CONTRACTOR, ['CONTRACTOR']);
    contract();
    answers[DISCLOSURE] = { status: 200, body: { simulated: true } };

    const tree = await run('./contracts/[id]/page', { id: fixtures.CONTRACT_ID });
    const screen = drawn(tree, ContractDetailScreen);

    expect(screen.props.demoMode).toBe('SIMULATED');
    expect(screen.html).toContain(LABEL);
    expect(asked.filter(({ path }) => path === DISCLOSURE)).toEqual([
      { path: DISCLOSURE, authorization: bearer },
    ]);
    expect(asked.map(({ path }) => path)).not.toContain('/v1/wallets/provider');
  });

  it('is not labelled once the provider is real', async () => {
    signedIn(fixtures.CONTRACTOR, ['CONTRACTOR']);
    contract();
    answers[DISCLOSURE] = { status: 200, body: { simulated: false } };

    const screen = drawn(
      await run('./contracts/[id]/page', { id: fixtures.CONTRACT_ID }),
      ContractDetailScreen,
    );
    expect(screen.props.demoMode).toBe('REAL');
    expect(screen.html).not.toContain(LABEL);
    expect(screen.html).not.toContain(UNKNOWN);
  });

  it.each(FAILURES)(
    'says the provider is unknown when the read was %s — never unlabelled',
    async (_how, answer) => {
      signedIn(fixtures.CONTRACTOR, ['CONTRACTOR']);
      contract();
      answers[DISCLOSURE] = answer;

      const screen = drawn(
        await run('./contracts/[id]/page', { id: fixtures.CONTRACT_ID }),
        ContractDetailScreen,
      );
      expect(screen.props.demoMode).toBe('UNKNOWN');
      expect(screen.html).toContain(UNKNOWN);
      expect(screen.html).not.toContain(LABEL);
    },
  );
});

describe('/orders/[id] while the provider is unknown (finding 1)', () => {
  const ORDER = {
    id: 'ORD_1',
    status: 'AWAITING_RECEIPT_CONFIRMATION',
    buyerOrganizationId: 'ORG-DEH-0001',
    supplierOrganizationId: 'ORG-SUP-0001',
    totalAmountMinor: '90000000',
    currency: 'IRR',
    lines: [
      {
        id: 'OLN_1',
        offerId: 'OFR_1',
        productId: 'PRD_1',
        productName: 'فیلتر روغن',
        quantity: 2,
        unitPriceMinor: '45000000',
        lineTotalMinor: '90000000',
        currency: 'IRR',
      },
    ],
    confirmedAt: '2026-09-20T08:00:00.000Z',
    fulfilledAt: '2026-09-21T08:00:00.000Z',
    receiptConfirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    failureReason: null,
    createdAt: '2026-09-19T08:00:00.000Z',
    availableActions: ['CONFIRM_RECEIPT', 'RAISE_DISPUTE'],
  };

  it.each(FAILURES)(
    'withholds the order’s money commands when the read was %s',
    async (_how, answer) => {
      signedIn('ORG-DEH-0001', ['ORGANIZATION_ADMIN']);
      answers['/v1/orders/ORD_1'] = { status: 200, body: ORDER };
      answers[DISCLOSURE] = answer;

      const screen = drawn(await run('./orders/[id]/page', { id: 'ORD_1' }), OrderDetailScreen);
      expect(screen.props.demoMode).toBe('UNKNOWN');
      expect(screen.html).toContain(UNKNOWN);
      expect(screen.html).toContain('اقدام‌های مالی این سفارش اکنون در دسترس نیست');
      expect(screen.html).not.toContain('<form');
      // The amounts are still shown — labelled as unknown, not hidden.
      expect(screen.html).toContain('فیلتر روغن');
    },
  );

  it('offers them, labelled, while the provider is simulated', async () => {
    signedIn('ORG-DEH-0001', ['ORGANIZATION_ADMIN']);
    answers['/v1/orders/ORD_1'] = { status: 200, body: ORDER };
    answers[DISCLOSURE] = { status: 200, body: { simulated: true } };

    const screen = drawn(await run('./orders/[id]/page', { id: 'ORD_1' }), OrderDetailScreen);
    expect(screen.props.demoMode).toBe('SIMULATED');
    expect(screen.html).toContain(LABEL);
    expect(screen.html).not.toContain('اکنون در دسترس نیست');
    expect(screen.html.match(/<form/g)?.length).toBe(2);
  });
});

describe('/marketplace/[productId] while the provider is unknown (finding 1)', () => {
  const PRODUCT = {
    id: 'PRD_1',
    sku: 'SKU-1',
    name: 'شیلنگ هیدرولیک صنعتی',
    description: null,
    category: 'PARTS',
    kind: 'GOOD',
    unit: 'عدد',
    offers: [],
  };
  const OFFER = {
    id: 'OFR_1',
    productId: 'PRD_1',
    supplierOrganizationId: 'ORG-SUP-0001',
    unitPriceMinor: '300000',
    currency: 'IRR',
    availableQuantity: 15,
    leadTimeDays: 5,
    minimumQuantity: 1,
    supplierQualification: 'UNAVAILABLE',
  };
  const read = (disclosure: Answer) => {
    signedIn('ORG-DEH-0001', ['ORGANIZATION_ADMIN']);
    answers['/v1/products/PRD_1'] = { status: 200, body: PRODUCT };
    answers['/v1/products/PRD_1/offers'] = { status: 200, body: { items: [OFFER] } };
    answers[DISCLOSURE] = disclosure;
    return run('./marketplace/[productId]/page', { productId: 'PRD_1' });
  };

  it('withholds the place-order form — it holds the amount in escrow', async () => {
    const screen = drawn(await read({ status: 503 }), OffersScreen);
    expect(screen.props.demoMode).toBe('UNKNOWN');
    expect(screen.html).toContain(UNKNOWN);
    expect(screen.html).toContain('ثبت سفارش اکنون در دسترس نیست');
    expect(screen.html).not.toContain('name="offerId"');
  });

  it('offers it while the provider is simulated', async () => {
    const screen = drawn(await read({ status: 200, body: { simulated: true } }), OffersScreen);
    expect(screen.html).toContain(LABEL);
    expect(screen.html).toContain('name="offerId"');
  });
});

describe('the screens round 2 labels, as routes (finding 3)', () => {
  const PROJECT = {
    id: 'PRJ_1',
    title: 'زیرسازی راه دسترسی',
    operationType: 'خاکبرداری',
    locationDescription: 'کیلومتر ۱۲ محور شمالی',
    estimatedCostMinor: '900000000',
    status: 'APPROVED',
    statusChangedAt: '2026-09-20T08:00:00.000Z',
  };
  const ROUTES: [string, string, Record<string, string>, unknown, () => void][] = [
    [
      '/projects',
      './projects/page',
      {},
      ProjectsScreen,
      () => {
        answers['/v1/projects'] = {
          status: 200,
          body: { items: [PROJECT], nextCursor: null, hasMore: false },
        };
      },
    ],
    [
      '/projects/[id]',
      './projects/[id]/page',
      { id: 'PRJ_1' },
      ProjectDetailScreen,
      () => {
        answers['/v1/projects/PRJ_1'] = {
          status: 200,
          body: {
            ...PROJECT,
            hasArea: true,
            statusReason: null,
            createdAt: '2026-09-19T08:00:00.000Z',
            scopeOfWork: 'خاکبرداری و تسطیح',
            needsSummary: { draft: 1, submitted: 2, withdrawn: 0 },
          },
        };
      },
    ],
    [
      '/assets/[id]/timeline',
      './assets/[id]/timeline/page',
      { id: 'AST_1' },
      TimelineScreen,
      () => {
        answers['/v1/assets/AST_1/timeline'] = {
          status: 200,
          body: {
            items: [
              {
                id: 'TL_1',
                eventName: 'MAINTENANCE_COMPLETED',
                sourceService: 'maintenance-service',
                category: 'MAINTENANCE',
                title: 'سرویس دوره‌ای تکمیل شد',
                description: 'تعویض روغن و فیلتر',
                amountMinor: '90000000',
                detail: {},
                occurredAt: '2026-02-01T00:00:00.000Z',
              },
            ],
            nextCursor: null,
            hasMore: false,
          },
        };
      },
    ],
  ];

  describe.each(ROUTES)('%s', (_route, path, params, type, stub) => {
    const read = async (disclosure: Answer) => {
      signedIn('ORG-DEH-0001', ['ORGANIZATION_ADMIN']);
      stub();
      answers[DISCLOSURE] = disclosure;
      return drawn(await run(path, params), type);
    };

    it('is labelled while the provider is simulated', async () => {
      const screen = await read({ status: 200, body: { simulated: true } });
      expect(screen.html).toContain(LABEL);
    });

    it('is not, once it is real', async () => {
      const screen = await read({ status: 200, body: { simulated: false } });
      expect(screen.html).not.toContain(LABEL);
      expect(screen.html).not.toContain(UNKNOWN);
    });

    it('says the provider is unknown when it could not be read', async () => {
      const screen = await read({ status: 403, body: { code: 'FORBIDDEN' } });
      expect(screen.html).toContain(UNKNOWN);
      expect(screen.html).not.toContain(LABEL);
    });
  });

  describe('/tenders/[id], on either door', () => {
    it.each([
      ['the owner’s', {}, ['ORGANIZATION_ADMIN']],
      ['the bidder’s', { view: 'open' }, ['CONTRACTOR']],
    ])('draws the notice above %s body, in each state', async (_door, search, roles) => {
      for (const [answer, mode, text] of [
        [{ status: 200, body: { simulated: true } }, 'SIMULATED', LABEL],
        [{ status: 503 }, 'UNKNOWN', UNKNOWN],
        [{ status: 200, body: { simulated: false } }, 'REAL', null],
      ] as const) {
        signedIn('ORG-DEH-0001', [...roles]);
        answers[DISCLOSURE] = answer;
        const notice = drawn(
          await run('./tenders/[id]/page', { id: 'TND_1' }, search),
          DemoModeNotice,
        );
        expect([mode, notice.props.mode]).toEqual([mode, mode]);
        if (text === null) expect(notice.html).toBe('');
        else expect(notice.html).toContain(text);
      }
    });
  });
});

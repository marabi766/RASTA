/**
 * @jest-environment node
 */

/**
 * Every gated screen draws from the access token's roles, never from
 * `/v1/users/me` — the divergence each test sets up on purpose.
 *
 * identity-service reports the membership rows as they are *now*; the services
 * decide on the token's `org_roles`, which only change when the token is
 * refreshed. Between the two:
 *
 * - **a role removed** — identity no longer lists it, the token still carries
 *   it, the service still admits it: the screen must still offer the form;
 * - **a role added** — identity lists it, the token does not carry it yet, the
 *   service still refuses: the screen must not offer the form.
 *
 * Each page is run as the server component it is, with the data reads stubbed
 * and `/v1/users/me` answering the *other* side of the divergence — it must not
 * be asked at all. What a page offers is read off the element tree it returns,
 * so no client component renders.
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const ORG = 'ORG-DEH-0001';
const mockSession = { current: null as unknown };
const mockFetched: string[] = [];
const mockAnswers: Record<string, unknown> = {};
const mockIdentity = jest.fn();

/** The module as it is, with every `fetch*` read answered from `mockAnswers` and recorded. */
function mockStubFetchers(path: string): Record<string, unknown> {
  const actual = jest.requireActual(path) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.startsWith('fetch') && typeof value === 'function'
        ? async () => {
            mockFetched.push(name);
            return mockAnswers[name] ?? { kind: 'NOT_FOUND' };
          }
        : value,
    ]),
  );
}

jest.mock('@/server/current-session', () => ({
  currentSession: async () => mockSession.current,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('@/server/identity', () => ({
  ...jest.requireActual('@/server/identity'),
  fetchCurrentUser: (...args: unknown[]) => mockIdentity(...args),
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
// The provider read, answered without a gateway: what it draws is `demo-mode-pages.spec.ts`'s subject.
jest.mock('@/server/demo-mode', () => ({ fetchDemoMode: async () => 'SIMULATED' }));
jest.mock('@/server/assets', () => mockStubFetchers('@/server/assets'));
jest.mock('@/server/asset-records', () => mockStubFetchers('@/server/asset-records'));
jest.mock('@/server/fleet-availability', () => mockStubFetchers('@/server/fleet-availability'));
jest.mock('@/server/drivers', () => mockStubFetchers('@/server/drivers'));
jest.mock('@/server/maintenance', () => mockStubFetchers('@/server/maintenance'));
jest.mock('@/server/marketplace', () => mockStubFetchers('@/server/marketplace'));
jest.mock('@/server/tenders', () => mockStubFetchers('@/server/tenders'));

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const page = (path: string): Page => (require(path) as { default: Page }).default;
const { PortalSidebar } = require('./app/PortalSidebar') as typeof import('./app/PortalSidebar');
const { RegisterAssetForm } =
  require('./app/assets/RegisterAssetForm') as typeof import('./app/assets/RegisterAssetForm');
const { UpdateAssetForm } =
  require('./app/assets/[id]/UpdateAssetForm') as typeof import('./app/assets/[id]/UpdateAssetForm');
const { NewDriverForm } =
  require('./app/drivers/NewDriverForm') as typeof import('./app/drivers/NewDriverForm');
const { DriverDetailScreen } =
  require('./app/drivers/[id]/DriverDetailScreen') as typeof import('./app/drivers/[id]/DriverDetailScreen');
const { ReportRequestForm } =
  require('./app/maintenance/ReportRequestForm') as typeof import('./app/maintenance/ReportRequestForm');
const { RequestDetailScreen } =
  require('./app/maintenance/[id]/RequestDetailScreen') as typeof import('./app/maintenance/[id]/RequestDetailScreen');
const { OffersScreen } =
  require('./app/marketplace/[productId]/OffersScreen') as typeof import('./app/marketplace/[productId]/OffersScreen');
/* eslint-enable @typescript-eslint/no-require-imports */

const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** A session whose access token was minted with these roles in `ORG`. */
function signedInWith(tokenRoles: string[]) {
  return {
    subject: 'user-1',
    username: 'u',
    organizationId: ORG,
    accessToken: jwt({
      org_id: ORG,
      org_ids: [ORG],
      org_roles: tokenRoles.map((role) => `${ORG}:${role}`),
    }),
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf-token-for-this-session',
    issuedAt: Math.floor(Date.now() / 1000) - 60,
  };
}

/** `/v1/users/me` answering with these roles — the membership rows as they are now. */
function identityReports(roles: string[]) {
  mockIdentity.mockResolvedValue({
    kind: 'USER',
    user: {
      id: 'user-1',
      username: 'u',
      firstName: '',
      lastName: '',
      status: 'ACTIVE',
      activeOrganizationId: ORG,
      memberships: [{ organizationId: ORG, roles, status: 'ACTIVE' }],
      effectiveRoles: roles,
      grantableRoles: [],
    },
  });
}

/** Every element in the tree a page returned, through children and element-valued props. */
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const item of node) elements(item, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values(node.props as Record<string, unknown>)) elements(value, out);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) if (isValidElement(value)) elements(value, out);
  }
  return out;
}

const ofType = (tree: ReactNode, type: unknown) => elements(tree).filter((e) => e.type === type);

/** The sidebar the page would draw, as hrefs. */
function sidebarOf(tree: ReactNode): string[] {
  const [sidebar] = ofType(tree, PortalSidebar);
  if (!sidebar) throw new Error('no sidebar');
  const drawn = PortalSidebar(sidebar.props as Parameters<typeof PortalSidebar>[0]);
  return (drawn.props as { items: { href: string }[] }).items.map((item) => item.href);
}

async function run(path: string, params: Record<string, string> = {}): Promise<ReactElement> {
  return page(path)({ params: Promise.resolve(params), searchParams: Promise.resolve({}) });
}

const ASSET = {
  id: 'AST_1',
  name: 'لودر',
  assetTag: null,
  manufacturer: null,
  model: null,
  manufactureYear: null,
  status: 'ACTIVE',
  version: 3,
};

beforeEach(() => {
  mockFetched.length = 0;
  for (const key of Object.keys(mockAnswers)) delete mockAnswers[key];
  mockIdentity.mockReset();
  mockAnswers.fetchDossier = { kind: 'OK', data: { asset: ASSET } };
  mockAnswers.fetchMaintenanceRequest = {
    kind: 'OK',
    data: { id: 'MRQ_1', status: 'OPEN', repairOrders: [], totalCostMinor: '0' },
  };
});

afterEach(() => expect(mockIdentity).not.toHaveBeenCalled());

/**
 * One row per gated screen: a role the gate admits, one it does not, and how
 * to read off the returned tree whether the gated thing was offered.
 */
const SCREENS: {
  readonly name: string;
  readonly path: string;
  readonly params?: Record<string, string>;
  readonly admitted: string;
  readonly refused: string;
  readonly offered: (tree: ReactElement) => boolean;
}[] = [
  {
    name: '/assets — the register form',
    path: './app/assets/page',
    admitted: 'FLEET_MANAGER',
    refused: 'DRIVER',
    offered: (tree) => ofType(tree, RegisterAssetForm).length > 0,
  },
  {
    name: '/assets/[id] — the edit form',
    path: './app/assets/[id]/page',
    params: { id: 'AST_1' },
    admitted: 'FLEET_MANAGER',
    refused: 'DRIVER',
    offered: (tree) => ofType(tree, UpdateAssetForm).length > 0,
  },
  {
    name: '/drivers — the registration form',
    path: './app/drivers/page',
    admitted: 'FLEET_MANAGER',
    refused: 'DRIVER',
    offered: (tree) => ofType(tree, NewDriverForm).length > 0,
  },
  {
    name: '/drivers/[id] — the write forms',
    path: './app/drivers/[id]/page',
    params: { id: 'DRV_1' },
    admitted: 'FLEET_MANAGER',
    refused: 'DRIVER',
    offered: (tree) =>
      (ofType(tree, DriverDetailScreen)[0]?.props as { canManageDrivers?: boolean })
        ?.canManageDrivers === true,
  },
  {
    name: '/maintenance — the report form',
    path: './app/maintenance/page',
    admitted: 'DRIVER',
    refused: 'SUPPLIER',
    offered: (tree) => ofType(tree, ReportRequestForm).length > 0,
  },
  {
    name: '/maintenance/[id] — the request commands',
    path: './app/maintenance/[id]/page',
    params: { id: 'MRQ_1' },
    admitted: 'FLEET_MANAGER',
    refused: 'DRIVER',
    offered: (tree) =>
      (ofType(tree, RequestDetailScreen)[0]?.props as { commandForms?: unknown })?.commandForms !==
      undefined,
  },
  {
    name: '/marketplace/[productId] — the order form',
    path: './app/marketplace/[productId]/page',
    params: { productId: 'PRD_1' },
    admitted: 'PROCUREMENT_USER',
    refused: 'DRIVER',
    offered: (tree) =>
      (ofType(tree, OffersScreen)[0]?.props as { ordering?: unknown })?.ordering !== undefined,
  },
];

describe.each(SCREENS)('$name', ({ path, params, admitted, refused, offered }) => {
  it('a role removed in identity but still in the token: still offered', async () => {
    mockSession.current = signedInWith([admitted]);
    identityReports([refused]);
    expect(offered(await run(path, params))).toBe(true);
  });

  it('a role added in identity but not yet in the token: not offered', async () => {
    mockSession.current = signedInWith([refused]);
    identityReports([admitted]);
    expect(offered(await run(path, params))).toBe(false);
  });

  it('a token whose roles cannot be read: not offered', async () => {
    mockSession.current = { ...signedInWith([admitted]), accessToken: 'opaque' };
    identityReports([admitted]);
    expect(offered(await run(path, params))).toBe(false);
  });
});

/**
 * PR 325 review 1, finding 2: what a screen offers follows `RolesGuard` — the
 * oversight role refused whatever else is held, the administrator admitted —
 * and a write needs the organization it is for.
 */
describe.each(SCREENS)(
  '$name — combined roles, as the guard decides',
  ({ path, params, admitted, refused, offered }) => {
    /** A session whose token carries these claims. */
    const withClaims = (claims: Record<string, unknown>) => ({
      ...signedInWith([]),
      accessToken: jwt(claims),
    });

    it('an admitted role with AUDITOR in the same organization: not offered', async () => {
      mockSession.current = signedInWith([admitted, 'AUDITOR']);
      identityReports([admitted]);
      expect(offered(await run(path, params))).toBe(false);
    });

    it('a scoped role the route does not list, with the global SYSTEM_ADMIN: offered', async () => {
      mockSession.current = withClaims({
        org_id: ORG,
        org_ids: [ORG],
        org_roles: [`${ORG}:${refused}`],
        realm_access: { roles: ['SYSTEM_ADMIN'] },
      });
      identityReports([refused]);
      expect(offered(await run(path, params))).toBe(true);
    });

    it('the global SYSTEM_ADMIN with AUDITOR in the organization: not offered', async () => {
      mockSession.current = withClaims({
        org_id: ORG,
        org_ids: [ORG],
        org_roles: [`${ORG}:AUDITOR`],
        realm_access: { roles: ['SYSTEM_ADMIN'] },
      });
      identityReports([admitted]);
      expect(offered(await run(path, params))).toBe(false);
    });

    it('the global SYSTEM_ADMIN alone, acting for no organization: not offered — the write is tenant-scoped', async () => {
      mockSession.current = withClaims({ realm_access: { roles: ['SYSTEM_ADMIN'] } });
      identityReports([admitted]);
      expect(offered(await run(path, params))).toBe(false);
    });
  },
);

describe('/tenders — which doors are asked', () => {
  it('a CONTRACTOR role removed in identity but still in the token: the bidder’s door', async () => {
    mockSession.current = signedInWith(['CONTRACTOR']);
    identityReports(['ORGANIZATION_ADMIN']);
    await run('./app/tenders/page');
    expect(mockFetched).toEqual(['fetchOpenTenders']);
  });

  it('an owner role added in identity but not yet in the token: still only the bidder’s door', async () => {
    mockSession.current = signedInWith(['CONTRACTOR']);
    identityReports(['CONTRACTOR', 'ORGANIZATION_ADMIN']);
    await run('./app/tenders/page');
    expect(mockFetched).toEqual(['fetchOpenTenders']);
  });

  it('an owner in the token: the owner’s door, whatever identity says', async () => {
    mockSession.current = signedInWith(['ORGANIZATION_ADMIN']);
    identityReports(['CONTRACTOR']);
    await run('./app/tenders/page');
    expect(mockFetched).toEqual(['fetchTenders']);
  });

  it('a token whose roles cannot be read: the owner’s door, whose own answer is shown', async () => {
    mockSession.current = { ...signedInWith(['CONTRACTOR']), accessToken: 'opaque' };
    identityReports(['CONTRACTOR']);
    await run('./app/tenders/page');
    expect(mockFetched).toEqual(['fetchTenders']);
  });
});

describe('/tenders/[id] — which door a bare address takes', () => {
  it('a bidder in the token: the bidder’s door, though identity now says owner', async () => {
    mockSession.current = signedInWith(['CONTRACTOR']);
    identityReports(['ORGANIZATION_ADMIN']);
    await run('./app/tenders/[id]/page', { id: 'TND_1' });
    expect(mockFetched).toEqual(['fetchOpenTender']);
  });

  it('an owner in the token: the owner’s door, though identity now says bidder', async () => {
    mockSession.current = signedInWith(['ORGANIZATION_ADMIN']);
    identityReports(['CONTRACTOR']);
    await run('./app/tenders/[id]/page', { id: 'TND_1' });
    expect(mockFetched).toEqual(['fetchTender']);
  });
});

describe('the sidebar every page draws', () => {
  it('follows the token: a role removed in identity still shows its link', async () => {
    mockSession.current = signedInWith(['ORGANIZATION_ADMIN']);
    identityReports(['DRIVER']);
    expect(sidebarOf(await run('./app/assets/page'))).toContain('/projects');
  });

  it('follows the token: a role added in identity shows no link yet', async () => {
    mockSession.current = signedInWith(['DRIVER']);
    identityReports(['ORGANIZATION_ADMIN']);
    expect(sidebarOf(await run('./app/assets/page'))).not.toContain('/projects');
  });
});

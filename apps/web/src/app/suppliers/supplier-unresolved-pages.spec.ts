/**
 * @jest-environment node
 */

/**
 * `/suppliers` and `/suppliers/[id]` as the server components they are, with the
 * reads stubbed: a write whose answer was lost is still on the page after a
 * reload or a visit from elsewhere (it lives in the platform's Redis, not in a form
 * or a cookie),
 * every command form is drawn disabled while it lasts, and nobody else — another
 * person, organization, login or supplier — is shown it.
 */

import { isValidElement, type ReactElement } from 'react';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SUPPLIER_ORG = 'ORG-SUP';
const SUPPLIER_ID = 'SUP_01J00000000000000000000000';
const mockSession = { current: null as unknown };
const mockDetail = {
  id: SUPPLIER_ID,
  organizationId: SUPPLIER_ORG,
  displayName: 'تعمیرگاه البرز',
  status: 'ACTIVE',
  capabilities: ['WORKSHOP_SERVICE'],
  qualifiedFor: ['WORKSHOP_SERVICE'],
  registeredAt: '2026-08-01T08:00:00.000Z',
  qualifications: [],
  suspensions: [],
};

jest.mock('@/server/current-session', () => ({
  currentSession: async () => mockSession.current,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('@/server/suppliers', () => ({
  fetchSuppliers: async () => ({
    kind: 'OK',
    data: { items: [], nextCursor: null },
    correlationId: 'c',
  }),
  fetchSupplier: async () => ({ kind: 'OK', data: mockDetail, correlationId: 'c' }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params?: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const DetailPage = (require('./[id]/page') as { default: Page }).default;
const ListPage = (require('./page') as { default: Page }).default;
const { PortalSidebar } = require('../PortalSidebar') as typeof import('../PortalSidebar');
const { UnresolvedSupplierNotice } =
  require('./UnresolvedSupplierNotice') as typeof import('./UnresolvedSupplierNotice');
const { SubmitQualificationForm, RegisterSupplierForm } =
  require('./SupplierForms') as typeof import('./SupplierForms');
const { SupplierPendingNotices } =
  require('./UnresolvedSupplierNotice') as typeof import('./UnresolvedSupplierNotice');
const { reserveUnresolved, settleUnresolved, useUnresolvedStore } =
  require('@/server/unresolved-request') as typeof import('@/server/unresolved-request');
const { memoryUnresolvedStore, UnresolvedStoreUnavailable } =
  require('@/server/unresolved-request-store') as typeof import('@/server/unresolved-request-store');
const { supplierWriteScope } =
  require('@/server/supplier-unresolved') as typeof import('@/server/supplier-unresolved');
/* eslint-enable @typescript-eslint/no-require-imports */

const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const SESSION = {
  subject: 'user-1',
  username: 'u',
  organizationId: SUPPLIER_ORG,
  accessToken: jwt({
    org_id: SUPPLIER_ORG,
    org_ids: [SUPPLIER_ORG],
    org_roles: [`${SUPPLIER_ORG}:SUPPLIER`],
  }),
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: Math.floor(Date.now() / 1000) - 60,
};

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const item of node) elements(item, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values(node.props as Record<string, unknown>)) elements(value, out);
  } else if (node !== null && typeof node === 'object') {
    // The commands the page hands its screen are a plain object of elements.
    for (const value of Object.values(node)) elements(value, out);
  }
  return out;
}

const props = (tree: ReactElement, type: unknown) =>
  elements(tree)
    .filter((element) => element.type === type)
    .map((element) => element.props as Record<string, unknown>);

const detailTree = (searchParams: Record<string, string> = {}) =>
  DetailPage({
    params: Promise.resolve({ id: SUPPLIER_ID }),
    searchParams: Promise.resolve(searchParams),
  });
const listTree = (searchParams: Record<string, string> = {}) =>
  ListPage({ searchParams: Promise.resolve(searchParams) });

/**
 * What the page's notices draw: the page hands `SupplierPendingNotices` its
 * reading of the slot, and that component is what puts the notice on screen.
 */
const noticesOf = (tree: ReactElement): ReactElement[] => {
  const mounted = props(tree, SupplierPendingNotices);
  expect(mounted).toHaveLength(1);
  return elements((SupplierPendingNotices as unknown as (p: unknown) => ReactElement)(mounted[0]));
};
const noticeProps = (tree: ReactElement) =>
  noticesOf(tree)
    .filter((element) => element.type === UnresolvedSupplierNotice)
    .map((element) => element.props as Record<string, unknown>);

/** A write that was sent and whose answer was lost: reserved, then left unresolved. */
async function lose(scope: ReturnType<typeof supplierWriteScope>, key: string, session = SESSION) {
  const reserved = await reserveUnresolved(session, scope, {
    key,
    digest: 'd',
    ref: null,
    issuedAt: Date.now(),
    deadline: null,
    windowMs: null,
  });
  if (reserved.kind !== 'RESERVED') throw new Error(reserved.kind);
  await settleUnresolved(reserved.attempt, 'UNRESOLVED');
}

beforeEach(() => {
  useUnresolvedStore(memoryUnresolvedStore());
  mockSession.current = SESSION;
});
afterEach(() => useUnresolvedStore(undefined));

describe('the shared navigation', () => {
  it('is the sidebar of both screens, on /suppliers (spelling checked in supplier-persian.spec.tsx)', async () => {
    for (const tree of [await listTree(), await detailTree()]) {
      expect(props(tree, PortalSidebar)).toEqual([
        expect.objectContaining({ currentHref: '/suppliers' }),
      ]);
    }
  });
});

describe('a supplier page with nothing unresolved', () => {
  it('draws no notice and enabled forms', async () => {
    const tree = await detailTree();
    expect(noticeProps(tree)).toHaveLength(0);
    expect(props(tree, SubmitQualificationForm)).toEqual([
      expect.objectContaining({ held: false }),
    ]);
  });
});

describe('a supplier page with an unresolved write', () => {
  beforeEach(async () => {
    await lose(supplierWriteScope(SUPPLIER_ID), 'sub_x');
  });

  it('shows its warning and reference on a reload, with a confirmation naming it, and draws the forms held', async () => {
    for (let visit = 0; visit < 2; visit += 1) {
      const tree = await detailTree();
      expect(noticeProps(tree)).toEqual([
        expect.objectContaining({
          supplierId: SUPPLIER_ID,
          request: expect.objectContaining({ key: 'sub_x', inFlight: false }),
          releaseToken: expect.any(String),
        }),
      ]);
      expect(props(tree, SubmitQualificationForm)).toEqual([
        expect.objectContaining({ held: true }),
      ]);
    }
  });

  it('is shown to nobody else: another person, organization, login or supplier', async () => {
    const others = [
      { ...SESSION, subject: 'user-2' },
      { ...SESSION, organizationId: 'ORG-OTHER' },
      { ...SESSION, csrfToken: 'a-later-login' },
    ];
    for (const other of others) {
      mockSession.current = other;
      expect(noticeProps(await detailTree())).toHaveLength(0);
    }
    mockSession.current = SESSION;
    mockDetail.id = 'SUP_OTHER';
    try {
      const tree = await DetailPage({
        params: Promise.resolve({ id: 'SUP_OTHER' }),
        searchParams: Promise.resolve({}),
      });
      expect(noticeProps(tree)).toHaveLength(0);
    } finally {
      mockDetail.id = SUPPLIER_ID;
    }
  });

  it('is not shown on the directory page, whose registration has its own slot', async () => {
    expect(noticeProps(await listTree())).toHaveLength(0);
  });
});

describe('the registration with an unresolved write', () => {
  it('keeps the notice on /suppliers and draws the form held', async () => {
    await lose(supplierWriteScope(null), 'sub_r');
    const tree = await listTree();
    expect(noticeProps(tree)).toEqual([expect.objectContaining({ supplierId: null })]);
    expect(props(tree, RegisterSupplierForm)).toEqual([expect.objectContaining({ held: true })]);
  });
});

describe('a store that cannot say', () => {
  const unreachable = () => {
    const down = () => {
      throw new UnresolvedStoreUnavailable(new Error('ECONNREFUSED'));
    };
    return { read: down, reserve: down, settle: down, release: down, purge: down };
  };

  it('is not "nothing held": the supplier page warns and draws its forms held', async () => {
    useUnresolvedStore(unreachable() as never);
    const tree = await detailTree();
    expect(props(tree, SubmitQualificationForm)).toEqual([expect.objectContaining({ held: true })]);
    const mounted = props(tree, SupplierPendingNotices);
    expect(mounted).toEqual([expect.objectContaining({ pending: { kind: 'UNAVAILABLE' } })]);
  });

  it('does the same for the registration', async () => {
    useUnresolvedStore(unreachable() as never);
    const tree = await listTree();
    expect(props(tree, RegisterSupplierForm)).toEqual([expect.objectContaining({ held: true })]);
  });
});

describe('back from a refused reconciliation', () => {
  it('says nothing changed, on the supplier page and on /suppliers', async () => {
    const detail = await detailTree({ release: 'STALE' });
    expect(props(detail, SupplierPendingNotices)).toEqual([
      expect.objectContaining({ release: 'STALE' }),
    ]);
    const list = await listTree({ release: 'IN_PROGRESS' });
    expect(props(list, SupplierPendingNotices)).toEqual([
      expect.objectContaining({ release: 'IN_PROGRESS' }),
    ]);
  });
});

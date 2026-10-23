/**
 * @jest-environment node
 */

/**
 * `/suppliers` and `/suppliers/[id]` as the server components they are, with the
 * reads stubbed: a write whose answer was lost is still on the page after a
 * reload or a visit from elsewhere (it lives in a signed cookie, not in a form),
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
const jar = new Map<string, string>();
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
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
const { UnresolvedSupplierNotice } =
  require('./UnresolvedSupplierNotice') as typeof import('./UnresolvedSupplierNotice');
const { SubmitQualificationForm, RegisterSupplierForm } =
  require('./SupplierForms') as typeof import('./SupplierForms');
const { rememberUnresolved } =
  require('@/server/unresolved-request') as typeof import('@/server/unresolved-request');
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

const detailTree = () =>
  DetailPage({
    params: Promise.resolve({ id: SUPPLIER_ID }),
    searchParams: Promise.resolve({}),
  });
const listTree = () => ListPage({ searchParams: Promise.resolve({}) });

beforeEach(() => {
  jar.clear();
  mockSession.current = SESSION;
});

describe('a supplier page with nothing unresolved', () => {
  it('draws no notice and enabled forms', async () => {
    const tree = await detailTree();
    expect(props(tree, UnresolvedSupplierNotice)).toHaveLength(0);
    expect(props(tree, SubmitQualificationForm)).toEqual([
      expect.objectContaining({ held: false }),
    ]);
  });
});

describe('a supplier page with an unresolved write', () => {
  beforeEach(async () => {
    await rememberUnresolved(SESSION, supplierWriteScope(SUPPLIER_ID), {
      key: 'sub_x',
      digest: 'd',
      deadline: null,
      ref: 'corr-lost',
    });
  });

  it('shows its warning and correlation id on a reload, and draws the forms held', async () => {
    for (let visit = 0; visit < 2; visit += 1) {
      const tree = await detailTree();
      expect(props(tree, UnresolvedSupplierNotice)).toEqual([
        expect.objectContaining({
          supplierId: SUPPLIER_ID,
          request: expect.objectContaining({ ref: 'corr-lost' }),
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
      expect(props(await detailTree(), UnresolvedSupplierNotice)).toHaveLength(0);
    }
    mockSession.current = SESSION;
    mockDetail.id = 'SUP_OTHER';
    try {
      const tree = await DetailPage({
        params: Promise.resolve({ id: 'SUP_OTHER' }),
        searchParams: Promise.resolve({}),
      });
      expect(props(tree, UnresolvedSupplierNotice)).toHaveLength(0);
    } finally {
      mockDetail.id = SUPPLIER_ID;
    }
  });

  it('is not shown on the directory page, whose registration has its own slot', async () => {
    expect(props(await listTree(), UnresolvedSupplierNotice)).toHaveLength(0);
  });
});

describe('the registration with an unresolved write', () => {
  it('keeps the notice on /suppliers and draws the form held', async () => {
    await rememberUnresolved(SESSION, supplierWriteScope(null), {
      key: 'sub_r',
      digest: 'd',
      deadline: null,
      ref: 'corr-reg',
    });
    const tree = await listTree();
    expect(props(tree, UnresolvedSupplierNotice)).toEqual([
      expect.objectContaining({ supplierId: null }),
    ]);
    expect(props(tree, RegisterSupplierForm)).toEqual([expect.objectContaining({ held: true })]);
  });
});

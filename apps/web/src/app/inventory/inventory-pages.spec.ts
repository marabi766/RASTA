/**
 * @jest-environment node
 */

/**
 * `/inventory` and `/inventory/shipments/[id]` as the server components they
 * are, with the reads stubbed: which forms each page draws for which token
 * (a copy of the service's checks — UX only), what each form's stamp binds, and
 * which reads are asked at all. What is offered is read off the element tree
 * the page returns (`opening-only-page.spec.ts`'s technique).
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
const mockArgs: Record<string, unknown[]> = {};

jest.mock('@/server/current-session', () => ({
  currentSession: async () => mockSession.current,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('@/server/inventory', () => {
  const actual = jest.requireActual('@/server/inventory') as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.startsWith('fetch') && typeof value === 'function'
        ? async (...args: unknown[]) => {
            mockFetched.push(name);
            mockArgs[name] = args;
            return mockAnswers[name] ?? { kind: 'NOT_FOUND' };
          }
        : value,
    ]),
  );
});

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params?: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const InventoryPage = (require('./page') as { default: Page }).default;
const ShipmentPage = (require('./shipments/[id]/page') as { default: Page }).default;
const { InventoryScreen } = require('./InventoryScreen') as typeof import('./InventoryScreen');
const { ShipmentScreen } =
  require('./shipments/[id]/ShipmentScreen') as typeof import('./shipments/[id]/ShipmentScreen');
const { verifyInventoryStamp } =
  require('@/server/inventory-replay') as typeof import('@/server/inventory-replay');
const { mintFlash } = require('@/server/flash') as typeof import('@/server/flash');
/* eslint-enable @typescript-eslint/no-require-imports */

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const WAREHOUSE_ID = `WHS_${ULID}`;
const SHIPMENT_ID = `SHP_${ULID}`;

const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function signedInWith(roles: string[], organization = ORG) {
  return {
    subject: 'user-1',
    username: 'u',
    organizationId: organization,
    accessToken: jwt({
      org_id: organization,
      org_ids: [organization],
      org_roles: roles.map((role) => `${organization}:${role}`),
    }),
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf-token-for-this-session',
    issuedAt: Math.floor(Date.now() / 1000) - 60,
  };
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

const ofType = (tree: ReactNode, type: unknown) => elements(tree).filter((e) => e.type === type);

const ok = (data: unknown) => ({ kind: 'OK', data });
const pageOf = (items: unknown[]) => ok({ items, nextCursor: null, hasMore: false });

const WAREHOUSE = { id: WAREHOUSE_ID, name: 'انبار', createdAt: '2026-09-19T08:00:00.000Z' };
const ITEM = {
  id: `SKI_${ULID}`,
  warehouseId: WAREHOUSE_ID,
  productId: `PRD_${ULID}`,
  onHandQuantity: 10,
  reservedQuantity: 0,
  availableQuantity: 10,
  updatedAt: '2026-09-20T08:00:00.000Z',
};
const SHIPMENT = {
  id: SHIPMENT_ID,
  organizationId: ORG,
  originWarehouseId: WAREHOUSE_ID,
  consigneeOrganizationId: 'ORG-DEH-0002',
  orderReference: null,
  status: 'CREATED',
  legs: [],
  createdAt: '2026-09-19T08:00:00.000Z',
  dispatchedAt: null,
  deliveredAt: null,
  version: 1,
};

beforeEach(() => {
  mockFetched.length = 0;
  for (const key of Object.keys(mockAnswers)) delete mockAnswers[key];
  for (const key of Object.keys(mockArgs)) delete mockArgs[key];
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN']);
  Object.assign(mockAnswers, {
    fetchWarehouses: pageOf([WAREHOUSE]),
    fetchWarehouse: ok(WAREHOUSE),
    fetchStock: pageOf([ITEM]),
    fetchMovements: pageOf([]),
    fetchShipments: pageOf([SHIPMENT]),
    fetchShipment: ok(SHIPMENT),
    fetchShipmentTracking: ok({ shipmentId: SHIPMENT_ID, status: 'CREATED', events: [] }),
  });
});

async function inventory(search: Record<string, string> = { warehouse: WAREHOUSE_ID }) {
  const tree = await InventoryPage({ searchParams: Promise.resolve(search) });
  const screen = ofType(tree, InventoryScreen)[0]!
    .props as import('./InventoryScreen').InventoryScreenProps;
  return { tree, screen, write: screen.write! };
}

async function shipment(search: Record<string, string> = {}) {
  const tree = await ShipmentPage({
    params: Promise.resolve({ id: SHIPMENT_ID }),
    searchParams: Promise.resolve(search),
  });
  return ofType(tree, ShipmentScreen)[0]!
    .props as import('./shipments/[id]/ShipmentScreen').ShipmentScreenProps;
}

describe('/inventory', () => {
  it('sends the person to sign in when there is no session', async () => {
    mockSession.current = null;
    await expect(InventoryPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT:/login?returnTo=/inventory',
    );
  });

  it('draws every form to an operator, each bound to the slot it is drawn in', async () => {
    const { write } = await inventory();
    expect(write.canOperate).toBe(true);
    expect(write.warehouseForms.map((form) => form.command)).toEqual(['CREATE_WAREHOUSE']);
    expect(write.selectionForms.map((form) => form.command)).toEqual([
      'RECEIVE_STOCK',
      'ADJUST_STOCK',
      'CREATE_SHIPMENT',
    ]);
    const session = mockSession.current as Parameters<typeof verifyInventoryStamp>[0];
    for (const form of write.selectionForms) {
      const stamp = verifyInventoryStamp(
        session,
        form.submission.replay.token,
        { kind: 'WAREHOUSE', warehouseId: WAREHOUSE_ID },
        form.submission.id,
      );
      expect(stamp).toMatchObject({ command: form.command, expectedVersion: null });
    }
    const created = write.warehouseForms[0]!;
    expect(
      verifyInventoryStamp(
        session,
        created.submission.replay.token,
        { kind: 'WAREHOUSES' },
        created.submission.id,
      ),
    ).toMatchObject({ command: 'CREATE_WAREHOUSE' });
    // One submission, one key: no two forms share one.
    const ids = [...write.warehouseForms, ...write.selectionForms].map(
      (form) => form.submission.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the adjustment back while the warehouse holds nothing', async () => {
    mockAnswers.fetchStock = pageOf([]);
    const { write } = await inventory();
    expect(write.selectionForms.map((form) => form.command)).toEqual([
      'RECEIVE_STOCK',
      'CREATE_SHIPMENT',
    ]);
  });

  it.each([
    ['the oversight role', ['ORGANIZATION_ADMIN', 'AUDITOR']],
    ['the platform administrator', ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN']],
    ['a role outside the operator set', ['FLEET_MANAGER']],
    ['no role', []],
  ])('draws no form to %s', async (_name, roles) => {
    mockSession.current = signedInWith(roles);
    const { write } = await inventory();
    expect(write.canOperate).toBe(false);
    expect(write.warehouseForms).toEqual([]);
    expect(write.selectionForms).toEqual([]);
  });

  it('offers nothing for a warehouse the service does not show, nor while its stock is not shown', async () => {
    mockAnswers.fetchWarehouse = { kind: 'NOT_FOUND' };
    expect((await inventory()).write.selectionForms).toEqual([]);
    mockAnswers.fetchWarehouse = ok(WAREHOUSE);
    mockAnswers.fetchStock = { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' };
    expect((await inventory()).write.selectionForms.map((form) => form.command)).toEqual([
      'RECEIVE_STOCK',
      'CREATE_SHIPMENT',
    ]);
  });

  it('asks the ledger only for a warehouse that is chosen, and never for an id it could not have issued', async () => {
    await inventory({});
    expect(mockFetched).not.toContain('fetchMovements');
    mockFetched.length = 0;
    await inventory({ warehouse: 'not-an-id' });
    expect(mockFetched).not.toContain('fetchMovements');
    expect(mockFetched).not.toContain('fetchStock');
    mockFetched.length = 0;
    await inventory({ warehouse: WAREHOUSE_ID, mcursor: 'MOV_0', scursor: 'SHP_0' });
    expect(mockArgs.fetchMovements?.slice(1)).toEqual([WAREHOUSE_ID, 'MOV_0']);
    expect(mockArgs.fetchShipments?.[1]).toEqual({ cursor: 'SHP_0' });
  });

  it('shows a confirmation only when this session earned it for this warehouse', async () => {
    const session = mockSession.current as Parameters<typeof mintFlash>[0];
    const earned = mintFlash(session, WAREHOUSE_ID, 'RECEIVE_STOCK');
    expect((await inventory({ warehouse: WAREHOUSE_ID, flash: earned })).write.notice).toBe(
      'RECEIVE_STOCK',
    );
    expect(
      (await inventory({ warehouse: WAREHOUSE_ID, flash: 'RECEIVE_STOCK' })).write.notice,
    ).toBeUndefined();
    const other = mintFlash(session, `WHS_${'A'.repeat(26)}`, 'RECEIVE_STOCK');
    expect(
      (await inventory({ warehouse: WAREHOUSE_ID, flash: other })).write.notice,
    ).toBeUndefined();
  });

  it('reloads the chosen warehouse after a command', async () => {
    expect((await inventory()).write.pageHref).toBe(`/inventory?warehouse=${WAREHOUSE_ID}`);
    expect((await inventory({})).write.pageHref).toBe('/inventory');
  });
});

describe('/inventory/shipments/[id]', () => {
  it('sends the person to sign in when there is no session', async () => {
    mockSession.current = null;
    await expect(shipment()).rejects.toThrow(
      `NEXT_REDIRECT:/login?returnTo=${encodeURIComponent(`/inventory/shipments/${SHIPMENT_ID}`)}`,
    );
  });

  it('offers the dispatch of a created shipment, its stamp bound to the version the page read', async () => {
    mockAnswers.fetchShipment = ok({ ...SHIPMENT, version: 1 });
    const props = await shipment();
    expect(props.offered.map((form) => form.command)).toEqual(['DISPATCH_SHIPMENT']);
    const form = props.offered[0]!;
    expect(
      verifyInventoryStamp(
        mockSession.current as Parameters<typeof verifyInventoryStamp>[0],
        form.submission.replay.token,
        { kind: 'SHIPMENT', shipmentId: SHIPMENT_ID },
        form.submission.id,
      ),
    ).toMatchObject({ command: 'DISPATCH_SHIPMENT', expectedVersion: 1 });
  });

  it('offers the delivery of a dispatched shipment, bound to version 2', async () => {
    mockAnswers.fetchShipment = ok({ ...SHIPMENT, status: 'DISPATCHED', version: 2 });
    const props = await shipment();
    expect(props.offered.map((form) => form.command)).toEqual(['DELIVER_SHIPMENT']);
    expect(
      verifyInventoryStamp(
        mockSession.current as Parameters<typeof verifyInventoryStamp>[0],
        props.offered[0]!.submission.replay.token,
        { kind: 'SHIPMENT', shipmentId: SHIPMENT_ID },
        props.offered[0]!.submission.id,
      ),
    ).toMatchObject({ expectedVersion: 2 });
  });

  it('offers nothing of a delivered shipment', async () => {
    mockAnswers.fetchShipment = ok({ ...SHIPMENT, status: 'DELIVERED', version: 3 });
    expect((await shipment()).offered).toEqual([]);
  });

  it('draws the consignee no move, and says which side it is on', async () => {
    mockSession.current = signedInWith(['ORGANIZATION_ADMIN'], 'ORG-DEH-0002');
    const props = await shipment();
    expect(props.offered).toEqual([]);
    expect(props.consigneeOnly).toBe(true);
    expect(props.canOperate).toBe(true);
  });

  it.each([
    ['the oversight role', ['ORGANIZATION_ADMIN', 'AUDITOR']],
    ['a role outside the operator set', ['FLEET_MANAGER']],
  ])('draws %s no move and says it only reads', async (_name, roles) => {
    mockSession.current = signedInWith(roles);
    const props = await shipment();
    expect(props.offered).toEqual([]);
    expect(props.canOperate).toBe(false);
    expect(props.consigneeOnly).toBe(false);
  });

  it('offers nothing while the shipment is not shown (404, degraded), and still passes the tracking on', async () => {
    mockAnswers.fetchShipment = { kind: 'NOT_FOUND' };
    expect((await shipment()).offered).toEqual([]);
    mockAnswers.fetchShipment = { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' };
    expect((await shipment()).offered).toEqual([]);
  });

  it('shows a confirmation only when this session earned it for this shipment', async () => {
    const session = mockSession.current as Parameters<typeof mintFlash>[0];
    const earned = mintFlash(session, SHIPMENT_ID, 'DISPATCH_SHIPMENT');
    expect((await shipment({ flash: earned })).notice).toBe('DISPATCH_SHIPMENT');
    expect((await shipment({ flash: 'DISPATCH_SHIPMENT' })).notice).toBeUndefined();
  });
});

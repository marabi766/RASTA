/**
 * @jest-environment node
 */
import {
  inventoryCallerOf,
  inventoryRequestOf,
  isConsigneeOnly,
  mayOperateInventory,
  shipmentMovesFor,
  type InventoryCaller,
} from './inventory-commands';

/**
 * Who the portal draws the inventory forms for — a copy of the service's own
 * checks (`InventoryAccess.assertOperator`, the shipment state machine), read
 * from the access token's roles — and the requests the forms post.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

const caller = (roles: string[], organizationId: string | null = 'ORG-A'): InventoryCaller => ({
  organizationId,
  roles,
});

describe('inventoryCallerOf', () => {
  it('reads the organization and the roles the token carries for it', () => {
    expect(
      inventoryCallerOf(
        token({
          org_id: 'ORG-A',
          org_ids: ['ORG-A', 'ORG-B'],
          org_roles: ['ORG-A:ORGANIZATION_ADMIN', 'ORG-B:AUDITOR'],
        }),
      ),
    ).toEqual({ organizationId: 'ORG-A', roles: ['ORGANIZATION_ADMIN'] });
  });

  it('a token that cannot be read, or that the service would refuse, draws nothing', () => {
    expect(inventoryCallerOf('opaque')).toEqual({ organizationId: null, roles: [] });
    expect(
      inventoryCallerOf(token({ org_id: 'ORG-A', org_ids: ['ORG-B'], org_roles: [] })),
    ).toEqual({ organizationId: null, roles: [] });
  });
});

describe('mayOperateInventory', () => {
  it('an organization administrator may; the default operator set is that role', () => {
    expect(mayOperateInventory(caller(['ORGANIZATION_ADMIN']))).toBe(true);
  });

  it.each([
    ['no role of the set', caller(['FLEET_MANAGER'])],
    ['no organization', caller(['ORGANIZATION_ADMIN'], null)],
    ['the oversight role, whatever else is held', caller(['ORGANIZATION_ADMIN', 'AUDITOR'])],
    [
      'the platform administrator, whatever else is held',
      caller(['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN']),
    ],
    ['nothing at all', caller([])],
  ])('is false for %s', (_name, who) => {
    expect(mayOperateInventory(who)).toBe(false);
  });

  it('follows the configured set, never the platform administrator or the oversight role', () => {
    expect(mayOperateInventory(caller(['FLEET_MANAGER']), ['FLEET_MANAGER'])).toBe(true);
    expect(mayOperateInventory(caller(['SYSTEM_ADMIN']), ['SYSTEM_ADMIN'])).toBe(false);
    expect(mayOperateInventory(caller(['AUDITOR']), ['AUDITOR'])).toBe(false);
  });
});

describe('shipmentMovesFor', () => {
  const owned = (status: string) => ({ organizationId: 'ORG-A', status });
  const admin = caller(['ORGANIZATION_ADMIN']);

  it('offers the dispatch of a created shipment and the delivery of a dispatched one — one at a time', () => {
    expect(shipmentMovesFor(admin, owned('CREATED'))).toEqual(['DISPATCH_SHIPMENT']);
    expect(shipmentMovesFor(admin, owned('DISPATCHED'))).toEqual(['DELIVER_SHIPMENT']);
  });

  it('offers nothing of a delivered shipment or of a status it does not know', () => {
    expect(shipmentMovesFor(admin, owned('DELIVERED'))).toEqual([]);
    expect(shipmentMovesFor(admin, owned('LOST_AT_SEA'))).toEqual([]);
  });

  it('offers nothing to the consignee, to a third organization or to a reader without the operator role', () => {
    const shipment = { organizationId: 'ORG-A', status: 'CREATED' };
    expect(shipmentMovesFor(caller(['ORGANIZATION_ADMIN'], 'ORG-B'), shipment)).toEqual([]);
    expect(shipmentMovesFor(caller(['FLEET_MANAGER']), shipment)).toEqual([]);
    expect(shipmentMovesFor(caller(['ORGANIZATION_ADMIN'], null), shipment)).toEqual([]);
  });

  it('knows the consignee side: another organization, named as the consignee', () => {
    const shipment = { organizationId: 'ORG-A', consigneeOrganizationId: 'ORG-B' };
    expect(isConsigneeOnly(caller(['ORGANIZATION_ADMIN'], 'ORG-B'), shipment)).toBe(true);
    expect(isConsigneeOnly(caller(['ORGANIZATION_ADMIN'], 'ORG-A'), shipment)).toBe(false);
    expect(isConsigneeOnly(caller(['ORGANIZATION_ADMIN'], 'ORG-C'), shipment)).toBe(false);
    // The owner sending to itself is the owner, not only a consignee.
    expect(
      isConsigneeOnly(caller([], 'ORG-A'), {
        organizationId: 'ORG-A',
        consigneeOrganizationId: 'ORG-A',
      }),
    ).toBe(false);
  });
});

describe('inventoryRequestOf', () => {
  it('a typed command with no body, a slot-bound one with no slot, a move without a version: no request', () => {
    expect(inventoryRequestOf('CREATE_WAREHOUSE', null, null, null)).toBeNull();
    expect(
      inventoryRequestOf(
        'RECEIVE_STOCK',
        null,
        { productId: 'p', quantity: 1, sourceReference: null },
        null,
      ),
    ).toBeNull();
    expect(inventoryRequestOf('DISPATCH_SHIPMENT', 'SHP_1', null, null)).toBeNull();
    expect(inventoryRequestOf('DELIVER_SHIPMENT', null, null, 2)).toBeNull();
  });

  it('a shipment id in a path is encoded', () => {
    expect(inventoryRequestOf('DISPATCH_SHIPMENT', 'a/b', null, 1)?.path).toBe(
      '/v1/shipments/a%2Fb/dispatch',
    );
  });
});

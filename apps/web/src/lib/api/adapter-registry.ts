import type { AdapterDescriptor } from './adapter';
import { ASSET_ADAPTER } from './adapters/asset';
import { DOCUMENT_ADAPTER } from './adapters/document';
import { ECONOMIC_LEDGER_ADAPTER, ECONOMIC_WALLET_ADAPTER } from './adapters/economic';
import { FLEET_ADAPTER } from './adapters/fleet';
import { IDENTITY_DIRECTORY_ADAPTER, IDENTITY_ME_ADAPTER } from './adapters/identity';
import { MAINTENANCE_ADAPTER } from './adapters/maintenance';
import { MARKETPLACE_CATALOGUE_ADAPTER, MARKETPLACE_ORDERS_ADAPTER } from './adapters/marketplace';
import { ORGANIZATION_DIRECTORY_ADAPTER } from './adapters/organization';
import { SUPPLIER_ADAPTER } from './adapters/supplier';

/**
 * Every adapter this application ships.
 *
 * The list is built from the adapter modules themselves rather than typed out,
 * so an id here always corresponds to code that issues a real request. That is
 * the property `assertManifestIntegrity` depends on: a capability cannot be
 * marked `LIVE` by editing a label, only by writing an adapter.
 */
export const ADAPTERS = [
  IDENTITY_ME_ADAPTER,
  IDENTITY_DIRECTORY_ADAPTER,
  ORGANIZATION_DIRECTORY_ADAPTER,
  ASSET_ADAPTER,
  FLEET_ADAPTER,
  MAINTENANCE_ADAPTER,
  MARKETPLACE_CATALOGUE_ADAPTER,
  MARKETPLACE_ORDERS_ADAPTER,
  ECONOMIC_WALLET_ADAPTER,
  ECONOMIC_LEDGER_ADAPTER,
  DOCUMENT_ADAPTER,
  SUPPLIER_ADAPTER,
] as const satisfies readonly AdapterDescriptor[];

export type AdapterId = (typeof ADAPTERS)[number]['id'];

export const REGISTERED_ADAPTERS: ReadonlySet<AdapterId> = new Set(
  ADAPTERS.map((adapter) => adapter.id),
);

export function adapterById(id: string): AdapterDescriptor | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

/**
 * Every gateway path prefix these adapters reach.
 *
 * Derived rather than listed, so a test can check the whole set against
 * `services/api-gateway/src/config/routes.ts` without a second list to keep in
 * step.
 */
export function declaredGatewayPrefixes(): ReadonlySet<string> {
  const prefixes = new Set<string>();

  for (const adapter of ADAPTERS) {
    for (const route of adapter.routes) {
      const path = route.split(' ')[1];
      const prefix = path?.split('/')[2];
      if (prefix) prefixes.add(prefix);
    }
  }

  return prefixes;
}

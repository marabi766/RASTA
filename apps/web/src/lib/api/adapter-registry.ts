import type { AdapterDescriptor } from './adapter';
import { ECONOMIC_PAYMENT_PROVIDER_ADAPTER } from './adapters/economic';
import { MARKETPLACE_CATALOGUE_ADAPTER } from './adapters/marketplace';
import { ORGANIZATION_DIRECTORY_ADAPTER } from './adapters/organization';

/**
 * Every adapter this application ships.
 *
 * The list is built from the adapter modules themselves rather than typed out,
 * so an id here always corresponds to code that issues a real request. That is
 * the property `assertManifestIntegrity` depends on: a capability cannot be
 * marked `LIVE` by editing a label, only by writing an adapter.
 */
export const ADAPTERS = [
  MARKETPLACE_CATALOGUE_ADAPTER,
  ORGANIZATION_DIRECTORY_ADAPTER,
  ECONOMIC_PAYMENT_PROVIDER_ADAPTER,
] as const satisfies readonly AdapterDescriptor[];

export type AdapterId = (typeof ADAPTERS)[number]['id'];

export const REGISTERED_ADAPTERS: ReadonlySet<AdapterId> = new Set(
  ADAPTERS.map((adapter) => adapter.id),
);

export function adapterById(id: string): AdapterDescriptor | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id);
}
